import test from "node:test";
import assert from "node:assert/strict";
import { runTaskOrchestrator, OrchestrationToolError,OrchestrationInputError,orchestrationFailureCode } from "./taskOrchestrator.js";
test('known orchestration failures have bounded diagnostic codes and unknown secrets are never copied',()=>{
 assert.equal(orchestrationFailureCode(new Error('已达到调度步骤上限，未完成任务；请缩小问题范围')),'task_step_limit');
 assert.equal(orchestrationFailureCode(new Error('本批任务超过已授权预算，已停止新的调用')),'task_budget_limit');
 assert.equal(orchestrationFailureCode(new Error('本批任务达到已授权预算，已停止新的模型调用；已产生的结果与用量保留。')),'task_budget_limit');
 assert.equal(orchestrationFailureCode(new Error('provider.invalid api_key=SECRET')),undefined);
 assert.equal(orchestrationFailureCode(new Error('__proto__')),undefined);
 assert.equal(orchestrationFailureCode({message:'调度模型没有返回结果'}),undefined);
});
const call = (id: string, query = "project", name = "knowledge_search") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify({ query }) } });
test('reviewed structured validation hints permit bounded repair without executing invalid or unavailable tools',async()=>{
 let turns=0,runs=0;
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,beforeStep:async()=>{},tools:[{name:'oneFlowchart',run:async()=>{},structured:{schema:{type:'object'},validate:raw=>{if(!(raw as {valid?:boolean}).valid)throw new OrchestrationInputError('使用平铺 version=1 和两个场景');return raw;},run:async()=>{runs++;return {status:'completed'};}}}],call:async messages=>{
   turns++;if(turns===1)return {content:'',toolCalls:[{id:'bad',type:'function',function:{name:'oneFlowchart',arguments:'{"valid":false}'}}]};
   if(turns===2){assert.match(JSON.stringify(messages),/TOOL_INPUT_REPAIR/);return {content:'',toolCalls:[{id:'fixed',type:'function',function:{name:'oneFlowchart',arguments:'{"valid":true}'}}]};}
   return {content:'done',toolCalls:[]};
 }});
 assert.equal(runs,1);assert.equal(turns,3);assert.equal(result.trace[0].status,'rejected');assert.equal(result.trace[1].status,'returned');
 let called=0;
 const hidden=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,beforeStep:async()=>{},tools:[{name:'oneFlowchart',run:async()=>{},structured:{schema:{type:'object'},validate:()=>{throw new Error('api_key=SECRET');},run:async()=>{called++;}}}],call:async messages=>messages.length?{content:'stopped',toolCalls:[]}:{content:'',toolCalls:[{id:'x',type:'function',function:{name:'oneFlowchart',arguments:'{}'}}]}});
 assert.equal(called,0);assert.doesNotMatch(JSON.stringify(hidden),/SECRET/);
});
test('progress reports actual tool boundaries, not fabricated completion',async()=>{
 const stages:string[]=[];let calls=0;
 await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,beforeStep:async()=>{},onStage:(stage,tool)=>stages.push(`${stage}:${tool||''}`),tools:[{name:'knowledge_search',run:async()=>{stages.push('actual-read');return{chunks:[]};}}],call:async()=>++calls===1?{content:'',toolCalls:[call('read')]}:{content:'没有匹配资料',toolCalls:[]}});
 assert.deepEqual(stages,['model:','tool:knowledge_search','actual-read','tool_returned:knowledge_search','model:']);
});

test("failed tool records a safe trace before stopping, never provider secrets or a second model call", async () => {
  for (const error of [new Error("https://provider.invalid?api_key=SECRET"), new OrchestrationToolError("TOOL_DEFINITION_CHANGED", "reviewed change")]) {
    let calls = 0;
    const snapshots: unknown[] = [];
    await assert.rejects(runTaskOrchestrator({ entryPoint: "workspace", messages: [], maxSteps: 3,
      tools: [{ name: "knowledge_search", run: async () => { throw error; } }],
      beforeStep: async () => {}, onTrace: steps => snapshots.push(steps),
      call: async () => { calls++; return { content: "", toolCalls: [call("failed")] }; }
    }), value => value === error);
    assert.equal(calls, 1);
    const trace = snapshots[0] as { status: string; resultPreview: string }[];
    assert.equal(trace[0].status, "failed");
    assert.match(trace[0].resultPreview, error instanceof OrchestrationToolError ? /TOOL_DEFINITION_CHANGED/ : /TOOL_EXECUTION_FAILED/);
    assert.doesNotMatch(JSON.stringify(snapshots), /SECRET|provider\.invalid/);
  }
});

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
