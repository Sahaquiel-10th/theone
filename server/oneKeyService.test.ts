import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { Store } from "./db.js";
import type { Database } from "./types.js";
import { OneKeyService } from "./oneKeyService.js";

function testStore(): Store {
  const database = {
    users: [{ id: "user-a", username: "a", passwordHash: "x", role: "user", defaultWorkspaceId: "workspace-a", enabled: true, createdAt: "2026-08-28" }],
    workspaces: [{ id: "workspace-a", name: "A", slug: "a", status: "active", createdAt: "2026-08-28", updatedAt: "2026-08-28" }],
    workspaceMembers: [{ id: "member-a", workspaceId: "workspace-a", userId: "user-a", role: "owner", createdAt: "2026-08-28" }],
    oneKeyDevices: [],
    deviceChallenges: [],
    oneTimeLoginCodes: []
  } as unknown as Database;
  return {
    async read() { return database; },
    async mutate<T>(fn: (db: Database) => T) { return fn(database); }
  };
}

test("provisions a key and redeems a signed challenge exactly once", async () => {
  const service = new OneKeyService(testStore());
  const provisioned = await service.provision({ workspaceId: "workspace-a", userId: "user-a", serialNumber: "ONE-0001" });
  assert.match(provisioned.deviceConfig.privateKeyRaw, /^[A-Za-z0-9_-]+$/);
  const challenge = await service.challenge(provisioned.device.id);
  const privateKey = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: provisioned.deviceConfig.privateKeyRaw, x: provisioned.deviceConfig.publicKeyRaw }, format: "jwk" });
  const signature = crypto.sign(null, Buffer.from(challenge.nonce, "base64url"), privateKey).toString("base64url");
  const verified = await service.verify(challenge.challengeId, signature);
  const binding = await service.redeem(verified.loginCode);
  assert.deepEqual(binding, { userId: "user-a", role: "user", workspaceId: "workspace-a", deviceId: provisioned.device.id });
  await assert.rejects(() => service.redeem(verified.loginCode), /已过期或已使用/);
  await assert.rejects(() => service.verify(challenge.challengeId, signature), /已过期或不可用/);
});

test("rejects invalid signatures and revoked keys", async () => {
  const service = new OneKeyService(testStore());
  const provisioned = await service.provision({ workspaceId: "workspace-a", userId: "user-a", serialNumber: "ONE-0002" });
  const challenge = await service.challenge(provisioned.device.id);
  await assert.rejects(() => service.verify(challenge.challengeId, crypto.randomBytes(64).toString("base64url")), /验证失败/);
  await service.revoke(provisioned.device.id);
  await assert.rejects(() => service.challenge(provisioned.device.id), /不存在或已挂失/);
});

test("does not provision a key across workspace membership boundaries", async () => {
  const service = new OneKeyService(testStore());
  await assert.rejects(() => service.provision({ workspaceId: "workspace-a", userId: "user-b", serialNumber: "ONE-0003" }), /用户不存在或已停用/);
});
