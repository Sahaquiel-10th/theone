import test from 'node:test';
import assert from 'node:assert/strict';
import type {Store} from './db.js';
import type {Database,ModelConfig} from './types.js';
import type {ModelToolMessage,ToolChatResult} from './modelGateway.js';
import {CoordinatorService} from './coordinatorService.js';
import {defaultTaskValues,updateTaskConfig} from './aiTaskConfig.js';

// Real dispatch, transaction, queue, source binding, workflow and model input.
// Only external model/knowledge boundaries are synthetic; no private data or
// actual provider requests are used by these acceptance regressions.
const owner={workspaceId:'wa',userId:'a'},foreign={workspaceId:'wb',userId:'b'},key=async()=>{};
const response=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}});
const call=(id:string,name:string,args:unknown)=>({id,type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
const request=(operationId:string,text:string)=>({operationId,text,featureIds:[],budget:.5,modelId:'router',webSearch:false});
const original='分别创建甲任务与乙任务，两个任务不要混合：甲材料 ALPHA_SIBLING_SOURCE；乙材料 BETA_SIBLING_SOURCE。\n'+'仅属原批次的补充材料。'.repeat(150);
const tasks=[
 {taskId:null,title:'甲任务',instruction:'只写甲的合成短文，语气温暖，不处理其他事情。',executorId:'general',featureIds:[]},
 {taskId:null,title:'乙任务',instruction:'只写乙的合成短文，语气简洁，不处理其他事情。',executorId:'general',featureIds:[]},
];
const assertNoSiblingSource=(messages:ModelToolMessage[])=>assert.doesNotMatch(JSON.stringify(messages),/ALPHA_SIBLING_SOURCE|BETA_SIBLING_SOURCE/,'a scoped brief must not be replaced by the multi-goal provenance body');

function fixture(){
 const models=['router','worker'].map(id=>({id,name:id,kind:'chat',enabled:true,apiKey:'synthetic-only',baseUrl:'https://invalid.example',protocol:'openai',model:id,systemPrompt:'',isDefault:id==='worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig));
 let db={users:[{id:'a',enabled:true,role:'admin',defaultWorkspaceId:'wa'},{id:'b',enabled:true,role:'user',defaultWorkspaceId:'wb'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[owner,foreign],models,settings:{safetyRules:'synthetic safety',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[owner,foreign].map(s=>({...s,id:s.userId,balanceMicros:100e6,reservedMicros:0})),powerLedger:[],attachments:[]} as unknown as Database;
 for(const [task,modelId] of [['coordinator','router'],['task_worker','worker']] as const){
  updateTaskConfig(db.settings,models,task,{revision:0,action:'draft',values:{...defaultTaskValues(task),modelId,enabled:true}},'a','now');
  updateTaskConfig(db.settings,models,task,{revision:1,action:'publish'},'a','now');
 }
 let chain=Promise.resolve();
 const store={read:async()=>structuredClone(db),mutate:<T>(fn:(draft:Database)=>T)=>{const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.then(()=>{},()=>{});return next;}} as Store;
 let route:(messages:ModelToolMessage[])=>ToolChatResult=()=>response('合成普通回复');
 let worker:(messages:ModelToolMessage[])=>Promise<ToolChatResult>=async()=>response('当前任务的合成成果');
 const workerInputs:ModelToolMessage[][]=[];
 const service=new CoordinatorService(store,{recallWithDiagnostics:async()=>assert.fail('no knowledge was authorized')},{contextMode:'legacy',modelCall:async(model,messages)=>{
  if(model.id==='router')return route(messages);
  workerInputs.push(structuredClone(messages));return worker(messages);
 }});
 const settle=async(count:number)=>{
  for(let i=0;i<300;i++){const snapshot=await store.read(),jobs=snapshot.chatOperations!.filter(op=>op.workRun);if(jobs.length===count&&jobs.every(op=>op.workRun!.state==='completed'))return snapshot;await new Promise(resolve=>setTimeout(resolve,10));}
  const snapshot=await store.read();assert.fail('scoped synthetic jobs did not complete: '+JSON.stringify(snapshot.chatOperations!.filter(op=>op.workRun).map(op=>({state:op.workRun!.state,failure:op.failure}))));
 };
 const batch=async(scope?:'current')=>{
  route=messages=>messages.at(-1)?.role==='tool'?response('两件合成任务已接到。'):{...response(''),toolCalls:[call('scoped-batch','delegate_tasks',{tasks:tasks.map(task=>({...task,outputKind:'text',dependsOn:[],...(scope?{materialScope:scope}:{})}))})]};
  const result=await service.dispatch(owner,request(`scoped_batch_original_${scope??'conversation'}`,original),key);
  await service.resume(owner,key);await settle(2);assert.equal(result.taskIds.length,2);return result.taskIds;
 };
 return {service,store,workerInputs,settle,batch,setRoute:(value:typeof route)=>{route=value;},setWorker:(value:typeof worker)=>{worker=value;}};
}

test('multiple single-task delegate calls settle the whole handoff before either child sees scoped material',async()=>{
 const f=fixture();let workers=0;
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?response('两件合成任务已接到。'):{...response(''),toolCalls:tasks.map((task,index)=>call(`single-${index}`,'delegate_task',task))});
 f.setWorker(async messages=>{
  workers++;assertNoSiblingSource(messages);
  const snapshot=await f.store.read(),parent=snapshot.chatOperations!.find(op=>op.operationId==='scoped_multiple_single_calls')!;
  assert.notEqual(parent.status,'pending','a first child cannot begin while another sibling handoff can still be added');
  const siblings=snapshot.chatOperations!.filter(op=>op.workRun?.parentOperationId===parent.operationId);
  assert.equal(siblings.length,2);assert.ok(siblings.every(op=>op.workRun!.inputContentMode==='brief'));
  return response('只针对当前任务的合成成果');
 });
 const result=await f.service.dispatch(owner,request('scoped_multiple_single_calls',original),key);
 await f.service.resume(owner,key);const snapshot=await f.settle(2);
 assert.equal(result.taskIds.length,2);assert.equal(workers,2);
 for(const taskId of result.taskIds){assert.equal(snapshot.conversations.find(c=>c.id===taskId)!.messages.find(m=>m.role==='user')!.content,original,'full original provenance is still retained for its owner');await assert.rejects(()=>f.service.task(foreign,taskId));}
 assert.equal(workers,2);
});

test('workflow-selected task history preserves a brief instead of reintroducing the earlier multi-goal original',async()=>{
 const f=fixture(),ids=await f.batch();let read=false;
 f.setRoute(()=>{
  if(!read){read=true;return {...response(''),toolCalls:[call('read-task','read_task',{taskId:ids[0]})]};}
  return {...response(''),toolCalls:[call('same-task-model','delegate_task',{...tasks[0],taskId:ids[0],workflow:{version:1,steps:[{id:'edit',title:'仅修改甲的语气',kind:'model',instruction:'只修改甲的合成成果语气。',inputs:[],historyCount:20}]}})]};
 });
 f.setWorker(async messages=>{assertNoSiblingSource(messages);assert.match(JSON.stringify(messages),/当前任务的合成成果|只写甲的合成短文/,'useful scoped history still reaches the next model');return response('只修改甲的合成成果。');});
 const result=await f.service.dispatch(owner,{...request('scoped_workflow_history_follow','请把这份短文改得更自然。'),boundTaskId:ids[0]},key);
 await f.service.resume(owner,key);const snapshot=await f.settle(3);
 assert.equal(result.taskId,ids[0]);assert.equal(f.workerInputs.length,3);
 const latest=snapshot.chatOperations!.filter(op=>op.conversationId===ids[0]&&op.workRun).at(-1)!;
 assert.equal(latest.workRun!.workflow!.spec.steps[0].historyCount,20);assert.equal(latest.workRun!.state,'completed');
 await assert.rejects(()=>f.service.task(foreign,ids[0]));
});

test('a brief child selecting current material cannot promote multi-goal provenance into a later direct supplement',async()=>{
 const f=fixture(),ids=await f.batch('current'),before=f.workerInputs.length;
 f.setWorker(async messages=>{assertNoSiblingSource(messages);assert.match(JSON.stringify(messages),/请把这份短文改得更自然/);return response('仅调整当前短文的合成成果。');});
 await f.service.direct(owner,ids[0],{operationId:'scoped_brief_material_follow',text:'请把这份短文改得更自然。'},key);
 await f.service.resume(owner,key);const snapshot=await f.settle(3);
 assert.equal(f.workerInputs.length,before+1);const jobs=snapshot.chatOperations!.filter(op=>op.conversationId===ids[0]&&op.workRun);
 assert.equal(jobs[0].workRun!.inputContentMode,'brief');assert.equal(jobs.at(-1)!.workRun!.materialScope,'current');assert.equal(jobs.at(-1)!.workRun!.state,'completed');
 assertNoSiblingSource(f.workerInputs.at(-1)!);await assert.rejects(()=>f.service.task(foreign,ids[0]));
});
