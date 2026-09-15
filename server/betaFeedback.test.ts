import assert from "node:assert/strict";
import test from "node:test";
import { adminBetaFeedback, ownBetaFeedback, saveBetaFeedback } from "./betaFeedback.js";
import { BetaInputError } from "./betaProfile.js";
import { safeAdminAuditLog } from "./serializers.js";
import type { Database } from "./types.js";

function database() {
  return {
    users: [{ id: "a", role: "user", defaultWorkspaceId: "wa", enabled: true }, { id: "b", role: "user", defaultWorkspaceId: "wb", enabled: true }, { id: "admin", role: "admin", defaultWorkspaceId: "admin-w", enabled: true }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }, { id: "admin-w", status: "active" }],
    workspaceMembers: [{ workspaceId: "wa", userId: "a" }, { workspaceId: "wb", userId: "b" }, { workspaceId: "admin-w", userId: "admin" }],
    conversations: [{ id: "ca", workspaceId: "wa", userId: "a", title: "a private title" }, { id: "cb", workspaceId: "wb", userId: "b", title: "b private title" }],
    messages: [{ id: "ma", workspaceId: "wa", userId: "a", conversationId: "ca", role: "assistant", content: "a private answer" }, { id: "mb", workspaceId: "wb", userId: "b", conversationId: "cb", role: "assistant", content: "b private answer" }, { id: "mu", workspaceId: "wa", userId: "a", conversationId: "ca", role: "user", content: "private question" }],
    contextTraces: [{ assistantMessageId: "ma", workspaceId: "wa", userId: "a", conversationId: "ca", requestId: "req_a", query: "private query" }],
    auditLogs: []
  } as unknown as Database;
}
const a = { userId: "a", workspaceId: "wa" };
const admin = { userId: "admin", workspaceId: "admin-w" };

test("feedback copies no private message, source, or conversation title and derives its own request ID", () => {
  const db = database();
  const saved = saveBetaFeedback(db, a, { messageId: "ma", rating: "helped", requestId: "forged" } as never);
  assert.equal(saved.requestId, "req_a");
  assert.equal(saved.sharedComment, false);
  assert.equal(JSON.stringify(db.auditLogs).includes("private"), false);
  const adminView = adminBetaFeedback(db, admin, "a");
  assert.equal(adminView.helped, 1);
  assert.equal(JSON.stringify(adminView).includes("private"), false);
});

test("feedback request IDs survive trace retention and prefer the exact saved message request", () => {
  const db = database();
  db.messages[0].requestId = "req_message";
  assert.equal(saveBetaFeedback(db, a, { messageId: "ma", rating: "helped" }).requestId, "req_message");
  db.contextTraces = [];
  db.messages[0].requestId = undefined;
  assert.equal(saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved" }).requestId, "req_message");
});

test("feedback rejects foreign messages and workspace spoofing including same-workspace different-user records", () => {
  const db = database();
  assert.throws(() => saveBetaFeedback(db, a, { messageId: "mb", rating: "not_solved" }), /消息不存在/);
  assert.throws(() => saveBetaFeedback(db, { userId: "a", workspaceId: "wb" }, { messageId: "mb", rating: "helped" }), BetaInputError);
  db.messages.push({ ...db.messages[0], id: "same-space-other-user", userId: "b" });
  assert.throws(() => saveBetaFeedback(db, a, { messageId: "same-space-other-user", rating: "helped" }), /消息不存在/);
  assert.throws(() => saveBetaFeedback(db, a, { messageId: "mu", rating: "helped" }), /消息不存在/);
  assert.throws(() => ownBetaFeedback(db, a, "cb"), /对话不存在/);
  assert.throws(() => adminBetaFeedback(db, a, "b"), /超管/);
});

test("optional feedback comments require explicit consent and appear only on dedicated feedback view", () => {
  const db = database();
  assert.throws(() => saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved", comment: "I want to share this" }), /确认同意/);
  saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved", comment: "I want to share this", shareComment: true });
  assert.equal(adminBetaFeedback(db, admin, "a").items[0].comment, "I want to share this");
  assert.equal(JSON.stringify(safeAdminAuditLog(db.auditLogs[0])).includes("I want to share this"), false);
  assert.throws(() => saveBetaFeedback(db, a, { messageId: "ma", rating: "helped", comment: "x".repeat(501), shareComment: true }), /500/);
  assert.throws(() => saveBetaFeedback(db, a, { messageId: "ma", rating: "other" }), BetaInputError);
});

test("feedback revisions append events, identical retries do not duplicate, and stats count one current rating per answer", () => {
  const db = database();
  saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved" }, "2026-01-01T00:00:00Z");
  saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved" }, "2026-01-01T00:00:01Z");
  assert.equal(db.auditLogs.length, 1);
  saveBetaFeedback(db, a, { messageId: "ma", rating: "helped" }, "2026-01-01T00:00:01Z");
  assert.equal(db.auditLogs.length, 2);
  assert.equal(adminBetaFeedback(db, admin, "a").helped, 1);
  assert.equal(adminBetaFeedback(db, admin, "a").notSolved, 0);
  assert.equal(ownBetaFeedback(db, a, "ca")[0].rating, "helped");
  assert.equal(adminBetaFeedback(db, admin, "b").pagination.total, 0);
});

test("latest feedback survives unordered SQL rows and identical update timestamps", () => {
  const db = database();
  const timestamp = "2026-01-01T00:00:00Z";
  saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved" }, timestamp);
  saveBetaFeedback(db, a, { messageId: "ma", rating: "helped" }, timestamp);
  db.auditLogs.reverse();
  assert.equal(ownBetaFeedback(db, a, "ca")[0].rating, "helped");
  saveBetaFeedback(db, a, { messageId: "ma", rating: "not_solved" }, timestamp);
  db.auditLogs.reverse();
  assert.equal(adminBetaFeedback(db, admin, "a").notSolved, 1);
  assert.equal(Math.max(...db.auditLogs.map(log => Number(log.details?.feedbackRevision))), 3);
});
