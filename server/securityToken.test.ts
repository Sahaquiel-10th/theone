import assert from "node:assert/strict";
import test from "node:test";
import { signToken, verifyToken } from "./security.js";

test("supports a longer ONE Key session without changing the default token lifetime", () => {
  const startedAt = Date.now();
  const payload = verifyToken(signToken({ sub: "user-a", deviceId: "device-a" }, "test-secret", 30_000), "test-secret");
  assert.equal(payload?.sub, "user-a");
  assert.equal(payload?.deviceId, "device-a");
  assert.ok((payload?.exp ?? 0) >= startedAt + 29_000);
  assert.ok((payload?.exp ?? 0) <= Date.now() + 30_000);
});
