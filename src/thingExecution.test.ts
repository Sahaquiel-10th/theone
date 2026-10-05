import test from "node:test";
import assert from "node:assert/strict";
import { thingExecutionSource } from "./thingExecution.js";

test("Things execution belongs to the selected saved thread, through its latest message", () => {
  const thing = { id: "selected-not-workbench", messages: [
    { id: "u", role: "user", content: "整理资料" },
    { id: "a", role: "assistant", content: "已讨论好的方案" },
    { id: "empty", role: "assistant", content: " " },
  ] };
  assert.deepEqual(thingExecutionSource(thing), { conversationId: thing.id, sourceMessageId: "a" });
  assert.equal(thing.messages.length, 3);
  assert.equal(thingExecutionSource({ ...thing, messagesLoaded: false }), undefined);
  assert.equal(thingExecutionSource({ ...thing, id: "tmp_unsaved" }), undefined);
  assert.equal(thingExecutionSource({ ...thing, messages: [] }), undefined);
});
