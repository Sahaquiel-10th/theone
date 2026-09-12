import assert from "node:assert/strict";
import test from "node:test";
import { adminUsageSummaries, adminUserUsageDetail } from "./adminUsage.js";
import type { Database } from "./types.js";

function database() {
  return {
    users: [
      { id: "a", username: "A", role: "user", defaultWorkspaceId: "wa", enabled: true, passwordHash: "x", createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", username: "B", role: "user", defaultWorkspaceId: "wb", enabled: true, passwordHash: "x", createdAt: "2026-01-01T00:00:00Z" }
    ],
    workspaces: [], workspaceMembers: [], conversationFolders: [], models: [{ id: "m", name: "Model" }], conversations: [
      { id: "ca", workspaceId: "wa", userId: "a", title: "A only", updatedAt: "2026-01-03T00:00:00Z" },
      { id: "cb", workspaceId: "wb", userId: "b", title: "B only", updatedAt: "2026-01-04T00:00:00Z" }
    ], messages: [], userSavedMemories: [], retrievalLogs: [], contextTraces: [],
    modelUsageRecords: [
      { id: "ua", workspaceId: "wa", userId: "a", conversationId: "ca", modelId: "m", inputTokens: 10, outputTokens: 2, totalTokens: 12, source: "provider", chargedMicros: 100, costMicros: 50, createdAt: "2026-01-03T00:00:00Z" },
      { id: "ub", workspaceId: "wb", userId: "b", conversationId: "cb", modelId: "m", inputTokens: 20, outputTokens: 3, totalTokens: 23, source: "provider", chargedMicros: 200, costMicros: 80, createdAt: "2026-01-04T00:00:00Z" }
    ],
    knowledgeConnections: [], oneKeyDevices: [], deviceChallenges: [], oneTimeLoginCodes: [],
    powerAccounts: [
      { id: "pa", workspaceId: "wa", userId: "a", balanceMicros: 1_000, createdAt: "x", updatedAt: "x" },
      { id: "pb", workspaceId: "wb", userId: "b", balanceMicros: 2_000, createdAt: "x", updatedAt: "x" }
    ], powerLedger: [], rechargeOrders: [], auditLogs: [], agents: [], attachments: [], executionTasks: [], executionEvents: [],
    settings: { safetyRules: "", rechargeCnyPerPower: 7 }
  } as unknown as Database;
}

test("admin usage summaries keep every user's tenant totals separate", () => {
  const summaries = adminUsageSummaries(database(), Date.parse("2026-01-05T00:00:00Z"));
  assert.equal(summaries.find((item) => item.userId === "a")?.total.chargedMicros, 100);
  assert.equal(summaries.find((item) => item.userId === "b")?.total.chargedMicros, 200);
});

test("user usage detail cannot mix another workspace's calls or reveal private conversation titles", () => {
  const detail = adminUserUsageDetail(database(), "a");
  assert.deepEqual(detail?.usage.map((item) => item.id), ["ua"]);
  assert.equal("conversationTitle" in detail!.usage[0], false);
  assert.equal(JSON.stringify(detail).includes("A only"), false);
  assert.equal(JSON.stringify(detail).includes("B only"), false);
});

test("usage details match both user and workspace, even with cross-tenant IDs", () => {
  const db = database();
  db.modelUsageRecords.push({ ...db.modelUsageRecords[0], id: "wrong-workspace", workspaceId: "wb" });
  db.modelUsageRecords.push({ ...db.modelUsageRecords[0], id: "wrong-user", userId: "b" });
  db.auditLogs.push(
    { id: "good", workspaceId: "wa", actorUserId: "a", action: "chat.completed", targetType: "conversation", details: { query: "private thought" }, createdAt: "2026-01-03T00:00:00Z" },
    { id: "wrong-workspace", workspaceId: "wb", actorUserId: "a", action: "chat.completed", targetType: "conversation", createdAt: "2026-01-03T00:00:00Z" },
    { id: "wrong-user", workspaceId: "wa", actorUserId: "b", action: "chat.completed", targetType: "conversation", createdAt: "2026-01-03T00:00:00Z" }
  );
  const detail = adminUserUsageDetail(db, "a");
  assert.deepEqual(detail?.usage.map((item) => item.id), ["ua"]);
  assert.deepEqual(detail?.activity.map((item) => item.id), ["good"]);
  assert.equal(JSON.stringify(detail).includes("private thought"), false);
});

test("new un-used accounts and freshly issued Keys are not reported as active usage", () => {
  const db = database();
  db.modelUsageRecords = [];
  db.oneKeyDevices.push({ id: "new-key", userId: "a", workspaceId: "wa", status: "active", createdAt: "2026-01-04T23:00:00Z", serialNumber: "ONE-001", publicKey: "public" });
  const summary = adminUsageSummaries(db, Date.parse("2026-01-05T00:00:00Z")).find((item) => item.userId === "a")!;
  assert.equal(summary.lastUsedAt, undefined);
  assert.equal(summary.activeDays7d, 0);
  assert.equal(summary.activeKeyCount, 1);
});

test("daily usage uses the China reporting day independent of server timezone", () => {
  const db = database();
  db.modelUsageRecords = [
    { ...db.modelUsageRecords[0], id: "yesterday", createdAt: "2026-01-04T15:59:59Z" },
    { ...db.modelUsageRecords[0], id: "today", createdAt: "2026-01-04T16:00:00Z" }
  ];
  const summary = adminUsageSummaries(db, Date.parse("2026-01-05T01:00:00Z")).find((item) => item.userId === "a")!;
  assert.equal(summary.today.calls, 1);
  assert.equal(summary.total.calls, 2);
  assert.equal(summary.activeDays7d, 2);
});

test("usage history is server-paginated and period filtering keeps whole totals", () => {
  const db = database();
  const original = db.modelUsageRecords[0];
  db.modelUsageRecords = Array.from({ length: 45 }, (_, index) => ({ ...original, id: `u${String(index).padStart(2, "0")}`,
    createdAt: new Date(Date.parse("2026-01-05T00:00:00Z") - index * 24 * 60 * 60 * 1000).toISOString() }));
  const page = adminUserUsageDetail(db, "a", { offset: 20, limit: 20 }, Date.parse("2026-01-05T01:00:00Z"))!;
  assert.equal(page.usage.length, 20);
  assert.equal(page.usage[0].id, "u20");
  assert.deepEqual(page.pagination, { offset: 20, limit: 20, total: 45, hasMore: true });
  const week = adminUserUsageDetail(db, "a", { period: "7d", offset: 0, limit: 20 }, Date.parse("2026-01-05T01:00:00Z"))!;
  assert.equal(week.pagination.total, 7);
  assert.equal(week.period, "7d");
  assert.equal(week.pagination.hasMore, false);
  const bounded = adminUserUsageDetail(db, "a", { offset: -10, limit: 100_000 }, Date.parse("2026-01-05T01:00:00Z"))!;
  assert.equal(bounded.pagination.offset, 0);
  assert.equal(bounded.pagination.limit, 100);
});
