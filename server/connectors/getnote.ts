import type { Database } from "../types.js";
import { decryptCredential } from "../knowledge/credentialCipher.js";
import { getNoteProvider } from "../knowledge/getnoteProvider.js";
import type { ConnectorHealth, KnowledgeAdapter } from "./registry.js";

function connectionFor(db: Database, workspaceId: string) {
  return db.knowledgeConnections.find(item => item.workspaceId === workspaceId && item.provider === "getnote");
}

function status(db: Database, workspaceId: string): ConnectorHealth {
  const connection = connectionFor(db, workspaceId);
  const health = (state: ConnectorHealth["state"], code: string, message: string): ConnectorHealth => ({ state, code, message, evidence: "stored" });
  if (!connection || connection.status === "revoked") return health("not_connected", "AUTHORIZATION_REQUIRED", "请连接知识来源");
  if (connection.status === "pending") return health("pending", "AUTHORIZATION_PENDING", "等待完成授权");
  if (connection.credentialExpiresAt && (!Number.isFinite(Date.parse(connection.credentialExpiresAt)) || Date.parse(connection.credentialExpiresAt) <= Date.now())) return health("expired", "AUTHORIZATION_EXPIRED", "授权已过期，请重新连接");
  if (connection.status === "error") return health("error", "CONNECTION_ERROR", "上次检索失败，请检查连接");
  if (!connection.clientId || !connection.encryptedApiKey) return health("not_connected", "CREDENTIAL_UNAVAILABLE", "授权资料不完整，请重新连接");
  return health("configured", "CREDENTIAL_STORED", "已保存授权，尚未进行本次远端检查");
}

export const getnoteConnector: KnowledgeAdapter = {
  kind: "knowledge",
  manifest: { id: "getnote", name: "得到大脑", version: "0.1.0", kind: "knowledge", capabilities: ["knowledge.search"], auth: "device_authorization" },
  status: (db, scope) => status(db, scope.workspaceId),
  async check(db, scope) {
    const current = status(db, scope.workspaceId);
    if (current.state !== "configured") return current;
    const connection = connectionFor(db, scope.workspaceId)!;
    try {
      await getNoteProvider.verify({ clientId: connection.clientId, apiKey: decryptCredential(connection.encryptedApiKey!) });
      return { state: "verified", code: "REMOTE_CHECK_PASSED", message: "知识检索接口检查通过", evidence: "remote" };
    } catch {
      // Provider errors may contain response bodies or credentials. Never expose
      // those through the shared diagnostics surface.
      return { state: "error", code: "REMOTE_CHECK_FAILED", message: "知识检索接口检查失败，请检查授权或稍后重试", evidence: "remote" };
    }
  },
  async recall(db, workspaceId, query, topK) {
    const current = status(db, workspaceId);
    if (current.state === "expired") throw new Error("知识来源授权已过期，请重新连接");
    if (current.state !== "configured") return [];
    const connection = connectionFor(db, workspaceId)!;
    return (await getNoteProvider.search({ clientId: connection.clientId, apiKey: decryptCredential(connection.encryptedApiKey!) }, query, topK))
      .map(chunk => ({ ...chunk, provider: "getnote" as const }));
  }
};
