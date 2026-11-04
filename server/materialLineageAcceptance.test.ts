import test from 'node:test';
import assert from 'node:assert/strict';
import type {Store} from './db.js';
import type {Database,ModelConfig} from './types.js';
import type {ModelToolMessage,ToolChatResult} from './modelGateway.js';
import {CoordinatorService} from './coordinatorService.js';
import {defaultTaskValues,updateTaskConfig} from './aiTaskConfig.js';

// Real service admission, exact source authorization, queue, billing and default
// workflow. Only the model boundary is synthetic; no network or private data.
const owner={workspaceId:'lineage-space',userId:'lineage-owner'},foreign={workspaceId:'other-space',userId:'other-owner'},key=async()=>{};
const answer=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}});
const invoke=(name:string,args:unknown):ToolChatResult=>({...answer(''),toolCalls:[{id:'lineage-control',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const markers=(name:string)=>['HEAD','MIDDLE','TAIL'].map(part=>`LINEAGE_${name}_${part}_73`);
function material(name:string,intro:string,size:number){
 const [head,middle,tail]=markers(name),fixed=`${intro}\n${head}\n\n${middle}\n\n${tail}`,remaining=size-fixed.length;
 assert.ok(remaining>=0);
 const text=`${intro}\n${head}\n${'甲'.repeat(Math.floor(remaining/2))}\n${middle}\n${'乙'.repeat(remaining-Math.floor(remaining/2))}\n${tail}`;
 assert.equal(text.length,size);return text;
}
const first=material('A','完整分析下面这份原始材料，只交付正文，不联网、不查知识库、不生成文件。材料如下：',10_000);
const second=material('B','把本次第二份材料与前面已选原始材料一起比较，不替换前面的材料。材料如下：',1666);
const third=material('C','再追加第三份材料，合并比较此前两份已选原文与本份材料，不替换。材料如下：',1900);
const replacement=material('D','改用以下全新材料，只分析本次原文，忽略前面所有原始材料和旧分析。材料如下：',1200);
function assertSources(messages:ModelToolMessage[],included:string[],excluded:string[]=[]){
 const actual=JSON.stringify(messages);
 for(const name of included)for(const marker of markers(name))assert.equal(actual.split(marker).length-1,1,`${name} original marker must reach the actual model exactly once: ${marker}`);
 for(const name of excluded)for(const marker of markers(name))assert.equal(actual.includes(marker),false,`replaced or unscoped material must stay absent: ${marker}`);
}

function fixture(options:{multiGoal?:boolean}={}){
 const models=['router','worker'].map(id=>({id,name:id,kind:'chat',enabled:true,apiKey:'synthetic-only',baseUrl:'https://invalid.example',protocol:'openai',model:id,systemPrompt:'',isDefault:id==='worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig));
 let db={users:[{id:owner.userId,enabled:true,role:'admin',defaultWorkspaceId:owner.workspaceId},{id:foreign.userId,enabled:true,role:'user',defaultWorkspaceId:foreign.workspaceId}],workspaces:[{id:owner.workspaceId,status:'active'},{id:foreign.workspaceId,status:'active'}],workspaceMembers:[owner,foreign],models,settings:{safetyRules:'synthetic safety',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[owner,foreign].map(scope=>({...scope,id:scope.userId,balanceMicros:100e6,reservedMicros:0})),powerLedger:[],attachments:[]} as unknown as Database;
 for(const [task,modelId] of [['coordinator','router'],['task_worker','worker']] as const){
  updateTaskConfig(db.settings,models,task,{revision:0,action:'draft',values:{...defaultTaskValues(task),modelId,enabled:true}},owner.userId,'now');
  updateTaskConfig(db.settings,models,task,{revision:1,action:'publish'},owner.userId,'now');
 }
 let chain=Promise.resolve();const store={read:async()=>structuredClone(db),mutate:<T>(fn:(draft:Database)=>T)=>{const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.then(()=>{},()=>{});return next;}} as Store;
 const actual:ModelToolMessage[][]=[];let taskId:string|undefined,decision:'current'|'conversation'='current',routerCalls=0;
 const service=new CoordinatorService(store,{recallWithDiagnostics:async()=>assert.fail('this synthetic task has no authorized knowledge source')},{contextMode:'adaptive',reportCall:async()=>answer('合成结果已返回。'),modelCall:async(model,messages,tools)=>{
  if(model.id!=='router'){
   assert.deepEqual(tools,[]);actual.push(structuredClone(messages));
   return answer(JSON.stringify({outcome:'completed',content:`第${actual.length}轮的合成分析正文，不包含原始材料标记。`,summary:'本轮合成分析已完成。'}));
  }
  routerCalls++;
  const returned=messages.filter(message=>message.role==='tool').flatMap(message=>{try{return[JSON.parse(message.content||'null')];}catch{return[];}});
  if(returned.some(value=>value?.taskId||value?.taskIds?.length))return answer('本轮已接到。');
  if(!tools.some(tool=>tool.function.name==='delegate_task'))return invoke('load_tools',{names:['delegate_task','delegate_tasks','read_context']});
  if(taskId){
   const read=returned.find(value=>value?.id===taskId);
   if(!read)return invoke('read_task',{taskId});
   const original=read.originalRequest;
   if(original?.truncated&&!returned.some(value=>value?.items?.some((item:{id:string;truncated?:boolean})=>item.id===original.id&&!item.truncated)))return invoke('read_context',{query:'',taskId,messageId:original.id,offset:original.nextOffset});
  }
  const task={taskId:taskId??null,title:'合成材料分析',instruction:decision==='conversation'?'把本轮新增原文与此前已选原文一起比较，交付完整分析正文，不联网、不生成文件。':'只分析本轮明确选定原文，交付完整正文，不联网、不生成文件。',executorId:'general',featureIds:[],materialScope:decision};
  // No explicit workflow/historyCount: the ordinary reviewed default must
  // preserve authorized selected material without relying on lucky planning.
  assert.equal('workflow' in task,false);
  if(!taskId&&options.multiGoal)return invoke('delegate_tasks',{tasks:[{...task,outputKind:'text',dependsOn:[]},{...task,title:'另一份独立短文',instruction:'只写另一任务的独立短文，不执行其他事情。',outputKind:'text',dependsOn:[]}]});
  return invoke('delegate_task',task);
 }});
 const settle=async(count:number)=>{
  for(let n=0;n<300;n++){
   const jobs=(await store.read()).chatOperations!.filter(operation=>operation.conversationId===taskId&&operation.workRun);
   if(jobs.length===count&&['completed','failed'].includes(jobs.at(-1)!.workRun!.state))return jobs;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('synthetic material lineage did not settle');
 };
 const start=async()=>{
  const result=await service.dispatch(owner,{operationId:'lineage_initial_operation',text:options.multiGoal?'分别创建两个独立任务，只使用各自短交接，不混合原文。\n'+first:first,budget:1,routeBudget:1},key);
  taskId=result.taskId??result.taskIds[0];assert.ok(taskId,JSON.stringify(result));await service.resume(owner,key);
  assert.equal((await settle(1))[0].workRun!.state,'completed');
  if(options.multiGoal)for(let n=0;n<300&&(await store.read()).chatOperations!.some(op=>op.workRun&&op.workRun.state!=='completed');n++)await new Promise(resolve=>setTimeout(resolve,10));
  return taskId!;
 };
 const submit=async(operationId:string,text:string,count:number,scope:'current'|'conversation')=>{
  assert.ok(taskId);decision=scope;
  await service.direct(owner,taskId,{operationId,text,budget:1},key);await service.resume(owner,key);
  const jobs=await settle(count),job=jobs.at(-1)!.workRun!;assert.equal(job.state,'completed',job.error);
  assert.ok(job.workflow?.spec.steps.every(step=>!step.historyCount),'these regressions intentionally use the default workflow without selected history');
  return jobs;
 };
 return{service,store,actual,start,submit,settle,routerCalls:()=>routerCalls};
}

test('default workflow keeps a 10k original through two appends and a brief, then a replacement drops the entire old lineage',async()=>{
 const f=fixture();await f.start();assertSources(f.actual[0],['A']);
 await f.submit('lineage_append_second',second,2,'conversation');assertSources(f.actual[1],['A','B']);
 await f.submit('lineage_append_third',third,3,'conversation');assertSources(f.actual[2],['A','B','C']);
 const before=f.routerCalls();await f.submit('lineage_brief_followup','继续沿用已选原始材料，把三份材料的比较分析写得口语一点，不更换材料。',4,'conversation');
 assertSources(f.actual[3],['A','B','C']);assert.equal(f.routerCalls(),before,'a short known clarification does not buy another routing round');
 await f.submit('lineage_replace_all',replacement,5,'current');assertSources(f.actual[4],['D'],['A','B','C']);
});

test('foreign callers cannot read or buy a continuation of another owner selected material',async()=>{
 const f=fixture(),taskId=await f.start(),calls=f.actual.length,routes=f.routerCalls(),before=(await f.store.read()).modelUsageRecords.length;
 await assert.rejects(()=>f.service.direct(foreign,taskId,{operationId:'lineage_foreign_attempt',text:second,budget:1},key));
 await assert.rejects(()=>f.service.task(foreign,taskId));assert.equal(f.actual.length,calls);assert.equal(f.routerCalls(),routes);assert.equal((await f.store.read()).modelUsageRecords.length,before);
});

test('revoking an earlier original in an appended lineage stops before another paid model call',async()=>{
 const f=fixture(),taskId=await f.start();await f.submit('lineage_revoke_append_b',second,2,'conversation');await f.submit('lineage_revoke_append_c',third,3,'conversation');
 const snapshot=await f.store.read(),firstInput=snapshot.conversations.find(task=>task.id===taskId)!.messages.find(message=>message.role==='user')!;
 await f.store.mutate(d=>{d.messages=d.messages.filter(message=>!(message.conversationId===taskId&&message.id===firstInput.id));});
 const calls=f.actual.length,routes=f.routerCalls(),usage=(await f.store.read()).modelUsageRecords.length;
 try{await f.service.direct(owner,taskId,{operationId:'lineage_revoked_brief',text:'继续使用这三份已选原始材料，补充比较结论。',budget:1},key);await f.service.resume(owner,key);}catch{/* A missing exact source may reject admission or stop its worker. */}
 for(let n=0;n<300;n++){
  const pending=(await f.store.read()).chatOperations!.some(operation=>operation.conversationId===taskId&&operation.workRun&&['queued','running'].includes(operation.workRun.state));
  if(!pending)break;
  assert.ok(n<299,'source rejection must not leave a runnable job behind');await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(f.actual.length,calls,'an old revoked source cannot be silently dropped and a new model bought');assert.equal(f.routerCalls(),routes);assert.equal((await f.store.read()).modelUsageRecords.length,usage);
});

test('a scoped brief child cannot promote the original multi-goal body into selected material',async()=>{
 const f=fixture({multiGoal:true}),taskId=await f.start();for(const messages of f.actual)assertSources(messages,[],['A']);
 const before=f.actual.length;await f.service.direct(owner,taskId,{operationId:'lineage_brief_child_follow',text:'把当前短文写得更温暖一点，不增加其他任务。',budget:1},key);await f.service.resume(owner,key);await f.settle(2);
 for(const messages of f.actual.slice(before))assertSources(messages,[],['A']);
 assert.ok(f.actual.length<=before+1,'no sibling model is repurchased');
});
