import { aiTaskCatalog, findAiTaskDefinition, type AiTaskKind } from "./aiTaskCatalog.js";
import type { ModelConfig, SystemSettings } from "./types.js";

export const localTaskTools = ["list_files", "read_file", "search_text", "write_file", "replace_in_file", "run_command"] as const;
export type AiTaskValues = { modelId: string; prompt: string; tools: string[]; maxSteps: number };
export type AiTaskVersion = AiTaskValues & { version: number; publishedAt: string; publishedBy: string };
export type AiTaskRecord = { revision: number; draft: AiTaskValues; published?: AiTaskVersion; history: AiTaskVersion[] };
export type AiTaskConfigs = Partial<Record<AiTaskKind, AiTaskRecord>>;

export function defaultTaskValues(id: string): AiTaskValues {
  return { modelId: "", prompt: "", tools: id === "local_agent" ? [...localTaskTools] : [], maxSteps: id === "local_agent" ? 24 : 1 };
}

export function validateTaskValues(id: string, value: unknown, models: ModelConfig[]): AiTaskValues {
  const definition = findAiTaskDefinition(id);
  if (!definition || definition.implementation !== "existing") throw new Error("该任务尚未开放配置");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("任务配置无效");
  const input = value as Record<string, unknown>;
  if (typeof input.modelId !== "string" || typeof input.prompt !== "string" || input.prompt.length > 12000) throw new Error("模型或提示词无效，提示词最多 12000 字符");
  if (input.modelId && !models.some(model => model.id === input.modelId && model.enabled && model.kind === definition.modelKind)) throw new Error("请选择已启用且类型匹配的模型");
  const allowed: readonly string[] = id === "local_agent" ? localTaskTools : [];
  if (!Array.isArray(input.tools) || input.tools.some(tool => typeof tool !== "string" || !allowed.includes(tool))) throw new Error("存在不允许的工具");
  if (!Number.isInteger(input.maxSteps) || Number(input.maxSteps) < 1 || Number(input.maxSteps) > (id === "local_agent" ? 24 : 1)) throw new Error("执行步数无效");
  return { modelId: input.modelId, prompt: input.prompt.trim(), tools: [...new Set(input.tools as string[])], maxSteps: Number(input.maxSteps) };
}

/** Global administrator-owned configuration, never a store for user context. */
export function updateTaskConfig(settings: SystemSettings, models: ModelConfig[], id: string, input: {
  revision: number; action: string; values?: unknown; version?: number;
}, actorId: string, timestamp: string) {
  const definition = findAiTaskDefinition(id);
  if (!definition || definition.implementation !== "existing") throw new Error("该任务尚未开放配置");
  const key = definition.id;
  const current = settings.aiTasks?.[key] ?? { revision: 0, draft: defaultTaskValues(key), history: [] };
  if (input.revision !== current.revision) throw new Error("配置已被修改，请重新打开后再保存");
  const next = structuredClone(current);
  if (input.action === "draft") next.draft = validateTaskValues(key, input.values, models);
  else if (input.action === "publish" || input.action === "rollback") {
    const source = input.action === "rollback" ? current.history.find(item => item.version === input.version) : current.draft;
    if (!source) throw new Error("历史版本不存在");
    const values = validateTaskValues(key, source, models);
    next.published = { ...values, version: (current.published?.version ?? 0) + 1, publishedBy: actorId, publishedAt: timestamp };
    next.draft = structuredClone(values);
    next.history.push(structuredClone(next.published));
  } else throw new Error("不支持的配置操作");
  next.revision++;
  settings.aiTasks ??= {};
  settings.aiTasks[key] = next;
  return next;
}

export function resolveAiTask(settings: SystemSettings, models: ModelConfig[], id: AiTaskKind, fallback: ModelConfig) {
  const definition = findAiTaskDefinition(id)!;
  if (definition.implementation !== "existing") throw new Error("任务执行器尚未启用");
  const config = settings.aiTasks?.[id]?.published;
  const selected = config?.modelId ? models.find(model => model.id === config.modelId) : fallback;
  if (!selected?.enabled || selected.kind !== definition.modelKind) throw new Error(`${definition.name}配置的模型不可用，请联系管理员`);
  const model = structuredClone(selected);
  if (config?.prompt) model.systemPrompt = [model.systemPrompt, config.prompt].filter(Boolean).join("\n\n");
  return { model, version: config?.version ?? 0, values: structuredClone(config ?? defaultTaskValues(id)) };
}

export function taskSummaries(settings: SystemSettings) {
  return aiTaskCatalog.map(definition => ({ ...definition, version: settings.aiTasks?.[definition.id]?.published?.version ?? 0 }));
}
