import assert from "node:assert/strict";
import test from "node:test";
import { relationalRecordMetadata, restoreRelationalRecordOrder } from "./dbRelationalMetadata.js";
import type { Database } from "./types.js";

const database = {
  oneKeyDevices: [
    { id: "device-a", serialNumber: "ONE-A", workspaceId: "workspace-a", userId: "user-a" },
    { id: "device-b", serialNumber: "ONE-B", workspaceId: "workspace-b", userId: "user-b" }
  ],
  executionTasks: []
} as unknown as Database;

test("relational metadata preserves the exact workspace boundary", () => {
  const messageA = { id: "message-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a" };
  const messageB = { id: "message-b", workspaceId: "workspace-b", userId: "user-b", conversationId: "conversation-b" };

  assert.deepEqual(relationalRecordMetadata("messages", messageA, database), {
    workspaceId: "workspace-a", userId: "user-a", parentId: "conversation-a", lookupKey: null
  });
  assert.deepEqual(relationalRecordMetadata("messages", messageB, database), {
    workspaceId: "workspace-b", userId: "user-b", parentId: "conversation-b", lookupKey: null
  });
});

test("device-derived records inherit only their bound workspace", () => {
  assert.equal(relationalRecordMetadata("deviceChallenges", { id: "challenge-a", deviceId: "device-a" }, database).workspaceId, "workspace-a");
  assert.equal(relationalRecordMetadata("deviceChallenges", { id: "challenge-b", deviceId: "device-b" }, database).workspaceId, "workspace-b");
});

test('restart restores job creation order without changing identities, receipts or catalog arrangement',()=>{
  const old={id:'z-old',workspaceId:'a',userId:'u',createdAt:'2026-10-20T00:22:00Z',updatedAt:'2026-10-20T06:00:00Z',notionReceipt:{state:'verified'}};
  const next={id:'a-next',workspaceId:'a',userId:'u',createdAt:'2026-10-20T00:27:00Z',notionReceipt:{state:'uncertain'}};
  const foreign={id:'foreign',workspaceId:'b',userId:'v',createdAt:'2026-10-20T00:24:00Z'};
  const sqlRows=[next,foreign,old],before=structuredClone(sqlRows);
  const restored=restoreRelationalRecordOrder('chatOperations',sqlRows);
  assert.deepEqual(restored.map(r=>r.id),['z-old','foreign','a-next']);
  assert.deepEqual(restored.filter(r=>r.workspaceId==='a').at(-1),next);
  assert.deepEqual(sqlRows,before,'do not mutate source rows or receipts');
  assert.equal(restoreRelationalRecordOrder('models',sqlRows),sqlRows,'catalog order is intentional');
});
