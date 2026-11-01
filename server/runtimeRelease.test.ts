import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RuntimeUpdateCatalog, selectRuntimeUpdate, verifyRuntimeUpdateEnvelope, type RuntimeUpdatePayload } from "./runtimeUpdate.js";

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

function macFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const macDirectory = path.join(f.directory, "mac"), macApp = path.join(macDirectory, "ONE for Mac.app");
  const macBinary = path.join(macApp, "Contents", "MacOS", "ONE");
  fs.mkdirSync(path.dirname(macBinary), { recursive: true });
  fs.writeFileSync(macBinary, "synthetic native binary; external Mac checks are isolated in this fixture");
  const metadataPath = path.join(macDirectory, "runtime-update.json");
  const metadata = { platform: "macos", version: "0.4.30", updateProtocol: 1, publicKeySha256: digest(f.publicRaw) };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const retainedWindowsPath = path.join(path.dirname(f.baseManifest), "one-windows-0.4.29.exe");
  fs.writeFileSync(retainedWindowsPath, f.windowsBytes);
  const payload: RuntimeUpdatePayload = { ...f.payload, artifacts: [
    { ...f.payload.artifacts[0], version: "0.4.29", url: "https://example.com/runtime-updates/one-macos-0.4.29.zip" },
    { ...f.payload.artifacts[1], version: "0.4.29", url: "https://example.com/runtime-updates/one-windows-0.4.29.exe", sha256: digest(f.windowsBytes), size: f.windowsBytes.length }
  ] };
  f.writeBase(payload);
  const loaderPath = path.join(f.directory, "synthetic-mac-native-checks.mjs"), callsPath = path.join(f.directory, "native-calls.jsonl");
  const archiveBytes = Buffer.from("synthetic Mac ZIP - only the native tools are substituted");
  // Isolate macOS-only commands in this child. The real CLI, Ed25519 checks,
  // hashes, file operations and production verifier remain in use on CI.
  fs.writeFileSync(loaderPath, `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = (command, args) => {
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({command, args}) + '\\n');
  if (command.endsWith('/codesign')) {
    if (process.env.ONE_TEST_MAC_FAILURE === 'codesign') throw Error('synthetic codesign failure');
    return Buffer.alloc(0);
  }
  if (command.endsWith('/lipo')) return process.env.ONE_TEST_MAC_ARCHS || 'arm64 x86_64';
  if (command.endsWith('/ditto')) {
    if (process.env.ONE_TEST_MAC_FAILURE === 'ditto') throw Error('synthetic ditto failure');
    fs.writeFileSync(args.at(-1), Buffer.from(${JSON.stringify(archiveBytes.toString("base64"))}, 'base64'));
    return Buffer.alloc(0);
  }
  throw Error('unexpected native command: ' + command);
};
syncBuiltinESMExports();
`);
  const runMac = (extra: string[] = [], environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    "--import", loaderPath, path.join(root, "scripts/publish-runtime-update.mjs"), "--mac-only",
    "--base-manifest", f.baseManifest, "--public-key", f.publicKey, "--private-key", f.privateKey,
    "--mac-app", macApp, "--output", f.output, "--version", "0.4.30", "--origin", "https://example.com", ...extra
  ], { encoding: "utf8", env: { ...process.env, ...environment } });
  const calls = (): { command: string; args: string[] }[] => fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { ...f, payload, metadata, metadataPath, macApp, macBinary, retainedWindowsPath, archiveBytes, runMac, calls };
}

test("Mac-only CLI retains Windows 0.4.29 verbatim while releasing only Mac 0.4.30", t => {
  const f = macFixture(t), baseBefore = fs.readFileSync(f.baseManifest);
  const result = f.runMac();
  assert.equal(result.status, 0, result.stderr);
  const manifest = path.join(f.output, "stable.json");
  const envelope = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const payload = verifyRuntimeUpdateEnvelope(envelope, f.publicRaw.toString("base64url"));
  assert.deepEqual(payload.artifacts.find(a => a.platform === "windows"), f.payload.artifacts[1]);
  assert.deepEqual(fs.readFileSync(path.join(f.output, "one-windows-0.4.29.exe")), f.windowsBytes);
  assert.deepEqual(fs.readFileSync(f.retainedWindowsPath), f.windowsBytes);
  assert.deepEqual(fs.readFileSync(f.baseManifest), baseBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.output, "one-macos-0.4.30.zip")), f.archiveBytes);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ["one-macos-0.4.30.zip", "one-windows-0.4.29.exe", "stable.json"]);
  const catalog = new RuntimeUpdateCatalog(manifest, f.publicRaw.toString("base64url"));
  assert.equal(catalog.updateFor({ platform: "macos", architecture: "arm64", version: "0.4.29", updateProtocol: 1 })?.artifact.version, "0.4.30");
  assert.equal(catalog.updateFor({ platform: "windows", architecture: "amd64", version: "0.4.29", updateProtocol: 1 }), undefined);
  const commands = f.calls();
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0], { command: "/usr/bin/codesign", args: ["--verify", "--deep", "--strict", "--verbose=2", f.macApp] });
  assert.deepEqual(commands[1].args, ["-archs", f.macBinary]);
  assert.equal(path.basename(commands[1].command), "lipo");
  assert.equal(commands[2].command, "/usr/bin/ditto");
  assert.deepEqual(commands[2].args.slice(0, -1), ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", f.macApp]);
  assert.equal(fs.existsSync(commands[2].args.at(-1)!), false, "temporary package must be cleaned up");
  const verify = spawnSync(process.execPath, [path.join(root, "scripts/verify-runtime-update.mjs"), "--manifest", manifest, "--public-key", f.publicKey], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /VERIFIED_MACOS_VERSION=0\.4\.30/);
  assert.match(verify.stdout, /VERIFIED_WINDOWS_VERSION=0\.4\.29/);
  assert.ok(!(result.stdout + result.stderr + JSON.stringify(envelope)).includes(f.privatePem));
});

test("Mac-only CLI replaces the Mac entry regardless of order and compares its own numeric version", t => {
  const f = macFixture(t);
  const preservedWindows = { ...f.payload.artifacts[1], version: "0.4.99", url: "https://example.com/runtime-updates/one-windows-0.4.99.exe" };
  fs.copyFileSync(f.retainedWindowsPath, path.join(path.dirname(f.baseManifest), "one-windows-0.4.99.exe"));
  f.writeBase({ ...f.payload, artifacts: [preservedWindows, {
    ...f.payload.artifacts[0], version: "0.4.9", url: "https://example.com/runtime-updates/one-macos-0.4.9.zip"
  }] });
  const result = f.runMac();
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(fs.readFileSync(path.join(f.output, "stable.json"), "utf8"));
  const payload = verifyRuntimeUpdateEnvelope(envelope, f.publicRaw.toString("base64url"));
  assert.deepEqual(payload.artifacts[0], preservedWindows);
  assert.equal(payload.artifacts[1].platform, "macos");
  assert.equal(payload.artifacts[1].version, "0.4.30");
});

test("Mac-only CLI rejects untrusted bases and signing keys without emitting private material", async t => {
  for (const variant of ["tampered", "foreign-public-key", "wrong-private-key", "malformed-private-key"] as const) await t.test(variant, sub => {
    const f = macFixture(sub);
    if (variant === "tampered") {
      const envelope = f.sign(f.payload);
      envelope.payload = Buffer.from(JSON.stringify({ ...f.payload, channel: "preview" })).toString("base64url");
      fs.writeFileSync(f.baseManifest, JSON.stringify(envelope));
    }
    if (variant === "foreign-public-key") fs.writeFileSync(f.publicKey, (crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url"));
    if (variant === "wrong-private-key") fs.writeFileSync(f.privateKey, crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
    if (variant === "malformed-private-key") fs.writeFileSync(f.privateKey, "PRIVATE-FIXTURE-MUST-NOT-APPEAR-IN-OUTPUT");
    const result = f.runMac();
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(f.output), false);
    assert.ok(!(result.stdout + result.stderr).includes(f.privatePem));
    assert.ok(!(result.stdout + result.stderr).includes("PRIVATE-FIXTURE-MUST-NOT-APPEAR-IN-OUTPUT"));
  });
});

test("Mac-only CLI rejects equal, equivalent and lower Mac versions", async t => {
  for (const version of ["0.4.30", "0.4.30.0", "0.4.31"]) await t.test(version, sub => {
    const f = macFixture(sub);
    f.writeBase({ ...f.payload, artifacts: [{ ...f.payload.artifacts[0], version, url: `https://example.com/runtime-updates/one-macos-${version}.zip` }, f.payload.artifacts[1]] });
    const result = f.runMac();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Mac 发布版本必须严格高于基清单版本/);
    assert.equal(fs.existsSync(f.output), false); assert.deepEqual(f.calls(), []);
  });
});

test("Mac-only CLI refuses missing or modified Windows artifacts before native packaging", async t => {
  for (const variant of ["missing", "size", "hash"] as const) await t.test(variant, sub => {
    const f = macFixture(sub);
    if (variant === "missing") fs.unlinkSync(f.retainedWindowsPath);
    else fs.writeFileSync(f.retainedWindowsPath, Buffer.alloc(variant === "size" ? 2 : f.windowsBytes.length));
    assert.notEqual(f.runMac().status, 0); assert.equal(fs.existsSync(f.output), false); assert.deepEqual(f.calls(), []);
  });
});

test("Mac-only CLI checks build identity and all native packaging gates", async t => {
  for (const variant of ["platform", "version", "protocol", "fingerprint", "apple-double", "renamed-app", "codesign", "single-architecture", "ditto"] as const) await t.test(variant, sub => {
    const f = macFixture(sub), environment: Record<string, string> = {};
    if (variant === "platform") fs.writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, platform: "windows" }));
    if (variant === "version") fs.writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, version: "0.4.29" }));
    if (variant === "protocol") fs.writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, updateProtocol: 2 }));
    if (variant === "fingerprint") fs.writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, publicKeySha256: "a".repeat(64) }));
    if (variant === "apple-double") fs.writeFileSync(path.join(path.dirname(f.macBinary), "._ONE"), "metadata");
    if (variant === "renamed-app") {
      // Change the source path in the test loader invocation; the publisher
      // must reject names the actual Mac updater cannot locate after unzip.
      const renamed = path.join(path.dirname(f.macApp), "Other.app");
      fs.renameSync(f.macApp, renamed);
      const result = spawnSync(process.execPath, [path.join(root, "scripts/publish-runtime-update.mjs"), "--mac-only", "--base-manifest", f.baseManifest, "--public-key", f.publicKey, "--private-key", f.privateKey, "--mac-app", renamed, "--output", f.output, "--version", "0.4.30"], { encoding: "utf8" });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Mac 更新应用必须命名/); assert.equal(fs.existsSync(f.output), false);
      return;
    }
    if (variant === "codesign" || variant === "ditto") environment.ONE_TEST_MAC_FAILURE = variant;
    if (variant === "single-architecture") environment.ONE_TEST_MAC_ARCHS = "arm64";
    const result = f.runMac([], environment);
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(f.output), false);
    assert.ok(!(result.stdout + result.stderr).includes(f.privatePem));
  });
});

test("Mac-only CLI rejects mode conflicts and leaves existing output intact", t => {
  const f = macFixture(t);
  const conflict = f.runMac(["--windows-only"]);
  assert.notEqual(conflict.status, 0); assert.match(conflict.stderr, /不能同时使用/);
  const extraneous = f.runMac(["--windows-exe", f.windowsExe]);
  assert.notEqual(extraneous.status, 0); assert.match(extraneous.stderr, /--mac-only 不接受 --windows-exe/);
  assert.deepEqual(f.calls(), []);
  fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, "keep.txt"), "preserve");
  assert.notEqual(f.runMac().status, 0);
  assert.equal(fs.readFileSync(path.join(f.output, "keep.txt"), "utf8"), "preserve");
});
