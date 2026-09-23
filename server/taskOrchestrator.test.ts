import test from "node:test";
import assert from "node:assert/strict";
import { runTaskOrchestrator } from "./taskOrchestrator.js";
const call = (id: string, query = "project", name = "knowledge_search") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify({ query }) } });
test("dispatcher transmits editable descriptions, reuses duplicate reads and delivers result", async () => {
  let runs = 0, calls = 0, checks = 0;
  const result = await runTaskOrchestrator({ messages: [{ role: "user", content: "find project" }], maxSteps: 4,
    beforeStep: async () => { checks++; }, tools: [{ name: "knowledge_search", description: "CUSTOM WHEN TO SEARCH", run: async () => { runs++; return { status: "used", chunks: ["fact"] }; } }],
    call: async (messages, tools) => {
      calls++; assert.equal(tools[0].function.description, "CUSTOM WHEN TO SEARCH");
      if (calls < 3) return { content: "", toolCalls: [call(`c${calls}`)] };
      assert.match(JSON.stringify(messages), /fact/); return { content: "answer", toolCalls: [] };
    } });
  assert.equal(result.content, "answer"); assert.equal(runs, 1); assert.equal(checks, 5); assert.equal(result.trace[1].status, "reused");
});
test("unavailable tools, invalid arguments and revoked authorization never execute", async () => {
  let invoked = 0, calls = 0;
  await runTaskOrchestrator({ messages: [], maxSteps: 2, beforeStep: async () => {}, tools: [{ name: "knowledge_search", run: async () => { invoked++; } }], call: async (_messages, tools) => {
    calls++; if (calls === 1) return { content: "", toolCalls: [call("a", "x", "run_command"), { ...call("b"), function: { name: "knowledge_search", arguments: '{"query":"x","workspaceId":"other"}' } }] };
    assert.deepEqual(tools, []); return { content: "cannot execute", toolCalls: [] };
  } });
  assert.equal(invoked, 0);
  await assert.rejects(runTaskOrchestrator({ messages: [], maxSteps: 2, tools: [], beforeStep: async () => { throw new Error("Key removed"); }, call: async () => { throw Error("must not call"); } }), /Key removed/);
});
test("step limit never reports false completion", async () => {
  await assert.rejects(runTaskOrchestrator({ messages: [], maxSteps: 1, tools: [], beforeStep: async () => {}, call: async () => ({ content: "done", toolCalls: [call("a")] }) }), /步骤上限/);
});
