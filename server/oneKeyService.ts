import crypto from "node:crypto";
import type { Store } from "./db.js";
import { uid } from "./security.js";

const challengeTtlMs = 2 * 60 * 1000;
const loginCodeTtlMs = 60 * 1000;
const maxChallengeAttempts = 5;

function now() { return new Date().toISOString(); }
function tokenHash(value: string) { return crypto.createHash("sha256").update(value).digest("base64url"); }

export class OneKeyService {
  constructor(private store: Store) {}

  async provision(params: { workspaceId: string; userId: string; serialNumber: string }) {
    const pair = crypto.generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateJwk = pair.privateKey.export({ format: "jwk" });
    if (!privateJwk.d || !privateJwk.x) throw new Error("无法生成 ONE Key 设备凭证");
    const device = await this.store.mutate((db) => {
      if (!db.workspaces.some((item) => item.id === params.workspaceId && item.status === "active")) throw new Error("Workspace 不存在或已停用");
      if (!db.users.some((item) => item.id === params.userId && item.enabled)) throw new Error("用户不存在或已停用");
      if (!db.workspaceMembers.some((item) => item.workspaceId === params.workspaceId && item.userId === params.userId)) throw new Error("用户不属于目标 Workspace");
      if (db.oneKeyDevices.some((item) => item.serialNumber === params.serialNumber && item.status === "active")) throw new Error("ONE Key 序列号已存在");
      const created = { id: uid("dev"), serialNumber: params.serialNumber, workspaceId: params.workspaceId, userId: params.userId, status: "active" as const, publicKey, createdAt: now() };
      db.oneKeyDevices.push(created);
      return created;
    });
    return {
      device: { id: device.id, serialNumber: device.serialNumber, workspaceId: device.workspaceId, userId: device.userId, status: device.status, createdAt: device.createdAt },
      deviceConfig: { version: 1, deviceId: device.id, privateKeyRaw: privateJwk.d, publicKeyRaw: privateJwk.x }
    };
  }

  async challenge(deviceId: string) {
    const nonce = crypto.randomBytes(32).toString("base64url");
    return this.store.mutate((db) => {
      const device = db.oneKeyDevices.find((item) => item.id === deviceId && item.status === "active");
      if (!device) throw new Error("ONE Key 不存在或已挂失");
      const createdAt = now();
      const challenge = { id: uid("chl"), deviceId, nonce, attempts: 0, createdAt, expiresAt: new Date(Date.now() + challengeTtlMs).toISOString() };
      db.deviceChallenges.push(challenge);
      return { challengeId: challenge.id, nonce, expiresAt: challenge.expiresAt };
    });
  }

  async verify(challengeId: string, signature: string) {
    const loginCode = crypto.randomBytes(32).toString("base64url");
    const outcome = await this.store.mutate((db) => {
      const challenge = db.deviceChallenges.find((item) => item.id === challengeId);
      if (!challenge || challenge.usedAt || Date.parse(challenge.expiresAt) <= Date.now()) return { error: "设备验证已过期或不可用" } as const;
      const device = db.oneKeyDevices.find((item) => item.id === challenge.deviceId && item.status === "active");
      if (!device) return { error: "ONE Key 不存在或已挂失" } as const;
      let valid = false;
      try {
        valid = crypto.verify(null, Buffer.from(challenge.nonce, "base64url"), device.publicKey, Buffer.from(signature, "base64url"));
      } catch {
        valid = false;
      }
      if (!valid) {
        challenge.attempts += 1;
        if (challenge.attempts >= maxChallengeAttempts) challenge.usedAt = now();
        return { error: "ONE Key 验证失败" } as const;
      }
      challenge.usedAt = now();
      device.lastUsedAt = challenge.usedAt;
      const createdAt = now();
      const code = { id: uid("otc"), tokenHash: tokenHash(loginCode), deviceId: device.id, workspaceId: device.workspaceId, userId: device.userId, createdAt, expiresAt: new Date(Date.now() + loginCodeTtlMs).toISOString() };
      db.oneTimeLoginCodes.push(code);
      return { loginCode, expiresAt: code.expiresAt } as const;
    });
    if ("error" in outcome) throw new Error(outcome.error);
    return outcome;
  }

  async redeem(loginCode: string) {
    const outcome = await this.store.mutate((db) => {
      const code = db.oneTimeLoginCodes.find((item) => item.tokenHash === tokenHash(loginCode));
      if (!code || code.usedAt || Date.parse(code.expiresAt) <= Date.now()) return { error: "一次性登录码已过期或已使用" } as const;
      const device = db.oneKeyDevices.find((item) => item.id === code.deviceId && item.status === "active");
      const user = db.users.find((item) => item.id === code.userId && item.enabled);
      const member = db.workspaceMembers.find((item) => item.workspaceId === code.workspaceId && item.userId === code.userId);
      if (!device || !user || !member) return { error: "ONE Key 绑定已失效" } as const;
      code.usedAt = now();
      return { userId: user.id, role: user.role, workspaceId: code.workspaceId, deviceId: device.id } as const;
    });
    if ("error" in outcome) throw new Error(outcome.error);
    return outcome;
  }

  async revoke(deviceId: string) {
    return this.store.mutate((db) => {
      const device = db.oneKeyDevices.find((item) => item.id === deviceId);
      if (!device) throw new Error("ONE Key 不存在");
      device.status = "revoked";
      device.revokedAt = now();
      for (const challenge of db.deviceChallenges) if (challenge.deviceId === deviceId && !challenge.usedAt) challenge.usedAt = device.revokedAt;
      for (const code of db.oneTimeLoginCodes) if (code.deviceId === deviceId && !code.usedAt) code.usedAt = device.revokedAt;
      return { id: device.id, status: device.status, revokedAt: device.revokedAt };
    });
  }
}
