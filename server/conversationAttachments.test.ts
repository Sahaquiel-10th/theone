import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationAttachmentContext, restoreConversationMessages, selectConversationAttachments } from "./conversationAttachments.js";
import type { Attachment, Conversation, Database, MessageRecord } from "./types.js";

const createdAt = "2026-09-01T00:00:00.000Z";
function attachment(id: string, patch: Partial<Attachment> = {}): Attachment {
  return { id, workspaceId: "workspace-a", userId: "user-a", originalName: `${id}.txt`, mimeType: "text/plain", kind: "text", size: 10, storagePath: `/private/mock/${id}.txt`, extractedText: `${id} contents`, createdAt, ...patch };
}
function message(id: string, attachmentIds: string[], patch: Partial<MessageRecord> = {}): MessageRecord {
  return { id, workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", role: "user", content: "test", attachmentIds, createdAt, ...patch };
}
function database(attachments: Attachment[], messages: MessageRecord[]) {
  const conversation: Conversation = { id: "conversation-a", workspaceId: "workspace-a", userId: "user-a", modelId: "model-a", archived: false, title: "A", messages: [], createdAt, updatedAt: createdAt };
  return { attachments, messages, conversations: [conversation] } as Database;
}
const scope = { workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a" };

test("follow-up questions retain previous user attachments from this conversation", () => {
  const db = database([attachment("old", { conversationId: "conversation-a" }), attachment("new")], [message("m-old", ["old"])]);
  const selected = selectConversationAttachments(db, scope, ["new"]);
  assert.deepEqual(selected.current.map(item => item.id), ["new"]);
  assert.deepEqual(selected.context.map(item => item.id), ["new", "old"]);
  assert.match(buildConversationAttachmentContext(selected.context).text, /new contents[\s\S]+old contents/);
  assert.deepEqual(selectConversationAttachments(db, scope, []).context.map(item => item.id), ["old"]);
});

test("attachment history is restricted by workspace, user, conversation and message role", () => {
  const db = database([
    attachment("allowed", { conversationId: "conversation-a" }), attachment("other-workspace", { workspaceId: "workspace-b" }),
    attachment("other-user", { userId: "user-b" }), attachment("other-chat", { conversationId: "conversation-b" }),
    attachment("generated", { kind: "image" }), attachment("unreferenced")
  ], [
    message("m-a", ["allowed", "other-workspace", "other-user", "other-chat"]),
    message("m-b", ["unreferenced"], { workspaceId: "workspace-b" }),
    message("m-c", ["unreferenced"], { userId: "user-b" }),
    message("m-d", ["unreferenced"], { conversationId: "conversation-b" }),
    message("m-generated", ["generated"], { role: "assistant" })
  ]);
  assert.deepEqual(selectConversationAttachments(db, scope, []).context.map(item => item.id), ["allowed"]);
  for (const id of ["other-workspace", "other-user", "other-chat", "missing"]) assert.throws(() => selectConversationAttachments(db, scope, [id]), /无权访问/);
  assert.throws(() => selectConversationAttachments(db, { ...scope, userId: "user-b" }, []), /对话不存在/);
});

test("current uploads precede the newest historical files, with deduplication and hard file/image caps", () => {
  const db = database([
    attachment("current"), attachment("old", { conversationId: "conversation-a" }), attachment("recent", { conversationId: "conversation-a" }),
    attachment("image-old", { kind: "image", conversationId: "conversation-a" }), attachment("image-new", { kind: "image" })
  ], [message("m-old", ["old", "image-old"]), message("m-new", ["recent", "recent"], { createdAt: "2026-09-02T00:00:00.000Z" })]);
  const files = selectConversationAttachments(db, scope, ["current", "current"], { maxFiles: 2 });
  assert.deepEqual(files.context.map(item => item.id), ["current", "recent"]);
  assert.equal(files.omittedCount, 2);
  const images = selectConversationAttachments(db, scope, ["image-new"], { maxImages: 1 });
  assert.equal(images.context.filter(item => item.kind === "image").length, 1);
  assert.equal(images.omittedCount, 1);
  assert.throws(() => selectConversationAttachments(db, scope, ["old", "recent"], { maxFiles: 1 }), /最多使用 1 个附件/);
  assert.throws(() => selectConversationAttachments(db, scope, ["image-old", "image-new"], { maxImages: 1 }), /最多使用 1 张图片/);
});

test("restart reconstruction restores safe summaries and rejects corrupt cross-owner references", () => {
  const db = database([attachment("allowed", { conversationId: "conversation-a" }), attachment("secret", { workspaceId: "workspace-b" }), attachment("other-chat", { conversationId: "conversation-b" })], [
    message("m-a", ["allowed", "secret", "other-chat", "missing"]), message("m-b", ["secret"], { userId: "user-b" })
  ]);
  const restored = restoreConversationMessages(db.conversations[0], db.messages, db.attachments);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].attachments?.map(item => item.id), ["allowed"]);
  assert.doesNotMatch(JSON.stringify(restored), /storagePath|extractedText|private\/mock|secret|other-chat/);
  assert.deepEqual(restored, restoreConversationMessages(db.conversations[0], JSON.parse(JSON.stringify(db.messages)), JSON.parse(JSON.stringify(db.attachments))));
});

test("restart reconstruction preserves per-answer diagnostics and feedback request identity", () => {
  const stored = message("answer-a", [], { role: "assistant", requestId: "request-a", attachmentWarning: "文件已截断", knowledgeDiagnostics: { status: "partial", failures: [{ provider: "getnote", code: "TIMEOUT", message: "知识来源响应超时", retryable: true }] } });
  const db = database([], [stored]);
  const [restored] = restoreConversationMessages(db.conversations[0], db.messages, db.attachments);
  assert.equal(restored.requestId, "request-a");
  assert.equal(restored.attachmentWarning, "文件已截断");
  assert.deepEqual(restored.knowledgeDiagnostics, stored.knowledgeDiagnostics);
});

test("new conversations cannot implicitly acquire unattached uploads or old conversations' files", () => {
  const db = database([attachment("unbound"), attachment("old", { conversationId: "conversation-a" })], [message("m-old", ["old"])]);
  assert.deepEqual(selectConversationAttachments(db, { workspaceId: "workspace-a", userId: "user-a" }, []).context, []);
  assert.deepEqual(selectConversationAttachments(db, { workspaceId: "workspace-a", userId: "user-a" }, ["unbound"]).context.map(item => item.id), ["unbound"]);
  assert.throws(() => selectConversationAttachments(db, { workspaceId: "workspace-a", userId: "user-a" }, ["old"]), /其他对话/);
});

test("attachment context marks untrusted text and communicates truncation within its total cap", () => {
  const result = buildConversationAttachmentContext([attachment("large", { extractedText: "x".repeat(10_000) }), attachment("omitted")], 1_000);
  assert.equal(result.truncated, true);
  assert.equal(result.omittedCount, 1);
  assert.ok(result.text.length <= 1_000);
  assert.match(result.text, /不可信参考资料/);
  assert.match(result.text, /已截断/);
  assert.doesNotMatch(result.text, /omitted contents/);
  assert.equal(buildConversationAttachmentContext([attachment("small")]).truncated, false);
});
