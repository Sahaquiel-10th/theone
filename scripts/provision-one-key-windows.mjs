import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const has = (name) => args.includes(name);
const volumeArgument = value("--volume");
if (!volumeArgument) usage();

const volumePath = path.resolve(volumeArgument);
if (!fs.existsSync(volumePath) || !fs.statSync(volumePath).isDirectory()) throw new Error(`U 盘卷不存在：${volumePath}`);
if (path.dirname(volumePath) !== "/Volumes" || path.basename(volumePath) === "Macintosh HD") throw new Error("--volume 必须是 /Volumes 下的一个明确 U 盘卷");
const credentialPath = path.join(volumePath, ".one/credential.json");
if (!fs.existsSync(credentialPath)) throw new Error(`U 盘中没有 ONE Key 凭证：${credentialPath}`);

const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
for (const field of ["deviceId", "privateKeyRaw", "serverBaseUrl"]) {
  if (typeof credential[field] !== "string" || !credential[field].trim()) throw new Error(`凭证缺少字段：${field}`);
}

const target = path.join(volumePath, "ONE.exe");
if (fs.existsSync(target) && !has("--replace")) throw new Error("U 盘已经存在 ONE.exe；确认替换时请增加 --replace");
if (fs.existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const backupRoot = path.join(volumePath, `.one-windows-backup-${stamp}`);
  fs.mkdirSync(backupRoot);
  fs.renameSync(target, path.join(backupRoot, "ONE.exe"));
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "one-key-windows-"));
try {
  const buildArgs = [path.join(projectRoot, "scripts/build-windows-one-key.mjs"), "--output", temporaryRoot];
  if (value("--go-bin")) buildArgs.push("--go-bin", path.resolve(value("--go-bin")));
  execFileSync(process.execPath, buildArgs, { stdio: "inherit" });
  fs.copyFileSync(path.join(temporaryRoot, "ONE.exe"), target);
  fs.writeFileSync(path.join(volumePath, "使用 ONE.txt"), "macOS：双击 ONE.app\r\nWindows：双击 ONE.exe\r\n\r\n启动后会自动打开浏览器并登录 ONE。U 盘持续插着时，休眠、临时断网或服务重启会自动恢复；拔出后立即停用，重新插入需要再次双击。\r\n普通 U 盘凭证可以被复制；遗失后请管理员立即在 ONE 超管后台挂失。\r\n");
  console.log(`\nWindows 灌装完成\nU 盘：${volumePath}\n设备 ID：${credential.deviceId}\n服务：${credential.serverBaseUrl}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function usage() {
  console.log("用法：npm run provision:one-key:windows -- --volume /Volumes/U盘名称 [--replace] [--go-bin /路径/go]");
  process.exit(1);
}
