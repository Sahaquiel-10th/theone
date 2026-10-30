import test from "node:test";
import assert from "node:assert/strict";
import { runTaskOrchestrator, OrchestrationToolError,OrchestrationInputError,OrchestrationResponseError,orchestrationFailureCode,orchestrationFailureProgress } from "./taskOrchestrator.js";
import {ModelRequestError} from './modelGateway.js';
import type {TaskStep} from './taskSteps.js';
import {inspect} from 'node:util';
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
test('validation repair gets one bounded execution opportunity even at the last callable turn',async()=>{
 let turns=0,runs=0;
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,maxCorrections:1,beforeStep:async()=>{},tools:[{name:'oneFlowchart',run:async()=>{},structured:{schema:{type:'object'},validate:value=>{if(!(value as {valid:boolean}).valid)throw new OrchestrationInputError('必须提供有效说明');return value;},run:async()=>{runs++;return {status:'completed'};}}}],call:async()=>{
  turns++;return turns<=2?{content:'',toolCalls:[{id:`attempt-${turns}`,type:'function',function:{name:'oneFlowchart',arguments:JSON.stringify({valid:turns===2})}}]}:{content:'done',toolCalls:[]};
 }});
 assert.equal(turns,3);assert.equal(runs,1);assert.equal(result.trace[0].status,'rejected');
 let rejectedTurns=0;
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,maxCorrections:1,beforeStep:async()=>{},tools:[{name:'oneFlowchart',run:async()=>{},structured:{schema:{type:'object'},validate:()=>{throw new OrchestrationInputError('仍无效');},run:async()=>{throw Error('must not run');}}}],call:async()=>{rejectedTurns++;return {content:'',toolCalls:[{id:`invalid-${rejectedTurns}`,type:'function',function:{name:'oneFlowchart',arguments:'{}'}}]};}}),/功能还没能正确接上/);
 assert.equal(rejectedTurns,2,'identical rejected arguments must not consume a third model call');
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
        assert.match(JSON.stringify(messages), /TOOL_NOT_OFFERED/);
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

test('a readable length answer keeps every returned byte and never buys a repair or required-tool call',async()=>{
 const body='  已经写出的正文\n'.repeat(2400)+'末尾原样保留  ';
 let calls=0,runs=0;
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:4,maxCorrections:2,requiredTools:['knowledge_search'],actionRequired:()=>{throw Error('length must not enter repair');},tools:[{name:'knowledge_search',run:async()=>{runs++;return{};}}],beforeStep:async()=>{},call:async()=>{calls++;return{content:body,toolCalls:[],finishReason:'length'};}});
 assert.equal(result.content,body);assert.equal(result.finishReason,'length');assert.deepEqual(result.requiredMissing,['knowledge_search']);assert.equal(calls,1);assert.equal(runs,0);
});

test('incomplete tool arguments never execute while their separate readable body is retained privately',async()=>{
 const body='实际已经返回的正文\n'+ '长正文'.repeat(16000),argument='{"query":"DO_NOT_COPY_TOOL_ARGUMENT';let runs=0,calls=0;
 const traces:unknown[]=[];
 await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,maxCorrections:2,tools:[{name:'knowledge_search',run:async()=>{runs++;return{};}}],beforeStep:async()=>{},onTrace:trace=>traces.push(trace),call:async()=>{calls++;return{content:body,toolCalls:[{id:'cut',type:'function',function:{name:'knowledge_search',arguments:argument}}],finishReason:'length'};}}),error=>{
  assert.ok(error instanceof OrchestrationResponseError);assert.equal(error.code,'task_tool_instruction_incomplete');assert.equal(error.partial?.content,body);assert.equal(error.partial?.finishReason,'length');
  assert.deepEqual(orchestrationFailureProgress(error),{partial:{kind:'tool_preamble',content:body,finishReason:'length'},completedTools:[]});
  assert.deepEqual(Object.keys(error.partial!),['kind','content','finishReason']);assert.doesNotMatch(JSON.stringify(error),/实际已经返回|DO_NOT_COPY_TOOL_ARGUMENT|长正文/);assert.doesNotMatch(inspect(error),/实际已经返回|DO_NOT_COPY_TOOL_ARGUMENT|长正文/);assert.doesNotMatch(error.message,/DO_NOT_COPY_TOOL_ARGUMENT/);return true;
 });
 assert.equal(calls,1);assert.equal(runs,0);assert.deepEqual(traces,[]);
});

test('filtered bodies are neither returned nor retained, even alongside a complete-looking tool call',async()=>{
 for(const withTool of [false,true]){
  let calls=0,runs=0;
  await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,tools:[{name:'knowledge_search',run:async()=>{runs++;return{};}}],beforeStep:async()=>{},call:async()=>{calls++;return{content:'FILTERED_BODY_MUST_NOT_ESCAPE',toolCalls:withTool?[call('filtered','FILTERED_ARGUMENT')]:[],finishReason:'filtered'};}}),error=>{
   assert.ok(error instanceof OrchestrationResponseError);assert.equal(orchestrationFailureCode(error),'task_response_filtered');assert.equal(error.partial,undefined);assert.equal(orchestrationFailureProgress(error),undefined);assert.doesNotMatch(JSON.stringify(error),/FILTERED_BODY|FILTERED_ARGUMENT/);return true;
  });
  assert.equal(calls,1);assert.equal(runs,0);
 }
});

test('empty and malformed model responses are distinct and cannot execute any tool',async()=>{
 const malformed=[null,{}, {content:null,toolCalls:[]},{content:'body',toolCalls:null},{content:'body',toolCalls:[{id:'bad',type:'function',function:{name:'knowledge_search',arguments:{query:'no'}}}]},{content:'body',toolCalls:[],finishReason:'invalid'}];
 for(const [result,code] of [[{content:' \n ',toolCalls:[]},'task_empty_response'],[{content:'',toolCalls:[],finishReason:'length'},'task_empty_response'],...malformed.map(result=>[result,'task_invalid_response'])] as const){
  let runs=0,calls=0;
  await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,tools:[{name:'knowledge_search',run:async()=>{runs++;return{};}}],beforeStep:async()=>{},call:async()=>{calls++;return result as never;}}),error=>{
   assert.ok(error instanceof OrchestrationResponseError);assert.equal(orchestrationFailureCode(error),code);assert.equal(error.partial,undefined);return true;
  });
  assert.equal(calls,1);assert.equal(runs,0);
 }
});

test('a later model failure preserves completed tool checkpoints and readable text without changing error identity or logging text',async()=>{
 for(const error of [new ModelRequestError(503,'暂时无法连接'),new Error('unknown_transport api_key=SECRET')]){
  let calls=0,runs=0;const steps:TaskStep[]=[];
  const traces:unknown[]=[];
  await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,checkpoints:{namespace:'worker',steps,save:async step=>{const index=steps.findIndex(s=>s.key===step.key);if(index<0)steps.push(step);else steps[index]=step;}},tools:[{name:'knowledge_search',label:'已授权资料读取',run:async()=>{runs++;return{status:'used',chunks:['真实工具结果']};}}],beforeStep:async()=>{},onTrace:trace=>traces.push(trace),call:async()=>{calls++;if(calls===1)return{content:'已经返回的独立正文',toolCalls:[call('read','当前资料')],finishReason:'tool_calls'};throw error;}}),actual=>{
   assert.equal(actual,error);assert.deepEqual(orchestrationFailureProgress(actual),{partial:{kind:'tool_preamble',content:'已经返回的独立正文',finishReason:'tool_calls'},completedTools:['knowledge_search']});
   assert.doesNotMatch(JSON.stringify(actual),/独立正文|真实工具结果|当前资料/);assert.doesNotMatch(inspect(actual),/独立正文|真实工具结果|当前资料/);return true;
  });
  assert.equal(calls,2);assert.equal(runs,1);assert.equal(steps.length,1);assert.equal(steps[0].state,'completed');assert.deepEqual(steps[0].output,{status:'used',chunks:['真实工具结果']});
  assert.doesNotMatch(JSON.stringify(traces),/SECRET|unknown_transport/);
  const detached=orchestrationFailureProgress(error)!;detached.partial!.content='changed';detached.completedTools.push('forged');assert.equal(orchestrationFailureProgress(error)!.partial!.content,'已经返回的独立正文');assert.deepEqual(orchestrationFailureProgress(error)!.completedTools,['knowledge_search']);
 }
});

test('a reused error in another isolated run cannot retain the previous run private body or completed tools',async()=>{
 const error=new ModelRequestError(503,'暂时无法连接');let calls=0;
 await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,tools:[{name:'knowledge_search',run:async()=>({status:'used'})}],beforeStep:async()=>{},call:async()=>{calls++;if(calls===1)return{content:'FIRST_OWNER_BODY',toolCalls:[call('one')],finishReason:'tool_calls'};throw error;}}));
 assert.equal(orchestrationFailureProgress(error)?.partial?.content,'FIRST_OWNER_BODY');
 await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[{role:'user',content:'SECOND_OWNER_INPUT'}],maxSteps:1,tools:[],beforeStep:async()=>{},call:async()=>{throw error;}}),actual=>actual===error);
 assert.equal(orchestrationFailureProgress(error),undefined);
});

test('a length tool preamble cannot be mistaken for a delivered or continuation-ready body',async()=>{
 let runs=0;
 await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,tools:[{name:'save_notion_draft',run:async()=>{runs++;return{};}}],beforeStep:async()=>{},call:async()=>({content:'已经保存到 Notion，原页面更新好了。',finishReason:'length',toolCalls:[{id:'unfinished-write',type:'function',function:{name:'save_notion_draft',arguments:'{"body":"未完整'}}]})}),error=>{
  const partial=orchestrationFailureProgress(error)?.partial;
  assert.ok(partial);assert.equal(partial.kind,'tool_preamble');assert.equal(partial.content,'已经保存到 Notion，原页面更新好了。');return true;
 });
 assert.equal(runs,0);
});

test('pure prose is a body while mixed prose and tool preambles retain their unverified label',async()=>{
 for(const mixed of [false,true]){
  let calls=0;const error=new ModelRequestError(503,'connection unavailable');
  await assert.rejects(runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,requiredTools:['oneHtml'],tools:[{name:'knowledge_search',run:async()=>({status:'used'})}],beforeStep:async()=>{},call:async()=>{
   calls++;if(calls===1)return mixed?{content:'我已经保存所有成果。',toolCalls:[call('read')],finishReason:'tool_calls'}:{content:'可读的正文第一段',toolCalls:[],finishReason:'stop'};
   if(calls===2)return{content:'可读的正文第二段',toolCalls:[],finishReason:'stop'};
   throw error;
  }}),actual=>actual===error);
  const partial=orchestrationFailureProgress(error)?.partial;
  assert.equal(partial?.kind,mixed?'tool_preamble':'body');assert.match(partial!.content,/可读的正文第二段/);assert.equal(calls,3);
 }
});
