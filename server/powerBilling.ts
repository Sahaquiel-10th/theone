import { Database, ModelConfig } from "./types.js";
import { uid } from "./security.js";

export const MICROS_PER_POWER = 1_000_000;

function micros(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.ceil(value * MICROS_PER_POWER - 1e-7));
}

export function calculateModelPower(model: ModelConfig, inputTokens: number, outputTokens: number) {
  const chargedPower = inputTokens / 1_000_000 * model.inputPowerPerMillion
    + outputTokens / 1_000_000 * model.outputPowerPerMillion;
  const costPower = inputTokens / 1_000_000 * model.costInputPowerPerMillion
    + outputTokens / 1_000_000 * model.costOutputPowerPerMillion;
  return { chargedMicros: micros(chargedPower), costMicros: micros(costPower) };
}

export function powerAccount(db: Database, workspaceId: string, userId: string) {
  return db.powerAccounts.find((item) => item.workspaceId === workspaceId && item.userId === userId);
}

export function availablePowerMicros(db: Database, workspaceId: string, userId: string) {
  const account = powerAccount(db, workspaceId, userId);
  return account ? Math.max(0, account.balanceMicros - (account.reservedMicros ?? 0)) : 0;
}

export function estimateTokenCeiling(value: unknown) {
  // Conservative text-only reservation estimate, not a promise about provider billing.
  // Vision/hidden-token overruns are handled by the durable settlement's retail cap.
  return Math.max(1, Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8"));
}

export function reservePower(db: Database, params: {
  workspaceId: string; userId: string; amountMicros: number;
}) {
  const account = powerAccount(db, params.workspaceId, params.userId);
  if (!account) throw new Error("电力账户不存在");
  if (!Number.isSafeInteger(params.amountMicros) || params.amountMicros < 0) throw new Error("预占电力必须是非负整数");
  if (availablePowerMicros(db, params.workspaceId, params.userId) < params.amountMicros) throw new Error("电力不足，请先充值");
  account.reservedMicros = (account.reservedMicros ?? 0) + params.amountMicros;
  account.updatedAt = new Date().toISOString();
  return params.amountMicros;
}

export function releasePower(db: Database, params: {
  workspaceId: string; userId: string; amountMicros: number;
}) {
  const account = powerAccount(db, params.workspaceId, params.userId);
  if (!account) throw new Error("电力账户不存在");
  account.reservedMicros = Math.max(0, (account.reservedMicros ?? 0) - Math.max(0, params.amountMicros));
  account.updatedAt = new Date().toISOString();
}

export function creditPower(db: Database, params: {
  workspaceId: string; userId: string; amountMicros: number; type: "gift" | "recharge" | "adjustment" | "refund";
  title: string; createdByUserId?: string;
}) {
  const account = powerAccount(db, params.workspaceId, params.userId);
  if (!account) throw new Error("电力账户不存在");
  if (!Number.isSafeInteger(params.amountMicros) || params.amountMicros <= 0 || !Number.isSafeInteger(account.balanceMicros + params.amountMicros)) throw new Error("电力数量必须为有效正数");
  const before = account.balanceMicros;
  account.balanceMicros += params.amountMicros;
  account.updatedAt = new Date().toISOString();
  const entry = { id: uid("pwl"), workspaceId: params.workspaceId, userId: params.userId, type: params.type, amountMicros: params.amountMicros, balanceBeforeMicros: before, balanceAfterMicros: account.balanceMicros, title: params.title, createdByUserId: params.createdByUserId, createdAt: account.updatedAt } as const;
  db.powerLedger.push(entry);
  return entry;
}

export function chargePower(db: Database, params: {
  workspaceId: string; userId: string; amountMicros: number; modelId: string; usageRecordId: string; title: string;
}) {
  const account = powerAccount(db, params.workspaceId, params.userId);
  if (!account) throw new Error("电力账户不存在");
  if (!Number.isSafeInteger(params.amountMicros) || params.amountMicros < 0) throw new Error("扣费必须是有效的非负整数");
  if (availablePowerMicros(db, params.workspaceId, params.userId) < params.amountMicros) throw new Error("电力不足，请先充值");
  const before = account.balanceMicros;
  account.balanceMicros -= params.amountMicros;
  account.updatedAt = new Date().toISOString();
  const entry = { id: uid("pwl"), workspaceId: params.workspaceId, userId: params.userId, type: "usage" as const, amountMicros: -params.amountMicros, balanceBeforeMicros: before, balanceAfterMicros: account.balanceMicros, title: params.title, modelId: params.modelId, usageRecordId: params.usageRecordId, createdAt: account.updatedAt };
  db.powerLedger.push(entry);
  return entry;
}
