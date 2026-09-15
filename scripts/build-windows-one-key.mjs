import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const outputRoot = path.resolve(root, value("--output") || "output/ONE-Key-Windows");
const goBinary = value("--go-bin") || "go";
const launcherRoot = path.join(root, "launcher/windows");
const executable = path.join(outputRoot, "ONE.exe");
const publicKeyPath = path.resolve(root, value("--update-public-key") || "config/runtime-update-public-key.txt");
const versionPath = path.resolve(root, value("--runtime-version") || "config/runtime-version.txt");
if (!fs.existsSync(publicKeyPath)) throw new Error(`更新发布公钥不存在：${publicKeyPath}`);
if (!fs.existsSync(versionPath)) throw new Error(`启动器版本文件不存在：${versionPath}`);
const updatePublicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
const runtimeVersion = fs.readFileSync(versionPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(updatePublicKey)) throw new Error("更新发布公钥格式无效");
if (!/^\d+(?:\.\d+){1,3}$/.test(runtimeVersion)) throw new Error("启动器版本格式无效");

for (const resource of ["ONE.ico", "ONE.exe.manifest", "rsrc_windows_amd64.syso"]) {
  if (!fs.existsSync(path.join(launcherRoot, resource))) throw new Error(`Windows 启动器资源不存在：${resource}`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

execFileSync(goBinary, ["mod", "download"], { cwd: launcherRoot, stdio: "inherit" });
execFileSync(goBinary, ["build", "-buildvcs=false", "-trimpath", "-ldflags", `-s -w -H=windowsgui -X main.version=${runtimeVersion} -X main.updatePublicKeyRaw=${updatePublicKey}`, "-o", executable, "."], {
  cwd: launcherRoot,
  env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  stdio: "inherit"
});
fs.writeFileSync(path.join(outputRoot, "runtime-update.json"), `${JSON.stringify({
  platform: "windows",
  version: runtimeVersion,
  updateProtocol: 1,
  publicKeySha256: crypto.createHash("sha256").update(Buffer.from(updatePublicKey, "base64url")).digest("hex")
}, null, 2)}\n`);
console.log(`Windows ONE Key 已生成：${executable}`);
