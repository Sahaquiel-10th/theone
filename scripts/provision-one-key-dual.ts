import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionOrigin = "https://theone.aiarrival.cn";
const macAppName = "ONE for Mac.app";
const windowsAppName = "ONE for Windows.exe";
const credentialDirectoryName = ".one";
const knownSystemEntries = new Set([
  ".DS_Store",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  "$RECYCLE.BIN",
  "System Volume Information"
]);
const knownOneEntries = new Set([
  credentialDirectoryName,
  macAppName,
  windowsAppName,
  "ONE.app",
  "ONE.exe"
]);

export type OneKeyCredential = {
  version: 1;
  deviceId: string;
  publicKeyRaw: string;
  privateKeyRaw: string;
  serverBaseUrl: string;
  [key: string]: unknown;
};

export function readCredential(raw: string, expectedOrigin = productionOrigin): OneKeyCredential {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("凭证不是有效的 JSON 文件"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("凭证格式无效");
  const credential = parsed as Record<string, unknown>;
  if (credential.version !== 1) throw new Error("凭证版本不是 ONE Key V1");
  for (const field of ["deviceId", "publicKeyRaw", "privateKeyRaw", "serverBaseUrl"] as const) {
    const value = credential[field];
    if (typeof value !== "string" || !value.trim()) throw new Error(`凭证缺少字段：${field}`);
  }
  let server: URL;
  try { server = new URL(String(credential.serverBaseUrl)); }
  catch { throw new Error("凭证服务地址无效"); }
  if (server.origin !== expectedOrigin || !["", "/"].includes(server.pathname) || server.search || server.hash || server.username || server.password) {
    throw new Error(`凭证不是生产环境 ${expectedOrigin}`);
  }
  return credential as OneKeyCredential;
}

export function unexpectedFactoryEntries(entries: string[]) {
  return entries.filter((entry) => !knownSystemEntries.has(entry));
}

export function containsExistingOnePayload(entries: string[]) {
  return entries.some((entry) => knownOneEntries.has(entry) || entry.startsWith(".one-backup-") || entry.startsWith(".one-windows-backup-"));
}

export function validVolumePath(volumePath: string) {
  const resolved = path.resolve(volumePath);
  return path.dirname(resolved) === "/Volumes" && path.basename(resolved) !== "Macintosh HD";
}

export function sha256(target: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function argumentValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function hasArgument(args: string[], name: string) {
  return args.includes(name);
}

function assertKnownArguments(args: string[]) {
  const flags = new Set(["--list-volumes", "--dry-run"]);
  const valued = new Set(["--credential", "--volume", "--go-bin", "--codex-bin", "--expected-origin"]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (flags.has(argument)) continue;
    if (valued.has(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${argument} 缺少参数`);
      index++;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
}

function listVolumes() {
  return fs.readdirSync("/Volumes", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "Macintosh HD")
    .map((entry) => `/Volumes/${entry.name}`);
}

function assertExternalVolume(volumePath: string) {
  if (!validVolumePath(volumePath) || !fs.existsSync(volumePath) || !fs.statSync(volumePath).isDirectory()) {
    throw new Error("--volume 必须指向 /Volumes 下一个明确存在的 U 盘卷");
  }
  const plist = execFileSync("/usr/sbin/diskutil", ["info", "-plist", volumePath]);
  const internal = execFileSync("/usr/bin/plutil", ["-extract", "Internal", "raw", "-o", "-", "-"], { input: plist, encoding: "utf8" }).trim();
  if (internal !== "false") throw new Error("目标不是 macOS 识别的外置磁盘，已停止灌装");
}

function directorySize(target: string): number {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + directorySize(path.join(target, name)), 0);
}

function writeInstructions(target: string) {
  fs.writeFileSync(target, [
    `macOS：双击 ${macAppName}`,
    `Windows：双击 ${windowsAppName}`,
    "",
    "U 盘插着即可使用；拔出后新的请求会停止。",
    "重新插入或电脑休眠唤醒后会自动恢复。",
    "电脑重启后请再双击一次。",
    "U 盘遗失后请立即联系 ONE 管理员挂失。",
    ""
  ].join("\r\n"));
}

function run(command: string, args: string[], options: Parameters<typeof execFileSync>[2] = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

async function provision(args = process.argv.slice(2)) {
  assertKnownArguments(args);
  if (hasArgument(args, "--list-volumes")) {
    const volumes = listVolumes();
    console.log(volumes.length ? volumes.join("\n") : "没有发现外置卷");
    return;
  }

  const credentialArgument = argumentValue(args, "--credential");
  const volumeArgument = argumentValue(args, "--volume");
  const expectedOrigin = argumentValue(args, "--expected-origin") || productionOrigin;
  if (!credentialArgument || (!volumeArgument && !hasArgument(args, "--dry-run"))) return usage();

  const credentialPath = path.resolve(credentialArgument);
  if (!fs.existsSync(credentialPath) || !fs.statSync(credentialPath).isFile()) throw new Error(`凭证文件不存在：${credentialPath}`);
  const credentialRaw = fs.readFileSync(credentialPath, "utf8");
  const credential = readCredential(credentialRaw, expectedOrigin);

  if (hasArgument(args, "--dry-run")) {
    console.log(`凭证校验通过\n设备 ID：${credential.deviceId}\n服务：${credential.serverBaseUrl}`);
    return;
  }

  const volumePath = path.resolve(volumeArgument);
  assertExternalVolume(volumePath);
  const entries = fs.readdirSync(volumePath);
  if (containsExistingOnePayload(entries)) throw new Error("这只 U 盘已经灌装过 ONE；当前命令只接受空白新盘");
  const unexpected = unexpectedFactoryEntries(entries);
  if (unexpected.length) throw new Error(`U 盘不是空白新盘，请先核对或格式化：${unexpected.join("、")}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "one-key-dual-build-"));
  const macOutput = path.join(temporaryRoot, "mac");
  const windowsOutput = path.join(temporaryRoot, "windows");
  const staging = path.join(volumePath, `.one-provisioning-${crypto.randomBytes(6).toString("hex")}`);
  const promotedPaths: string[] = [];
  let completed = false;

  try {
    const macBuildArgs = [path.join(projectRoot, "scripts/build-macos-one-key.mjs"), "--output", macOutput];
    const codexBinary = argumentValue(args, "--codex-bin");
    if (codexBinary) macBuildArgs.push("--codex-bin", path.resolve(codexBinary));
    run(process.execPath, macBuildArgs);

    const windowsBuildArgs = [path.join(projectRoot, "scripts/build-windows-one-key.mjs"), "--output", windowsOutput];
    const goBinary = argumentValue(args, "--go-bin");
    if (goBinary) windowsBuildArgs.push("--go-bin", path.resolve(goBinary));
    run(process.execPath, windowsBuildArgs);

    const builtMac = path.join(macOutput, "ONE.app");
    const builtWindows = path.join(windowsOutput, "ONE.exe");
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", builtMac]);
    const architectures = execFileSync("/usr/bin/lipo", ["-archs", path.join(builtMac, "Contents/MacOS/ONE")], { encoding: "utf8" }).trim().split(/\s+/);
    if (!architectures.includes("arm64") || !architectures.includes("x86_64")) throw new Error("Mac 启动器不是 arm64 + x86_64 通用版本");
    const fileDescription = execFileSync("/usr/bin/file", [builtWindows], { encoding: "utf8" });
    if (!/PE32\+ executable.*x86-64/i.test(fileDescription)) throw new Error("Windows 启动器不是 x64 PE32+ 程序");

    const requiredBytes = directorySize(builtMac) + fs.statSync(builtWindows).size + Buffer.byteLength(credentialRaw) + 16 * 1024 * 1024;
    const volumeStats = fs.statfsSync(volumePath);
    const availableBytes = Number(volumeStats.bavail) * Number(volumeStats.bsize);
    if (availableBytes < requiredBytes) throw new Error(`U 盘空间不足，至少还需要 ${Math.ceil(requiredBytes / 1024 / 1024)} MB`);

    fs.mkdirSync(staging, { mode: 0o700 });
    fs.cpSync(builtMac, path.join(staging, macAppName), { recursive: true, errorOnExist: true });
    fs.copyFileSync(builtWindows, path.join(staging, windowsAppName));
    fs.mkdirSync(path.join(staging, credentialDirectoryName), { mode: 0o700 });
    fs.writeFileSync(path.join(staging, credentialDirectoryName, "credential.json"), credentialRaw, { mode: 0o600 });
    writeInstructions(path.join(staging, credentialDirectoryName, "使用说明.txt"));

    const stagedMac = path.join(staging, macAppName);
    const stagedWindows = path.join(staging, windowsAppName);
    run("/usr/sbin/dot_clean", ["-m", stagedMac]);
    run("/usr/bin/xattr", ["-cr", stagedMac]);
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedMac]);
    run("/usr/sbin/dot_clean", ["-m", stagedMac]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", stagedMac]);
    if (sha256(stagedWindows) !== sha256(builtWindows)) throw new Error("Windows 启动器写入校验失败");
    const writtenCredential = readCredential(fs.readFileSync(path.join(staging, credentialDirectoryName, "credential.json"), "utf8"), expectedOrigin);
    if (writtenCredential.deviceId !== credential.deviceId || writtenCredential.privateKeyRaw !== credential.privateKeyRaw || writtenCredential.publicKeyRaw !== credential.publicKeyRaw) {
      throw new Error("写入后的 ONE Key 凭证不一致");
    }

    const finalMac = path.join(volumePath, macAppName);
    const finalWindows = path.join(volumePath, windowsAppName);
    const finalCredentialDirectory = path.join(volumePath, credentialDirectoryName);
    fs.renameSync(stagedMac, finalMac);
    promotedPaths.push(finalMac);
    fs.renameSync(stagedWindows, finalWindows);
    promotedPaths.push(finalWindows);
    fs.renameSync(path.join(staging, credentialDirectoryName), finalCredentialDirectory);
    promotedPaths.push(finalCredentialDirectory);
    fs.rmdirSync(staging);
    run("/usr/bin/SetFile", ["-a", "V", finalCredentialDirectory]);
    run("/usr/sbin/dot_clean", ["-m", volumePath]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", finalMac]);
    if (sha256(finalWindows) !== sha256(builtWindows)) throw new Error("Windows 启动器最终校验失败");
    const finalCredential = readCredential(fs.readFileSync(path.join(finalCredentialDirectory, "credential.json"), "utf8"), expectedOrigin);
    if (finalCredential.deviceId !== credential.deviceId || finalCredential.privateKeyRaw !== credential.privateKeyRaw) throw new Error("ONE Key 最终凭证校验失败");
    execFileSync("/bin/sync", []);
    completed = true;

    console.log([
      "",
      "ONE 双系统灌装完成",
      `U 盘：${volumePath}`,
      `设备 ID：${credential.deviceId}`,
      `服务：${credential.serverBaseUrl}`,
      "Mac：0.2.8 · arm64 + x86_64",
      `Windows：0.2.4 · x64 · SHA-256 ${sha256(finalWindows)}`,
      "请在访达中安全推出 U 盘。"
    ].join("\n"));
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (!completed) {
      // The volume was verified as blank before this run, so these exact paths
      // can only be payloads promoted by this invocation. Never leave a partial
      // credential or a single-platform launcher behind after a failed check.
      for (const target of promotedPaths.reverse()) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function usage(): never {
  console.log(`用法：
  npm run provision:one-key -- --list-volumes
  npm run provision:one-key -- --credential /路径/ONE-序列号.one-key.json --dry-run
  npm run provision:one-key -- --credential /路径/ONE-序列号.one-key.json --volume /Volumes/U盘名称

可选：
  --go-bin /完整路径/go
  --codex-bin /完整路径/codex

当前命令只灌装空白新盘，不覆盖旧 ONE Key，也不格式化 U 盘。`);
  process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  provision().catch((error) => {
    console.error(error instanceof Error ? `灌装失败：${error.message}` : "灌装失败");
    process.exitCode = 1;
  });
}
