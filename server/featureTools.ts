import { localSkillPresets } from "./skillLocalTools.js";
import { sandboxDefinition, sandboxEndpoints } from "./adapterSandbox.js";
import { importReadOnlyOperation, type HttpTool } from "./connectors/standardHttp.js";
import { mcpDefinition, type McpDefinition } from "./connectors/featureMcp.js";
import { safeToolEndpoint } from "./connectors/boundedHttps.js";

export type FeatureToolChoice = { id: string; description: string; document?: unknown; operationId?: string; auth?: 'bearer'|'api_key'; mcp?: { endpoint:string; tool:McpDefinition; reviewedReadOnly:true } };
export const sandboxMcpEndpoint='https://theone.aiarrival.cn/api/adapter-sandbox/mcp';
export function featureMcpEndpoints(){return [sandboxMcpEndpoint,...(process.env.ONE_FEATURE_MCP_ENDPOINTS??'').split(',').map(s=>s.trim()).filter(Boolean)];}
export function featureToolEndpoint(choice:FeatureToolChoice){
  if(isLocalFeatureTool(choice))return "";
  if(choice.mcp){const endpoint=safeToolEndpoint(choice.mcp.endpoint).href;if(!featureMcpEndpoints().includes(endpoint))throw new Error('MCP 地址未审核');return endpoint;}
  return resolveFeatureTool(choice).endpoint;
}
export function isLocalFeatureTool(choice:FeatureToolChoice){return localSkillPresets.some(t=>t.id===choice.id)&&choice.document===undefined&&choice.mcp===undefined;}
export const featureToolPresets = [
  ...localSkillPresets,
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
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["id", "description", "document", "operationId", "auth", "mcp"].includes(k))) throw new Error("工具配置无效，请勿放入密钥或脚本");
    if (typeof raw.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(raw.id) || raw.id === "knowledge_search" || ids.has(raw.id)) throw new Error("工具标识无效、保留或重复");
    ids.add(raw.id);
    if (typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 2000) throw new Error("请填写工具调用条件，最多 2000 字");
    if (raw.document !== undefined && JSON.stringify(raw.document).length > 40000) throw new Error("接口定义超过 40 KB");
    if(raw.auth!==undefined&&!['bearer','api_key'].includes(raw.auth))throw new Error('鉴权方式不支持');
    if(raw.mcp!==undefined&&(!raw.mcp||Array.isArray(raw.mcp)||raw.document!==undefined||raw.operationId!==undefined||typeof raw.mcp!=='object'||Object.keys(raw.mcp).some(k=>!['endpoint','tool','reviewedReadOnly'].includes(k))||raw.mcp.reviewedReadOnly!==true))throw new Error('请明确审核 MCP 工具为只读');
    const choice: FeatureToolChoice = { id: raw.id, description: raw.description.trim(), ...(raw.document !== undefined ? { document: raw.document, operationId: raw.operationId } : {}),...(raw.auth?{auth:raw.auth}:{}),...(raw.mcp?{mcp:{endpoint:raw.mcp.endpoint,tool:mcpDefinition(raw.mcp.tool),reviewedReadOnly:true}}:{}) };
    if(isLocalFeatureTool(choice)&&(raw.auth!==undefined||raw.operationId!==undefined))throw new Error("内置工具无需外部凭证或接口");
    if(localSkillPresets.some(t=>t.id===choice.id)&&(raw.document!==undefined||raw.mcp!==undefined))throw new Error("内置工具标识不能覆盖");
    try { featureToolEndpoint(choice); } catch { throw new Error("接口定义不受支持或地址未获准；仅支持已审核的只读接口"); }
    return choice;
  });
}
