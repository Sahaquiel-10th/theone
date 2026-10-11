import type { SystemSettings } from "./types.js";
import { validateFeatureTools, type FeatureToolChoice } from "./featureTools.js";
import {featureCategories,type FeatureCategory} from './featureCategories.js';

/** Official, global metadata only. Never store tenant knowledge or credentials here.
 * Approval alone is not runtime authorization: explicit recipient releases are
 * managed separately and every execution checks current entitlement and Key.
 */
export type OfficialFeatureValues = {
  name: string; description: string; author: string; instructions: string;
  limitations: string; integration: "question_answer" | "mcp" | "openapi";
  skillAttribution?: string;
  modelId?: string; tools?: FeatureToolChoice[];
  category?:FeatureCategory;
  knowledgeMode?: "none" | "optional" | "required";
};
export type OfficialFeatureVersion = {
  version: number; values: OfficialFeatureValues; evidence: string;
  approvedBy: string; approvedAt: string;
};
export type OfficialFeatureRecord = {
  /** Omitted for shared platform templates; set for private company definitions. */
  workspaceId?: string;
  companyReleases?: { workspaceId: string; id: string; version: number; publishedAt: string; publishedBy: string }[];
  id: string; revision: number; draft: OfficialFeatureValues;
  status: "draft" | "approved" | "paused";
  current?: OfficialFeatureVersion; history: OfficialFeatureVersion[];
  release?: { id: string; version: number; userIds: string[]; publishedAt: string; publishedBy: string };
};
export class FeatureConfigError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const emptyFeature = (): OfficialFeatureValues => ({ name: "", description: "", author: "ONE", instructions: "", limitations: "", integration: "question_answer" });
export function featureValues(value: unknown): OfficialFeatureValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeatureConfigError("功能配置无效");
  const v = value as Record<string, unknown>;
  const keys = ["name", "description", "author", "instructions", "limitations", "integration", "modelId", "tools", "knowledgeMode", "category", "skillAttribution"];
  if (Object.keys(v).some(k => !keys.includes(k))) throw new FeatureConfigError("仅支持功能说明配置，请勿加入密钥、地址或脚本字段");
  const take = (key: string, max: number, required = true) => {
    const text = v[key];
    if (typeof text !== "string" || text.length > max || (required && !text.trim())) throw new FeatureConfigError(`请检查${({name:"名称",description:"用途",author:"作者",instructions:"执行要求",limitations:"使用边界"} as Record<string,string>)[key]}及长度`);
    return text.trim();
  };
  if (!["question_answer", "mcp", "openapi"].includes(String(v.integration))) throw new FeatureConfigError("接入类型无效");
  if (v.modelId !== undefined && (typeof v.modelId !== "string" || v.modelId.length > 100)) throw new FeatureConfigError("模型无效");
  if (v.skillAttribution !== undefined && (typeof v.skillAttribution !== 'string' || v.skillAttribution.length > 30000)) throw new FeatureConfigError('来源与许可记录无效或过长');
  if (v.knowledgeMode !== undefined && !["none", "optional", "required"].includes(String(v.knowledgeMode))) throw new FeatureConfigError("知识使用方式无效");
  let tools: FeatureToolChoice[] | undefined;
  if(v.category!==undefined&&!featureCategories.some(c=>c.id===v.category))throw new FeatureConfigError('功能分类无效');
  try { if (v.tools !== undefined) tools = validateFeatureTools(v.tools); } catch (e) { throw new FeatureConfigError(e instanceof Error ? e.message : "工具配置无效"); }
  return { name: take("name",60), description: take("description",500), author: take("author",100), instructions: take("instructions",12000), limitations: take("limitations",2000), integration: v.integration as OfficialFeatureValues["integration"], ...(v.skillAttribution !== undefined ? {skillAttribution: v.skillAttribution as string} : {}), ...(v.modelId !== undefined ? { modelId: v.modelId as string } : {}), ...(tools ? { tools } : {}), ...(v.knowledgeMode !== undefined ? { knowledgeMode: v.knowledgeMode as OfficialFeatureValues["knowledgeMode"] } : {}),...(v.category!==undefined?{category:v.category as FeatureCategory}:{}) };
}
export function updateOfficialFeature(settings: SystemSettings, id: string, input: unknown, actor: string, at: string) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id) || ["constructor", "prototype"].includes(id)) throw new FeatureConfigError("标识需为 3–64 位小写英文、数字或短横线，以英文开头");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FeatureConfigError("请求无效");
  const body = input as Record<string,unknown>;
  const current = settings.officialFeatures?.find(f => f.id === id);
  if (!Number.isSafeInteger(body.revision) || body.revision !== (current?.revision ?? 0)) throw new FeatureConfigError("配置已更新，请重新打开后操作",409);
  if (!current && (body.action !== "save" || (settings.officialFeatures?.length ?? 0) >= 100)) throw new FeatureConfigError("请先保存功能草稿，最多保留 100 项");
  const next: OfficialFeatureRecord = current ? structuredClone(current) : { id, revision:0, draft:emptyFeature(), status:"draft", history:[] };
  if (body.action === "save") next.draft = featureValues(body.values);
  else if (body.action === "approve") {
    if (typeof body.evidence !== "string" || body.evidence.trim().length < 20 || body.evidence.length > 4000 || body.confirmed !== true) throw new FeatureConfigError("请填写至少 20 字的验收记录，并确认这是官方配置认定，不代表已开放运行");
    if (next.history.length >= 100) throw new FeatureConfigError("版本记录已达上限，请联系维护人员；历史不会自动删除");
    const snapshot: OfficialFeatureVersion = { version:(next.history.at(-1)?.version ?? 0)+1, values:featureValues(next.draft), evidence:body.evidence.trim(), approvedBy:actor, approvedAt:at };
    next.current = structuredClone(snapshot); next.history.push(snapshot); next.status="approved";
  } else if (body.action === "pause") {
    if (!next.current) throw new FeatureConfigError("尚无已认定版本");
    next.status="paused";
    delete next.release;
    delete next.companyReleases;
  } else if (body.action === "restore") {
    const version=next.history.find(v=>v.version===body.version);
    if (!version) throw new FeatureConfigError("历史版本不存在",404);
    // Restoring changes the draft, never silently re-enables a paused version.
    next.draft=structuredClone(version.values);
  } else throw new FeatureConfigError("操作无效");
  next.revision++;
  settings.officialFeatures = [...(settings.officialFeatures ?? []).filter(f=>f.id!==id), next];
  return next;
}
