import { sandboxDefinition, sandboxEndpoints } from "./adapterSandbox.js";
import { importReadOnlyOperation, type HttpTool } from "./connectors/standardHttp.js";

export type FeatureToolChoice = { id: string; description: string; document?: unknown; operationId?: string };
export const featureToolPresets = [
  { id: "sandboxLookup", name: "测试资料查询", description: "查询测试园区会议室或打印机规则。topic 使用 meeting、printer；missing 用于无结果测试。" },
  { id: "sandboxInventory", name: "测试库存查询", description: "查询虚构物品库存。itemId 为整数：101 白板笔、102 笔记本、999 不存在的物品。" }
];
export function featureAllowedEndpoints() {
  return [...sandboxEndpoints, ...(process.env.ONE_FEATURE_HTTP_ENDPOINTS ?? "").split(",").map(s => s.trim()).filter(Boolean)];
}
export function resolveFeatureTool(choice: FeatureToolChoice): HttpTool {
  if (choice.document !== undefined) return importReadOnlyOperation(choice.document, choice.operationId ?? "", featureAllowedEndpoints());
  if (!featureToolPresets.some(p => p.id === choice.id)) throw new Error("工具尚未支持，请重新选择");
  return importReadOnlyOperation(sandboxDefinition, choice.id, sandboxEndpoints);
}
export function validateFeatureTools(value: unknown): FeatureToolChoice[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error("最多添加 6 个工具");
  const ids = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["id", "description", "document", "operationId"].includes(k))) throw new Error("工具配置无效，请勿放入密钥或脚本");
    if (typeof raw.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(raw.id) || ids.has(raw.id)) throw new Error("工具标识无效或重复");
    ids.add(raw.id);
    if (typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 2000) throw new Error("请填写工具调用条件，最多 2000 字");
    if (raw.document !== undefined && JSON.stringify(raw.document).length > 40000) throw new Error("接口定义超过 40 KB");
    // Imported definitions must not embed credentials, including in descriptions.
    // No auth fields are supported; the strict importer rejects security/headers.
    const choice: FeatureToolChoice = { id: raw.id, description: raw.description.trim(), ...(raw.document !== undefined ? { document: raw.document, operationId: raw.operationId } : {}) };
    try { resolveFeatureTool(choice); } catch { throw new Error("接口定义不受支持或地址未获准；仅支持已审核地址的无鉴权只读 GET 接口"); }
    return choice;
  });
}
