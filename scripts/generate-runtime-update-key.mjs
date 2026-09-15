import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const privatePath = value("--private-key");
if (!privatePath) throw new Error("用法：node scripts/generate-runtime-update-key.mjs --private-key /仓库外/安全位置/runtime-update-private.pem");
const resolved = path.resolve(privatePath);
if (fs.existsSync(resolved)) throw new Error(`拒绝覆盖已有发布私钥：${resolved}`);
fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
const pair = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(resolved, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
const der = pair.publicKey.export({ format: "der", type: "spki" });
console.log(JSON.stringify({ privateKeyPath: resolved, publicKeyRaw: der.subarray(der.length - 32).toString("base64url") }));
