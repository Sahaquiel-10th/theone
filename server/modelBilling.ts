import type { Store } from "./db.js";
import type { Database, ModelConfig, ModelUsageRecord } from "./types.js";
import { MODEL_MAX_OUTPUT_TOKENS } from "./modelGateway.js";
import { calculateModelPower, chargePower, estimateTokenCeiling, MICROS_PER_POWER, powerAccount, releasePower, reservePower } from "./powerBilling.js";
import { uid } from "./security.js";

export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number; source: string };
type BillingParams = { workspaceId: string; userId: string; conversationId?: string; model: ModelConfig; input: unknown; activity: string; requestId: string };
type BillingScope = { usageId: string; workspaceId: string; userId: string };

export class BillingReviewRequiredError extends Error {
  readonly code = "BILLING_REVIEW_REQUIRED";
  constructor() { super("有一笔模型用量等待管理员核对，电力已暂时预留，请联系管理员后继续使用"); }
}

function validTokens(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validUsage(value?: ModelUsage): value is ModelUsage {
  return !!value && value.source === "provider" && validTokens(value.inputTokens) && validTokens(value.outputTokens)
    && validTokens(value.totalTokens) && value.totalTokens >= value.inputTokens + value.outputTokens;
}
function fixedMicros(value: number) {
  const amount = Math.ceil(value * MICROS_PER_POWER - 1e-7);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("模型计费价格无效，请联系管理员");
  return amount;
}

// Image bytes never become estimated billable tokens. This allowance is only a hold;
// settlement uses the provider's usage and caps the retail charge at this hold.
function estimateInputCeiling(input: unknown) {
  let images = 0;
  const text = JSON.stringify(input, (key, value: unknown) => {
    if (typeof value === "string" && /^data:image\//i.test(value)) { images++; return "[image]"; }
    if (key === "inputImages" && typeof value === "number") images += Math.max(0, value);
    return value;
  }) ?? "";
  return estimateTokenCeiling(text) + images * 32_768;
}

export function modelReservationMicros(model: ModelConfig, input: unknown) {
  if (model.kind === "image") {
    if (typeof model.imagePowerPerCall !== "number" || !Number.isFinite(model.imagePowerPerCall) || model.imagePowerPerCall <= 0
      || typeof model.costImagePowerPerCall !== "number" || !Number.isFinite(model.costImagePowerPerCall) || model.costImagePowerPerCall < 0) {
      throw new Error("图片模型尚未配置每次生成售价和成本，请联系管理员");
    }
    return fixedMicros(model.imagePowerPerCall);
  }
  for (const value of [model.inputPowerPerMillion, model.outputPowerPerMillion, model.costInputPowerPerMillion, model.costOutputPowerPerMillion]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("模型计费价格无效，请联系管理员");
  }
  const amount = calculateModelPower(model, estimateInputCeiling({ input, modelPrompt: model.systemPrompt }), MODEL_MAX_OUTPUT_TOKENS).chargedMicros;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("本次请求超过电力计费范围，请缩短输入");
  return amount;
}

function scopedRecord(db: Database, scope: BillingScope) {
  const row = db.modelUsageRecords.find((item) => item.id === scope.usageId && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  if (!row) throw new Error("用量记录不存在或不属于此用户");
  return row;
}
function pricingSnapshot(row: ModelUsageRecord): ModelConfig {
  return {
    inputPowerPerMillion: row.inputPowerPerMillionSnapshot ?? 0,
    outputPowerPerMillion: row.outputPowerPerMillionSnapshot ?? 0,
    costInputPowerPerMillion: row.costInputPowerPerMillionSnapshot ?? 0,
    costOutputPowerPerMillion: row.costOutputPowerPerMillionSnapshot ?? 0
  } as ModelConfig;
}

/** Idempotent: a final record can never release or charge the same hold twice. */
export function settleBillingRecord(db: Database, scope: BillingScope, usage: ModelUsage | undefined, durationMs: number) {
  const row = scopedRecord(db, scope);
  if (row.status !== "pending" && row.status !== "needs_review") return row;
  row.durationMs = Math.max(0, durationMs);
  row.completedAt = new Date().toISOString();
  const isFixedImage = typeof row.imagePowerPerCallSnapshot === "number";
  if (!isFixedImage && !validUsage(usage)) {
    row.status = "needs_review";
    row.source = "unknown";
    row.reviewReason = "provider_usage_missing_or_invalid";
    return row;
  }
  if (validUsage(usage)) {
    row.inputTokens = usage.inputTokens; row.outputTokens = usage.outputTokens; row.totalTokens = usage.totalTokens;
  }
  row.source = isFixedImage ? "fixed" : "provider";
  const calculated = isFixedImage
    ? { chargedMicros: fixedMicros(row.imagePowerPerCallSnapshot!), costMicros: fixedMicros(row.costImagePowerPerCallSnapshot ?? 0) }
    : calculateModelPower(pricingSnapshot(row), row.inputTokens, row.outputTokens);
  const held = row.reservedMicros ?? 0;
  const charged = Math.min(held, calculated.chargedMicros);
  releasePower(db, { workspaceId: row.workspaceId, userId: row.userId, amountMicros: held });
  chargePower(db, { workspaceId: row.workspaceId, userId: row.userId, amountMicros: charged, modelId: row.modelId, usageRecordId: row.id, title: row.activity || "模型调用" });
  row.chargedMicros = charged; row.calculatedChargeMicros = calculated.chargedMicros; row.costMicros = calculated.costMicros;
  row.billingCapped = charged < calculated.chargedMicros; row.reservedMicros = 0; row.status = "success"; row.reviewReason = undefined;
  return row;
}

export async function runBilledModel<T extends { usage?: ModelUsage }>(store: Store, params: BillingParams, call: (modelSnapshot: ModelConfig) => Promise<T>): Promise<T> {
  const model = structuredClone(params.model);
  const amountMicros = modelReservationMicros(model, params.input);
  const timestamp = new Date().toISOString();
  const row: ModelUsageRecord = {
    id: uid("use"), workspaceId: params.workspaceId, userId: params.userId, conversationId: params.conversationId ?? "",
    modelId: model.id, inputTokens: 0, outputTokens: 0, totalTokens: 0, source: "unknown", status: "pending",
    chargedMicros: 0, reservedMicros: amountMicros, activity: params.activity, requestId: params.requestId, createdAt: timestamp,
    inputPowerPerMillionSnapshot: model.inputPowerPerMillion, outputPowerPerMillionSnapshot: model.outputPowerPerMillion,
    costInputPowerPerMillionSnapshot: model.costInputPowerPerMillion, costOutputPowerPerMillionSnapshot: model.costOutputPowerPerMillion,
    ...(model.kind === "image" ? { imagePowerPerCallSnapshot: model.imagePowerPerCall, costImagePowerPerCallSnapshot: model.costImagePowerPerCall } : {})
  };
  await store.mutate((db) => {
    if (!db.users.some((item) => item.id === params.userId && item.enabled)
      || !db.workspaceMembers.some((item) => item.userId === params.userId && item.workspaceId === params.workspaceId)
      || !db.workspaces.some((item) => item.id === params.workspaceId && item.status === "active")) throw new Error("账号或个人空间不可用");
    if (!db.models.some((item) => item.id === model.id && item.enabled)) throw new Error("模型已停用，请重新选择");
    if (db.modelUsageRecords.some((item) => item.workspaceId === params.workspaceId && item.userId === params.userId && item.status === "needs_review")) throw new BillingReviewRequiredError();
    reservePower(db, { ...params, amountMicros });
    db.modelUsageRecords.push(row);
  });
  const scope = { usageId: row.id, workspaceId: row.workspaceId, userId: row.userId };
  const startedAt = Date.now();
  let result: T;
  try { result = await call(model); }
  catch (error) {
    try {
      await store.mutate((db) => {
        const failed = scopedRecord(db, scope);
        if (failed.status !== "pending") return;
        releasePower(db, { ...params, amountMicros: failed.reservedMicros ?? 0 });
        failed.status = "failed"; failed.reservedMicros = 0; failed.chargedMicros = 0;
        failed.durationMs = Date.now() - startedAt; failed.completedAt = new Date().toISOString();
        failed.reviewReason = "upstream_failed_cost_unknown";
      });
    } catch {
      // A transient failure while releasing must not leave an unreviewable hold.
      // If storage remains unavailable, startup recovery still reconciles pending.
      await store.mutate((db) => {
        const failed = scopedRecord(db, scope);
        if (failed.status !== "pending") return;
        failed.status = "needs_review";
        failed.reviewReason = "failure_release_storage_failed";
        failed.durationMs = Date.now() - startedAt;
        failed.completedAt = new Date().toISOString();
      }).catch(() => undefined);
    }
    throw error;
  }
  try { await store.mutate((db) => settleBillingRecord(db, scope, result.usage, Date.now() - startedAt)); }
  catch (error) {
    // The upstream may already have billed us. Never erase the durable pending row.
    await store.mutate((db) => {
      const uncertain = scopedRecord(db, scope);
      if (uncertain.status !== "pending") return;
      uncertain.status = "needs_review";
      uncertain.reviewReason = "settlement_storage_failed";
      uncertain.durationMs = Date.now() - startedAt;
    }).catch(() => undefined);
    throw error;
  }
  return result;
}

export function resolveBillingReview(db: Database, params: BillingScope & { action: "waive" | "provider_usage"; inputTokens?: number; outputTokens?: number }) {
  const row = scopedRecord(db, params);
  if (row.status === "success" || row.status === "waived") return row;
  if (row.status !== "needs_review") throw new Error("这笔用量不需要人工核对");
  if (params.action === "waive") {
    releasePower(db, { workspaceId: row.workspaceId, userId: row.userId, amountMicros: row.reservedMicros ?? 0 });
    row.status = "waived"; row.reservedMicros = 0; row.chargedMicros = 0; row.completedAt = new Date().toISOString();
    row.reviewReason = "admin_waived";
    return row;
  }
  if (!validTokens(params.inputTokens) || !validTokens(params.outputTokens) || !Number.isSafeInteger(params.inputTokens + params.outputTokens)) throw new Error("请输入上游账单中的非负整数 Token 用量");
  return settleBillingRecord(db, params, { inputTokens: params.inputTokens, outputTokens: params.outputTokens, totalTokens: params.inputTokens + params.outputTokens, source: "provider" }, row.durationMs ?? 0);
}

/** Single-process startup recovery: unknown calls keep their funds reserved for review. */
export function reconcileInterruptedBilling(db: Database) {
  for (const account of db.powerAccounts) account.reservedMicros = 0;
  for (const row of db.modelUsageRecords) {
    if (row.status === "pending") { row.status = "needs_review"; row.reviewReason = "server_restarted_before_settlement"; }
    if (row.status !== "needs_review") continue;
    const account = powerAccount(db, row.workspaceId, row.userId);
    if (account) account.reservedMicros = (account.reservedMicros ?? 0) + Math.max(0, row.reservedMicros ?? 0);
  }
}
