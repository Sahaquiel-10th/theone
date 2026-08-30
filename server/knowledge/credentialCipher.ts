import crypto from "node:crypto";

function encryptionKey() {
  const secret = process.env.PROVIDER_CREDENTIALS_KEY?.trim() || (process.env.NODE_ENV === "production" ? "" : process.env.JWT_SECRET?.trim() || "one-local-development-key");
  if (!secret) throw new Error("生产环境必须配置 PROVIDER_CREDENTIALS_KEY");
  if (process.env.NODE_ENV === "production" && secret.length < 32) throw new Error("PROVIDER_CREDENTIALS_KEY 至少需要 32 个字符");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptCredential(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptCredential(value: string) {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("知识库凭证格式无效");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
