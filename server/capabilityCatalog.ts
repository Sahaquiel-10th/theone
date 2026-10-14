import type { Database, ModelConfig } from "./types.js";
import { defaultTaskValues, resolveAiTask } from "./aiTaskConfig.js";
import { aiTaskCatalog, type AiTaskKind } from "./aiTaskCatalog.js";
import { executorDefaults, resolveExecutor } from "./executorProfiles.js";
import { availableFeature, featureMember, type FeatureScope } from "./featureRuns.js";
import { featureEntitled, featureRelease } from "./enterprisePolicy.js";
import { featureMultiplier } from "./featurePricing.js";
import { effectiveModel } from "./modelPricing.js";
import { resolveImageTask } from "./imageTaskConfiguration.js";

export type CapabilityOutputKind = "text" | "image" | "local_file";
export type CapabilityRuntimeOptions = { localAvailable?: boolean; imageStorageAvailable?: boolean };
export type CapabilityCard = {
  id: string;
  kind: "executor" | "feature" | "builtin";
  mode: "text" | "image" | "local";
  name: string;
  description: string;
  version: number;
  modelId?: string;
  modelName?: string;
  available: boolean;
  unavailableReason?: string;
  outputKinds: CapabilityOutputKind[];
  tools: string[];
  usageMultiplier?: number;
  executorId?: string;
  featureId?: string;
  releaseId?: string;
  taskKind?: AiTaskKind;
  routingRole?: "logic" | "writing" | "custom";
  requiresLocalConnection?: boolean;
};

const usableModel = (db: Database, id: string | undefined, kind: ModelConfig["kind"]) =>
  db.models.find((model) => model.id === id && model.enabled && model.kind === kind && !!model.apiKey);
const fallbackModel = (db: Database, kind: ModelConfig["kind"]) =>
  db.models.find((model) => model.enabled && model.kind === kind && model.isDefault && !!model.apiKey)
  ?? db.models.find((model) => model.enabled && model.kind === kind && !!model.apiKey);

/** Only metadata crosses this boundary: no credentials, URLs, prompts or tenant context. */
export function executorCapabilityCards(db: Database): CapabilityCard[] {
  const records = [{ id: "general", draft: executorDefaults(), enabled: true, published: undefined }, ...(db.settings.executorProfiles ?? [])];
  return records.map((record) => {
    const values = record.published ?? record.draft;
    const fallback = fallbackModel(db, "chat");
    const card: CapabilityCard = {
      id: `executor:${record.id}`, kind: "executor", mode: "text", name: values.name,
      description: values.description, version: record.published?.version ?? 0,
      modelId: values.modelId || undefined, available: false, outputKinds: ["text"],
      tools: [...values.tools], executorId: record.id, routingRole: values.routingRole ?? "custom",
    };
    if (!record.enabled || (record.id !== "general" && !record.published)) {
      card.unavailableReason = record.published ? "已停用" : "尚未发布";
      return card;
    }
    try {
      if (!fallback) throw new Error("没有可用的文字模型");
      const resolved = resolveExecutor(db, record.id, fallback);
      if (!resolved.model.apiKey) throw new Error("执行模型尚未配置");
      card.name = resolved.values.name;
      card.description = resolved.values.description;
      card.version = resolved.version;
      card.modelId = resolved.model.id;
      card.modelName = resolved.model.name;
      card.usageMultiplier = effectiveModel(resolved.model).pricing?.multiplier;
      card.tools = [...resolved.values.tools];
      card.available = true;
    } catch {
      card.unavailableReason = "执行模型不可用，请在能力配置中检查";
    }
    return card;
  });
}

export function builtinCapabilityCards(db: Database, options: CapabilityRuntimeOptions = {}): CapabilityCard[] {
  return aiTaskCatalog.filter((definition) => definition.id !== "coordinator").map((definition) => {
    const saved = db.settings.aiTasks?.[definition.id]?.published;
    const values = saved ?? defaultTaskValues(definition.id);
    const mode = definition.modelKind === "image" ? "image" : ["local_agent", "codex_execution"].includes(definition.id) ? "local" : "text";
    const fallback = definition.id === "image_generation" ? usableModel(db, saved?.modelId, "image") : fallbackModel(db, definition.modelKind);
    const card: CapabilityCard = {
      id: `builtin:${definition.id}`, kind: "builtin", mode, name: definition.name,
      description: definition.id === "image_generation" ? "生成图片并交付实际图片文件；用于绘图请求。"
        : definition.id === "codex_execution" ? "在用户确认的本机工作文件夹内创建、修改、检查文件与工程。"
        : definition.id === "local_agent" ? "在用户已授权的本机目录内完成受限文件操作。"
        : definition.id === "notion_writer" ? "根据要求准备文章并交给已授权的 Notion 写入流程。" : "ONE 内部处理步骤，可调整执行模型与提示词。",
      version: saved?.version ?? 0, available: false, outputKinds: mode === "image" ? ["image"] : mode === "local" ? ["local_file"] : ["text"],
      tools: [...values.tools], taskKind: definition.id,
      ...(definition.id === "image_generation" ? { executorId: "image_generation" } : mode === "local" ? { executorId: "local_special", requiresLocalConnection: true } : {}),
    };
    if (definition.id === "image_generation") {
      const selected = db.models.find((model) => model.id === saved?.modelId);
      card.modelId = selected?.id; card.modelName = selected?.name;
      try {
        const config = resolveImageTask(db, options.imageStorageAvailable === true);
        card.modelId = config.credentialModel.id; card.modelName = config.credentialModel.name;
        card.available = true;
      } catch (error) { card.unavailableReason = error instanceof Error ? error.message : "图片能力尚未配置"; }
      return card;
    }
    try {
      if (!fallback) throw new Error("没有类型匹配的可用模型");
      const model = resolveAiTask(db.settings, db.models, definition.id, fallback).model;
      if (!model.apiKey || !usableModel(db, model.id, definition.modelKind)) throw new Error("执行模型不可用");
      if (definition.id === "codex_execution" && model.protocol !== "openai") throw new Error("本机工程模型类型不兼容");
      card.modelId = model.id;
      card.modelName = model.name;
      card.usageMultiplier = effectiveModel(model).pricing?.multiplier;
      card.available = mode !== "local" || options.localAvailable === true;
      if (!card.available) card.unavailableReason = "需要连接本机执行器并确认工作文件夹";
    } catch {
      card.unavailableReason = "执行模型不可用，请在能力配置中检查";
    }
    return card;
  });
}

function featureCard(db: Database, record: NonNullable<Database["settings"]["officialFeatures"]>[number], scope?: FeatureScope): CapabilityCard {
  const release = scope ? featureRelease(db, scope, record) : record.release;
  const version = release ? record.history.find((item) => item.version === release.version) : record.current;
  const values = version?.values ?? record.draft;
  const mode = values.experience?.mode === "image" ? "image" : "text";
  const model = usableModel(db, values.modelId, mode === "image" ? "image" : "chat");
  const available = record.status === "approved" && !!release && !!version && !!model;
  return {
    id: `feature:${record.id}`, kind: "feature", mode, name: values.name, description: values.description,
    version: version?.version ?? 0, modelId: values.modelId, modelName: model?.name,
    available, unavailableReason: available ? undefined : record.status === "paused" ? "已停用" : !release ? "尚未上架给使用者" : "发布版本或执行模型不可用",
    outputKinds: mode === "image" ? ["image"] : ["text"], tools: values.tools?.map((tool) => tool.id) ?? [],
    usageMultiplier: featureMultiplier(values), featureId: record.id, releaseId: release?.id,
  };
}

/** Admin catalog is global configuration only. Scope catalog never exposes another workspace's private features. */
export function adminCapabilityCatalog(db: Database, options: CapabilityRuntimeOptions = {}): CapabilityCard[] {
  return [...executorCapabilityCards(db), ...builtinCapabilityCards(db, options), ...(db.settings.officialFeatures ?? []).map((record) => featureCard(db, record))];
}

/** A routing card describes a real server capability, not an authorization to execute it. */
export function routingCapabilities(db: Database, scope: FeatureScope, options: CapabilityRuntimeOptions = {}): CapabilityCard[] {
  featureMember(db, scope);
  const executors = executorCapabilityCards(db).filter((card) => {
    if (!card.available) return false;
    const profile = db.settings.executorProfiles?.find((record) => record.id === card.executorId);
    return (profile?.published?.featureIds ?? []).every((id) => {
      try { return !!availableFeature(db, scope, id); } catch { return false; }
    });
  });
  const builtins = builtinCapabilityCards(db, options).filter((card) => ["image_generation", "codex_execution"].includes(card.taskKind ?? "") && card.available);
  const features = (db.settings.officialFeatures ?? []).filter((record) => featureEntitled(db, scope, record)).map((record) => featureCard(db, record, scope)).filter((card) => card.available);
  return [...executors, ...builtins, ...features];
}
