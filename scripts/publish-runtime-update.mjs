import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const required = name => { const result = value(name); if (!result) throw new Error(`${name} 不能为空`); return path.resolve(result); };
const privateKeyPath = required("--private-key");
const macApp = required("--mac-app");
const windowsExe = required("--windows-exe");
const output = required("--output");
const origin = value("--origin") || "https://theone.aiarrival.cn";
const version = value("--version");
if (!/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$/.test(version)) throw new Error("--version 必须是纯数字版本，例如 0.3.1");
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== "https:" || parsedOrigin.username || parsedOrigin.password || parsedOrigin.search || parsedOrigin.hash || !["", "/"].includes(parsedOrigin.pathname)) {
  throw new Error("--origin 必须是没有路径、账号或参数的 HTTPS 站点地址");
}
if (!fs.statSync(macApp).isDirectory() || !fs.statSync(windowsExe).isFile()) throw new Error("双平台制品不完整");
if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("--output 必须是空目录或不存在");
fs.mkdirSync(output, { recursive: true });

const readMetadata = (target, platform) => {
  const metadataPath = path.join(path.dirname(target), "runtime-update.json");
  if (!fs.existsSync(metadataPath)) throw new Error(`${platform} 制品缺少在线更新构建信息`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (metadata.platform !== platform || metadata.version !== version || metadata.updateProtocol !== 1 || !/^[a-f0-9]{64}$/.test(metadata.publicKeySha256 || "")) {
    throw new Error(`${platform} 制品版本或更新协议不一致`);
  }
  return metadata;
};
const macMetadata = readMetadata(macApp, "macos");
const windowsMetadata = readMetadata(windowsExe, "windows");
if (macMetadata.publicKeySha256 !== windowsMetadata.publicKeySha256) throw new Error("双平台制品信任的发布公钥不一致");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", macApp], { stdio: "inherit" });
const commandLineLipo = "/Library/Developer/CommandLineTools/usr/bin/lipo";
const lipoBinary = fs.existsSync(commandLineLipo) ? commandLineLipo : "/usr/bin/lipo";
const macArchitectures = execFileSync(lipoBinary, ["-archs", path.join(macApp, "Contents/MacOS/ONE")], { encoding: "utf8" }).trim().split(/\s+/);
if (!macArchitectures.includes("arm64") || !macArchitectures.includes("x86_64")) throw new Error("Mac 更新制品不是 Universal 版本");
const windowsDescription = execFileSync("/usr/bin/file", [windowsExe], { encoding: "utf8" });
if (!/PE32\+ executable.*x86-64/i.test(windowsDescription)) throw new Error("Windows 更新制品不是 x64 PE32+ 程序");

const macName = `one-macos-${version}.zip`;
const windowsName = `one-windows-${version}.exe`;
const macTarget = path.join(output, macName);
const windowsTarget = path.join(output, windowsName);
execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", macApp, macTarget], { stdio: "inherit" });
fs.copyFileSync(windowsExe, windowsTarget, fs.constants.COPYFILE_EXCL);
const digest = target => crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
const artifact = (platform, architecture, name, target) => ({
  platform, architecture, version,
  url: new URL(`/runtime-updates/${name}`, origin).toString(),
  sha256: digest(target), size: fs.statSync(target).size
});
const payload = {
  schemaVersion: 1,
  channel: "stable",
  releasedAt: new Date().toISOString(),
  artifacts: [artifact("macos", "universal", macName, macTarget), artifact("windows", "amd64", windowsName, windowsTarget)]
};
const payloadBytes = Buffer.from(JSON.stringify(payload));
const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
const publicDer = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
const signingKeyFingerprint = crypto.createHash("sha256").update(publicDer.subarray(publicDer.length - 32)).digest("hex");
if (signingKeyFingerprint !== macMetadata.publicKeySha256) throw new Error("发布私钥与启动器内置公钥不匹配");
const envelope = { payload: payloadBytes.toString("base64url"), signature: crypto.sign(null, payloadBytes, privateKey).toString("base64url") };
fs.writeFileSync(path.join(output, "stable.json"), `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o644 });
console.log(`已生成签名更新目录：${output}`);
