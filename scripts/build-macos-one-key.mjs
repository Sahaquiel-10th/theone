import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const outputRoot = path.resolve(root, value("--output") || "output/ONE-Key-macOS");
const credentialPath = value("--credential") ? path.resolve(value("--credential")) : "";
const codexBinary = value("--codex-bin") ? path.resolve(value("--codex-bin")) : "";
const credentialData = credentialPath
  ? fs.existsSync(credentialPath)
    ? fs.readFileSync(credentialPath)
    : (() => { throw new Error(`凭证文件不存在：${credentialPath}`); })()
  : null;
const app = path.join(outputRoot, "ONE.app");
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(resources, { recursive: true });
fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>ONE</string>
<key>CFBundleExecutable</key><string>ONE</string>
<key>CFBundleIdentifier</key><string>one.theone.key</string>
<key>CFBundleName</key><string>ONE</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.3</string>
<key>CFBundleVersion</key><string>5</string>
<key>CFBundleIconFile</key><string>ONE.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);

execFileSync("/usr/bin/swiftc", ["-parse-as-library", "-O", path.join(root, "launcher/macos/ONEKeyLauncher.swift"), "-o", path.join(macos, "ONE")], { stdio: "inherit" });
if (codexBinary) {
  if (!fs.existsSync(codexBinary)) throw new Error(`Codex Runtime 不存在：${codexBinary}`);
  fs.copyFileSync(codexBinary, path.join(resources, "codex"));
  fs.chmodSync(path.join(resources, "codex"), 0o755);
}

const iconset = path.join(outputRoot, "ONE.iconset");
fs.mkdirSync(iconset, { recursive: true });
const iconSourceVector = path.join(root, "public/one-app-icon.svg");
const renderedIconRoot = path.join(outputRoot, ".icon-source");
fs.mkdirSync(renderedIconRoot, { recursive: true });
execFileSync("/usr/bin/qlmanage", ["-t", "-s", "1024", "-o", renderedIconRoot, iconSourceVector], { stdio: "ignore" });
const iconSource = path.join(renderedIconRoot, `${path.basename(iconSourceVector)}.png`);
if (!fs.existsSync(iconSource)) throw new Error("无法从 ONE 矢量标志生成 macOS App 图标");
for (const [name, size] of [["icon_16x16.png",16],["icon_16x16@2x.png",32],["icon_32x32.png",32],["icon_32x32@2x.png",64],["icon_128x128.png",128],["icon_128x128@2x.png",256],["icon_256x256.png",256],["icon_256x256@2x.png",512],["icon_512x512.png",512],["icon_512x512@2x.png",1024]]) {
  execFileSync("/usr/bin/sips", ["-z", String(size), String(size), iconSource, "--out", path.join(iconset, name)], { stdio: "ignore" });
}
execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "ONE.icns")], { stdio: "inherit" });
fs.rmSync(iconset, { recursive: true, force: true });
fs.rmSync(renderedIconRoot, { recursive: true, force: true });

if (credentialData) {
  fs.mkdirSync(path.join(outputRoot, ".one"), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, ".one/credential.json"), credentialData, { mode: 0o600 });
}
fs.writeFileSync(path.join(outputRoot, "使用 ONE.txt"), "插入 ONE Key 后，双击 ONE 图标即可打开已登录的 ONE。\n\n第一次从对话进入执行时，选择一次允许 Codex 工作的文件夹；后续不需要重复安装或选择。\n如果提示凭证不存在，请确认隐藏目录 .one 中存在 credential.json。\n普通 U 盘凭证可以被复制；遗失后请管理员立即在 ONE 超管后台挂失。\n");
// Icon generation may leave Finder/resource-fork metadata that codesign rejects.
execFileSync("/usr/bin/xattr", ["-cr", app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
console.log(`macOS ONE Key 已生成：${outputRoot}`);
