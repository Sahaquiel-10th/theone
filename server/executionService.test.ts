import assert from "node:assert/strict";
import test from "node:test";
import type { Database, ExecutionTask, MessageRecord } from "./types.js";
import { appendExecutionEvent, buildExecutionCompilerMessages, messagesThrough, publicExecutionTask, taskEvents, executionTrace } from "./executionService.js";

test("execution trace cannot expose another workspace or user's instruction", () => {
  const database = { executionTasks: [{ id: "t", workspaceId: "a", userId: "u", instruction: "private" }], messages: [] } as unknown as Database;
  assert.equal(executionTrace(database, "t", "b", "u"), undefined);
  assert.equal(executionTrace(database, "t", "a", "other"), undefined);
});

const records: MessageRecord[] = [
  { id: "m1", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", role: "user", content: "先分析登录问题", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "m2", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", role: "assistant", content: "建议检查 session", createdAt: "2026-01-01T00:00:01.000Z" },
  { id: "m3", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", role: "user", content: "不要改数据库", createdAt: "2026-01-01T00:00:02.000Z" },
  { id: "foreign", workspaceId: "workspace-b", userId: "user-b", conversationId: "c1", role: "user", content: "别人的内容", createdAt: "2026-01-01T00:00:00.500Z" }
];

test("execution handoff stops at the selected message and stays in the workspace", () => {
  const prefix = messagesThrough(records, "c1", "workspace-a", "m2");
  assert.deepEqual(prefix.map((item) => item.id), ["m1", "m2"]);
  const compiler = buildExecutionCompilerMessages(prefix, "m2")[0].content;
  assert.match(compiler, /建议检查 session/);
  assert.doesNotMatch(compiler, /不要改数据库/);
  assert.doesNotMatch(compiler, /别人的内容/);
});

test("public execution task never exposes the compiled instruction or device id", () => {
  const task = { id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", sourceMessageId: "m2", provider: "codex", status: "queued", instruction: "secret handoff", deviceId: "device-a", createdAt: "2026-01-01", updatedAt: "2026-01-01" } satisfies ExecutionTask;
  assert.equal("instruction" in publicExecutionTask(task), false);
  assert.equal("deviceId" in publicExecutionTask(task), false);
});

test("task events are isolated by workspace and user", () => {
  const task = { id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", sourceMessageId: "m2", provider: "codex", status: "queued", instruction: "x", deviceId: "device-a", createdAt: "2026-01-01", updatedAt: "2026-01-01" } satisfies ExecutionTask;
  const database = { executionEvents: [] } as unknown as Database;
  appendExecutionEvent(database, { id: "event-a", workspaceId: "workspace-a", userId: "user-a", taskId: task.id, kind: "message", text: "visible", createdAt: "2026-01-01" });
  appendExecutionEvent(database, { id: "event-b", workspaceId: "workspace-b", userId: "user-b", taskId: task.id, kind: "message", text: "hidden", createdAt: "2026-01-02" });
  assert.deepEqual(taskEvents(database, task).map((item) => item.text), ["visible"]);
});
