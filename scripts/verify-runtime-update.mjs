import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const manifest = path.resolve(value("--manifest") || "");
const publicKeyFile = path.resolve(value("--public-key") || "config/runtime-update-public-key.txt");
if (!fs.existsSync(manifest) || !fs.existsSync(publicKeyFile)) throw new Error("更新清单或发布公钥不存在");
const envelope = JSON.parse(fs.readFileSync(manifest, "utf8"));
const payloadBytes = Buffer.from(String(envelope.payload || ""), "base64url");
const signature = Buffer.from(String(envelope.signature || ""), "base64url");
const publicRaw = Buffer.from(fs.readFileSync(publicKeyFile, "utf8").trim(), "base64url");
if (publicRaw.length !== 32 || signature.length !== 64) throw new Error("更新签名格式无效");
const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicRaw]), format: "der", type: "spki" });
if (!crypto.verify(null, payloadBytes, publicKey, signature)) throw new Error("更新清单签名无效");
const payload = JSON.parse(payloadBytes.toString("utf8"));
if (payload.schemaVersion !== 1 || payload.channel !== "stable" || !Array.isArray(payload.artifacts) || payload.artifacts.length !== 2) throw new Error("更新清单内容无效");
const directory = path.dirname(manifest);
for (const artifact of payload.artifacts) {
  const url = new URL(artifact.url);
  const name = path.basename(url.pathname);
  if (!/^one-(macos|windows)-[0-9.]+\.(zip|exe)$/.test(name) || url.pathname !== `/runtime-updates/${name}`) throw new Error("更新文件名或地址无效");
  const target = path.join(directory, name);
  if (!fs.existsSync(target) || fs.statSync(target).size !== artifact.size) throw new Error(`更新文件缺失或大小不符：${name}`);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (hash !== artifact.sha256) throw new Error(`更新文件摘要不符：${name}`);
}
console.log(`VERIFIED_VERSION=${payload.artifacts[0].version}`);
