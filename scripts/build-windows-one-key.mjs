import { execFileSync } from "node:child_process";
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

for (const resource of ["ONE.ico", "ONE.exe.manifest", "rsrc_windows_amd64.syso"]) {
  if (!fs.existsSync(path.join(launcherRoot, resource))) throw new Error(`Windows 启动器资源不存在：${resource}`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

execFileSync(goBinary, ["mod", "download"], { cwd: launcherRoot, stdio: "inherit" });
execFileSync(goBinary, ["build", "-trimpath", "-ldflags", "-s -w -H=windowsgui", "-o", executable, "."], {
  cwd: launcherRoot,
  env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  stdio: "inherit"
});
console.log(`Windows ONE Key 已生成：${executable}`);
