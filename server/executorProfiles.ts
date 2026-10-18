import type { Database, ModelConfig } from "./types.js";
import {
  defaultTaskValues,
  resolveAiTask,
  validateTaskValues,
  updateTaskConfig,
  type AiTaskValues,
} from "./aiTaskConfig.js";
import { uid } from "./security.js";
import {validateDiscoveryMetadata,type DiscoveryMetadata} from './discoveryMetadata.js';

export type ExecutorValues = AiTaskValues & {
  name: string;
  description: string;
  featureIds: string[];
  routingRole?: "logic" | "writing" | "custom";
  discovery?: DiscoveryMetadata;
};
export type ExecutorVersion = ExecutorValues & {
  version: number;
  publishedAt: string;
  publishedBy: string;
};
export type ExecutorProfile = {
  id: string;
  revision: number;
  enabled: boolean;
  draft: ExecutorValues;
  published?: ExecutorVersion;
  history: ExecutorVersion[];
};
export class CoordinatorError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function executorDefaults(): ExecutorValues {
  return {
    ...defaultTaskValues("task_worker"),
    name: "通用执行器",
    description: "处理一件独立事情，按需读取已授权资料。",
    featureIds: [],
    routingRole: "custom",
  };
}
export function validateExecutor(db: Database, input: unknown): ExecutorValues {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CoordinatorError("执行器配置无效", 400);
  const v = input as ExecutorValues;
  if (
    typeof v.name !== "string" ||
    !v.name.trim() ||
    v.name.length > 60 ||
    typeof v.description !== "string" ||
    !v.description.trim() ||
    v.description.length > 1000
  )
    throw new CoordinatorError("请填写执行器名称和适用说明", 400);
  if (
    !Array.isArray(v.featureIds) ||
    v.featureIds.length > 8 ||
    v.featureIds.some(
      (id) =>
        typeof id !== "string" ||
        !db.settings.officialFeatures?.some(
          (f) => f.id === id && f.status === "approved" && f.current,
        ),
    )
  )
    throw new CoordinatorError("只能绑定最多八个已认定功能", 400);
  if (v.routingRole !== undefined && !["logic", "writing", "custom"].includes(v.routingRole))
    throw new CoordinatorError("执行器用途无效", 400);
  let discovery:DiscoveryMetadata|undefined;
  try{discovery=validateDiscoveryMetadata(v.discovery);}catch(e){throw new CoordinatorError(e instanceof Error?e.message:'能力发现信息无效',400);}
  return {
    ...validateTaskValues("task_worker", v, db.models),
    ...(discovery?{discovery}:{}),
    name: v.name.trim(),
    description: v.description.trim(),
    featureIds: [...new Set(v.featureIds)],
    routingRole: v.routingRole ?? "custom",
  };
}

export const defaultExecutorDefinitions = [
  {
    id: "logic",
    family: "gpt",
    name: "逻辑与分析",
    description: "分析、推理、资料整理、方案结构、数据核算与编程任务。除文章写作外，优先使用本能力；本机工程需要另交本机执行，绘图另交图片生成。",
    prompt: "你是 ONE 的逻辑与分析执行 AI。根据本轮任务交接、已确认要求和授权资料完成分析、推理、资料整理、方案或代码建议。保留事实与来源，假设和待确认项明确标记；检查计算与约束。只返回本轮实际完成的成果和必要说明。没有实际写入文件、运行程序或生成图片时，不得声称已完成这些动作；需要操作本机的部分应交给本机执行能力。文章、专栏、长文润色等写作任务交给文章写作能力。",
  },
  {
    id: "writing",
    family: "claude",
    name: "文章写作",
    description: "撰写、改写、润色文章、专栏、文案和长篇内容。需要成文表达时优先使用本能力；纯计算、逻辑分析与编程交给逻辑与分析。",
    prompt: "你是 ONE 的文章写作执行 AI。根据本轮任务交接、用户语气、用途、长度与授权素材完成文章、专栏、文案或改写。尊重已确认的观点与事实，不把缺失资料编造成事实；必要假设和待确认信息单独说明。优先交付可直接使用的完整正文，并仅附必要的来源或修改说明。没有实际保存或发布时，不声称已保存或发布；需要写入 Notion 或本机文件时把正文交给对应写入能力。",
  },
] as const;

/** Explicit administrator setup. Existing drafts, published versions and prices are never replaced. */
export function setupDefaultExecutors(
  db: Database,
  actor: string,
  input: { logicModelId?: string; writingModelId?: string; publish?: boolean } = {},
) {
  if (!db.users.some((u) => u.id === actor && u.enabled && u.role === "admin"))
    throw new CoordinatorError("无权配置", 403);
  const records = (db.settings.executorProfiles ??= []);
  const needed = defaultExecutorDefinitions.filter((definition) => !records.some((record) => record.id === definition.id || record.draft.routingRole === definition.id));
  if (records.length + needed.length > 100) throw new CoordinatorError("执行器数量已达上限，请先整理配置", 400);
  for (const definition of needed) {
    const specified = definition.id === "logic" ? input.logicModelId : input.writingModelId;
    if (specified && !db.models.some((m) => m.id === specified && m.enabled && m.kind === "chat" && !!m.apiKey && new RegExp(definition.family, "i").test(`${m.model} ${m.name}`)))
      throw new CoordinatorError(`请选择已启用的 ${definition.family === "gpt" ? "GPT" : "Claude"} 模型`, 400);
  }
  const added: string[] = [], existing: string[] = [], unavailable: { id: string; reason: string }[] = [];
  for (const definition of defaultExecutorDefinitions) {
    if (records.some((record) => record.id === definition.id || record.draft.routingRole === definition.id)) {
      existing.push(definition.id);
      continue;
    }
    const specified = definition.id === "logic" ? input.logicModelId : input.writingModelId;
    const matches = db.models.filter((m) => m.enabled && m.kind === "chat" && !!m.apiKey && new RegExp(definition.family, "i").test(`${m.model} ${m.name}`));
    const model = specified ? matches.find((m) => m.id === specified) : matches.length === 1 ? matches[0] : undefined;
    if (specified && !model) throw new CoordinatorError(`请选择已启用的 ${definition.family === "gpt" ? "GPT" : "Claude"} 模型`, 400);
    const values: ExecutorValues = {
      ...executorDefaults(),
      name: definition.name,
      description: definition.description,
      prompt: definition.prompt,
      promptMode: "replace",
      modelId: model?.id ?? "",
      routingRole: definition.id,
      featureIds: [],
    };
    const record: ExecutorProfile = { id: definition.id, revision: 1, enabled: false, draft: values, history: [] };
    if (model && input.publish === true) {
      const published: ExecutorVersion = { ...structuredClone(values), version: 1, publishedAt: new Date().toISOString(), publishedBy: actor };
      record.published = published;
      record.history.push(structuredClone(published));
      record.enabled = true;
    }
    records.push(record);
    added.push(record.id);
    if (!model) unavailable.push({ id: record.id, reason: matches.length ? `有多个 ${definition.family} 模型，请在能力配置中选择` : `尚未配置可用的 ${definition.family === "gpt" ? "GPT" : "Claude"} 模型` });
    db.auditLogs.push({ id: uid("aud"), actorUserId: actor, action: "admin.executor.setup_default", targetType: "executor", targetId: record.id, details: { enabled: record.enabled, version: record.published?.version ?? 0 }, createdAt: new Date().toISOString() });
  }
  let coordinatorUpdated = false;
  const coordinator = db.settings.aiTasks?.coordinator;
  if (input.publish === true && coordinator?.published?.enabled === true) {
    const tools = [...new Set([...coordinator.published.tools, "delegate_tasks", "generate_image", "discover_capabilities"])];
    if (tools.length !== coordinator.published.tools.length) {
      const draft = structuredClone(coordinator.draft);
      const at = new Date().toISOString();
      updateTaskConfig(db.settings, db.models, "coordinator", { revision: coordinator.revision, action: "draft", values: { ...coordinator.published, tools } }, actor, at);
      const updated = updateTaskConfig(db.settings, db.models, "coordinator", { revision: coordinator.revision + 1, action: "publish" }, actor, at);
      // Keep any administrator's unpublished prompt/model edits while extending the tool ceiling.
      updated.draft = { ...draft, tools: [...new Set([...draft.tools, "delegate_tasks", "generate_image"])] };
      coordinatorUpdated = true;
      db.auditLogs.push({ id: uid("aud"), actorUserId: actor, action: "admin.coordinator.setup_capability_tools", targetType: "ai_task", targetId: "coordinator", details: { version: updated.published?.version ?? 0 }, createdAt: at });
    }
  }
  return { added, existing, unavailable, coordinatorUpdated };
}
export function updateExecutor(
  db: Database,
  actor: string,
  id: string | undefined,
  body: {
    revision: number;
    action: string;
    values?: unknown;
    version?: number;
  },
) {
  if (!db.users.some((u) => u.id === actor && u.enabled && u.role === "admin"))
    throw new CoordinatorError("无权配置", 403);
  const records = (db.settings.executorProfiles ??= []);
  let record = id ? records.find((p) => p.id === id) : undefined;
  if (id && !record) throw new CoordinatorError("执行器不存在", 404);
  if (!record) {
    if (body.action !== "draft" || body.revision !== 0 || records.length >= 100)
      throw new CoordinatorError("请先创建执行器草稿，最多一百项", 400);
    record = {
      id: uid("execp"),
      revision: 0,
      enabled: false,
      draft: executorDefaults(),
      history: [],
    };
  }
  if (body.revision !== record.revision)
    throw new CoordinatorError("配置已变化，请重新打开");
  const next = structuredClone(record),
    at = new Date().toISOString();
  if (body.action === "draft") next.draft = validateExecutor(db, body.values);
  else if (body.action === "publish" || body.action === "rollback") {
    const source =
      body.action === "rollback"
        ? next.history.find((v) => v.version === body.version)
        : next.draft;
    if (!source) throw new CoordinatorError("历史版本不存在", 404);
    if (["logic", "writing"].includes(source.routingRole ?? "") && !source.modelId)
      throw new CoordinatorError("请先为此能力选择明确的执行模型", 400);
    next.published = {
      ...validateExecutor(db, source),
      version: (next.published?.version ?? 0) + 1,
      publishedAt: at,
      publishedBy: actor,
    };
    next.history.push(structuredClone(next.published));
    next.draft = structuredClone(next.published);
    next.enabled = true;
  } else if (body.action === "pause") next.enabled = false;
  else throw new CoordinatorError("操作无效", 400);
  next.revision++;
  const index = records.findIndex((p) => p.id === next.id);
  if (index < 0) records.push(next);
  else records[index] = next;
  db.auditLogs.push({
    id: uid("aud"),
    actorUserId: actor,
    action: `admin.executor.${body.action}`,
    targetType: "executor",
    targetId: next.id,
    details: { version: next.published?.version ?? 0, revision: next.revision },
    createdAt: at,
  });
  return next;
}
export function resolveExecutor(
  db: Database,
  id: string,
  fallback: ModelConfig,
) {
  if (id === "general") {
    const config = resolveAiTask(
      db.settings,
      db.models,
      "task_worker",
      fallback,
    );
    return {
      values: {
        ...executorDefaults(),
        ...config.values,
        modelId: config.model.id,
      },
      version: config.version,
      model: config.model,
    };
  }
  const p = db.settings.executorProfiles?.find(
    (p) => p.id === id && p.enabled && p.published,
  );
  if (!p?.published) throw new CoordinatorError("执行器已停用或尚未发布", 403);
  const values = structuredClone(p.published),
    selected = values.modelId
      ? db.models.find((m) => m.id === values.modelId)
      : fallback;
  if (!selected?.enabled || selected.kind !== "chat" || !selected.apiKey)
    throw new CoordinatorError("执行器模型不可用");
  return {
    values: { ...values, modelId: selected.id },
    version: values.version,
    model: {
      ...structuredClone(selected),
      systemPrompt: [selected.systemPrompt, values.prompt]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

/** A routing role is an alias, not a promise that the persisted profile ID is the role name. */
export function resolveRoutingExecutorId(db: Database, role: "logic" | "writing"): string {
  const candidates = (db.settings.executorProfiles ?? []).filter((profile) => profile.enabled && profile.published
    && (profile.published.routingRole === role || profile.id === role)
    && db.models.some((model) => model.id === profile.published!.modelId && model.enabled && model.kind === "chat" && !!model.apiKey));
  const exact = candidates.find((profile) => profile.id === role);
  if (exact) return exact.id;
  if (candidates.length === 1) return candidates[0].id;
  throw new CoordinatorError(candidates.length ? `有多个${role === "logic" ? "逻辑" : "写作"}能力，请明确选择` : `${role === "logic" ? "逻辑" : "写作"}能力尚未配置或已停用`, 409);
}
