import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { AuthorizationSessionError, AuthorizationSessions } from "./authorizationSessions.js";

function fixture() {
  const db = { knowledgeConnections: [] } as unknown as Database;
  const store = { async read() { return db; }, async mutate<T>(fn: (value: Database) => T) { return fn(db); } } as Store;
  return { db, store, sessions: new AuthorizationSessions(store) };
}

test("authorization sessions encrypt secrets and bind device polling to workspace and user", async () => {
  const f = fixture();
  const created = await f.sessions.create({
    workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", protocol: "device_authorization",
    payload: { clientId: "client-a", code: "private-device-code" }, expiresAt: Date.now() + 60_000
  });
  assert.doesNotMatch(JSON.stringify(f.db), /private-device-code/);
  await assert.rejects(f.sessions.poll({ id: created.id, workspaceId: "workspace-b", userId: "user-a", connectorId: "getnote", minimumDelayMs: 1000 }), AuthorizationSessionError);
  await assert.rejects(f.sessions.poll({ id: created.id, workspaceId: "workspace-a", userId: "user-b", connectorId: "getnote", minimumDelayMs: 1000 }), AuthorizationSessionError);
  const result = await f.sessions.poll({ id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", minimumDelayMs: 1000 });
  assert.equal(result.payload.code, "private-device-code");
  await assert.rejects(f.sessions.poll({ id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", minimumDelayMs: 1000 }), (error: unknown) => error instanceof AuthorizationSessionError && error.code === "POLL_TOO_FAST");

  await assert.rejects(f.sessions.replacePendingPayload({ id: created.id, workspaceId: "workspace-b", userId: "user-a", connectorId: "getnote", payload: { apiKey: "must-not-save" } }), AuthorizationSessionError);
  await f.sessions.replacePendingPayload({
    id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote",
    payload: { clientId: "client-a", credentialClientId: "client-a", apiKey: "private-api-key" }
  });
  assert.doesNotMatch(JSON.stringify(f.db), /private-api-key|private-device-code/);
  const staged = await f.sessions.poll({ id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", minimumDelayMs: 1000 });
  assert.equal(staged.payload.apiKey, "private-api-key");
  assert.equal(staged.payload.code, undefined);
});

test("OAuth state is hashed, single-use and survives a service instance restart", async () => {
  const f = fixture();
  await f.sessions.create({
    workspaceId: "workspace-a", userId: "user-a", connectorId: "notion", protocol: "oauth_pkce",
    state: "raw-private-state", payload: { clientId: "client-a", verifier: "private-verifier" }, expiresAt: Date.now() + 60_000
  });
  assert.doesNotMatch(JSON.stringify(f.db), /raw-private-state|private-verifier/);
  const restarted = new AuthorizationSessions(f.store);
  const claimed = await restarted.claimState("notion", "raw-private-state");
  assert.equal(claimed.payload.verifier, "private-verifier");
  await assert.rejects(restarted.claimState("notion", "raw-private-state"), (error: unknown) => error instanceof AuthorizationSessionError && error.code === "INVALID_STATE");
  await restarted.finish(claimed.session.id);
  assert.equal(f.db.knowledgeConnections[0].authorizationSession, undefined);
});

test("cancelling a pending flow is exact-scoped and prevents a later commit", async () => {
  const f = fixture();
  const created = await f.sessions.create({
    workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", protocol: "device_authorization",
    payload: { clientId: "client-a", code: "private-device-code" }, expiresAt: Date.now() + 60_000
  });
  await assert.rejects(f.sessions.cancelPending({ id: created.id, workspaceId: "workspace-b", userId: "user-a", connectorId: "getnote" }), AuthorizationSessionError);
  const connection = await f.sessions.cancelPending({ id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote" });
  assert.equal(connection.status, "revoked");
  assert.equal(f.db.knowledgeConnections[0].authorizationSession, undefined);
  await assert.rejects(f.sessions.replacePendingPayload({
    id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", payload: { apiKey: "must-not-save" }
  }), AuthorizationSessionError);
});

test("an expired device authorization is removed and cannot be polled again", async () => {
  const f = fixture();
  const created = await f.sessions.create({
    workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", protocol: "device_authorization",
    payload: { clientId: "client-a", code: "expired-device-code" }, expiresAt: Date.now() - 1
  });
  await assert.rejects(
    f.sessions.poll({ id: created.id, workspaceId: "workspace-a", userId: "user-a", connectorId: "getnote", minimumDelayMs: 1000 }),
    (error: unknown) => error instanceof AuthorizationSessionError && error.code === "EXPIRED"
  );
  assert.equal(f.db.knowledgeConnections[0].authorizationSession, undefined);
});
