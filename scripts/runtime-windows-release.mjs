import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const versionPattern = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const validVersion = version => typeof version === "string" && version.length <= 40 && versionPattern.test(version);
const fail = message => { throw new Error(message); };

function newerVersion(next, previous) {
  const a = next.split(".").map(BigInt), b = previous.split(".").map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0n, right = b[index] ?? 0n;
    if (left !== right) return left > right;
  }
  return false;
}

function artifactName(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || !["macos", "windows"].includes(artifact.platform)
    || artifact.architecture !== (artifact.platform === "macos" ? "universal" : "amd64")
    || !validVersion(artifact.version) || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
    || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 512 * 1024 * 1024
    || typeof artifact.url !== "string" || artifact.url.length > 2048) fail("基清单制品内容无效");
  let url;
  try { url = new URL(artifact.url); } catch { fail("基清单制品地址无效"); }
  const name = `one-${artifact.platform}-${artifact.version}.${artifact.platform === "macos" ? "zip" : "exe"}`;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== `/runtime-updates/${name}`) fail("基清单制品地址无效");
  return name;
}

function verifyBaseManifest(file, publicRaw) {
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(envelope.payload) || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)) fail("基清单签名格式无效");
  const payloadBytes = Buffer.from(envelope.payload, "base64url");
  const signature = Buffer.from(envelope.signature, "base64url");
  if (!payloadBytes.length || payloadBytes.length > 128 * 1024 || signature.length !== 64) fail("基清单签名格式无效");
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicRaw]),
    format: "der", type: "spki"
  });
  if (!crypto.verify(null, payloadBytes, key, signature)) fail("基清单签名无效");
  const payload = JSON.parse(payloadBytes.toString("utf8"));
  if (!payload || payload.schemaVersion !== 1 || payload.channel !== "stable"
    || typeof payload.releasedAt !== "string" || !Number.isFinite(Date.parse(payload.releasedAt))
    || !Array.isArray(payload.artifacts) || payload.artifacts.length !== 2) fail("基清单内容无效");
  for (const artifact of payload.artifacts) artifactName(artifact);
  if (new Set(payload.artifacts.map(artifact => artifact.platform)).size !== 2) fail("基清单平台必须各有且仅有一个制品");
  return payload;
}

function readArtifact(file, expected) {
  if (!fs.lstatSync(file).isFile()) fail("发布制品必须是普通文件");
  const size = fs.statSync(file).size;
  if (size <= 0 || size > 512 * 1024 * 1024 || (expected && size !== expected.size)) fail("制品大小不符");
  const bytes = fs.readFileSync(file);
  if (expected && hash(bytes) !== expected.sha256) fail(`保留的 ${expected.platform === "macos" ? "Mac" : "Windows"} 制品摘要不符`);
  return bytes;
}

function verifyWindowsExecutable(bytes) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) fail("Windows 更新制品不是 x64 PE32+ 程序");
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 94 || bytes.readUInt32LE(offset) !== 0x00004550
    || bytes.readUInt16LE(offset + 4) !== 0x8664 || !(bytes.readUInt16LE(offset + 22) & 0x0002)
    || bytes.readUInt16LE(offset + 24) !== 0x020b) fail("Windows 更新制品不是 x64 PE32+ 程序");
}

function readMacArchive(app) {
  if (!["ONE.app", "ONE for Mac.app"].includes(path.basename(app))) fail("Mac 更新应用必须命名为 ONE.app 或 ONE for Mac.app");
  if (!fs.lstatSync(app).isDirectory()) fail("Mac 更新制品必须是应用目录");
  const inspect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith("._")) fail("Mac 制品包含 AppleDouble 元数据，拒绝发布");
      if (entry.isDirectory()) inspect(path.join(directory, entry.name));
    }
  };
  inspect(app);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  const commandLineLipo = "/Library/Developer/CommandLineTools/usr/bin/lipo";
  const lipo = fs.existsSync(commandLineLipo) ? commandLineLipo : "/usr/bin/lipo";
  const architectures = execFileSync(lipo, ["-archs", path.join(app, "Contents/MacOS/ONE")], { encoding: "utf8" }).trim().split(/\s+/);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) fail("Mac 更新制品不是 Universal 版本");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "one-mac-runtime-release-"));
  try {
    const archive = path.join(staging, "runtime.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", app, archive], { stdio: "inherit" });
    return readArtifact(archive);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Only the requested platform is replaced. The other trusted artifact object
// and its verified file bytes stay intact in the two-artifact envelope.
function publishSinglePlatformUpdate(options, platform) {
  const label = platform === "macos" ? "Mac" : "Windows";
  if (!validVersion(options.version)) fail("--version 必须是纯数字版本，例如 0.4.28");
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") fail("--origin 必须是没有路径、账号或参数的 HTTPS 站点地址");
  if (fs.existsSync(options.output) && fs.readdirSync(options.output).length) fail("--output 必须是空目录或不存在");
  const publicText = fs.readFileSync(options.publicKey, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicText)) fail("发布公钥格式无效");
  const publicRaw = Buffer.from(publicText, "base64url");
  if (publicRaw.length !== 32 || publicRaw.toString("base64url") !== publicText) fail("发布公钥格式无效");
  const fingerprint = hash(publicRaw);
  const base = verifyBaseManifest(options.baseManifest, publicRaw);
  const previous = base.artifacts.find(artifact => artifact.platform === platform);
  const preserved = base.artifacts.find(artifact => artifact.platform !== platform);
  if (!newerVersion(options.version, previous.version)) fail(`${label} 发布版本必须严格高于基清单版本`);
  const source = platform === "macos" ? options.macApp : options.windowsExe;
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(source), "runtime-update.json"), "utf8"));
  if (metadata.platform !== platform || metadata.version !== options.version || metadata.updateProtocol !== 1
    || metadata.publicKeySha256 !== fingerprint) fail(`${label} 制品版本、更新协议或发布公钥指纹不一致`);
  const preservedName = artifactName(preserved);
  const preservedBytes = readArtifact(path.join(path.dirname(options.baseManifest), preservedName), preserved);
  const replacementBytes = platform === "macos" ? readMacArchive(source) : readArtifact(source);
  if (platform === "windows") verifyWindowsExecutable(replacementBytes);
  let privateKey;
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(options.privateKey)); }
  catch { fail("发布私钥无法读取或格式无效"); }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("发布私钥必须是 Ed25519");
  const signingPublic = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  if (hash(signingPublic) !== fingerprint) fail("发布私钥与可信公钥不匹配");
  const replacementName = `one-${platform}-${options.version}.${platform === "macos" ? "zip" : "exe"}`;
  const replacement = {
    platform, architecture: platform === "macos" ? "universal" : "amd64", version: options.version,
    url: new URL(`/runtime-updates/${replacementName}`, origin).toString(),
    sha256: hash(replacementBytes), size: replacementBytes.length
  };
  const payload = { schemaVersion: 1, channel: "stable", releasedAt: new Date().toISOString(), artifacts: base.artifacts.map(artifact => artifact.platform === platform ? replacement : artifact) };
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const envelope = { payload: payloadBytes.toString("base64url"), signature: crypto.sign(null, payloadBytes, privateKey).toString("base64url") };
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, preservedName), preservedBytes, { flag: "wx", mode: 0o644 });
  fs.writeFileSync(path.join(options.output, replacementName), replacementBytes, { flag: "wx", mode: 0o644 });
  fs.writeFileSync(path.join(options.output, "stable.json"), `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`已生成 ${label} ${options.version} 签名更新目录：${options.output}；保留 ${preserved.platform === "macos" ? "Mac" : "Windows"} ${preserved.version}`);
}

export function publishWindowsRuntimeUpdate(options) { publishSinglePlatformUpdate(options, "windows"); }
export function publishMacRuntimeUpdate(options) { publishSinglePlatformUpdate(options, "macos"); }
