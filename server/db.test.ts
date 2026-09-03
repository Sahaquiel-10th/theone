import assert from "node:assert/strict";
import test from "node:test";
import { relationalRecordMetadata } from "./dbRelationalMetadata.js";
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
