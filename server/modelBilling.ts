import type { Store } from "./db.js";
import type { CacheUsage, Database, ModelConfig, ModelUsageRecord } from "./types.js";
import { outputTokenLimit } from "./modelGateway.js";
import { calculateModelPower, contextPricedModel, chargePower, estimateTokenCeiling, MICROS_PER_POWER, powerAccount, releasePower, reservePower } from "./powerBilling.js";
import { uid } from "./security.js";
import { effectiveModel } from "./modelPricing.js";
import {reserveCommerce,releaseCommerce,settleCommerce,restoreCommerceHolds} from './commerceBilling.js';
import type {PublicCommerceSnapshot} from './publicSharingTypes.js';
import { activeMember, billingAccountUserId, companyWorkspace } from './enterprisePolicy.js';
import { featurePricedModel, type FeaturePrice } from './featurePricing.js';
import { reserveExecutionBatchBudget, type ExecutionBatchBudget } from './executionBatchBudget.js';
import {inputProfile} from './oneContext.js';

export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cacheUsage?: CacheUsage; source: string };
type BillingParams = { maxOutputTokens?: number; sponsorship?:{kind:'welcome_gift';operationId:string;stage?:'manual'|'image'}; batchBudget?: ExecutionBatchBudget; featurePrice?: FeaturePrice; workspaceId: string; userId: string; conversationId?: string; model: ModelConfig; input: unknown; activity: string; requestId: string; beforeReserve?: (db: Database, amountMicros: number) => void;commerce?:PublicCommerceSnapshot };
type BillingScope = { usageId: string; workspaceId: string; userId: string };

export class BillingReviewRequiredError extends Error {
  readonly code = "BILLING_REVIEW_REQUIRED";
  constructor() { super("有一笔模型用量等待管理员核对，电力已暂时预留，请联系管理员后继续使用"); }
}
/** A reviewed error code, without raw storage/provider exception text. */
export class ModelBillingError extends Error {
  readonly code='BILLING_SETTLEMENT_FAILED';
  constructor(){super('本次模型用量结算未完成，需要管理员核对');}
}

function validTokens(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validUsage(value?: ModelUsage): value is ModelUsage {
  if (value?.cacheUsage && (![value.cacheUsage.read, value.cacheUsage.write, value.cacheUsage.write5m, value.cacheUsage.write1h].every(validTokens) || value.cacheUsage.write < value.cacheUsage.write5m + value.cacheUsage.write1h || !Number.isSafeInteger(value.inputTokens + value.outputTokens + value.cacheUsage.read + value.cacheUsage.write) || value.totalTokens < value.inputTokens + value.outputTokens + value.cacheUsage.read + value.cacheUsage.write)) return false;
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

export function modelReservationMicros(model: ModelConfig, input: unknown, maxOutputTokens?: number) {
  const outputLimit = outputTokenLimit(maxOutputTokens);
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
  const high = model.pricing?.longContext ? contextPricedModel(model, model.pricing.longContext.thresholdInputTokens + 1) : model;
  const maximumInput = Math.max(model.inputPowerPerMillion, ...Object.values(model.cachePrices || {}), high.inputPowerPerMillion, ...Object.values(high.cachePrices || {}));
  const messages=(input as {messages?:{role?:string;content?:unknown}[]}|null)?.messages;
  const promptIncluded=!model.systemPrompt?.trim()||Array.isArray(messages)&&messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.includes(model.systemPrompt.trim()));
  const amount = calculateModelPower({ ...model, pricing: undefined, inputPowerPerMillion: maximumInput, outputPowerPerMillion: Math.max(model.outputPowerPerMillion, high.outputPowerPerMillion) }, estimateInputCeiling(promptIncluded?input:{input,modelPrompt:model.systemPrompt}), outputLimit).chargedMicros;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("本次请求超过电力计费范围，请缩短输入");
  return amount;
}

/** Size a document call to existing authorized headroom, without enlarging the
 * budget or starting a call with only a token-sized allowance left. The atomic
 * reservation still rechecks races immediately before calling the provider. */
export function affordableDocumentOutput(model:ModelConfig,input:unknown,availableMicros:number){
  const priced=effectiveModel(model);
  if(!Number.isSafeInteger(availableMicros)||availableMicros<0||modelReservationMicros(priced,input,3000)>availableMicros)return undefined;
  let low=3000,high=12000;
  while(low<high){const middle=Math.ceil((low+high)/2);if(modelReservationMicros(priced,input,middle)<=availableMicros)low=middle;else high=middle-1;}
  return low;
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
    costOutputPowerPerMillion: row.costOutputPowerPerMillionSnapshot ?? 0,
    cachePrices: row.cachePricesSnapshot, cacheCostPrices: row.cacheCostPricesSnapshot,
    pricing: row.pricingSnapshot, longContextCostPrices: row.longContextCostPricesSnapshot
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
    row.inputTokens = usage.inputTokens; row.outputTokens = usage.outputTokens; row.totalTokens = usage.totalTokens; row.cacheUsage = usage.cacheUsage;
  }
  row.source = isFixedImage ? "fixed" : "provider";
  row.promptTokens = row.inputTokens + (row.cacheUsage?.read ?? 0) + (row.cacheUsage?.write ?? 0);
  row.contextPriceTier = row.pricingSnapshot?.longContext && row.promptTokens > row.pricingSnapshot.longContext.thresholdInputTokens ? "long" : "standard";
  const selected = contextPricedModel(pricingSnapshot(row), row.inputTokens, row.cacheUsage);
  if (!isFixedImage && row.cacheUsage && row.cacheUsage.read + row.cacheUsage.write > 0 && (!selected.cachePrices || !selected.cacheCostPrices)) {
    row.status = "needs_review"; row.reviewReason = "cache_pricing_missing"; return row;
  }
  const calculated = isFixedImage
    ? { chargedMicros: fixedMicros(row.imagePowerPerCallSnapshot!), costMicros: fixedMicros(row.costImagePowerPerCallSnapshot ?? 0) }
    : calculateModelPower(pricingSnapshot(row), row.inputTokens, row.outputTokens, row.cacheUsage);
  const held = row.reservedMicros ?? 0;
  const charged = Math.min(held, calculated.chargedMicros);
  if(row.commercial)settleCommerce(db,row,charged);
  else if(!row.sponsorship) {if(!powerAccount(db,row.workspaceId,row.userId)?.powerHolds?.some(h=>h.id===row.id))releasePower(db, { workspaceId: row.workspaceId, userId: row.userId, amountMicros: held });
  chargePower(db, { workspaceId: row.workspaceId, userId: row.userId, amountMicros: charged, modelId: row.modelId, usageRecordId: row.id, holdId:row.id, title: row.activity || "模型调用" });}
  row.chargedMicros = charged; row.calculatedChargeMicros = calculated.chargedMicros; row.costMicros = calculated.costMicros;
  row.billingCapped = !row.sponsorship&&charged < calculated.chargedMicros; row.reservedMicros = 0; row.status = "success"; row.reviewReason = undefined;
  return row;
}

export async function runBilledModel<T extends { usage?: ModelUsage; finishReason?: import("./modelGateway.js").ModelFinishReason }>(store: Store, params: BillingParams, call: (modelSnapshot: ModelConfig) => Promise<T>): Promise<T> {
  const model = params.featurePrice ? featurePricedModel(params.model, params.featurePrice.multiplier) : effectiveModel(params.model);
  const amountMicros = modelReservationMicros(model, params.input, params.maxOutputTokens);
  const timestamp = new Date().toISOString();
  const row: ModelUsageRecord = {
    inputProfile:inputProfile(params.input,params.workspaceId),
    sponsorship:params.sponsorship?structuredClone(params.sponsorship):undefined,
    featurePriceSnapshot: params.featurePrice ? structuredClone(params.featurePrice) : undefined,
    aiTaskVersion: params.input && typeof params.input === "object" && "taskVersion" in params.input && Number.isSafeInteger(params.input.taskVersion) ? Number(params.input.taskVersion) : undefined,
    id: uid("use"), workspaceId: params.workspaceId, userId: params.userId, conversationId: params.conversationId ?? "",
    pricingSnapshot: structuredClone(model.pricing), longContextCostPricesSnapshot: structuredClone(model.longContextCostPrices), modelNameSnapshot: model.name, cachePricesSnapshot: structuredClone(model.cachePrices), cacheCostPricesSnapshot: structuredClone(model.cacheCostPrices),
    modelId: model.id, inputTokens: 0, outputTokens: 0, totalTokens: 0, source: "unknown", status: "pending",
    chargedMicros: 0, reservedMicros: amountMicros, activity: params.activity, requestId: params.requestId, createdAt: timestamp,
    inputPowerPerMillionSnapshot: model.inputPowerPerMillion, outputPowerPerMillionSnapshot: model.outputPowerPerMillion,
    costInputPowerPerMillionSnapshot: model.costInputPowerPerMillion, costOutputPowerPerMillionSnapshot: model.costOutputPowerPerMillion,
    ...(model.kind === "image" ? { imagePowerPerCallSnapshot: model.imagePowerPerCall, costImagePowerPerCallSnapshot: model.costImagePowerPerCall } : {})
  };
  await store.mutate((db) => {
    if (!db.users.some((item) => item.id === params.userId && item.enabled)
      || !activeMember(db, params)
      || !db.workspaces.some((item) => item.id === params.workspaceId && item.status === "active")) throw new Error("账号或个人空间不可用");
    if (!db.models.some((item) => item.id === model.id && item.enabled)) throw new Error("模型已停用，请重新选择");
    if(params.sponsorship){
      const gift=params.sponsorship.operationId;
      const profile=db.users.find(u=>u.id===params.userId&&u.defaultWorkspaceId===params.workspaceId)?.profile;
      const job=db.chatOperations?.find(o=>o.workspaceId===params.workspaceId&&o.userId===params.userId&&o.requestId===params.requestId&&o.conversationId===params.conversationId)?.workRun;
      const stage=params.sponsorship.stage??'image';
      const validStage=stage==='image'?model.kind==='image'&&(model.costImagePowerPerCall??Infinity)<=.5:model.kind==='chat'&&job?.welcomeManual?.model.id===model.id&&job.welcomeManual.reservation>=amountMicros&&amountMicros<=500000&&params.activity==='welcome_manual'&&!job.welcomeManual.document;
      if(!validStage||params.featurePrice||params.commerce||params.batchBudget||profile?.workspaceId!==params.workspaceId||profile.onboarding.welcomeGiftOperationId!==gift||job?.kind!=='image'||!job.welcomeSponsored||job.welcomeOperationId!==gift||job.state!=='running'||db.modelUsageRecords.some(r=>r.workspaceId===params.workspaceId&&r.userId===params.userId&&r.sponsorship?.operationId===gift&&(r.sponsorship?.stage??'image')===stage))throw new Error('欢迎礼物赠送资格无效或已使用');
      row.reservedMicros=0;row.activity='首次使用说明（ONE承担）';
    }
    // An uncertain bill keeps its own reservation. It must not lock unrelated
    // calls or the next step of an otherwise healthy local execution. The
    // ordinary payer/budget checks below only spend the remaining free balance.
    params.beforeReserve?.(db, amountMicros);
    row.batchBudget = reserveExecutionBatchBudget(db, params, params.requestId, amountMicros, params.batchBudget);
    if(!params.sponsorship&&companyWorkspace(db,params.workspaceId)) {
      if(params.commerce)throw new Error('企业费用不能通过公开分享支付');
      row.payerUserId=billingAccountUserId(db,params.workspaceId,params.userId);
      const limit=activeMember(db,params)?.permissions?.powerLimitMicros;
      const used=db.modelUsageRecords.filter(r=>r.workspaceId===params.workspaceId&&r.userId===params.userId).reduce((sum,r)=>sum+(r.chargedMicros??0)+(r.reservedMicros??0),0);
      if(limit!==undefined&&used+amountMicros>limit)throw new Error('本次调用超过公司为你设置的累计电力额度');
    }
    if(params.commerce)reserveCommerce(db,row,params.commerce,amountMicros);
    else if(!params.sponsorship) reservePower(db, { ...params, amountMicros, holdId:row.id });
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
        if(failed.commercial){releaseCommerce(db,failed);failed.commercial.status='released';}
        else if(!failed.sponsorship) releasePower(db, { ...params, amountMicros: failed.reservedMicros ?? 0, holdId:failed.id });
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
  try { await store.mutate((db) => { const record = settleBillingRecord(db, scope, result.usage, Date.now() - startedAt); record.finishReason = result.finishReason; }); }
  catch (error) {
    // The upstream may already have billed us. Never erase the durable pending row.
    await store.mutate((db) => {
      const uncertain = scopedRecord(db, scope);
      if (uncertain.status !== "pending") return;
      uncertain.status = "needs_review";
      uncertain.reviewReason = "settlement_storage_failed";
      uncertain.durationMs = Date.now() - startedAt;
    }).catch(() => undefined);
    throw new ModelBillingError();
  }
  return result;
}

export function resolveBillingReview(db: Database, params: BillingScope & { action: "waive" | "provider_usage"; inputTokens?: number; outputTokens?: number; cacheUsage?: CacheUsage }) {
  const row = scopedRecord(db, params);
  if (row.status === "success" || row.status === "waived") return row;
  if (row.status !== "needs_review") throw new Error("这笔用量不需要人工核对");
  if (params.action === "waive") {
    if(row.commercial){releaseCommerce(db,row);row.commercial.status='released';}
    else if(!row.sponsorship) releasePower(db, { workspaceId: row.workspaceId, userId: row.userId, amountMicros: row.reservedMicros ?? 0, holdId:row.id });
    row.status = "waived"; row.reservedMicros = 0; row.chargedMicros = 0; row.completedAt = new Date().toISOString();
    row.reviewReason = "admin_waived";
    return row;
  }
  if (!validTokens(params.inputTokens) || !validTokens(params.outputTokens) || !Number.isSafeInteger(params.inputTokens + params.outputTokens)) throw new Error("请输入上游账单中的非负整数 Token 用量");
  const cacheUsage = params.cacheUsage ?? row.cacheUsage;
  const checked = { inputTokens: params.inputTokens, outputTokens: params.outputTokens, totalTokens: params.inputTokens + params.outputTokens + (cacheUsage?.read ?? 0) + (cacheUsage?.write ?? 0), cacheUsage, source: "provider" };
  if (!validUsage(checked)) throw new Error("缓存用量不完整或不一致");
  const selected = contextPricedModel(pricingSnapshot(row), params.inputTokens, cacheUsage);
  if (cacheUsage && cacheUsage.read + cacheUsage.write > 0 && (!selected.cachePrices || !selected.cacheCostPrices)) throw new Error("本次调用缺少缓存价格快照，不能按新价补扣；请免扣释放预占");
  return settleBillingRecord(db, params, checked, row.durationMs ?? 0);
}

/** Single-process startup recovery: unknown calls keep their funds reserved for review. */
export function reconcileInterruptedBilling(db: Database) {
  for (const account of db.powerAccounts) {
    account.reservedMicros=0;
    account.powerHolds=account.powerHolds?.filter(h=>db.modelUsageRecords.some(r=>(r.status==='pending'||r.status==='needs_review')&&(h.id===r.id||h.id===`${r.id}:payer`||h.id===`${r.id}:publisher`)));
  }
  for (const row of db.modelUsageRecords) {
    if (row.status === "pending") { row.status = "needs_review"; row.reviewReason = "server_restarted_before_settlement"; }
    if (row.status !== "needs_review") continue;
    if(row.sponsorship)continue;
    if(row.commercial){restoreCommerceHolds(db,row);continue;}
    const account = powerAccount(db, row.workspaceId, row.userId);
    if (account) account.reservedMicros = (account.reservedMicros ?? 0) + Math.max(0, row.reservedMicros ?? 0);
  }
}
