import crypto from "node:crypto";
import fs from "node:fs";

export function wechatConfig() {
  const get = (name: string) => process.env[`WECHAT_PAY_${name}`]?.trim() ?? "";
  return { appId: get("APP_ID"), mchId: get("MCH_ID"), serial: get("MERCHANT_SERIAL_NO"), privateKeyPath: get("PRIVATE_KEY_PATH"),
    publicKeyId: get("PUBLIC_KEY_ID"), publicKeyPath: get("PUBLIC_KEY_PATH"), apiV3Key: get("API_V3_KEY"), notifyUrl: get("NOTIFY_URL") };
}
export function wechatReady() {
  const c = wechatConfig();
  return Object.values(c).every(Boolean) && Buffer.byteLength(c.apiV3Key) === 32 && c.notifyUrl.startsWith("https://");
}
export function verifyPaymentSignature(headers: Headers, body: string, publicKey: string | Buffer, expectedSerial: string) {
  const timestamp = headers.get("wechatpay-timestamp") ?? "", nonce = headers.get("wechatpay-nonce") ?? "";
  const signature = headers.get("wechatpay-signature") ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !nonce || !signature
    || headers.get("wechatpay-serial") !== expectedSerial
    || !crypto.verify("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), publicKey, Buffer.from(signature, "base64"))) throw new Error("微信支付验签失败");
}
export async function wechatRequest(method: "GET" | "POST", path: string, payload?: unknown) {
  const c = wechatConfig(); if (!wechatReady()) throw new Error("微信支付尚未配置");
  const body = payload === undefined ? "" : JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(16).toString("hex");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), fs.readFileSync(c.privateKeyPath)).toString("base64");
  const response = await fetch(`https://api.mch.weixin.qq.com${path}`, { method, body: body || undefined, signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${c.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${c.serial}",signature="${signature}"` } });
  const raw = await response.text(); verifyPaymentSignature(response.headers, raw, fs.readFileSync(c.publicKeyPath), c.publicKeyId);
  if (!response.ok) throw new Error("微信支付请求未完成，请核对订单状态");
  return JSON.parse(raw);
}
export function decodePaymentNotification(headers: Headers, raw: string) {
  const c = wechatConfig();
  verifyPaymentSignature(headers, raw, fs.readFileSync(c.publicKeyPath), c.publicKeyId);
  const event = JSON.parse(raw);
  if (event.event_type !== "TRANSACTION.SUCCESS") return null;
  const r = event.resource;
  if (event.resource_type !== "encrypt-resource" || r?.algorithm !== "AEAD_AES_256_GCM" || Buffer.byteLength(c.apiV3Key) !== 32) throw new Error("微信支付通知无效");
  const bytes = Buffer.from(r.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(c.apiV3Key), Buffer.from(r.nonce));
  decipher.setAuthTag(bytes.subarray(-16)); decipher.setAAD(Buffer.from(r.associated_data ?? ""));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString());
}
