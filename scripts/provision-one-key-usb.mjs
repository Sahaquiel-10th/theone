import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const has = (name) => args.includes(name);

if (has("--list-volumes")) {
  const volumes = fs.readdirSync("/Volumes", { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `/Volumes/${entry.name}`);
  console.log(volumes.length ? volumes.join("\n") : "没有发现已挂载的外置卷");
  process.exit(0);
}

const credentialArgument = value("--credential");
const volumeArgument = value("--volume");
if (!credentialArgument || (!volumeArgument && !has("--dry-run"))) usage();

const credentialPath = path.resolve(credentialArgument);
const volumePath = volumeArgument ? path.resolve(volumeArgument) : "";
if (!fs.existsSync(credentialPath) || !fs.statSync(credentialPath).isFile()) throw new Error(`凭证文件不存在：${credentialPath}`);
if (!has("--dry-run") && (!fs.existsSync(volumePath) || !fs.statSync(volumePath).isDirectory())) throw new Error(`U 盘卷不存在：${volumePath}`);
if (!has("--dry-run") && (path.dirname(volumePath) !== "/Volumes" || path.basename(volumePath) === "Macintosh HD")) throw new Error("--volume 必须是 /Volumes 下的一个明确 U 盘卷，不能是系统盘或上级目录");

const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
for (const field of ["deviceId", "publicKeyRaw", "privateKeyRaw", "serverBaseUrl"]) {
  if (typeof credential[field] !== "string" || !credential[field].trim()) throw new Error(`凭证缺少字段：${field}`);
}
const serverUrl = new URL(credential.serverBaseUrl);
if (serverUrl.protocol !== "https:" && serverUrl.hostname !== "localhost") throw new Error("正式 ONE Key 的 serverBaseUrl 必须使用 HTTPS");
if (has("--dry-run")) {
  console.log(`凭证校验通过\n设备 ID：${credential.deviceId}\n服务：${credential.serverBaseUrl}`);
  process.exit(0);
}

const appTarget = path.join(volumePath, "ONE.app");
const hiddenTarget = path.join(volumePath, ".one");
if ((fs.existsSync(appTarget) || fs.existsSync(hiddenTarget)) && !has("--replace")) {
  throw new Error("该 U 盘已经存在 ONE.app 或 .one；确认替换时请增加 --replace，脚本会先备份旧版本");
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "one-key-usb-"));
const buildOutput = path.join(temporaryRoot, "payload");
try {
  const runtimeArgs = value("--codex-bin") ? ["--codex-bin", path.resolve(value("--codex-bin"))] : [];
  execFileSync(process.execPath, [path.join(projectRoot, "scripts/build-macos-one-key.mjs"), "--credential", credentialPath, "--output", buildOutput, ...runtimeArgs], { stdio: "inherit" });
  if (fs.existsSync(appTarget) || fs.existsSync(hiddenTarget)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    const backupRoot = path.join(volumePath, `.one-backup-${stamp}`);
    fs.mkdirSync(backupRoot, { recursive: false });
    if (fs.existsSync(appTarget)) fs.renameSync(appTarget, path.join(backupRoot, "ONE.app"));
    if (fs.existsSync(hiddenTarget)) fs.renameSync(hiddenTarget, path.join(backupRoot, ".one"));
    console.log(`旧版已备份：${backupRoot}`);
  }
  fs.cpSync(path.join(buildOutput, "ONE.app"), appTarget, { recursive: true, errorOnExist: true });
  fs.cpSync(path.join(buildOutput, ".one"), hiddenTarget, { recursive: true, errorOnExist: true });
  fs.copyFileSync(path.join(buildOutput, "使用 ONE.txt"), path.join(volumePath, "使用 ONE.txt"));
  // FAT volumes represent macOS metadata as AppleDouble `._*` files. Clean only
  // the freshly copied ONE payload so xattr/codesign do not fail on those files.
  execFileSync("/usr/sbin/dot_clean", ["-m", appTarget], { stdio: "inherit" });
  execFileSync("/usr/sbin/dot_clean", ["-m", hiddenTarget], { stdio: "inherit" });
  execFileSync("/usr/bin/xattr", ["-cr", appTarget], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appTarget], { stdio: "inherit" });
  execFileSync("/usr/sbin/dot_clean", ["-m", appTarget], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appTarget], { stdio: "inherit" });
  console.log(`\n灌装完成\nU 盘：${volumePath}\n设备 ID：${credential.deviceId}\n服务：${credential.serverBaseUrl}\n\n现在可弹出 U 盘，重新插入后双击 ONE.app 验证。`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function usage() {
  console.log(`用法：
  npm run provision:one-key:mac -- --list-volumes
  npm run provision:one-key:mac -- --credential /路径/ONE-xxx.one-key.json --dry-run
  npm run provision:one-key:mac -- --credential /路径/ONE-xxx.one-key.json --volume /Volumes/U盘名称
  npm run provision:one-key:mac -- --credential /路径/ONE-xxx.one-key.json --volume /Volumes/U盘名称 --replace

脚本不会格式化 U 盘，也不会删除与 ONE 无关的文件。`);
  process.exit(1);
}
