import type { ImaService } from "../knowledge/imaService.js";
import type { KnowledgeAdapter } from "./registry.js";

export function imaConnector(service: ImaService): KnowledgeAdapter {
  return {
    kind: "knowledge",
    manifest: { id: "ima", name: "腾讯 ima", version: "0.1.0", kind: "knowledge", capabilities: ["knowledge.search", "knowledge.read"], auth: "api_key", security: { trust: "untrusted_reference", transport: "fixed_https", access: "read_only", allowedHosts: ["ima.qq.com"] } },
    status: (db, scope) => service.localStatus(db, scope.workspaceId),
    async check(_db, scope) {
      try { await service.verify(scope.workspaceId); return { state: "verified", code: "REMOTE_CHECK_PASSED", message: "ima 读取接口检查通过", evidence: "remote" }; }
      catch { return { state: "error", code: "REMOTE_CHECK_FAILED", message: "ima 读取接口检查失败，请检查凭据或稍后重试", evidence: "remote" }; }
    },
    recall: (_db, workspaceId, query, topK) => service.search(workspaceId, query, topK)
  };
}
