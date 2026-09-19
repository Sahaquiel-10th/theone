import type { Database } from "../types.js";
import type { RemoteMcpKnowledgeService } from "../knowledge/remoteMcpKnowledgeService.js";
import type { ConnectorHealth, KnowledgeAdapter } from "./registry.js";
import type { RemoteMcpProviderConfig } from "../knowledge/remoteMcpKnowledgeService.js";

export function remoteMcpConnector(service: RemoteMcpKnowledgeService, config: RemoteMcpProviderConfig): KnowledgeAdapter {
  return {
    kind: "knowledge",
    manifest: { id: config.provider, name: config.label, version: "0.1.0", kind: "knowledge", capabilities: ["knowledge.search", "knowledge.read"], auth: "oauth_pkce", security: { trust: "untrusted_reference", transport: "fixed_https", access: "read_only", allowedHosts: config.hosts } },
    status(db: Database, scope): ConnectorHealth { return service.localStatus(db, scope.workspaceId); },
    async check(_db, scope) { try { await service.verify(scope.workspaceId); return { state: "verified", code: "REMOTE_CHECK_PASSED", message: `${config.label} 读取接口检查通过`, evidence: "remote" }; } catch { return { state: "error", code: "REMOTE_CHECK_FAILED", message: `${config.label} 读取接口检查失败，请重新连接或稍后重试`, evidence: "remote" }; } },
    recall(_db, workspaceId, query, topK) { return service.search(workspaceId, query, topK); }
  };
}
