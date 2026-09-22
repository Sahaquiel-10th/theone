import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { compareRuntimeVersions, runtimeUpdateWasCompleted, selectRuntimeUpdate, verifyRuntimeUpdateEnvelope, type RuntimeUpdatePayload } from "./runtimeUpdate.js";

function signed(payload: RuntimeUpdatePayload) {
  const pair = crypto.generateKeyPairSync("ed25519");
  const bytes = Buffer.from(JSON.stringify(payload));
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    publicKeyRaw: publicDer.subarray(publicDer.length - 32).toString("base64url"),
    envelope: { payload: bytes.toString("base64url"), signature: crypto.sign(null, bytes, pair.privateKey).toString("base64url") }
  };
}

const payload: RuntimeUpdatePayload = {
  schemaVersion: 1,
  channel: "stable",
  releasedAt: "2026-09-15T00:00:00.000Z",
  artifacts: [
    { platform: "macos", architecture: "universal", version: "0.3.0", url: "https://theone.aiarrival.cn/runtime-updates/one-macos-0.3.0.zip", sha256: "a".repeat(64), size: 1200 },
    { platform: "windows", architecture: "amd64", version: "0.3.1", url: "https://theone.aiarrival.cn/runtime-updates/one-windows-0.3.1.exe", sha256: "b".repeat(64), size: 900 }
  ]
};

test("compares numeric launcher versions without lexical mistakes", () => {
  assert.equal(compareRuntimeVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareRuntimeVersions("1.0", "1.0.0"), 0);
  assert.equal(compareRuntimeVersions("0.2.8", "0.3.0"), -1);
  assert.throws(() => compareRuntimeVersions("1.0-beta", "1.0"), /VERSION_INVALID/);
});

test("verifies the signed bytes before accepting an update catalog", () => {
  const fixture = signed(payload);
  assert.deepEqual(verifyRuntimeUpdateEnvelope(fixture.envelope, fixture.publicKeyRaw), payload);
  const tampered = { ...fixture.envelope, payload: Buffer.from(JSON.stringify({ ...payload, channel: "preview" })).toString("base64url") };
  assert.throws(() => verifyRuntimeUpdateEnvelope(tampered, fixture.publicKeyRaw), /SIGNATURE_INVALID/);
});

test("selects only the current platform and compatible architecture", () => {
  assert.equal(selectRuntimeUpdate(payload, { platform: "macos", architecture: "arm64", version: "0.2.8", updateProtocol: 1 })?.version, "0.3.0");
  assert.equal(selectRuntimeUpdate(payload, { platform: "windows", architecture: "amd64", version: "0.2.4", updateProtocol: 1 })?.version, "0.3.1");
  assert.equal(selectRuntimeUpdate(payload, { platform: "windows", architecture: "x86_64", version: "0.2.4", updateProtocol: 1 }), undefined);
});

test("does not re-offer a package during the resident hand-off", () => {
  assert.equal(runtimeUpdateWasCompleted({ status: "completed", version: "0.3.9" }, "0.3.9"), true);
  assert.equal(runtimeUpdateWasCompleted({ status: "completed", version: "0.3.9" }, "0.3.10"), false);
  assert.equal(runtimeUpdateWasCompleted({ status: "installing", version: "0.3.9" }, "0.3.9"), false);
});
