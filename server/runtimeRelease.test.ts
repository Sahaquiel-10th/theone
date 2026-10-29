import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectRuntimeUpdate, verifyRuntimeUpdateEnvelope, type RuntimeUpdatePayload } from "./runtimeUpdate.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "one-runtime-release-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicRaw = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const publicKey = path.join(directory, "public.txt"), privateKey = path.join(directory, "fixture-private.pem");
  fs.writeFileSync(publicKey, publicRaw.toString("base64url"));
  fs.writeFileSync(privateKey, privatePem, { mode: 0o600 });
  const baseDirectory = path.join(directory, "base"), windowsDirectory = path.join(directory, "windows"), output = path.join(directory, "output");
  fs.mkdirSync(baseDirectory); fs.mkdirSync(windowsDirectory);
  const macBytes = Buffer.from("existing signed Mac ZIP - preserve exact bytes");
  const windowsBytes = Buffer.alloc(512);
  windowsBytes.writeUInt16LE(0x5a4d, 0); windowsBytes.writeUInt32LE(0x80, 0x3c);
  windowsBytes.writeUInt32LE(0x00004550, 0x80); windowsBytes.writeUInt16LE(0x8664, 0x84);
  windowsBytes.writeUInt16LE(0x0022, 0x96); windowsBytes.writeUInt16LE(0x020b, 0x98);
  const windowsExe = path.join(windowsDirectory, "ONE.exe"), metadataPath = path.join(windowsDirectory, "runtime-update.json");
  fs.writeFileSync(windowsExe, windowsBytes);
  const metadata = { platform: "windows", version: "0.4.28", updateProtocol: 1, publicKeySha256: digest(publicRaw) };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const macName = "one-macos-0.4.27.zip", oldWindowsName = "one-windows-0.4.27.exe";
  const macPath = path.join(baseDirectory, macName), baseManifest = path.join(baseDirectory, "stable.json");
  fs.writeFileSync(macPath, macBytes);
  const payload: RuntimeUpdatePayload = {
    schemaVersion: 1, channel: "stable", releasedAt: "2026-10-29T00:00:00.000Z", artifacts: [
      { platform: "macos", architecture: "universal", version: "0.4.27", url: `https://example.com/runtime-updates/${macName}`, sha256: digest(macBytes), size: macBytes.length },
      { platform: "windows", architecture: "amd64", version: "0.4.27", url: `https://example.com/runtime-updates/${oldWindowsName}`, sha256: digest(Buffer.from("old Windows")), size: 11 }
    ]
  };
  const sign = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { payload: bytes.toString("base64url"), signature: crypto.sign(null, bytes, pair.privateKey).toString("base64url") };
  };
  const writeBase = (value: unknown = payload) => fs.writeFileSync(baseManifest, JSON.stringify(sign(value)));
  writeBase();
  const run = (extra: string[] = []) => spawnSync(process.execPath, [path.join(root, "scripts/publish-runtime-update.mjs"),
    "--windows-only", "--base-manifest", baseManifest, "--public-key", publicKey, "--private-key", privateKey,
    "--windows-exe", windowsExe, "--output", output, "--version", "0.4.28", "--origin", "https://example.com", ...extra
  ], { encoding: "utf8" });
  return { directory, output, publicKey, publicRaw, privateKey, privatePem, payload, metadata, metadataPath, baseManifest, macPath, macBytes, windowsBytes, windowsExe, writeBase, sign, run };
}

test("Windows-only CLI preserves the signed Mac entry and bytes and passes the production verifier", t => {
  const f = fixture(t), baseBefore = fs.readFileSync(f.baseManifest);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(fs.readFileSync(path.join(f.output, "stable.json"), "utf8"));
  const payload = verifyRuntimeUpdateEnvelope(envelope, f.publicRaw.toString("base64url"));
  assert.equal(payload.artifacts.length, 2);
  assert.deepEqual(payload.artifacts[0], f.payload.artifacts[0]);
  assert.deepEqual(fs.readFileSync(path.join(f.output, "one-macos-0.4.27.zip")), f.macBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.output, "one-windows-0.4.28.exe")), f.windowsBytes);
  assert.deepEqual(fs.readFileSync(f.baseManifest), baseBefore);
  assert.equal(selectRuntimeUpdate(payload, { platform: "macos", architecture: "arm64", version: "0.4.27", updateProtocol: 1 })?.version, "0.4.27");
  assert.equal(selectRuntimeUpdate(payload, { platform: "windows", architecture: "amd64", version: "0.4.27", updateProtocol: 1 })?.version, "0.4.28");
  const verify = spawnSync(process.execPath, [path.join(root, "scripts/verify-runtime-update.mjs"), "--manifest", path.join(f.output, "stable.json"), "--public-key", f.publicKey], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ["one-macos-0.4.27.zip", "one-windows-0.4.28.exe", "stable.json"]);
  assert.ok(!(result.stdout + result.stderr + JSON.stringify(envelope)).includes(f.privatePem));
});

test("Windows-only CLI compares numeric versions rather than lexical order", t => {
  const f = fixture(t);
  f.writeBase({ ...f.payload, artifacts: [f.payload.artifacts[0], {
    ...f.payload.artifacts[1], version: "0.4.9", url: "https://example.com/runtime-updates/one-windows-0.4.9.exe"
  }] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test("Windows-only CLI fails closed for an untrusted or tampered base signature", async t => {
  for (const variant of ["tampered", "foreign-key"] as const) await t.test(variant, sub => {
    const f = fixture(sub);
    if (variant === "tampered") {
      const envelope = f.sign(f.payload);
      envelope.payload = Buffer.from(JSON.stringify({ ...f.payload, channel: "preview" })).toString("base64url");
      fs.writeFileSync(f.baseManifest, JSON.stringify(envelope));
    } else {
      const foreign = crypto.generateKeyPairSync("ed25519");
      fs.writeFileSync(f.publicKey, (foreign.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url"));
    }
    const result = f.run();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /基清单签名无效/);
    assert.equal(fs.existsSync(f.output), false);
    assert.ok(!(result.stdout + result.stderr).includes(f.privatePem));
  });
});

test("Windows-only CLI rejects signed malformed, duplicate, insecure and non-increasing catalogs", async t => {
  const cases: [string, (payload: RuntimeUpdatePayload) => unknown][] = [
    ["schema", p => ({ ...p, schemaVersion: 2 })], ["channel", p => ({ ...p, channel: "preview" })],
    ["duplicate", p => ({ ...p, artifacts: [p.artifacts[0], p.artifacts[0]] })],
    ["missing-platform", p => ({ ...p, artifacts: [p.artifacts[0]] })],
    ["http", p => ({ ...p, artifacts: [{ ...p.artifacts[0], url: p.artifacts[0].url.replace("https:", "http:") }, p.artifacts[1]] })],
    ["credentials", p => ({ ...p, artifacts: [{ ...p.artifacts[0], url: p.artifacts[0].url.replace("example.com", "user:pass@example.com") }, p.artifacts[1]] })],
    ["equal-version", p => ({ ...p, artifacts: [p.artifacts[0], { ...p.artifacts[1], version: "0.4.28", url: "https://example.com/runtime-updates/one-windows-0.4.28.exe" }] })],
    ["lower-version", p => ({ ...p, artifacts: [p.artifacts[0], { ...p.artifacts[1], version: "0.4.29", url: "https://example.com/runtime-updates/one-windows-0.4.29.exe" }] })]
  ];
  for (const [name, change] of cases) await t.test(name, sub => {
    const f = fixture(sub); f.writeBase(change(f.payload));
    assert.notEqual(f.run().status, 0); assert.equal(fs.existsSync(f.output), false);
  });
});

test("Windows-only CLI verifies Mac integrity, Windows build identity and signing fingerprint before writing", async t => {
  for (const variant of ["mac-hash", "windows-metadata", "windows-version", "not-pe", "wrong-signing-key", "malformed-private-key"] as const) await t.test(variant, sub => {
    const f = fixture(sub);
    if (variant === "mac-hash") fs.writeFileSync(f.macPath, Buffer.alloc(f.macBytes.length));
    if (variant === "windows-metadata") fs.writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, publicKeySha256: "a".repeat(64) }));
    if (variant === "windows-version") fs.writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, version: "0.4.27" }));
    if (variant === "not-pe") fs.writeFileSync(f.windowsExe, Buffer.from("not a Windows executable"));
    if (variant === "wrong-signing-key") fs.writeFileSync(f.privateKey, crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
    if (variant === "malformed-private-key") fs.writeFileSync(f.privateKey, "PRIVATE-FIXTURE-MUST-NOT-APPEAR-IN-OUTPUT");
    const result = f.run();
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(f.output), false);
    assert.ok(!(result.stdout + result.stderr).includes(f.privatePem));
    assert.ok(!(result.stdout + result.stderr).includes("PRIVATE-FIXTURE-MUST-NOT-APPEAR-IN-OUTPUT"));
  });
});

test("Windows-only CLI preserves existing output and requires an explicit mode", t => {
  const f = fixture(t);
  fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, "keep.txt"), "preserve");
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.output, "keep.txt"), "utf8"), "preserve");
  const legacy = spawnSync(process.execPath, [path.join(root, "scripts/publish-runtime-update.mjs"), "--private-key", f.privateKey], { encoding: "utf8" });
  assert.notEqual(legacy.status, 0); assert.match(legacy.stderr, /--mac-app 不能为空/);
  assert.notEqual(f.run(["--mac-app", "unused.app"]).status, 0);
});
