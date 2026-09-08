import type { Database } from "../types.js";
import type { NotionMcpService } from "../knowledge/notionMcpService.js";
import type { ConnectorHealth, KnowledgeAdapter } from "./registry.js";

export function notionConnector(service: NotionMcpService): KnowledgeAdapter {
  return {
    kind: "knowledge",
    manifest: { id: "notion", name: "Notion", version: "0.1.0", kind: "knowledge", capabilities: ["knowledge.search", "knowledge.read"], auth: "oauth_pkce" },
    status(db: Database, scope): ConnectorHealth { return service.localStatus(db, scope.workspaceId); },
    async check(_db, scope) {
      try {
        await service.verify(scope.workspaceId);
        return { state: "verified", code: "REMOTE_CHECK_PASSED", message: "Notion 读取接口检查通过", evidence: "remote" };
      } catch {
        return { state: "error", code: "REMOTE_CHECK_FAILED", message: "Notion 读取接口检查失败，请重新连接或稍后重试", evidence: "remote" };
      }
    },
    recall(_db, workspaceId, query, topK) { return service.search(workspaceId, query, topK); }
  };
}
