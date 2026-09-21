import type { FeishuService } from "../knowledge/feishuService.js";
import type { KnowledgeAdapter } from "./registry.js";
// Recall remains read-only. User-confirmed writes use a separate protected route.
export function feishuConnector(service: FeishuService): KnowledgeAdapter {
  return { kind: "knowledge", manifest: { id: "feishu", name: "飞书", version: "0.1.0", kind: "knowledge", capabilities: ["knowledge.search", "knowledge.read"], auth: "oauth_pkce", security: { trust: "untrusted_reference", transport: "fixed_https", access: "read_only", allowedHosts: ["open.feishu.cn"] } },
    status: (db, scope) => service.localStatus(db, scope.workspaceId), recall: (_db, workspaceId, query, topK) => service.search(workspaceId, query, topK) };
}
