import type { Database, ModelUsageRecord } from "./types.js";
import { powerAccount } from "./powerBilling.js";
import { publicUsageRecord, safeAdminAuditLog } from "./serializers.js";

const dayMs = 24 * 60 * 60 * 1000;
const reportingOffsetMs = 8 * 60 * 60 * 1000;

function timestamp(value?: string) { return value ? Date.parse(value) || 0 : 0; }

function totals(records: ModelUsageRecord[]) {
  return records.reduce((sum, item) => ({
    calls: sum.calls + 1,
    inputTokens: sum.inputTokens + item.inputTokens,
    outputTokens: sum.outputTokens + item.outputTokens,
    chargedMicros: sum.chargedMicros + (item.chargedMicros ?? 0),
    costMicros: sum.costMicros + (item.costMicros ?? 0),
    unknownCostCalls: sum.unknownCostCalls + (item.costMicros === undefined ? 1 : 0),
    reviewCalls: sum.reviewCalls + (item.status === "needs_review" ? 1 : 0),
    failedCalls: sum.failedCalls + (item.status === "failed" ? 1 : 0)
  }), { calls: 0, inputTokens: 0, outputTokens: 0, chargedMicros: 0, costMicros: 0, unknownCostCalls: 0, reviewCalls: 0, failedCalls: 0 });
}

export function adminUsageSummaries(db: Database, currentTime = Date.now()) {
  // Match the pilot's Asia/Shanghai calendar even when the server runs in UTC.
  const todayStart = Math.floor((currentTime + reportingOffsetMs) / dayMs) * dayMs - reportingOffsetMs;
  const sevenDaysAgo = currentTime - 7 * dayMs;
  return db.users.map((user) => {
    const workspaceId = user.defaultWorkspaceId;
    const records = db.modelUsageRecords.filter((item) => item.workspaceId === workspaceId && item.userId === user.id);
    const conversations = db.conversations.filter((item) => item.workspaceId === workspaceId && item.userId === user.id);
    const devices = db.oneKeyDevices.filter((item) => item.workspaceId === workspaceId && item.userId === user.id);
    const retrievals = db.retrievalLogs.filter((item) => item.workspaceId === workspaceId && item.userId === user.id);
    const executions = db.executionTasks.filter((item) => item.workspaceId === workspaceId && item.userId === user.id);
    const auditActivity = db.auditLogs.filter((item) => item.workspaceId === workspaceId && item.actorUserId === user.id);
    const activityTimes = [
      ...records.map((item) => item.createdAt),
      ...auditActivity.map((item) => item.createdAt),
      ...devices.flatMap((item) => item.lastUsedAt ? [item.lastUsedAt] : [])
    ].filter((value) => timestamp(value) <= currentTime).sort((a, b) => timestamp(b) - timestamp(a));
    return {
      userId: user.id,
      workspaceId,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      balanceMicros: powerAccount(db, workspaceId, user.id)?.balanceMicros ?? 0,
      reservedMicros: powerAccount(db, workspaceId, user.id)?.reservedMicros ?? 0,
      today: totals(records.filter((item) => timestamp(item.createdAt) >= todayStart && timestamp(item.createdAt) <= currentTime)),
      sevenDays: totals(records.filter((item) => timestamp(item.createdAt) >= sevenDaysAgo && timestamp(item.createdAt) <= currentTime)),
      total: totals(records),
      conversationCount: conversations.length,
      knowledgeRecallCount: retrievals.length,
      executionCount: executions.length,
      activeKeyCount: devices.filter((item) => item.status === "active").length,
      activeDays7d: new Set(activityTimes.filter((value) => timestamp(value) >= sevenDaysAgo).map((value) => Math.floor((timestamp(value) + reportingOffsetMs) / dayMs))).size,
      lastUsedAt: activityTimes[0]
    };
  }).sort((a, b) => timestamp(b.lastUsedAt) - timestamp(a.lastUsedAt));
}

export type AdminUsageDetailOptions = { period?: "all" | "7d" | "30d"; offset?: number; limit?: number };

export function adminUsageRecord(item: ModelUsageRecord) {
  return { ...publicUsageRecord(item), costMicros: item.costMicros,
    costInputPowerPerMillionSnapshot: item.costInputPowerPerMillionSnapshot,
    costOutputPowerPerMillionSnapshot: item.costOutputPowerPerMillionSnapshot,
    costImagePowerPerCallSnapshot: item.costImagePowerPerCallSnapshot, reviewReason: item.reviewReason };
}

export function adminUserUsageDetail(db: Database, userId: string, options: AdminUsageDetailOptions = {}, currentTime = Date.now()) {
  const user = db.users.find((item) => item.id === userId);
  if (!user) return null;
  const workspaceId = user.defaultWorkspaceId;
  const period = options.period === "7d" || options.period === "30d" ? options.period : "all";
  const since = period === "all" ? 0 : currentTime - (period === "7d" ? 7 : 30) * dayMs;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.floor(options.limit!))) : 20;
  const withinPeriod = (createdAt: string) => timestamp(createdAt) >= since && timestamp(createdAt) <= currentTime;
  const matchingUsage = db.modelUsageRecords
    .filter((item) => item.workspaceId === workspaceId && item.userId === user.id && withinPeriod(item.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const usage = matchingUsage.slice(offset, offset + limit)
    .map((item) => ({
      ...adminUsageRecord(item),
      username: user.username,
      modelName: db.models.find((model) => model.id === item.modelId)?.name || "已删除模型"
    }));
  const matchingActivity = db.auditLogs
    .filter((item) => item.workspaceId === workspaceId && item.actorUserId === user.id && withinPeriod(item.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const activity = matchingActivity.slice(0, 100).map(safeAdminAuditLog);
  return { user: { id: user.id, username: user.username, enabled: user.enabled, workspaceId }, usage, activity,
    period, pagination: { offset, limit, total: matchingUsage.length, hasMore: offset + usage.length < matchingUsage.length }, activityTotal: matchingActivity.length };
}
