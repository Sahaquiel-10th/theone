import crypto from "node:crypto";
import type { Store } from "../db.js";
import { authorizationSessionContext, decryptCredential, encryptCredential } from "../knowledge/credentialCipher.js";
import { uid } from "../security.js";
import type { ConnectorAuthorizationSession } from "../types.js";

export type AuthorizationPayload = Record<string, unknown>;

export class AuthorizationSessionError extends Error {
  constructor(readonly code: "NOT_FOUND" | "EXPIRED" | "INVALID_STATE" | "POLL_TOO_FAST", message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

function stateHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function decodePayload(session: ConnectorAuthorizationSession) {
  const parsed = JSON.parse(decryptCredential(session.encryptedPayload, authorizationSessionContext(session.id, session.workspaceId, session.connectorId))) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("连接授权资料格式无效");
  return parsed as AuthorizationPayload;
}

/**
 * Persistent, tenant-bound authorization transactions shared by connector
 * protocol drivers. Raw OAuth state, device codes and PKCE verifiers are never
 * stored in plaintext and successful/failed transactions are removed.
 */
export class AuthorizationSessions {
  constructor(private store: Store) {}

  async create(params: {
    workspaceId: string;
    userId: string;
    connectorId: ConnectorAuthorizationSession["connectorId"];
    protocol: ConnectorAuthorizationSession["protocol"];
    payload: AuthorizationPayload;
    expiresAt: number;
    state?: string;
    nextAttemptAt?: number;
  }) {
    const timestamp = new Date().toISOString();
    const id = uid("cas");
    const session: ConnectorAuthorizationSession = {
      id, workspaceId: params.workspaceId, userId: params.userId,
      connectorId: params.connectorId, protocol: params.protocol, status: "pending",
      stateHash: params.state ? stateHash(params.state) : undefined,
      encryptedPayload: encryptCredential(JSON.stringify(params.payload), authorizationSessionContext(id, params.workspaceId, params.connectorId)),
      expiresAt: new Date(params.expiresAt).toISOString(),
      nextAttemptAt: params.nextAttemptAt ? new Date(params.nextAttemptAt).toISOString() : undefined,
      createdAt: timestamp, updatedAt: timestamp
    };
    await this.store.mutate(db => {
      const now = Date.now();
      db.connectorAuthorizationSessions = db.connectorAuthorizationSessions.filter(item =>
        Date.parse(item.expiresAt) > now &&
        !(item.workspaceId === params.workspaceId && item.connectorId === params.connectorId)
      );
      db.connectorAuthorizationSessions.push(session);
    });
    return { id: session.id };
  }

  async poll(params: {
    id: string;
    workspaceId: string;
    userId: string;
    connectorId: ConnectorAuthorizationSession["connectorId"];
    minimumDelayMs: number;
  }) {
    const result = await this.store.mutate(db => {
      const target = db.connectorAuthorizationSessions.find(item =>
        item.id === params.id && item.workspaceId === params.workspaceId && item.userId === params.userId &&
        item.connectorId === params.connectorId && item.status === "pending"
      );
      if (!target) throw new AuthorizationSessionError("NOT_FOUND", "授权流程不存在");
      const now = Date.now();
      if (!Number.isFinite(Date.parse(target.expiresAt)) || Date.parse(target.expiresAt) <= now) {
        return { expiredId: target.id };
      }
      const nextAttempt = target.nextAttemptAt ? Date.parse(target.nextAttemptAt) : 0;
      if (Number.isFinite(nextAttempt) && nextAttempt > now) throw new AuthorizationSessionError("POLL_TOO_FAST", "轮询过快", nextAttempt - now);
      target.nextAttemptAt = new Date(now + params.minimumDelayMs).toISOString();
      target.updatedAt = new Date(now).toISOString();
      return { session: structuredClone(target) };
    });
    if ("expiredId" in result) {
      await this.finish(result.expiredId!);
      throw new AuthorizationSessionError("EXPIRED", "授权已过期，请重新连接");
    }
    const session = result.session;
    return { session, payload: decodePayload(session) };
  }

  async defer(id: string, retryAfterMs: number) {
    await this.store.mutate(db => {
      const target = db.connectorAuthorizationSessions.find(item => item.id === id && item.status === "pending");
      if (!target) return;
      target.nextAttemptAt = new Date(Date.now() + retryAfterMs).toISOString();
      target.updatedAt = new Date().toISOString();
    });
  }

  async claimState(connectorId: ConnectorAuthorizationSession["connectorId"], state: string) {
    if (!state) throw new AuthorizationSessionError("INVALID_STATE", "授权状态无效，请返回 ONE 重试");
    const wanted = stateHash(state);
    const result = await this.store.mutate(db => {
      const target = db.connectorAuthorizationSessions.find(item => item.connectorId === connectorId && item.stateHash === wanted && item.status === "pending");
      if (!target) throw new AuthorizationSessionError("INVALID_STATE", "授权状态无效或已经使用，请返回 ONE 重试");
      if (!Number.isFinite(Date.parse(target.expiresAt)) || Date.parse(target.expiresAt) <= Date.now()) {
        return { expiredId: target.id };
      }
      target.status = "exchanging";
      target.updatedAt = new Date().toISOString();
      return { session: structuredClone(target) };
    });
    if ("expiredId" in result) {
      await this.finish(result.expiredId!);
      throw new AuthorizationSessionError("EXPIRED", "授权流程已过期，请返回 ONE 重试");
    }
    const session = result.session;
    return { session, payload: decodePayload(session) };
  }

  async cancelState(connectorId: ConnectorAuthorizationSession["connectorId"], state: string) {
    if (!state) return undefined;
    const wanted = stateHash(state);
    const session = await this.store.mutate(db => {
      const index = db.connectorAuthorizationSessions.findIndex(item => item.connectorId === connectorId && item.stateHash === wanted && item.status === "pending");
      if (index < 0) return undefined;
      return db.connectorAuthorizationSessions.splice(index, 1)[0];
    });
    return session ? { session, payload: decodePayload(session) } : undefined;
  }

  async markVerifying(id: string) {
    await this.store.mutate(db => {
      const target = db.connectorAuthorizationSessions.find(item => item.id === id && item.status === "exchanging");
      if (!target) throw new AuthorizationSessionError("NOT_FOUND", "授权流程不存在或已经结束");
      target.status = "verifying";
      target.updatedAt = new Date().toISOString();
    });
  }

  async finish(id: string) {
    await this.store.mutate(db => {
      db.connectorAuthorizationSessions = db.connectorAuthorizationSessions.filter(item => item.id !== id);
    });
  }
}
