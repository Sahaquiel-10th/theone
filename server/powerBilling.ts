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

export function creditPower(db: Database, params: {
  workspaceId: string; userId: string; amountMicros: number; type: "gift" | "recharge" | "adjustment" | "refund";
  title: string; createdByUserId?: string;
}) {
  const account = powerAccount(db, params.workspaceId, params.userId);
  if (!account) throw new Error("电力账户不存在");
  if (!Number.isInteger(params.amountMicros) || params.amountMicros <= 0) throw new Error("电力数量必须大于 0");
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
  if (account.balanceMicros < params.amountMicros) throw new Error("电力不足，请先充值");
  const before = account.balanceMicros;
  account.balanceMicros -= params.amountMicros;
  account.updatedAt = new Date().toISOString();
  const entry = { id: uid("pwl"), workspaceId: params.workspaceId, userId: params.userId, type: "usage" as const, amountMicros: -params.amountMicros, balanceBeforeMicros: before, balanceAfterMicros: account.balanceMicros, title: params.title, modelId: params.modelId, usageRecordId: params.usageRecordId, createdAt: account.updatedAt };
  db.powerLedger.push(entry);
  return entry;
}
