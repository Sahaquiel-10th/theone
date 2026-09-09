import test from "node:test";
import assert from "node:assert/strict";
import { mergeTaskSnapshots, recoverTaskDraft } from "./oneStudioState";

test("late task history never replaces a newer live completion", () => {
  const completed = { id: "a", updatedAt: "2026-09-10T02:00:00Z", status: "completed" };
  const result = mergeTaskSnapshots([completed], [{ ...completed, updatedAt: "2026-09-10T01:00:00Z", status: "running" }]);
  assert.deepEqual(result, [completed]);
});
test("task snapshots preserve other background tasks and update only matching ids", () => {
  const a = { id: "a", updatedAt: "1", status: "running" };
  const b = { id: "b", updatedAt: "2", status: "running" };
  assert.deepEqual(mergeTaskSnapshots([a, b], [{ ...a, updatedAt: "3", status: "completed" }]), [{ ...a, updatedAt: "3", status: "completed" }, b]);
});
test("failed send recovery preserves newer notes and deduplicates attachments", () => {
  const sent = { content: "first request", attachments: [{ id: "a" }] };
  const newer = { content: "a follow-up thought", attachments: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(recoverTaskDraft(sent, newer), { content: "first request\n\na follow-up thought", attachments: [{ id: "a" }, { id: "b" }] });
  assert.equal(newer.content, "a follow-up thought");
});
test("a failed task can restore its own draft without another task's content", () => {
  const sent = { content: "retry me", attachments: [{ id: "a" }] };
  assert.deepEqual(recoverTaskDraft(sent), sent);
});
