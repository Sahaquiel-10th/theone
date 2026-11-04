import test from 'node:test';
import assert from 'node:assert/strict';
import type {Store} from './db.js';
import type {Database,ModelConfig} from './types.js';
import type {ModelToolMessage,ToolChatResult} from './modelGateway.js';
import {CoordinatorService} from './coordinatorService.js';
import {defaultTaskValues,updateTaskConfig} from './aiTaskConfig.js';

const scope={workspaceId:'routing-space',userId:'routing-owner'},foreign={workspaceId:'foreign-space',userId:'foreign-owner'},key=async()=>{};
const answer=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}});
const invoke=(name:string,args:unknown):ToolChatResult=>({...answer(''),toolCalls:[{id:'material-routing-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
function fixture(options:{batch?:boolean;omitOnce?:boolean;chargeRouting?:boolean}={}){
 const models=['router','worker'].map(id=>({id,name:id,enabled:true,kind:'chat',apiKey:'synthetic',model:'synthetic',protocol:'openai',baseUrl:'https://invalid.example',systemPrompt:'',isDefault:id==='worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig));
 let db={users:[{id:scope.userId,enabled:true,role:'admin',defaultWorkspaceId:scope.workspaceId},{id:foreign.userId,enabled:true,role:'user',defaultWorkspaceId:foreign.workspaceId}],workspaces:[{id:scope.workspaceId,status:'active'},{id:foreign.workspaceId,status:'active'}],workspaceMembers:[scope,foreign],models,settings:{safetyRules:'synthetic safety',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[scope,foreign].map(s=>({...s,id:s.userId,balanceMicros:100e6,reservedMicros:0})),powerLedger:[],attachments:[]} as unknown as Database;
 for(const [task,modelId] of [['coordinator','router'],['task_worker','worker']] as const){updateTaskConfig(db.settings,models,task,{revision:0,action:'draft',values:{...defaultTaskValues(task),modelId,enabled:true}},scope.userId,'now');updateTaskConfig(db.settings,models,task,{revision:1,action:'publish'},scope.userId,'now');}
 let chain=Promise.resolve();const store={read:async()=>structuredClone(db),mutate:<T>(fn:(value:Database)=>T)=>{const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.then(()=>{},()=>{});return next;}} as Store;
 let taskId:string|undefined,routerCalls=0,delegations=0,gate:Promise<void>|undefined;const actual:ModelToolMessage[][]=[];
 const modelCall:NonNullable<NonNullable<ConstructorParameters<typeof CoordinatorService>[2]>['modelCall']>=async(model,messages,tools)=>{
  if(model.id!=='router'){actual.push(structuredClone(messages));return answer(JSON.stringify({outcome:'completed',content:actual.length===1?'OLD_ASSISTANT_RESULT_CODE_99：这是旧材料的分析结果。':'NEW_CURRENT_RESULT：已分析本轮材料。',summary:actual.length===1?'OLD_SUMMARY_CODE_88':'新材料完成。'}));}
  routerCalls++;if(gate)await gate;
  if(!tools.some(tool=>tool.function.name==='delegate_task'))return invoke('load_tools',{names:['delegate_task','delegate_tasks']});
  const read=messages.filter(message=>message.role==='tool').some(message=>{try{return JSON.parse(message.content??'null')?.id===taskId;}catch{return false;}});
  if(taskId&&!read)return invoke('read_task',{taskId});
  if(taskId)delegations++;
  const task={taskId:taskId??null,title:'材料分析',instruction:'仅分析本轮指定的原始材料，返回完整正文，不联网、不生成文件。',executorId:'general',featureIds:[],...(!taskId||!options.omitOnce||delegations>1?{materialScope:'current'}:{}),...(taskId?{workflow:{version:1,steps:[{id:'analysis',kind:'model',title:'分析选定材料',instruction:'只依据本轮选定的材料输出正文。',inputs:[],historyCount:20}]}}:{})};
  if(taskId&&options.omitOnce&&delegations===2)assert.match(messages.at(-1)!.content!,/materialScope/,'a missing semantic decision is repaired before a child is created');
  const result=options.batch?invoke('delegate_tasks',{tasks:[{...task,outputKind:'text',dependsOn:[]}]}):invoke('delegate_task',task);
  return taskId&&options.chargeRouting?{...result,usage:{inputTokens:9000,outputTokens:1000,totalTokens:10000,source:'provider'}}:result;
 };
 const createService=()=>new CoordinatorService(store,{recallWithDiagnostics:async()=>assert.fail('no knowledge was authorized')},{contextMode:'adaptive',modelCall});
 const service=createService();
 const settle=async(count:number)=>{for(let i=0;i<250;i++){const jobs=(await store.read()).chatOperations!.filter(op=>op.conversationId===taskId&&op.workRun);if(jobs.length===count&&['completed','failed'].includes(jobs.at(-1)!.workRun!.state))return jobs;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('direct material routing did not settle');};
 const start=async()=>{const r=await service.dispatch(scope,{operationId:'material_routing_seed_operation',text:'请完整分析以下原始材料，不联网、不查知识库、不生成文件。材料如下：\nOLD_SOURCE_BODY_CODE_42',budget:1,routeBudget:1},key);taskId=r.taskId;assert.ok(taskId,JSON.stringify(r));await service.resume(scope,key);assert.equal((await settle(1))[0].workRun!.state,'completed');return taskId!;};
 return {service,store,actual,start,settle,restart:createService,routerCalls:()=>routerCalls,delegations:()=>delegations,setGate:(value?:Promise<void>)=>{gate=value;}};
}

for(const batch of [false,true])test(`direct replacement requires an explicit semantic scope and excludes all pre-replacement results; batch=${batch}`,async()=>{
 const f=fixture({batch,omitOnce:true}),taskId=await f.start(),operationId=`material_routing_required_${batch}`;
 const text='请改用以下新材料，不使用此前原文或分析，仍只交付分析正文。材料如下：\nNEW_SOURCE_HEAD\n'+ '新正文。'.repeat(250)+'\nNEW_SOURCE_TAIL_CODE_57';
 const before=f.routerCalls();const result=await f.service.direct(scope,taskId,{operationId,text,budget:1},key);assert.equal(result.status,'accepted');assert.equal(f.routerCalls()-before,3,'one read, one rejected omission and one corrected handoff');
 await f.service.resume(scope,key);const jobs=await f.settle(2),job=jobs[1].workRun!;
 assert.equal(job.state,'completed',job.error);assert.equal(job.materialScope,'current');assert.equal(job.materialSource?.inputMessageId,job.inputMessageId);assert.equal(job.budgetIncludesRouting,true);
 assert.equal(f.actual.length,2);const actual=JSON.stringify(f.actual[1]);assert.match(actual,/NEW_SOURCE_HEAD/);assert.match(actual,/NEW_SOURCE_TAIL_CODE_57/);assert.doesNotMatch(actual,/OLD_SOURCE_BODY_CODE_42|OLD_ASSISTANT_RESULT_CODE_99|OLD_SUMMARY_CODE_88/);
 const detail=await f.service.task(scope,taskId);assert.equal(detail.jobs[1].operationId,`${operationId}_work`);assert.equal(detail.jobs[1].submissionOperationId,operationId);
 await assert.rejects(()=>f.service.task(foreign,taskId));const calls=f.routerCalls();await f.service.direct(scope,taskId,{operationId,text,budget:1},key);await f.service.resume(scope,key);assert.equal(f.routerCalls(),calls);assert.equal(f.actual.length,2);
 await assert.rejects(()=>f.service.direct(scope,taskId,{operationId,text:text+'改',budget:1},key));assert.equal(f.routerCalls(),calls);
});

test('a pending routed parent cannot be purchased again after restart, and exposes one exact submission receipt',async()=>{
 const f=fixture(),taskId=await f.start(),operationId='material_routing_pending_parent';let release!:()=>void;
 f.setGate(new Promise(resolve=>release=resolve));
 const payload={operationId,text:'材料如下：\n当前新版本，替换此前版本。',budget:1};
 const running=f.service.direct(scope,taskId,payload,key);
 for(let i=0;i<100&&(await f.store.read()).chatOperations!.find(op=>op.operationId===operationId)?.status!=='pending';i++)await new Promise(resolve=>setTimeout(resolve,5));
 const count=f.routerCalls();await assert.rejects(()=>f.restart().direct(scope,taskId,payload,key),/处理中|还有一条/);assert.equal(f.routerCalls(),count);
 release();f.setGate();const result=await running;assert.equal(result.taskId,taskId);await f.service.resume(scope,key);const jobs=await f.settle(2);assert.equal(jobs.length,2);assert.equal(f.actual.length,2);
 const detail=await f.service.task(scope,taskId);assert.equal(detail.jobs[1].submissionOperationId,operationId);
 await f.service.direct(scope,taskId,payload,key);assert.equal(f.actual.length,2);assert.equal((await f.store.read()).chatOperations!.filter(op=>op.workRun?.parentOperationId===operationId).length,1);
});

test('an already accepted legacy direct operation replays its original enqueue even if it now resembles a material decision',async()=>{
 const f=fixture(),taskId=await f.start();await f.store.mutate(db=>{const previous=db.chatOperations!.find(op=>op.conversationId===taskId&&op.workRun)!;previous.workRun!.materialScope='conversation';delete previous.workRun!.materialSources;});
 const payload={operationId:'material_routing_old_direct_path',text:'材料如下：\n'+ '旧入口已受理的原话。'.repeat(100),budget:1};
 const before=f.routerCalls();await f.service.direct(scope,taskId,payload,key);await f.service.resume(scope,key);const jobs=await f.settle(2);assert.equal(f.routerCalls(),before);
 await f.store.mutate(db=>{const own=db.chatOperations!.find(op=>op.id===jobs[1].id)!.workRun!;own.materialScope='current';own.materialSource=own.inputSource;});
 await f.service.direct(scope,taskId,payload,key);assert.equal(f.routerCalls(),before);assert.equal((await f.store.read()).chatOperations!.filter(op=>op.conversationId===taskId&&op.workRun).length,2);assert.equal(f.actual.length,2);
});

test('the new routing and worker share the submitted cap; routing spend can deny the first worker call',async()=>{
 const f=fixture({chargeRouting:true}),taskId=await f.start();
 await f.store.mutate(db=>{db.models.find(model=>model.id==='worker')!.outputPowerPerMillion=30;});
 const operationId='material_routing_shared_cap';const result=await f.service.direct(scope,taskId,{operationId,text:'材料如下：\n本轮新内容，只分析这份内容。',budget:.1},key);assert.equal(result.status,'accepted',JSON.stringify(result));
 await f.service.resume(scope,key);const jobs=await f.settle(2),job=jobs[1].workRun!,db=await f.store.read();
 assert.equal(job.state,'failed');assert.match(job.failureCode??'',/budget/);assert.equal(f.actual.length,1,'routing costs leave insufficient headroom for any new worker provider call');assert.equal(job.budgetIncludesRouting,true);
 const parent=db.chatOperations!.find(op=>op.operationId===operationId)!,ids=new Set([parent.requestId,jobs[1].requestId]);const spent=db.modelUsageRecords.filter(row=>row.requestId&&ids.has(row.requestId)).reduce((n,row)=>n+(row.chargedMicros??0)+(row.reservedMicros??0),0);
 assert.ok(spent>0&&spent<=100000);await assert.rejects(()=>f.service.task(foreign,taskId));
});

test('public submission aliases never borrow another owner parent and HTTP-shaped budget flags have no authority',async()=>{
 const f=fixture(),taskId=await f.start();const operationId='material_routing_public_main';
 await f.service.dispatch(scope,{operationId,text:'材料如下：本轮重新选择的内容。',boundTaskId:taskId,budget:1,routeBudget:1,budgetIncludesRouting:true} as Parameters<CoordinatorService['dispatch']>[1],key);
 await f.service.resume(scope,key);const jobs=await f.settle(2);assert.equal(jobs[1].workRun!.budgetIncludesRouting,undefined,'only the private direct entry can opt into the new shared cap');
 await f.store.mutate(db=>{db.chatOperations!.push({...foreign,id:'foreign-parent',operationId:'foreign-parent-operation',payloadHash:'x',requestId:'foreign-request',status:'completed',createdAt:'now',updatedAt:'now'});db.chatOperations!.find(op=>op.id===jobs[1].id)!.workRun!.parentOperationId='foreign-parent-operation';});
 const detail=await f.service.task(scope,taskId);assert.equal(detail.jobs[1].submissionOperationId,detail.jobs[1].operationId);assert.notEqual(detail.jobs[1].submissionOperationId,'foreign-parent-operation');
});
