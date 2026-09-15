import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chatSubmission, forgetChatSubmission, pendingChatSubmissions } from "./chatSubmission";

function storageFor(t: TestContext, blocked = false) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem(key: string) { if (blocked) throw new Error("Storage disabled"); return values.get(key) ?? null; },
      setItem(key: string, value: string) { if (blocked) throw new Error("Storage disabled"); values.set(key, value); }
    }
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  return values;
}

test("ambiguous retries retain the original operation ID until explicitly resolved", async t => {
  storageFor(t);
  const userId = randomUUID();
  const payload = { content: "请继续原来的回答", conversationId: "conversation-a", attachmentIds: ["attachment-a"] };
  const original = await chatSubmission(userId, payload);
  // A timeout, 401, 404 or 428 is not a resolution. The caller must leave this ID intact.
  for (const status of [504, 401, 404, 428]) {
    assert.equal(await chatSubmission(userId, { ...payload }), original, `unresolved ${status} retry`);
  }
  assert.equal(pendingChatSubmissions(userId).length, 1);
});

test("operation IDs and pending lists are isolated by user", async t => {
  storageFor(t);
  const userA = randomUUID();
  const userB = randomUUID();
  const payload = { content: "same question", conversationId: "same-id" };
  const first = await chatSubmission(userA, payload);
  const second = await chatSubmission(userB, payload);
  assert.notEqual(first, second);
  assert.deepEqual(pendingChatSubmissions(userA).map(item => item.operationId), [first]);
  assert.deepEqual(pendingChatSubmissions(userB).map(item => item.operationId), [second]);
  forgetChatSubmission(userA, second);
  assert.equal(await chatSubmission(userA, payload), first);
  assert.equal(await chatSubmission(userB, payload), second);
});

test("resolved or explicitly safe submissions can be forgotten without clearing other requests", async t => {
  storageFor(t);
  const userId = randomUUID();
  const resolvedPayload = { content: "completed request" };
  const unresolvedPayload = { content: "still pending request" };
  const resolved = await chatSubmission(userId, resolvedPayload);
  const unresolved = await chatSubmission(userId, unresolvedPayload);
  forgetChatSubmission(userId, resolved);
  assert.deepEqual(pendingChatSubmissions(userId).map(item => item.operationId), [unresolved]);
  assert.equal(await chatSubmission(userId, unresolvedPayload), unresolved);
  assert.notEqual(await chatSubmission(userId, resolvedPayload), resolved);
});

test("browser storage contains only operation metadata, never prompt or credential text", async t => {
  const storage = storageFor(t);
  const userId = randomUUID();
  const payload = { content: "PRIVATE_PROMPT_SENTINEL", attachmentIds: ["PRIVATE_FILE_SENTINEL"], token: "FAKE_SECRET_SENTINEL" };
  const operationId = await chatSubmission(userId, payload);
  const serialized = storage.get(`one.pending-chat:${userId}`)!;
  assert.ok(serialized.includes(operationId));
  for (const sentinel of Object.values(payload).flat()) assert.ok(!serialized.includes(sentinel));
  const [record] = JSON.parse(serialized);
  assert.deepEqual(Object.keys(record).sort(), ["createdAt", "fingerprint", "operationId"]);
  assert.match(record.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
});

test("blocked browser storage still reuses and explicitly releases the in-memory operation", async t => {
  storageFor(t, true);
  const userId = randomUUID();
  const payload = { content: "private-mode retry" };
  const original = await chatSubmission(userId, payload);
  assert.equal(await chatSubmission(userId, payload), original);
  assert.deepEqual(pendingChatSubmissions(userId).map(item => item.operationId), [original]);
  forgetChatSubmission(userId, original);
  assert.deepEqual(pendingChatSubmissions(userId), []);
  assert.notEqual(await chatSubmission(userId, payload), original);
});

test("the pending limit blocks new requests instead of evicting ambiguous operations", async t => {
  storageFor(t);
  const userId = randomUUID();
  const operations = [];
  for (let index = 0; index < 50; index++) operations.push(await chatSubmission(userId, { content: `request-${index}` }));
  assert.equal(pendingChatSubmissions(userId).length, 50);
  await assert.rejects(chatSubmission(userId, { content: "one request too many" }), /尚未确认的消息较多/);
  assert.deepEqual(pendingChatSubmissions(userId).map(item => item.operationId), operations);
  assert.equal(await chatSubmission(userId, { content: "request-0" }), operations[0]);
  forgetChatSubmission(userId, operations[20]);
  const next = await chatSubmission(userId, { content: "one request too many" });
  assert.equal(pendingChatSubmissions(userId).length, 50);
  assert.ok(!operations.includes(next));
  assert.equal(await chatSubmission(userId, { content: "request-0" }), operations[0]);
});

test("persisted metadata is reused after an earlier page instance, with malformed storage ignored", async t => {
  const storage = storageFor(t);
  const firstUser = randomUUID();
  const reloadedUser = randomUUID();
  const payload = { content: "persisted request" };
  const original = await chatSubmission(firstUser, payload);
  // Loading the same persisted entry under a fresh test user avoids any module-level memory entry.
  storage.set(`one.pending-chat:${reloadedUser}`, storage.get(`one.pending-chat:${firstUser}`)!);
  assert.equal(await chatSubmission(reloadedUser, payload), original);
  const malformedUser = randomUUID();
  storage.set(`one.pending-chat:${malformedUser}`, "not json");
  assert.deepEqual(pendingChatSubmissions(malformedUser), []);
  assert.match(await chatSubmission(malformedUser, { content: "new" }), /^[a-f0-9-]{36}$/);
});
