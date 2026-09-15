import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "./db.js";
import type { Conversation, Database, Message } from "./types.js";
import { beginChatOperation, bindChatOperationConversation, ChatOperationError, completeChatOperation, failChatOperation, failChatOperationInMutation, getChatOperationResult, reconcileInterruptedChatOperations } from "./chatOperations.js";
import type { ChatOperation } from "./chatOperations.js";

type TestDatabase = Database & { chatOperations: ChatOperation[] };
const scope = { workspaceId: "wa", userId: "a", operationId: "client-operation-0001" };
const payload = { content: "personal question", modelId: "model", attachmentIds: ["attachment-a"], webSearch: false };
const start = { ...scope, requestId: "server-request-1", payload };

function fixture(snapshot?: TestDatabase) {
  let db = snapshot ? structuredClone(snapshot) : {
    users: [{ id: "a", enabled: true }, { id: "b", enabled: true }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }],
    workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }],
    conversations: [], chatOperations: []
  } as unknown as TestDatabase;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(fn: (db: Database) => T) => {
    const next = queue.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } });
    queue = next.catch(() => undefined); return next;
  } };
  return { store, db: () => db };
}

function conversation(id = "conversation-a", workspaceId = "wa", userId = "a"): Conversation {
  return { id, workspaceId, userId, modelId: "model", title: "personal question", archived: false, messages: [], createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" };
}
const userMessage: Message = { id: "user-message", role: "user", content: "personal question", createdAt: "2026-09-13T00:00:01.000Z" };
const assistantMessage: Message = { id: "assistant-message", role: "assistant", content: "private answer", sources: [{ title: "private source", url: "https://example.com/note", snippet: "private snippet" }], createdAt: "2026-09-13T00:00:02.000Z" };

async function finish(f: ReturnType<typeof fixture>) {
  await f.store.mutate(db => {
    const target = conversation(); target.messages.push(structuredClone(userMessage));
    db.conversations.push(target);
    bindChatOperationConversation(db, scope, target.id);
  });
  await f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  });
}

const code = (expected: ChatOperationError["code"]) => (error: unknown) => error instanceof ChatOperationError && error.code === expected;

test("response-loss retry and process restart reuse the saved answer without retrieval, model or charge", async () => {
  let f = fixture(); let retrievals = 0; let calls = 0; let charges = 0;
  async function request() {
    const begun = await beginChatOperation(f.store, start);
    if (begun.kind === "started") { retrievals++; calls++; charges++; await finish(f); }
    return getChatOperationResult(f.db(), scope);
  }
  const original = await request();
  // The first HTTP response was lost. The browser must reuse the original operation id.
  f = fixture(f.db()); reconcileInterruptedChatOperations(f.db());
  const repeated = await request();
  assert.deepEqual(repeated, original);
  assert.deepEqual([retrievals, calls, charges], [1, 1, 1]);
  assert.equal(f.db().chatOperations.length, 1);
  assert.equal(f.db().chatOperations[0].requestId, "server-request-1");
  assert.ok(!JSON.stringify(f.db().chatOperations).includes("private answer"));
  assert.ok(!JSON.stringify(f.db().chatOperations).includes("personal question"));
});

test("parallel identical requests are rejected safely while only one operation is reserved", async () => {
  const f = fixture();
  const results = await Promise.allSettled([beginChatOperation(f.store, start), beginChatOperation(f.store, { ...start, requestId: "server-request-2" })]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  const rejected = results.find(item => item.status === "rejected") as PromiseRejectedResult;
  assert.ok(code("CHAT_OPERATION_PENDING")(rejected.reason));
  assert.equal(rejected.reason.details.requestId, "server-request-1");
  assert.equal(f.db().chatOperations.length, 1);
});

test("same operation id with changed content, model, attachment or options never executes", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  for (const changed of [{ ...payload, content: "another question" }, { ...payload, modelId: "other" }, { ...payload, attachmentIds: ["other"] }, { ...payload, webSearch: true }]) {
    await assert.rejects(beginChatOperation(f.store, { ...start, payload: changed }), code("CHAT_OPERATION_CONFLICT"));
  }
  assert.equal(f.db().chatOperations.length, 1);
});

test("equivalent JSON object key order hashes identically", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  const repeated = await beginChatOperation(f.store, { ...start, payload: { webSearch: false, attachmentIds: ["attachment-a"], modelId: "model", content: "personal question", omitted: undefined } });
  assert.equal(repeated.kind, "completed");
});

test("same-conversation concurrent different operations are blocked until the first completes", async () => {
  const f = fixture(); f.db().conversations.push(conversation());
  await beginChatOperation(f.store, { ...start, conversationId: "conversation-a" });
  const second = { ...start, operationId: "client-operation-0002", conversationId: "conversation-a" };
  await assert.rejects(beginChatOperation(f.store, second), code("CHAT_CONVERSATION_BUSY"));
  await f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  });
  assert.equal((await beginChatOperation(f.store, second)).kind, "started");
});

test("new conversations gain the same serialization guard as existing conversations", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push(conversation());
  bindChatOperationConversation(f.db(), scope, "conversation-a");
  await assert.rejects(beginChatOperation(f.store, { ...start, operationId: "client-operation-0002", conversationId: "conversation-a" }), code("CHAT_CONVERSATION_BUSY"));
  f.db().conversations.push(conversation("other"));
  assert.throws(() => bindChatOperationConversation(f.db(), scope, "other"), code("CHAT_OPERATION_CONFLICT"));
});

test("workspace and user scopes prevent both replay access and foreign-conversation binding", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  const other = { ...scope, workspaceId: "wb", userId: "b" };
  assert.throws(() => getChatOperationResult(f.db(), other), code("CHAT_OPERATION_NOT_FOUND"));
  await assert.rejects(beginChatOperation(f.store, { ...start, ...other, conversationId: "conversation-a" }), code("CHAT_OPERATION_NOT_FOUND"));
  await assert.rejects(beginChatOperation(f.store, { ...start, workspaceId: "wb" }), code("CHAT_OPERATION_FORBIDDEN"));
  assert.equal((await beginChatOperation(f.store, { ...start, ...other })).kind, "started");
  assert.notEqual(f.db().chatOperations[0].id, f.db().chatOperations[1].id);
  assert.throws(() => bindChatOperationConversation(f.db(), other, "conversation-a"), code("CHAT_OPERATION_NOT_FOUND"));
  // Shared workspace membership does not allow one user to read another user's result.
  f.db().workspaceMembers.push({ id: "membership", workspaceId: "wa", userId: "b", role: "member", createdAt: "now" });
  assert.throws(() => getChatOperationResult(f.db(), { ...scope, userId: "b" }), code("CHAT_OPERATION_NOT_FOUND"));
});

test("disabled users and suspended workspaces cannot replay previously saved private results", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  f.db().users[0].enabled = false;
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_FORBIDDEN"));
  f.db().users[0].enabled = true; f.db().workspaces[0].status = "suspended";
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_FORBIDDEN"));
});

test("replay is detached and ends at the original assistant reply, not later messages", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  f.db().conversations[0].messages.push({ ...userMessage, id: "later", content: "later text" });
  const replay = getChatOperationResult(f.db(), scope);
  assert.equal(replay.conversation.messages.length, 2);
  assert.equal(replay.message.id, assistantMessage.id);
  replay.message.content = "mutated response";
  replay.message.sources![0].snippet = "mutated snippet";
  assert.equal(f.db().conversations[0].messages[1].content, "private answer");
  assert.equal(f.db().conversations[0].messages[1].sources![0].snippet, "private snippet");
});

test("deleted conversation leaves a tombstone so an old request cannot cause another charge", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  f.db().conversations = [];
  assert.equal((await beginChatOperation(f.store, start)).kind, "completed");
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_RESULT_UNAVAILABLE"));
  assert.equal(f.db().chatOperations.length, 1);
});

test("restart changes unfinished requests to uncertain without ever re-executing them", async () => {
  let f = fixture(); await beginChatOperation(f.store, start);
  f = fixture(f.db()); reconcileInterruptedChatOperations(f.db()); reconcileInterruptedChatOperations(f.db());
  assert.equal(f.db().chatOperations[0].status, "interrupted");
  await assert.rejects(beginChatOperation(f.store, start), code("CHAT_OPERATION_INTERRUPTED"));
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_INTERRUPTED"));
  assert.equal(f.db().chatOperations[0].retryable, false);
});

test("failed attempts stay failed for the same operation id; known safe failures permit an explicit new operation", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  await failChatOperation(f.store, scope, { retryable: true });
  await assert.rejects(beginChatOperation(f.store, start), (error: unknown) => code("CHAT_OPERATION_FAILED")(error) && (error as ChatOperationError).details.retryable === true);
  assert.equal((await beginChatOperation(f.store, { ...start, operationId: "client-operation-0002" })).kind, "started");
});

test("an after-completion HTTP failure never overwrites the durable successful result", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  await failChatOperation(f.store, scope);
  completeChatOperation(f.db(), scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  assert.equal((await beginChatOperation(f.store, start)).kind, "completed");
  assert.equal(f.db().chatOperations[0].status, "completed");
});

test("failed result transaction rolls back both response and completion; retry remains safely blocked", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push(conversation()); bindChatOperationConversation(f.db(), scope, "conversation-a");
  await assert.rejects(f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
    throw Error("simulated persistence failure");
  }), /simulated/);
  assert.equal(f.db().conversations[0].messages.length, 0);
  assert.equal(f.db().chatOperations[0].status, "pending");
  await assert.rejects(beginChatOperation(f.store, start), code("CHAT_OPERATION_PENDING"));
});

test("invalid operation ids and non-JSON payloads cannot reserve rows", async () => {
  const f = fixture();
  for (const operationId of ["", "short", "x".repeat(129), "has/slash/invalid"])
    await assert.rejects(beginChatOperation(f.store, { ...start, operationId }), code("CHAT_OPERATION_INVALID"));
  await assert.rejects(beginChatOperation(f.store, { ...start, payload: { invalid: Infinity } }), code("CHAT_OPERATION_INVALID"));
  assert.equal(f.db().chatOperations.length, 0);
});

test("failed-message cleanup and conversation unlock commit atomically, including storage failure", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push({ ...conversation(), messages: [structuredClone(userMessage)] });
  bindChatOperationConversation(f.db(), scope, "conversation-a");
  f.db().attachments = [{ id: "attachment-a", workspaceId: scope.workspaceId, userId: scope.userId, conversationId: "conversation-a", messageId: userMessage.id }] as Database["attachments"];
  const clean = (db: Database) => {
    db.conversations[0].messages = [];
    delete db.attachments[0].messageId; delete db.attachments[0].conversationId;
    failChatOperationInMutation(db, scope, { retryable: true });
  };
  await assert.rejects(f.store.mutate(db => { clean(db); throw Error("storage unavailable"); }), /storage unavailable/);
  assert.equal(f.db().conversations[0].messages.length, 1);
  assert.equal(f.db().attachments[0].messageId, userMessage.id);
  assert.equal(f.db().chatOperations[0].status, "pending");
  await assert.rejects(beginChatOperation(f.store, { ...start, conversationId: "conversation-a", operationId: "client-operation-0002" }), code("CHAT_CONVERSATION_BUSY"));
  await f.store.mutate(clean);
  assert.equal(f.db().conversations[0].messages.length, 0);
  assert.equal(f.db().attachments[0].messageId, undefined);
  assert.equal(f.db().chatOperations[0].status, "failed");
  assert.equal((await beginChatOperation(f.store, { ...start, conversationId: "conversation-a", operationId: "client-operation-0002" })).kind, "started");
});

test("mid-call account disable permits durable finalization, never public replay access", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push(conversation()); bindChatOperationConversation(f.db(), scope, "conversation-a");
  f.db().users[0].enabled = false;
  await f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  });
  assert.equal(f.db().chatOperations[0].status, "completed");
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_FORBIDDEN"));
  f.db().users[0].enabled = true;
  assert.equal(getChatOperationResult(f.db(), scope).message.content, "private answer");
});

test("mid-call account disable still permits failure cleanup with strict operation ownership", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().users[0].enabled = false;
  assert.throws(() => failChatOperationInMutation(f.db(), { ...scope, workspaceId: "wb", userId: "b" }), code("CHAT_OPERATION_NOT_FOUND"));
  assert.throws(() => completeChatOperation(f.db(), { ...scope, workspaceId: "wb", userId: "b" }, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! }), code("CHAT_OPERATION_NOT_FOUND"));
  await failChatOperation(f.store, scope, { retryable: true });
  assert.equal(f.db().chatOperations[0].status, "failed");
});
