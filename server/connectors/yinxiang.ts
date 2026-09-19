import type { Database } from "../types.js";
import type { YinxiangService } from "../knowledge/yinxiangService.js";
import type { ConnectorHealth, KnowledgeAdapter } from "./registry.js";

export function yinxiangConnector(service: YinxiangService): KnowledgeAdapter {
  return { kind: "knowledge", manifest: { id: "yinxiang", name: "印象笔记", version: "0.1.0", kind: "knowledge", capabilities: ["knowledge.search", "knowledge.read"], auth: "oauth1", security: { trust: "untrusted_reference", transport: "fixed_https", access: "read_only", allowedHosts: ["app.yinxiang.com"] } }, status(db: Database, scope): ConnectorHealth { return service.localStatus(db, scope.workspaceId); }, async check(_db, scope) { try { await service.verify(scope.workspaceId); return { state: "verified", code: "REMOTE_CHECK_PASSED", message: "印象笔记读取接口检查通过", evidence: "remote" }; } catch { return { state: "error", code: "REMOTE_CHECK_FAILED", message: "印象笔记读取接口检查失败，请重新连接或稍后重试", evidence: "remote" }; } }, recall(_db, workspaceId, query, topK) { return service.search(workspaceId, query, topK); } };
}
