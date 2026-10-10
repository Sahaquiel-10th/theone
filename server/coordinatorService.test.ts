import test from "node:test";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCoordinatorRoutes } from "./coordinatorRoutes.js";
import assert from "node:assert/strict";
import type { Store } from "./db.js";
import type { Database, ModelConfig } from "./types.js";
import { CoordinatorService } from "./coordinatorService.js";
import { defaultTaskValues, updateTaskConfig } from "./aiTaskConfig.js";
import { executorDefaults, updateExecutor } from "./executorProfiles.js";
import { reconcileInterruptedChatOperations } from "./chatOperations.js";
import type { ModelToolMessage, ModelToolDefinition, ToolChatResult } from "./modelGateway.js";

test('legacy assistant restrictions remain enforced before accepting or charging a task supplement',async()=>{
 const f=fixture(),stamp=new Date().toISOString();
 await f.store.mutate(d=>{
  d.agents=[{id:'private-agent',workspaceId:a.workspaceId,ownerId:a.userId,published:false,allowFileUpload:false,allowImageInput:false,allowWebSearch:false,prompt:'个人分身指令'} as Database['agents'][number]];
  d.conversations.push({...a,id:'legacy-agent',agentId:'private-agent',title:'UI 个人分身',modelId:'worker',archived:false,messages:[],createdAt:stamp,updatedAt:stamp});
  d.attachments.push({...a,id:'own-file',kind:'text',mimeType:'text/plain',originalName:'说明.txt',storagePath:'/fixture-only',size:20,extractedText:'资料',status:'ready',createdAt:stamp});
 });
 await assert.rejects(()=>f.service.direct(a,'legacy-agent',{operationId:'operation_agent_file_1',text:'看看资料',attachmentIds:['own-file']},key),/未开放附件/);
 assert.equal(f.calls.length,0);assert.equal((await f.store.read()).chatOperations?.length,0);
 const result=await f.service.direct(a,'legacy-agent',{operationId:'operation_agent_text_1',text:'继续 UI'},key);
 await f.service.resume(a,key);
 await waitFor(async()=>(await f.service.task(a,result.taskId)).jobs[0].state==='completed');
 assert.match(JSON.stringify(f.calls),/个人分身指令/);
});

test('legacy continuation preserves original history and attached file handoff is scoped and survives restart views',async()=>{
 const f=fixture();const stamp=new Date().toISOString();
 await f.store.mutate(d=>{d.conversations.push({...a,id:'legacy',title:'旧 UI',modelId:'worker',messages:[{id:'legacy-user',role:'user',content:'之前的完整原话',createdAt:stamp},{id:'legacy-answer',role:'assistant',content:'之前的成果',createdAt:stamp}],archived:false,createdAt:stamp,updatedAt:stamp});d.attachments.push({...a,id:'own-file',kind:'text',mimeType:'text/plain',originalName:'说明.txt',storagePath:'/fixture-only',size:20,extractedText:'独立输入框和不打断注意力',status:'ready',createdAt:stamp},{...b,id:'foreign-file',kind:'text',mimeType:'text/plain',originalName:'秘密.txt',storagePath:'/foreign',size:20,extractedText:'不能读取',status:'ready',createdAt:stamp});});
 await assert.rejects(()=>f.service.dispatch(a,{...input('operation_foreign_f','UI'),attachmentIds:['foreign-file']},key));assert.equal(f.calls.length,0);
 const r=await f.service.dispatch(a,{...input('operation_attach_ok','UI 看看附件'),boundTaskId:'legacy',attachmentIds:['own-file']},key);
 assert.equal(r.taskId,'legacy');const queued=await f.store.read();assert.ok(queued.messages.some(m=>m.id==='legacy-user'));assert.ok(queued.attachments.find(a=>a.id==='own-file')!.sharedConversationIds?.includes('legacy'));
 assert.equal(f.calls.find(c=>c.modelId==='router')!.requiredTool,'delegate_task','new attachments require delegation without pretending to read them');
 assert.equal(f.calls.filter(c=>c.modelId==='router').at(-1)!.requiredTool,undefined,'acknowledgement must not dispatch again');
 await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,'legacy')).jobs[0].state==='completed');
 const call=f.calls.find(c=>c.modelId==='worker')!;assert.match(call.messages[0].content!,/独立输入框/);assert.match(JSON.stringify(call.messages),/之前的完整原话|之前的成果/);assert.doesNotMatch(JSON.stringify(call.messages),/不能读取/);
});

test('on-disk restart restores executor configuration, task originals and unstarted queue',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_disk_0001','UI 原话'),key),db=await f.store.read();
 const p=updateExecutor(db,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'磁盘保存模板'}});
 updateExecutor(db,'a',p.id,{revision:1,action:'publish'});
 for(const user of db.users)user.defaultWorkspaceId=user.id==='a'?'wa':'wb';
 const directory=mkdtempSync(path.join(tmpdir(),'one-execution-restart-'));
 try{
  writeFileSync(path.join(directory,'db.json'),JSON.stringify(db));
  const script=`const {store}=await import('./server/db.ts');const d=await store.read();console.log(JSON.stringify({profile:d.settings.executorProfiles[0].published.name,task:d.conversations.find(c=>c.id===${JSON.stringify(r.taskId)}),job:d.chatOperations.find(o=>o.workRun).workRun.state}));`;
  for(let n=0;n<2;n++){
   const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,DB_PROVIDER:'json',ONE_DATA_DIR:directory,NODE_ENV:'test',PROVIDER_CREDENTIALS_KEY:'fixture-only-encryption-key-32-characters'},encoding:'utf8',timeout:15000});
   assert.equal(result.status,0,result.stderr);const restored=JSON.parse(result.stdout.trim());assert.equal(restored.profile,'磁盘保存模板');assert.equal(restored.job,'queued');assert.equal(restored.task.executorProfileId,'general');assert.equal(restored.task.messages[0].content,'UI 原话');
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('truncated task output is not a completed result; own trace preserves actual input',async()=>{
 const f=fixture();f.setWorker(async()=>({...answer('不完整成果'),finishReason:'length'}));
 const r=await f.service.dispatch(a,input('operation_truncate_1','UI'),key);await f.service.resume(a,key);
 await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[0].state==='failed');
 const task=await f.service.task(a,r.taskId!);assert.equal(task.conversation.messages.filter(m=>m.role==='assistant').length,0);
 const db=await f.store.read(),trace=db.contextTraces.find(t=>t.conversationId===r.taskId)!;
 assert.equal(trace.workspaceId,a.workspaceId);assert.match(JSON.stringify(trace.sections),/本轮交接|用户原话/);
 assert.equal(db.contextTraces.filter(t=>t.workspaceId===b.workspaceId).length,0);
});

const a = { workspaceId: "wa", userId: "a" },
  b = { workspaceId: "wb", userId: "b" };
const answer = (content: string): ToolChatResult => ({
  content,
  finishReason: "stop",
  toolCalls: [],
  usage: {
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    source: "provider",
  },
});
function fixture() {
  const models = ["router", "worker", "special"].map(
    (id) =>
      ({
        id,
        name: id,
        enabled: true,
        kind: "chat",
        apiKey: "fixture-only",
        systemPrompt: "",
        isDefault: id === "worker",
        inputPowerPerMillion: 1,
        outputPowerPerMillion: 1,
        costInputPowerPerMillion: 1,
        costOutputPowerPerMillion: 1,
      }) as ModelConfig,
  );
  let db = {
    users: [
      { id: "a", enabled: true, role: "admin" },
      { id: "b", enabled: true, role: "user" },
    ],
    workspaces: [
      { id: "wa", status: "active" },
      { id: "wb", status: "active" },
    ],
    workspaceMembers: [
      { workspaceId: "wa", userId: "a" },
      { workspaceId: "wb", userId: "b" },
    ],
    models,
    settings: { safetyRules: "fixed-safety", rechargeCnyPerPower: 7 },
    conversations: [],
    messages: [],
    chatOperations: [],
    knowledgeConnections: [],
    auditLogs: [],
    contextTraces: [],
    modelUsageRecords: [],
    powerAccounts: [a, b].map((s) => ({
      ...s,
      id: s.userId,
      balanceMicros: 100e6,
      reservedMicros: 0,
    })),
    powerLedger: [],
    attachments: [],
  } as unknown as Database;
  updateTaskConfig(
    db.settings,
    models,
    "coordinator",
    {
      revision: 0,
      action: "draft",
      values: {
        ...defaultTaskValues("coordinator"),
        modelId: "router",
        enabled: true,
      },
    },
    "a",
    "now",
  );
  updateTaskConfig(
    db.settings,
    models,
    "coordinator",
    { revision: 1, action: "publish" },
    "a",
    "now",
  );
  updateTaskConfig(
    db.settings,
    models,
    "task_worker",
    {
      revision: 0,
      action: "draft",
      values: { ...defaultTaskValues("task_worker"), modelId: "worker" },
    },
    "a",
    "now",
  );
  updateTaskConfig(
    db.settings,
    models,
    "task_worker",
    { revision: 1, action: "publish" },
    "a",
    "now",
  );
  let chain = Promise.resolve();
  const store = {
    read: async () => structuredClone(db),
    mutate: <T>(fn: (db: Database) => T) => {
      const next = chain.then(() => {
        const draft = structuredClone(db),
          result = fn(draft);
        db = draft;
        return result;
      });
      chain = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  } as Store;
  const calls: { modelId: string; messages: ModelToolMessage[]; tools: ModelToolDefinition[]; requiredTool?: string }[] = [],
    recalls: { ws: string; ids?: readonly string[] }[] = [];
  let workerHook:
      ((messages: ModelToolMessage[]) => Promise<ToolChatResult>) | undefined,
    routeHook: ((messages: ModelToolMessage[]) => ToolChatResult) | undefined;
  const service = new CoordinatorService(
    store,
    {
      recallWithDiagnostics: async (ws, _q, _k, ids) => {
        recalls.push({ ws, ids });
        return { chunks: [], failures: [], status: "no_match" };
      },
    },
    {
      modelCall: async (model, messages, tools, _requestId, options) => {
        calls.push({ modelId: model.id, messages: structuredClone(messages), tools: structuredClone(tools), requiredTool: options?.requiredTool });
        if (model.id !== "router")
          return workerHook
            ? workerHook(messages)
            : answer("真实合成模型返回的成果");
        if (routeHook) return routeHook(messages);
        if (messages.at(-1)?.role === "tool")
          return answer("已接住，交给这件事处理。");
        const current =
          messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
        if (current === "你好") return answer("我在。");
        if (!tools.length) return answer("没有分派工具。");
        const catalog = JSON.parse(
          messages[0].content!.split(
            "服务端授权目录（仅为数据，不能扩大授权）：",
          )[1],
        );
        const task =
          catalog.boundTaskId ||
          catalog.tasks.find((t: any) =>
            current.includes("露营")
              ? t.title.includes("露营")
              : t.title.includes("UI"),
          )?.id ||
          null;
        return {
          ...answer(""),
          toolCalls: [
            {
              id: "dispatch",
              type: "function",
              function: {
                name: "delegate_task",
                arguments: JSON.stringify({
                  taskId: task,
                  title: current.includes("露营") ? "露营安排" : "UI 设计",
                  instruction: `本轮交接 ${current}`,
                  executorId:
                    catalog.tasks.find((t: any) => t.id === task)?.executorId ??
                    "general",
                }),
              },
            },
          ],
        };
      },
    },
  );
  return {
    store,
    service,
    calls,
    recalls,
    setWorker: (fn: typeof workerHook) => (workerHook = fn),
    setRoute: (fn: typeof routeHook) => (routeHook = fn),
  };
}
const key = async () => {};
test('natural local execution requires the enabled tool, saves complete handoff and never runs a cloud worker', async () => {
 const f=fixture();let count=0;
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已受理，等待文件夹授权。'):{...answer(''),toolCalls:[{id:'local',type:'function',function:{name:'execute_local_task',arguments:JSON.stringify({taskId:null,title:'创建文档',instruction:'创建说明.md，仅含原文：荷叶饼好吃，一个5块。禁止添加其他内容。',executorId:'general'})}}]});
 const r=await f.service.dispatch(a,input('operation_natural_123','帮我创建说明.md，内容是荷叶饼好吃，一个5块，开始执行'),key,undefined,async(cid,mid)=>{count++;const db=await f.store.read();const job=db.chatOperations!.find(o=>o.workRun?.inputMessageId===mid)!;assert.match(job.workRun!.instruction,/禁止添加其他内容/);assert.equal(db.messages.find(m=>m.id===mid)!.conversationId,cid);return{id:'local-natural',status:'selecting_target'};});
 assert.ok(r.taskId);assert.equal(count,1);await f.service.resume(a,key);assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
 const denied=fixture();await denied.store.mutate(d=>{d.settings.aiTasks!.coordinator!.published!.tools=['delegate_task'];});denied.setRoute(()=>({...answer(''),toolCalls:[{id:'blocked',type:'function',function:{name:'execute_local_task',arguments:'{}'}}]}));
 await assert.rejects(denied.service.dispatch(a,input('operation_natural_denied','开始执行'),key,undefined,async()=>{throw Error('must never invoke');}));assert.equal((await denied.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('on-demand task reading is private and local completion reporting is persistent and idempotent',async()=>{
 const f=fixture(),stamp=new Date().toISOString();await f.store.mutate(d=>{d.conversations.push({...a,id:'owned',title:'旧UI',modelId:'worker',messages:[{id:'old',role:'user',content:'文件只能写一句荷叶饼',createdAt:stamp}],archived:false,createdAt:stamp,updatedAt:stamp},{...b,id:'foreign',title:'不能读取',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});});
 let step=0;f.setRoute(messages=>{if(step++===0)return{...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query:'owned'})}}]};assert.match(JSON.stringify(messages),/文件只能写一句荷叶饼/);return answer('目标确认，请继续。');});
 await f.service.dispatch(a,input('operation_read_12345','之前UI的要求是什么？'),key);
 await f.store.mutate(d=>{d.executionTasks=[{...a,id:'local-completed',conversationId:'owned',sourceMessageId:'old',provider:'codex',instruction:'创建文档',deviceId:'fixture-key',status:'completed',finalResponse:'本轮进程结束，产物需查看',createdAt:stamp,updatedAt:stamp}];});
 await f.service.report(b,['local-completed'],key);assert.equal((await f.store.read()).executionTasks[0].reportedToCoordinatorAt,undefined);
 await f.service.report(a,['local-completed'],key);await f.service.report(a,['local-completed'],key);const db=await f.store.read();assert.equal(db.conversations.find(c=>c.coordinatorMain&&c.userId==='a')!.messages.filter(m=>m.id==='report_local-completed').length,1);assert.ok(db.executionTasks[0].reportedToCoordinatorAt);
 await f.store.mutate(d=>{const task=d.executionTasks[0];task.reportRound=1;task.reportedToCoordinatorAt=undefined;task.finalResponse='第二轮的独立结果';});await f.service.report(a,['local-completed'],key);await f.service.report(a,['local-completed'],key);assert.equal((await f.store.read()).conversations.find(c=>c.coordinatorMain&&c.userId==='a')!.messages.filter(m=>m.id==='report_local-completed_1').length,1);
 const blocked=fixture();await blocked.store.mutate(d=>{d.conversations.push({...b,id:'foreign',title:'秘密',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});});blocked.setRoute(()=>({...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query:'foreign'})}}]}));await assert.rejects(blocked.service.dispatch(a,input('operation_read_denied','读旧事情'),key));
});
test('an execution click cannot be acknowledged as dispatched without a real local task', async () => {
 const f=fixture(); f.setRoute(()=>answer('已转达并开始执行。'));
 let runs=0;
 await assert.rejects(()=>f.service.dispatch(a,{...input('operation_false_local','修改网页标题'),localExecution:true},key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}),/本机执行尚未开始/);
 assert.equal(runs,0);
 const db=await f.store.read();
 assert.ok(db.messages.some(m=>m.role==='user'&&m.content==='修改网页标题'));
 assert.ok(!db.messages.some(m=>m.role==='assistant'&&m.content==='已转达并开始执行。'));
});

test('explicit answer-only messages cannot delegate even when bound to an existing task', async () => {
 const f=fixture(), stamp=new Date().toISOString();
 await f.store.mutate(d=>d.conversations.push({...a,id:'owned-read',title:'UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp}));
 f.setRoute(()=>answer('只读回执回答，没有执行。'));
 let runs=0;
 const reply=await f.service.dispatch(a,{...input('operation_answer_only_01','只回答，不执行、不重跑。'),boundTaskId:'owned-read'},key,undefined,async()=>{runs++;return{id:'never',status:'queued'};});
 assert.equal(reply.taskId,undefined);
 assert.equal(runs,0);
 assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
 const tools=f.calls.filter(c=>c.modelId==='router').flatMap(c=>c.tools.map(t=>t.function.name));
 assert.ok(!tools.includes('delegate_task')&&!tools.includes('execute_local_task'));
 const denied=fixture(); denied.setRoute(()=>({...answer(''),toolCalls:[{id:'forbidden',type:'function',function:{name:'execute_local_task',arguments:JSON.stringify({taskId:null,title:'旧任务',instruction:'不能执行',executorId:'general'})}}]}));
 await assert.rejects(()=>denied.service.dispatch(a,input('operation_answer_only_02','只回答，不执行。'),key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}));
 assert.equal(runs,0);
 assert.equal((await denied.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
 const foreign=fixture(); foreign.setRoute(()=>answer('不应读取'));
 await foreign.store.mutate(d=>d.conversations.push({...a,id:'owned-read',title:'UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp}));
 await assert.rejects(()=>foreign.service.dispatch(b,{...input('operation_answer_only_03','只回答，不执行。'),boundTaskId:'owned-read'},key));
 assert.equal(foreign.calls.length,0);
 await assert.rejects(()=>f.service.dispatch(a,{...input('operation_answer_only_04','不执行。'),localExecution:true},key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}),/本机尚未开始/);
 assert.equal(runs,0);
});
test('local notices acknowledge their own execution round without suppressing a requested brief', async () => {
 const f=fixture(); await f.service.dispatch(a,input('operation_notice_init','你好'),key);
 const stamp=new Date().toISOString();
 await f.store.mutate(d=>{
  d.conversations.push({...a,id:'notice-task',title:'本机测试',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});
  d.executionTasks=[{...a,id:'notice-execution',conversationId:'notice-task',sourceMessageId:'m',provider:'local_agent',instruction:'safe',deviceId:'fixture-key',status:'completed',reportRound:0,finalResponse:'已回读',createdAt:stamp,updatedAt:stamp}];
 });
 await assert.rejects(()=>f.service.acknowledge(b,['notice-execution']));
 await assert.rejects(()=>f.service.acknowledge(a,['notice-execution','missing']));
 assert.equal((await f.store.read()).executionTasks[0].noticeReadRound,undefined);
 await f.service.acknowledge(a,['notice-execution']); await f.service.acknowledge(a,['notice-execution']);
 assert.equal((await f.service.state(a)).notices.length,0);
 assert.equal((await f.store.read()).executionTasks[0].reportedToCoordinatorAt,undefined);
 await f.service.report(a,['notice-execution'],key);
 assert.ok((await f.store.read()).executionTasks[0].reportedToCoordinatorAt);
 await f.store.mutate(d=>{d.executionTasks[0].reportRound=1;d.executionTasks[0].reportedToCoordinatorAt=undefined;});
 assert.equal((await f.service.state(a)).notices.length,1);
});
test('saving a task alone is not proof that the local executor accepted it',async()=>{
 const f=fixture();let runs=0;
 const result=await f.service.dispatch(a,{...input('operation_local_rejected','UI 改标题'),localExecution:true},key,undefined,async()=>{runs++;throw new Error('连接执行器失败');});
 assert.match(result.conversation.messages.at(-1)?.content ?? '',/尚不能确认已开始或完成/);
 assert.equal(runs,1);
 const db=await f.store.read();
 assert.ok(db.messages.some(m=>m.role==='user'&&m.content==='UI 改标题'));
 assert.equal((db.executionTasks ?? []).length,0);
 assert.equal(db.chatOperations?.find(o=>o.operationId==='operation_local_rejected')?.status,'completed');
});
test('a batch briefing is one message with all task links and replays never duplicate it', async () => {
 const f=fixture(); await f.service.dispatch(a,input('operation_batch_start','你好'),key);
 const stamp=new Date().toISOString();
 await f.store.mutate(d=>{
   d.executionTasks=['one','two'].map(id=>({...a,id,conversationId:id,sourceMessageId:id,provider:'local_agent',instruction:'safe',deviceId:'fixture-key',status:'completed',finalResponse:`${id} 已创建并回读：/QA/${id}.md`,createdAt:stamp,updatedAt:stamp}));
   for(const id of ['one','two']) d.conversations.push({...a,id,title:id,modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});
 });
 await f.service.report(a,['one','two'],key);await f.service.report(a,['two','one'],key);
 const state=await f.service.state(a), brief=state.conversation!.messages.filter(m=>m.id?.startsWith('report_'));
 assert.equal(brief.length,1);assert.match(brief[0].content,/2 件事情/);
 assert.deepEqual(state.links.filter(l=>l.messageId===brief[0].id).map(l=>l.taskId).sort(),['one','two']);
 assert.equal(state.notices.length,0);
});
test('local dispatch preserves the handoff, bypasses cloud worker and replay never executes twice', async () => {
  const f = fixture(), executed: string[] = [];
  const run = async (cid: string, mid: string) => { const d=await f.store.read(); assert.equal(d.messages.find(m=>m.id===mid)?.content,'UI 标题改成荷叶饼，开工'); executed.push(cid); return {id:'ext-fixture',status:'queued'}; };
  const request={...input('operation_local_1234','UI 标题改成荷叶饼，开工'),localExecution:true};
  const result = await f.service.dispatch(a,request,key,undefined,run);
  await f.service.resume(a,key);
  assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
  assert.equal((await f.service.task(a,result.taskId!)).jobs[0].state,'prepared');
  await f.service.dispatch(a,request,key,undefined,run);
  assert.equal(executed.length,1);
  await assert.rejects(f.service.dispatch(b,{...request,operationId:'operation_local_other',boundTaskId:result.taskId},key,undefined,run),/不存在|未授权/);
});
test('completed result returns to the main dialogue once and cannot leak another user result',async()=>{
  const f=fixture(),r=await f.service.dispatch(a,input('operation_report_123','UI'),key);
  await f.service.resume(a,key); await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[0].state==='completed');
  const d=await f.store.read(),id=d.chatOperations!.find(o=>o.workRun)!.id;
  await f.service.report(b,[id],key); assert.equal((await f.store.read()).conversations.find(c=>c.userId==='b'&&c.coordinatorMain),undefined);
  await f.service.report(a,[id],key);await f.service.report(a,[id],key);
  const main=(await f.store.read()).conversations.find(c=>c.userId==='a'&&c.coordinatorMain)!;
  assert.equal(main.messages.filter(m=>m.id===`report_${id}`).length,1);
  assert.match(main.messages.find(m=>m.id===`report_${id}`)!.content,/真实合成模型返回的成果/);
  assert.equal((await f.service.state(a)).notices.length,0);
});
test("failed core routing preserves only its owner's safe diagnostic receipt", async () => {
  const f = fixture();
  f.setRoute(() => { throw new Error("upstream api_key=SECRET"); });
  await assert.rejects(f.service.dispatch(a, input("operation_route_failure", "UI"), key));
  const db = await f.store.read(), operation = db.chatOperations?.find(o => o.operationId === "operation_route_failure")!;
  assert.equal(operation.status, "failed");
  const traces = db.contextTraces.filter(t => t.requestId === operation.requestId);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].workspaceId, a.workspaceId);
  assert.equal(traces[0].userId, a.userId);
  assert.match(traces[0].responsePreview, /未完成分派/);
  assert.doesNotMatch(JSON.stringify(traces), /api_key|SECRET/);
  assert.equal(db.contextTraces.filter(t => t.workspaceId === b.workspaceId).length, 0);
});
test("omitted task budget has a usable bounded default; explicit smaller caps remain unchanged", async () => {
  const f = fixture();
  const first = await f.service.dispatch(a, { operationId: "operation_default_cap", text: "UI" }, key);
  const second = await f.service.direct(a, first.taskId!, { operationId: "operation_explicit_cap", text: "补充", budget: 0.02 }, key);
  const db = await f.store.read();
  assert.equal(db.chatOperations?.find(o => o.operationId === "operation_default_cap_work")?.workRun?.budget, 0.5);
  assert.equal(db.chatOperations?.find(o => o.operationId === "operation_explicit_cap")?.workRun?.budget, 0.02);
  assert.equal(second.taskId, first.taskId);
});
async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}
const input = (operationId: string, text: string) => ({
  operationId,
  text,
  budget: 0.1,
  routeBudget: 0.1,
});

test("HTTP routes require trusted Key/admin gates and isolate task and operation receipts", async () => {
  const f = fixture(),
    app = express();
  app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => {
    const id = req.headers["x-fixture-user"];
    if (
      !["a", "b"].includes(String(id)) ||
      req.headers["x-fixture-key"] !== "present"
    ) {
      res.status(428).json({ error: "Key required" });
      return;
    }
    req.user = { id: String(id), role: id === "a" ? "admin" : "user" } as any;
    req.workspaceId = id === "a" ? "wa" : "wb";
    next();
  };
  const admin: express.RequestHandler = (req, res, next) => {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "admin required" });
      return;
    }
    next();
  };
  installCoordinatorRoutes(app, [auth], [auth, admin], f.store, key, {
    recallWithDiagnostics: async () => ({
      chunks: [],
      failures: [],
      status: "no_match",
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as { port: number },
    base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    user = "a",
    method = "GET",
    body?: unknown,
    keyPresent = true,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-fixture-user": user,
        ...(keyPresent ? { "x-fixture-key": "present" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request("/api/coordinator", "a", "GET", undefined, false)).status,
      428,
    );
    assert.equal((await request("/api/admin/executors", "b")).status, 403);
    const created = await request("/api/admin/executors", "a", "POST", {
      revision: 0,
      action: "draft",
      values: { ...executorDefaults(), name: "接口测试执行器" },
    });
    assert.equal(created.status, 200);
    const profile = (await created.json()) as { id: string };
    assert.equal(
      (await request(`/api/admin/executors/${profile.id}`, "b")).status,
      403,
    );
    assert.equal(
      (
        await request(`/api/admin/executors/${profile.id}`, "a", "POST", {
          revision: 0,
          action: "publish",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`/api/admin/executors/${profile.id}`, "a", "POST", {
          revision: 1,
          action: "publish",
        })
      ).status,
      200,
    );
    const result = await f.service.dispatch(
      a,
      input("operation_http_0001", "UI"),
      key,
    );
    assert.equal(
      (await request(`/api/coordinator/tasks/${result.taskId}`, "b")).status,
      404,
    );
    assert.equal(
      (await request("/api/coordinator/messages/operation_http_0001", "b"))
        .status,
      404,
    );
    const receipt = await request(
      "/api/coordinator/messages/operation_http_0001",
    );
    assert.equal(receipt.status, 200);
    const json = JSON.stringify(await receipt.json());
    assert.doesNotMatch(json, /fixture-only|modelPrompt|credentials/);
    assert.equal(
      (
        await request("/api/coordinator/resume", "a", "POST", {
          continueTaskId: result.taskId,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/api/coordinator/messages", "a", "POST", {
          ...input("operation_attach_01", "UI"),
          attachmentIds: ["file"],
        })
      ).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("real model-backed routing preserves one main conversation, separates original words, and replay does not call or charge twice", async () => {
  const f = fixture();
  const first = await f.service.dispatch(
      a,
      input("operation_first_001", "UI 保留输入框"),
      key,
    ),
    second = await f.service.dispatch(
      a,
      input("operation_second_02", "露营要带帐篷"),
      key,
    );
  assert.equal(first.conversation.id, second.conversation.id);
  assert.notEqual(first.taskId, second.taskId);
  const ui = await f.service.task(a, first.taskId!),
    camp = await f.service.task(a, second.taskId!);
  assert.equal(ui.conversation.messages[0].content, "UI 保留输入框");
  assert.equal(camp.conversation.messages[0].content, "露营要带帐篷");
  const calls = f.calls.length,
    ledger = (await f.store.read()).powerLedger.length;
  const replay = await f.service.dispatch(
    a,
    input("operation_first_001", "UI 保留输入框"),
    key,
  );
  assert.equal(replay.taskId, first.taskId);
  assert.equal(f.calls.length, calls);
  assert.equal((await f.store.read()).powerLedger.length, ledger);
  await assert.rejects(() =>
    f.service.dispatch(a, input("operation_first_001", "更改内容"), key),
  );
  const chat = await f.service.dispatch(
    a,
    input("operation_hello_001", "你好"),
    key,
  );
  assert.equal(chat.taskId, undefined);
  assert.equal(f.calls.at(-1)!.requiredTool, undefined, "ordinary conversation retains automatic routing");
  assert.equal((await f.service.state(a)).total, 2);
});
test("same-task supplements wait; another task proceeds; running snapshot excludes the new supplement", async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let count = 0;
  f.setWorker(async (messages) => {
    if (++count === 1) await blocked;
    return answer("本轮成果");
  });
  const first = await f.service.dispatch(
    a,
    input("operation_queue_001", "UI 第一轮"),
    key,
  );
  await f.service.resume(a, key);
  await waitFor(async () => f.calls.some((c) => c.modelId === "worker"));
  await f.service.dispatch(
    a,
    {
      ...input("operation_queue_002", "再补充一个边界"),
      boundTaskId: first.taskId,
    },
    key,
  );
  const camp = await f.service.dispatch(
    a,
    input("operation_queue_003", "露营第二件事"),
    key,
  );
  await f.service.resume(a, key);
  await waitFor(async () =>
    (await f.service.task(a, camp.taskId!)).jobs.some(
      (j) => j.state === "completed",
    ),
  );
  const interim = await f.service.task(a, first.taskId!);
  assert.equal(interim.jobs[0].state, "running");
  assert.equal(interim.jobs[1].state, "queued");
  assert.doesNotMatch(
    JSON.stringify(f.calls.find((c) => c.modelId === "worker")!.messages),
    /再补充一个边界|露营第二件事/,
  );
  release();
  await waitFor(async () =>
    (await f.service.task(a, first.taskId!)).jobs.every(
      (j) => j.state === "completed",
    ),
  );
  const db = await f.store.read();
  assert.equal(
    db.conversations
      .filter((c) => c.coordinatorMain)[0]
      .messages.filter((m) => m.content === "本轮成果").length,
    0,
  );
  assert.equal((await f.service.state(a)).notices.length, 3);
});
test("direct task continuation never changes the main conversation, and scoped reads/notifications cannot cross users", async () => {
  const f = fixture(),
    r = await f.service.dispatch(
      a,
      input("operation_direct_001", "UI 第一句"),
      key,
    );
  const main = (await f.service.state(a)).conversation!;
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_direct_002", "直接补充"),
    key,
  );
  assert.deepEqual((await f.service.state(a)).conversation, main);
  await assert.rejects(() => f.service.task(b, r.taskId!));
  await assert.rejects(() =>
    f.service.direct(b, r.taskId!, input("operation_direct_003", "越权"), key),
  );
  await f.service.resume(a, key);
  await waitFor(async () =>
    (await f.service.task(a, r.taskId!)).jobs.every(
      (j) => j.state === "completed",
    ),
  );
  const notices = (await f.service.state(a)).notices;
  await assert.rejects(() => f.service.acknowledge(b, [notices[0].id]));
  await f.service.acknowledge(
    a,
    notices.map((n) => n.id),
  );
  await f.service.acknowledge(
    a,
    notices.map((n) => n.id),
  );
  assert.equal((await f.service.state(a)).notices.length, 0);
  assert.equal((await f.service.state(b)).total, 0);
});
test("executor profiles use different models and immutable versions; stopping the profile stops further calls", async () => {
  const f = fixture();
  const p = await f.store.mutate((d) =>
    updateExecutor(d, "a", undefined, {
      revision: 0,
      action: "draft",
      values: {
        ...executorDefaults(),
        name: "专业设计",
        description: "设计任务",
        modelId: "special",
        prompt: "SPECIAL_VERSION_ONE",
      },
    }),
  );
  await f.store.mutate((d) =>
    updateExecutor(d, "a", p.id, { revision: 1, action: "publish" }),
  );
  f.setRoute((messages) =>
    messages.at(-1)?.role === "tool"
      ? answer("已分派")
      : {
          ...answer(""),
          toolCalls: [
            {
              id: "d",
              type: "function",
              function: {
                name: "delegate_task",
                arguments: JSON.stringify({
                  taskId: null,
                  title: "设计",
                  instruction: "完成设计",
                  executorId: p.id,
                }),
              },
            },
          ],
        },
  );
  const r = await f.service.dispatch(
    a,
    input("operation_profile_001", "做 UI"),
    key,
  );
  await f.store.mutate((d) => {
    updateExecutor(d, "a", p.id, {
      revision: 2,
      action: "draft",
      values: {
        ...executorDefaults(),
        name: "专业设计",
        description: "设计任务",
        modelId: "worker",
        prompt: "SPECIAL_VERSION_TWO",
      },
    });
    updateExecutor(d, "a", p.id, { revision: 3, action: "publish" });
  });
  await f.service.resume(a, key);
  await waitFor(
    async () =>
      (await f.service.task(a, r.taskId!)).jobs[0].state === "completed",
  );
  const worker = f.calls.find((c) => c.modelId === "special")!;
  assert.match(worker.messages[0].content!, /SPECIAL_VERSION_ONE/);
  assert.doesNotMatch(worker.messages[0].content!, /SPECIAL_VERSION_TWO/);
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_profile_002", "补充"),
    key,
  );
  await f.store.mutate((d) =>
    updateExecutor(d, "a", p.id, { revision: 4, action: "pause" }),
  );
  const count = f.calls.length;
  await f.service.resume(a, key);
  await waitFor(
    async () => (await f.service.task(a, r.taskId!)).jobs[1].state === "failed",
  );
  assert.equal(f.calls.length, count);
});
test("Key loss, insufficient budget and malformed/foreign routing never trigger a worker call", async () => {
  const f = fixture();
  await assert.rejects(() =>
    f.service.dispatch(a, input("operation_denied_001", "UI"), async () => {
      throw Error("Key absent");
    }),
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(() =>
    f.service.dispatch(
      a,
      { ...input("operation_budget_001", "UI"), routeBudget: 0.001 },
      key,
    ),
  );
  assert.equal(f.calls.length, 0);
  f.setRoute(() => ({
    ...answer(""),
    toolCalls: [
      {
        id: "d",
        type: "function",
        function: {
          name: "delegate_task",
          arguments: JSON.stringify({
            taskId: "foreign",
            title: "偷读",
            instruction: "test",
            executorId: "general",
          }),
        },
      },
    ],
  }));
  await assert.rejects(() =>
    f.service.dispatch(
      a,
      { ...input("operation_foreign_01", "UI"), boundTaskId: "foreign" },
      key,
    ),
  );
  const before = (await f.store.read()).conversations.length;
  await assert.rejects(() =>
    f.service.dispatch(a, input("operation_invalid_1", "UI"), key),
  );
  assert.equal((await f.store.read()).conversations.length, before);
  assert.equal(f.calls.filter((c) => c.modelId === "worker").length, 0);
});
test("failed tasks pause their supplements; restart marks only in-flight work interrupted and never replays it", async () => {
  const f = fixture();
  f.setWorker(async () => {
    throw Error("upstream unavailable");
  });
  const r = await f.service.dispatch(
    a,
    input("operation_fail_0001", "UI"),
    key,
  );
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_fail_0002", "补充保留"),
    key,
  );
  await f.service.resume(a, key);
  await waitFor(
    async () => (await f.service.task(a, r.taskId!)).jobs[0].state === "failed",
  );
  assert.equal((await f.service.task(a, r.taskId!)).jobs[1].state, "queued");
  await f.service.resume(a, key);
  assert.equal((await f.service.task(a, r.taskId!)).jobs[1].state, "queued");
  f.setWorker(undefined);
  await f.service.resume(a, key, r.taskId);
  await waitFor(
    async () =>
      (await f.service.task(a, r.taskId!)).jobs[1].state === "completed",
  );
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_fail_0003", "新补充"),
    key,
  );
  await f.store.mutate((d) => {
    const ops = d.chatOperations!.filter((o) => o.workRun);
    ops[0].status = "pending";
    ops[0].workRun!.state = "running";
    reconcileInterruptedChatOperations(d);
    assert.equal(ops[0].workRun!.state, "interrupted");
    assert.equal(ops.at(-1)!.workRun!.state, "queued");
  });
  const calls = f.calls.length;
  await f.service.resume(a, key);
  assert.equal(f.calls.length, calls);
});
test("knowledge revocation is checked before worker billing; public credentials and private prompt snapshots stay off task receipts", async () => {
  const f = fixture();
  await f.store.mutate((d) =>
    d.knowledgeConnections.push({
      id: "source",
      workspaceId: "wa",
      provider: "getnote",
      status: "connected",
      clientId: "c",
      encryptedApiKey: "PRIVATE_CREDENTIAL",
    } as any),
  );
  const r = await f.service.dispatch(
    a,
    input("operation_source_01", "UI 查资料"),
    key,
  );
  await f.store.mutate((d) => {
    d.knowledgeConnections[0].status = "revoked";
  });
  const calls = f.calls.length;
  await f.service.resume(a, key);
  await waitFor(
    async () => (await f.service.task(a, r.taskId!)).jobs[0].state === "failed",
  );
  assert.equal(f.calls.length, calls);
  assert.doesNotMatch(
    JSON.stringify(await f.service.task(a, r.taskId!)),
    /PRIVATE_CREDENTIAL|本轮交接|modelPrompt|encryptedApiKey/,
  );
});
