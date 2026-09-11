import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskActivityRows, getSettledTaskTransitions, selectConversationExecution, shouldAutoReadTaskNotice } from "./oneTaskAttention";

const task = (id: string, conversationId: string, status: string, updatedAt = "2026-09-11T02:00:00Z") => ({ id, conversationId, status, updatedAt });
const conversation = (id: string, updatedAt = "2026-09-11T01:00:00Z", archived = false) => ({ id, title: `任务 ${id}`, updatedAt, archived });
const empty = () => new Set<string>();

test("explicit historical selection wins over running work in the same conversation", () => {
  const old = task("old", "one", "completed", "2026-09-11T01:00:00Z");
  const live = task("live", "one", "running");
  assert.equal(selectConversationExecution([live, old], "one", "old"), old);
});

test("invalid and cross-conversation selections fall back to this conversation's running task", () => {
  const live = task("live", "one", "running");
  const unrelated = task("other", "two", "completed", "2026-09-11T04:00:00Z");
  const tasks = [task("newest", "one", "completed", "2026-09-11T03:00:00Z"), live, unrelated];
  assert.equal(selectConversationExecution(tasks, "one", "missing"), live);
  assert.equal(selectConversationExecution(tasks, "one", "other"), live);
});

test("default execution selection prefers active work, then newest within its category", () => {
  const latestLive = task("live", "one", "selecting_target", "2026-09-11T03:00:00Z");
  const newest = task("complete", "one", "completed", "2026-09-11T04:00:00Z");
  const older = task("older", "one", "queued");
  assert.equal(selectConversationExecution([newest, older, latestLive], "one"), latestLive);
  assert.equal(selectConversationExecution([task("old", "one", "failed"), newest], "one"), newest);
});

test("selection returns null for absent conversations and ignores stale duplicate snapshots", () => {
  const completed = task("a", "one", "completed", "2026-09-11T03:00:00Z");
  assert.equal(selectConversationExecution([], "one"), null);
  assert.equal(selectConversationExecution([completed], "missing", "a"), null);
  assert.equal(selectConversationExecution([completed, task("a", "one", "running")], "one", "a"), completed);
});

test("execution selection preserves caller order and task values", () => {
  const tasks = [Object.freeze(task("a", "one", "completed")), Object.freeze(task("b", "one", "running"))];
  const original = JSON.stringify(tasks);
  selectConversationExecution(tasks, "one");
  selectConversationExecution(tasks, "one", "a");
  assert.equal(JSON.stringify(tasks), original);
});

test("only a visible matching conversation can automatically read a notice", () => {
  assert.equal(shouldAutoReadTaskNotice("one", "one", true), true);
  assert.equal(shouldAutoReadTaskNotice("one", "one", false), false);
  assert.equal(shouldAutoReadTaskNotice("one", "two", true), false);
  assert.equal(shouldAutoReadTaskNotice("", "one", true), false);
  assert.equal(shouldAutoReadTaskNotice("", "", true), false);
});

test("initial task history does not produce completion notifications", () => {
  assert.deepEqual(getSettledTaskTransitions([], [task("a", "one", "completed"), task("b", "two", "failed")]), []);
});

test("each live execution state can transition to each settled state", () => {
  for (const before of ["queued", "selecting_target", "running"]) {
    for (const after of ["completed", "failed", "cancelled"]) {
      const settled = { ...task("a", "one", after), output: "keeps generic fields" };
      assert.deepEqual(getSettledTaskTransitions([task("a", "one", before, "2026-09-11T01:00:00Z")], [settled]), [settled]);
    }
  }
});

test("repeated, stale, unknown and unrelated snapshots never notify", () => {
  const previous = [task("a", "one", "completed"), task("b", "two", "running"), task("c", "three", "running")];
  const current = [task("a", "one", "completed"), task("b", "two", "failed", "2026-09-11T01:59:59Z"), task("c", "three", "paused"), task("d", "four", "completed")];
  assert.deepEqual(getSettledTaskTransitions(previous, current), []);
  assert.deepEqual(getSettledTaskTransitions([task("a", "one", "running")], [task("a", "another", "completed")]), []);
});

test("live-to-settled transition at the same timestamp is not lost", () => {
  const completed = task("a", "one", "completed");
  assert.deepEqual(getSettledTaskTransitions([task("a", "one", "running")], [completed]), [completed]);
  assert.deepEqual(getSettledTaskTransitions([completed], [completed]), []);
});

test("resumed execution earns attention again when it next completes", () => {
  const first = task("a", "one", "completed", "2026-09-11T01:00:00Z");
  const resumed = task("a", "one", "running", "2026-09-11T02:00:00Z");
  const completed = task("a", "one", "completed", "2026-09-11T03:00:00Z");
  assert.deepEqual(getSettledTaskTransitions([first], [resumed]), []);
  assert.deepEqual(getSettledTaskTransitions([resumed], [completed]), [completed]);
});

test("duplicate snapshots use newest task states and notify once", () => {
  const running = task("a", "one", "running");
  const completed = task("a", "one", "completed", "2026-09-11T03:00:00Z");
  assert.deepEqual(getSettledTaskTransitions([running, task("a", "one", "completed", "2026-09-11T01:00:00Z")], [completed, completed, running]), [completed]);
});

test("activity chooses a running execution over newer terminal history", () => {
  const rows = buildTaskActivityRows([conversation("one")], [task("live", "one", "running"), task("newer", "one", "completed", "2026-09-11T03:00:00Z")], empty(), empty(), empty());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, "live");
  assert.equal(rows[0].status, "running");
});

test("activity chooses the newest task within the same execution category", () => {
  for (const status of ["queued", "selecting_target", "running", "completed", "failed", "cancelled"]) {
    const rows = buildTaskActivityRows([conversation("one")], [task("older", "one", status), task("newer", "one", status, "2026-09-11T03:00:00Z")], empty(), empty(), empty());
    assert.equal(rows[0].taskId, "newer");
    assert.equal(rows[0].status, ["queued", "selecting_target", "running"].includes(status) ? "running" : status);
  }
});

test("a stale duplicate task does not make completed work look active", () => {
  const rows = buildTaskActivityRows([conversation("one")], [task("a", "one", "completed", "2026-09-11T03:00:00Z"), task("a", "one", "running")], empty(), empty(), empty());
  assert.equal(rows[0].status, "completed");
});

test("execution outranks chat loading and failed sends; loading outranks failed sends", () => {
  const rows = buildTaskActivityRows([conversation("executing"), conversation("chatting"), conversation("failed")], [task("a", "executing", "queued"), task("b", "chatting", "completed"), task("c", "failed", "completed")], new Set(["executing", "chatting"]), new Set(["executing", "chatting", "failed"]), empty());
  assert.equal(rows.find(row => row.conversationId === "executing")?.status, "running");
  assert.equal(rows.find(row => row.conversationId === "chatting")?.status, "thinking");
  assert.equal(rows.find(row => row.conversationId === "failed")?.status, "failed");
});

test("ordinary conversations stay recent, including unrecognized task statuses", () => {
  const rows = buildTaskActivityRows([conversation("one"), conversation("two")], [task("a", "two", "unknown")], empty(), empty(), empty());
  assert.ok(rows.every(row => row.status === "recent"));
  assert.equal(rows.find(row => row.conversationId === "one")?.taskId, undefined);
});

test("archived conversations remain hidden unless busy or unread", () => {
  const ids = ["hidden", "running", "thinking", "unread", "failed"];
  const rows = buildTaskActivityRows(ids.map(id => conversation(id, undefined, true)), [task("a", "running", "selecting_target")], new Set(["thinking"]), new Set(["failed"]), new Set(["unread"]));
  assert.deepEqual(rows.map(row => row.conversationId).sort(), ["running", "thinking", "unread"]);
  assert.equal(rows.find(row => row.conversationId === "unread")?.unread, true);
});

test("tasks whose conversations have not loaded still have one readable row", () => {
  const rows = buildTaskActivityRows([], [task("a", "missing", "running"), task("b", "missing", "completed")], empty(), empty(), new Set(["missing"]));
  assert.deepEqual(rows, [{ conversationId: "missing", title: "本机任务", taskId: "a", status: "running", updatedAt: "2026-09-11T02:00:00Z", unread: true }]);
});

test("newest conversation metadata wins without duplicating activity", () => {
  const old = conversation("one");
  const newest = { ...old, title: "Updated title", updatedAt: "2026-09-11T04:00:00Z" };
  const rows = buildTaskActivityRows([newest, old], [task("a", "one", "completed")], empty(), empty(), empty());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Updated title");
  assert.equal(rows[0].updatedAt, newest.updatedAt);
});

test("activity sorts busy first, unread next, then most recently updated", () => {
  const ids = ["old", "unread", "new", "running", "thinking", "running-unread"];
  const rows = buildTaskActivityRows(ids.map(id => conversation(id, id === "new" ? "2026-09-11T10:00:00Z" : "2026-09-11T01:00:00Z")), [task("a", "running", "running"), task("b", "running-unread", "running", "2026-09-11T01:00:00Z")], new Set(["thinking"]), empty(), new Set(["unread", "running-unread"]));
  assert.deepEqual(rows.map(row => row.conversationId), ["running-unread", "running", "thinking", "unread", "new", "old"]);
});

test("helpers leave snapshots and caller-owned sets untouched", () => {
  const conversations = [Object.freeze(conversation("one")), Object.freeze(conversation("two"))];
  const previous = [Object.freeze(task("a", "one", "running"))];
  const tasks = [Object.freeze(task("a", "one", "completed"))];
  const loading = new Set(["two"]);
  const failed = new Set(["one"]);
  const unread = new Set(["one"]);
  const original = JSON.stringify({ conversations, previous, tasks, loading: [...loading], failed: [...failed], unread: [...unread] });
  getSettledTaskTransitions(previous, tasks);
  buildTaskActivityRows(conversations, tasks, loading, failed, unread);
  assert.equal(JSON.stringify({ conversations, previous, tasks, loading: [...loading], failed: [...failed], unread: [...unread] }), original);
});
