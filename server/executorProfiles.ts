import type { Database, ModelConfig } from "./types.js";
import {
  defaultTaskValues,
  resolveAiTask,
  validateTaskValues,
  type AiTaskValues,
} from "./aiTaskConfig.js";
import { uid } from "./security.js";

export type ExecutorValues = AiTaskValues & {
  name: string;
  description: string;
  featureIds: string[];
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
  return {
    ...validateTaskValues("task_worker", v, db.models),
    name: v.name.trim(),
    description: v.description.trim(),
    featureIds: [...new Set(v.featureIds)],
  };
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
