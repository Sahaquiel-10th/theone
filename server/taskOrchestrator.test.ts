import test from "node:test";
import assert from "node:assert/strict";
import { runTaskOrchestrator } from "./taskOrchestrator.js";
const call = (id: string, query = "project", name = "knowledge_search") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify({ query }) } });

test("public executor rejects forbidden tools before any model charge and forged calls never execute", async () => {
  for (const entryPoint of ["published_web", "published_api"] as const) {
    for (const name of ["web_search", "read_file", "write_file", "run_command", "save_note", "image_generation", "unknown_future_tool"]) {
      await assert.rejects(runTaskOrchestrator({ entryPoint, messages: [], maxSteps: 2,
        tools: [{ name, run: async () => { assert.fail("forbidden handler executed"); } }],
        beforeStep: async () => {}, call: async () => { assert.fail("must reject before charging"); }
      }), /分享分身/);
    }
    let reads = 0, requests = 0;
    const answer = await runTaskOrchestrator({ entryPoint, messages: [], maxSteps: 2,
      tools: [{ name: "knowledge_search", run: async () => { reads++; return { chunks: ["authorized fact"] }; } }],
      beforeStep: async () => {}, call: async (messages, tools) => {
        requests++;
        if (requests === 1) { assert.deepEqual(tools.map(t => t.function.name), ["knowledge_search"]); return { content: "", toolCalls: [call("a", "x", "web_search"), call("b")] }; }
        assert.match(JSON.stringify(messages), /工具未授权/);
        return { content: "answer", toolCalls: [] };
      }
    });
    assert.equal(reads, 1); assert.equal(answer.content, "answer");
  }
  await assert.rejects(runTaskOrchestrator({ entryPoint: undefined as never, messages: [], tools: [], maxSteps: 1,
    beforeStep: async () => {}, call: async () => { assert.fail("unknown entry must fail closed"); }
  }), /执行入口无效/);
});
test("dispatcher transmits editable descriptions, reuses duplicate reads and delivers result", async () => {
  let runs = 0, calls = 0, checks = 0;
  const result = await runTaskOrchestrator({ entryPoint: "workspace", messages: [{ role: "user", content: "find project" }], maxSteps: 4,
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
  await runTaskOrchestrator({ entryPoint: "workspace", messages: [], maxSteps: 2, beforeStep: async () => {}, tools: [{ name: "knowledge_search", run: async () => { invoked++; } }], call: async (_messages, tools) => {
    calls++; if (calls === 1) return { content: "", toolCalls: [call("a", "x", "run_command"), { ...call("b"), function: { name: "knowledge_search", arguments: '{"query":"x","workspaceId":"other"}' } }] };
    assert.deepEqual(tools, []); return { content: "cannot execute", toolCalls: [] };
  } });
  assert.equal(invoked, 0);
  await assert.rejects(runTaskOrchestrator({ entryPoint: "workspace", messages: [], maxSteps: 2, tools: [], beforeStep: async () => { throw new Error("Key removed"); }, call: async () => { throw Error("must not call"); } }), /Key removed/);
});
test("step limit never reports false completion", async () => {
  await assert.rejects(runTaskOrchestrator({ entryPoint: "workspace", messages: [], maxSteps: 1, tools: [], beforeStep: async () => {}, call: async () => ({ content: "done", toolCalls: [call("a")] }) }), /步骤上限/);
});

test("truncated answers stay visible but truncated tool instructions never execute", async () => {
  const partial = await runTaskOrchestrator({ entryPoint: "workspace", messages: [], maxSteps: 2, tools: [], beforeStep: async () => {}, call: async () => ({ content: "unfinished", toolCalls: [], finishReason: "length" }) });
  assert.equal(partial.finishReason, "length");
  let invoked = false;
  await assert.rejects(runTaskOrchestrator({ entryPoint: "workspace", messages: [], maxSteps: 2, tools: [{ name: "knowledge_search", run: async () => { invoked = true; return {}; } }], beforeStep: async () => {}, call: async () => ({ content: "", toolCalls: [call("a")], finishReason: "length" }) }), /未完整返回/);
  assert.equal(invoked, false);
});
