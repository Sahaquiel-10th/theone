import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { planManagedExecutorPreparation, verifyManagedExecutorCatalog, type ManagedExecutorCatalog } from "./managedExecutorCatalog.js";

const catalog: ManagedExecutorCatalog = {
  kind: "one-managed-executors", schemaVersion: 1, releasedAt: "2026-10-09T00:00:00Z",
  releases: [{
    executor: "codex", version: "1.2.3", platform: "macos", architecture: "arm64",
    url: "https://downloads.example.com/executors/codex.tar.gz",
    sourceUrl: "https://github.com/openai/codex/releases/download/rust-v1.2.3/codex-aarch64-apple-darwin.tar.gz",
    sha256: "a".repeat(64), size: 200, entrypoint: "bin/codex",
    license: "Apache-2.0", licenseFiles: ["LICENSE", "NOTICE"]
  }]
};
const pair = crypto.generateKeyPairSync("ed25519");
const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
const publicKey = publicDer.subarray(publicDer.length - 32).toString("base64url");
const origins = ["https://downloads.example.com"];
function sign(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { payload: bytes.toString("base64url"), signature: crypto.sign(null, bytes, pair.privateKey).toString("base64url") };
}
function changed(fields: Record<string, unknown>) {
  return { ...catalog, releases: [{ ...catalog.releases[0], ...fields }] };
}

test("executor catalog requires authentic signed bytes and independent domain", () => {
  assert.deepEqual(verifyManagedExecutorCatalog(sign(catalog), publicKey, origins), catalog);
  assert.throws(() => verifyManagedExecutorCatalog({ ...sign(catalog), payload: sign(changed({ size: 201 })).payload }, publicKey, origins), /SIGNATURE_INVALID/);
  assert.throws(() => verifyManagedExecutorCatalog(sign({ schemaVersion: 1, channel: "stable", releasedAt: catalog.releasedAt, artifacts: [] }), publicKey, origins));
});

test("executor distribution rejects unreviewed tools, foreign hosts and embedded credentials", () => {
  for (const fields of [
    { executor: "claude_code" }, { license: "proprietary" }, { licenseFiles: [] },
    { url: "https://evil.example/executor.zip" }, { url: "https://downloads.example.com/a?token=secret" },
    { url: "https://user:password@downloads.example.com/a" },
    { sourceUrl: "https://github.com/other/codex/releases/download/v1/file" },
    { apiKey: "must-not-be-packaged" }, { size: 0 }, { sha256: "bad" }
  ]) assert.throws(() => verifyManagedExecutorCatalog(sign(changed(fields)), publicKey, origins));
  assert.throws(() => verifyManagedExecutorCatalog(sign(catalog), publicKey, []));
});

test("package metadata rejects traversal and duplicate releases", () => {
  for (const entrypoint of ["/bin/codex", "../codex", "bin/../codex", "C:\\codex.exe", "bin//codex", "bin/codex;rm"])
    assert.throws(() => verifyManagedExecutorCatalog(sign(changed({ entrypoint })), publicKey, origins));
  assert.throws(() => verifyManagedExecutorCatalog(sign(changed({ licenseFiles: ["../LICENSE"] })), publicKey, origins));
  assert.throws(() => verifyManagedExecutorCatalog(sign({ ...catalog, releases: [...catalog.releases, ...catalog.releases] }), publicKey, origins));
});

test("preparation matches architecture, never downgrades, and defers active work", () => {
  const verified = verifyManagedExecutorCatalog(sign(catalog), publicKey, origins);
  const device = { platform: "macos", architecture: "arm64" } as const;
  assert.equal(planManagedExecutorPreparation(verified, device, { activeExecutions: 0 }).action, "prepare");
  assert.equal(planManagedExecutorPreparation(verified, device, { activeExecutions: 1 }).action, "defer");
  assert.equal(planManagedExecutorPreparation(verified, device, { activeExecutions: 0, installedVersion: "1.2.3" }).action, "keep");
  assert.equal(planManagedExecutorPreparation(verified, device, { activeExecutions: 0, installedVersion: "1.2.4" }).action, "keep");
  assert.equal(planManagedExecutorPreparation(verified, { platform: "windows", architecture: "amd64" }, { activeExecutions: 0 }).action, "unavailable");
  assert.throws(() => planManagedExecutorPreparation(verified, device, { activeExecutions: -1 }));
});
