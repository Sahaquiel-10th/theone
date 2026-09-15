import assert from "node:assert/strict";
import test from "node:test";
import { betaEngagementSummary } from "./betaEngagement.js";
import type { Database } from "./types.js";

test("meaningful beta activity counts completed user answers, not logins, model steps or failed calls", () => {
  const db = {
    users: [{ id: "a", defaultWorkspaceId: "wa" }, { id: "b", defaultWorkspaceId: "wb" }],
    auditLogs: [
      { id: "login", workspaceId: "wa", actorUserId: "a", action: "one_key.login", createdAt: "2026-01-01T00:00:00Z" },
      { id: "failed", workspaceId: "wa", actorUserId: "a", action: "chat.failed", createdAt: "2026-01-02T00:00:00Z" },
      { id: "first", workspaceId: "wa", actorUserId: "a", action: "chat.completed", requestId: "req_first", details: { knowledgeUsed: true, content: "private" }, createdAt: "2026-01-03T15:00:00Z" },
      { id: "first-duplicate", workspaceId: "wa", actorUserId: "a", action: "chat.completed", requestId: "req_first", details: { knowledgeUsed: true }, createdAt: "2026-01-03T15:00:00Z" },
      { id: "second-day", workspaceId: "wa", actorUserId: "a", action: "chat.completed", requestId: "req_second", details: {}, createdAt: "2026-01-03T16:00:00Z" },
      { id: "other-space", workspaceId: "wb", actorUserId: "a", action: "chat.completed", createdAt: "2026-01-03T16:00:00Z" },
      { id: "other-user", workspaceId: "wa", actorUserId: "b", action: "chat.completed", createdAt: "2026-01-03T16:00:00Z" }
    ],
    executionTasks: [{ workspaceId: "wa", userId: "a", status: "failed", completedAt: "2026-01-03T16:00:00Z" }, { workspaceId: "wb", userId: "b", status: "completed", completedAt: "2026-01-03T16:00:00Z" }],
    modelUsageRecords: Array.from({ length: 20 }, () => ({ workspaceId: "wa", userId: "a", status: "success", activity: "local_agent_step" }))
  } as unknown as Database;
  const result = betaEngagementSummary(db, "a", Date.parse("2026-01-04T00:00:00Z"))!;
  assert.equal(result.completedAnswers, 2);
  assert.equal(result.todayCompletedAnswers, 1);
  assert.equal(result.knowledgeGroundedAnswers, 1);
  assert.equal(result.meaningfulActiveDays7d, 2);
  assert.equal(result.returnedOnAnotherDay, true);
  assert.equal(result.completedLocalTasks, 0);
  assert.equal(result.firstSuccessfulChatAt, "2026-01-03T15:00:00Z");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(betaEngagementSummary(db, "missing"), null);
});
