import crypto from "node:crypto";

function encryptionKey() {
  const secret = process.env.PROVIDER_CREDENTIALS_KEY?.trim() || (process.env.NODE_ENV === "production" ? "" : process.env.JWT_SECRET?.trim() || "one-local-development-key");
  if (!secret) throw new Error("生产环境必须配置 PROVIDER_CREDENTIALS_KEY");
  if (process.env.NODE_ENV === "production" && secret.length < 32) throw new Error("PROVIDER_CREDENTIALS_KEY 至少需要 32 个字符");
  return crypto.createHash("sha256").update(secret).digest();
}

export function knowledgeCredentialContext(workspaceId: string, provider: string, field: string) {
  return `knowledge:${workspaceId}:${provider}:${field}`;
}

export function authorizationSessionContext(sessionId: string, workspaceId: string, connectorId: string) {
  return `connector-authorization:${sessionId}:${workspaceId}:${connectorId}:payload`;
}

export function encryptCredential(value: string, context?: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  if (context) cipher.setAAD(Buffer.from(context, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${context ? "v2" : "v1"}.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptCredential(value: string, context?: string) {
  const [version, iv, tag, encrypted] = value.split(".");
  if ((version !== "v1" && version !== "v2") || !iv || !tag || !encrypted) throw new Error("知识库凭证格式无效");
  if (version === "v2" && !context) throw new Error("知识库凭证缺少账户绑定信息");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  if (version === "v2") decipher.setAAD(Buffer.from(context!, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
