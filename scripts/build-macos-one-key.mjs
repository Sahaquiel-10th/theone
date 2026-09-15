import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const outputRoot = path.resolve(root, value("--output") || "output/ONE-Key-macOS");
const credentialPath = value("--credential") ? path.resolve(value("--credential")) : "";
const codexBinary = value("--codex-bin") ? path.resolve(value("--codex-bin")) : "";
const publicKeyPath = path.resolve(root, value("--update-public-key") || "config/runtime-update-public-key.txt");
const versionPath = path.resolve(root, value("--runtime-version") || "config/runtime-version.txt");
if (!fs.existsSync(publicKeyPath)) throw new Error(`更新发布公钥不存在：${publicKeyPath}`);
if (!fs.existsSync(versionPath)) throw new Error(`启动器版本文件不存在：${versionPath}`);
const updatePublicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
const runtimeVersion = fs.readFileSync(versionPath, "utf8").trim();
const commandLineSwiftc = "/Library/Developer/CommandLineTools/usr/bin/swiftc";
const commandLineLipo = "/Library/Developer/CommandLineTools/usr/bin/lipo";
const swiftcBinary = value("--swiftc-bin") || (fs.existsSync(commandLineSwiftc) ? commandLineSwiftc : "/usr/bin/swiftc");
const lipoBinary = fs.existsSync(commandLineLipo) ? commandLineLipo : "/usr/bin/lipo";
const commandLineSdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk";
const swiftSdk = value("--swift-sdk") || (swiftcBinary === commandLineSwiftc && fs.existsSync(commandLineSdk) ? commandLineSdk : "");
if (!/^[A-Za-z0-9_-]{43}$/.test(updatePublicKey)) throw new Error("更新发布公钥格式无效");
if (!/^\d+(?:\.\d+){1,3}$/.test(runtimeVersion)) throw new Error("启动器版本格式无效");
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
<key>CFBundleShortVersionString</key><string>${runtimeVersion}</string>
<key>CFBundleVersion</key><string>11</string>
<key>CFBundleIconFile</key><string>ONE.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);

const generatedSource = path.join(outputRoot, ".ONEKeyLauncher.swift");
const moduleCache = path.join(outputRoot, ".module-cache");
fs.mkdirSync(moduleCache, { recursive: true });
const source = fs.readFileSync(path.join(root, "launcher/macos/ONEKeyLauncher.swift"), "utf8");
if (!source.includes("__ONE_UPDATE_PUBLIC_KEY__") || !source.includes("__ONE_RUNTIME_VERSION__")) throw new Error("Mac 启动器缺少版本或更新公钥占位符");
fs.writeFileSync(generatedSource, source.replaceAll("__ONE_UPDATE_PUBLIC_KEY__", updatePublicKey).replaceAll("__ONE_RUNTIME_VERSION__", runtimeVersion));
const slices = ["arm64", "x86_64"].map((architecture) => {
  const slice = path.join(outputRoot, `ONE-${architecture}`);
  const compileArgs = ["-target", `${architecture}-apple-macosx13.0`, "-parse-as-library", "-O", generatedSource, "-o", slice];
  if (swiftSdk) compileArgs.unshift("-sdk", swiftSdk);
  execFileSync(swiftcBinary, compileArgs, { env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULE_CACHE_PATH: moduleCache }, stdio: "inherit" });
  return slice;
});
execFileSync(lipoBinary, ["-create", ...slices, "-output", path.join(macos, "ONE")], { stdio: "inherit" });
for (const slice of slices) fs.unlinkSync(slice);
if (codexBinary) {
  if (!fs.existsSync(codexBinary)) throw new Error(`Codex Runtime 不存在：${codexBinary}`);
  fs.copyFileSync(codexBinary, path.join(resources, "codex"));
  fs.chmodSync(path.join(resources, "codex"), 0o755);
  // Desktop runtimes delegate code-mode execution to this sibling binary.
  // Include only known runtime components, never the user's Codex home/auth.
  for (const name of ["codex-code-mode-host", "rg"]) {
    const source = path.join(path.dirname(codexBinary), name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(resources, name));
      fs.chmodSync(path.join(resources, name), 0o755);
    }
  }
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
fs.writeFileSync(path.join(outputRoot, "使用 ONE.txt"), "首次在电脑上使用时，插入 ONE Key 并双击 ONE 图标。\n\nONE 会在当前用户目录安装一个不含私钥的在场检测器。此后 U 盘插着即可使用；拔出后新请求立即停用；重新插入或电脑休眠唤醒后会自动恢复，不需要刷新网页。电脑重启后请再双击一次。\n第一次从对话进入执行时，选择一次允许 Codex 工作的文件夹；后续不需要重复安装或选择。\n如果提示凭证不存在，请确认隐藏目录 .one 中存在 credential.json。\n普通 U 盘凭证可以被复制；遗失后请管理员立即在 ONE 超管后台挂失。\n");
// Icon generation may leave Finder/resource-fork metadata that codesign rejects.
execFileSync("/usr/bin/xattr", ["-cr", app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
// Desktop/File Provider volumes can add Finder metadata while codesign writes
// its bundle. Clear it once more so strict verification and USB copying remain
// deterministic; this does not change signed file contents.
execFileSync("/usr/bin/xattr", ["-cr", app], { stdio: "inherit" });
fs.writeFileSync(path.join(outputRoot, "runtime-update.json"), `${JSON.stringify({
  platform: "macos",
  version: runtimeVersion,
  updateProtocol: 1,
  publicKeySha256: crypto.createHash("sha256").update(Buffer.from(updatePublicKey, "base64url")).digest("hex")
}, null, 2)}\n`);
console.log(`macOS ONE Key 已生成：${outputRoot}`);
