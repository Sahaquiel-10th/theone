import test from 'node:test';
import assert from 'node:assert/strict';
import type {Store} from './db.js';
import type {Database,ModelConfig} from './types.js';
import type {ToolChatResult,ModelToolMessage} from './modelGateway.js';
import {CoordinatorService} from './coordinatorService.js';
import {updateTaskConfig,defaultTaskValues} from './aiTaskConfig.js';

const scope={workspaceId:'direct_acceptance_workspace',userId:'direct_acceptance_user'};
const answer=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}});
const key=async()=>{};
function fixture(nextScope:'current'|'conversation'='conversation'){
 const models=['router','worker'].map(id=>({id,name:id,enabled:true,kind:'chat',apiKey:'synthetic-only',model:'synthetic',baseUrl:'https://invalid.example',systemPrompt:'',isDefault:id==='worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig));
 let db={users:[{id:scope.userId,enabled:true,role:'admin',defaultWorkspaceId:scope.workspaceId,createdAt:'now'}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[scope],models,settings:{safetyRules:'synthetic safety',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[{...scope,id:'synthetic-power',balanceMicros:100e6,reservedMicros:0}],powerLedger:[],attachments:[]} as unknown as Database;
 for(const [task,modelId] of [['coordinator','router'],['task_worker','worker']] as const){updateTaskConfig(db.settings,models,task,{revision:0,action:'draft',values:{...defaultTaskValues(task),modelId,enabled:true}},scope.userId,'now');updateTaskConfig(db.settings,models,task,{revision:1,action:'publish'},scope.userId,'now');}
 let chain=Promise.resolve();const store={read:async()=>structuredClone(db),mutate:<T>(fn:(d:Database)=>T)=>{const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.then(()=>{},()=>{});return next;}} as Store;
 const actual:ModelToolMessage[][]=[];let routerCalls=0,acceptedTaskId:string|undefined;
 const service=new CoordinatorService(store,{recallWithDiagnostics:async()=>assert.fail('no knowledge in this synthetic acceptance')},{contextMode:'adaptive',reportCall:async()=>answer('合成结果已返回。'),modelCall:async(model,messages,tools)=>{
  if(model.id==='router'){
   routerCalls++;
   const returned=messages.filter(message=>message.role==='tool').flatMap(message=>{try{return[JSON.parse(message.content||'null')];}catch{return[];}});
   if(returned.some(value=>value?.taskId))return answer('本轮已接到。');
   if(acceptedTaskId&&!returned.some(value=>value?.id===acceptedTaskId))return {...answer(''),toolCalls:[{id:'read-original',type:'function',function:{name:'read_task',arguments:JSON.stringify({taskId:acceptedTaskId})}}]};
   if(!tools.some(tool=>tool.function.name==='delegate_task'))return {...answer(''),toolCalls:[{id:'load-routing',type:'function',function:{name:'load_tools',arguments:JSON.stringify({names:['delegate_task']})}}]};
   const materialScope=acceptedTaskId?nextScope:'current';
   return {...answer(''),toolCalls:[{id:'route-material',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:acceptedTaskId??null,title:'合成材料关系分析',instruction:materialScope==='conversation'?'将本轮新增材料与已有原始材料一起比较，保留来源，直接交付分析正文。':'只分析本轮明确选定原始材料，交付正文；不联网、不生成文件。',executorId:'general',featureIds:[],materialScope,...(acceptedTaskId&&materialScope==='conversation'?{workflow:{version:1,steps:[{id:'compare',title:'比较两份材料',kind:'model',instruction:'比较本轮新增材料及明确选择的已有两条历史，交付正文。',inputs:[],required:true,historyCount:2}]}}:{})})}}]};
  }
  assert.equal(model.id,'worker');assert.deepEqual(tools,[]);actual.push(structuredClone(messages));return answer(JSON.stringify({outcome:'completed',content:'这是本轮合成分析的完整正文。',summary:'本轮分析完成。'}));
 }});
 const settle=async(count:number)=>{for(let n=0;n<200;n++){const jobs=(await store.read()).chatOperations!.filter(op=>op.workRun&&op.conversationId===acceptedTaskId);if(jobs.length===count&&['completed','failed'].includes(jobs.at(-1)!.workRun!.state))return jobs;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('synthetic direct material did not settle');};
 const start=async()=>{const source='完整分析下列原始材料，只交付正文，不联网、不查知识库、不生成文件。材料如下：\nOLD_HEAD_42\n'+'甲'.repeat(1500)+'\nOLD_MIDDLE_17\n'+'乙'.repeat(1500)+'\nOLD_TAIL_93';const result=await service.dispatch(scope,{operationId:'direct_material_initial_0001',text:source,budget:1,routeBudget:1},key);acceptedTaskId=result.taskId;assert.ok(acceptedTaskId,JSON.stringify(result));await service.resume(scope,key);const jobs=await settle(1);assert.equal(jobs[0].workRun!.state,'completed',jobs[0].workRun!.error);return acceptedTaskId!;};
 return {service,store,actual,start,settle,routerCalls:()=>routerCalls};
}

test('a long direct append keeps explicitly selected original context and current material in the same task',async()=>{
 const f=fixture('conversation'),taskId=await f.start(),beforeRoute=f.routerCalls();
 const next='请把本次新增的第二份材料与前面的原始材料一起比较，不替换前面的材料，只交付比较正文。材料如下：\nADD_HEAD_64\n'+'丙'.repeat(900)+'\nADD_MIDDLE_28\n'+'丁'.repeat(900)+'\nADD_TAIL_57';
 await f.service.direct(scope,taskId,{operationId:'direct_material_append_0001',text:next,budget:1},key);await f.service.resume(scope,key);
 const jobs=await f.settle(2),job=jobs[1].workRun!;assert.equal(job.state,'completed',job.error);assert.equal(jobs[1].conversationId,taskId);assert.equal(job.materialScope,'conversation');assert.ok(f.routerCalls()>beforeRoute,'new material is first scoped through the bound router');assert.equal(f.actual.length,2);
 const actual=JSON.stringify(f.actual[1]);for(const marker of ['OLD_HEAD_42','OLD_MIDDLE_17','OLD_TAIL_93','ADD_HEAD_64','ADD_MIDDLE_28','ADD_TAIL_57'])assert.ok(actual.includes(marker),marker);
 const db=await f.store.read();assert.equal(db.conversations.filter(conversation=>!conversation.coordinatorMain).length,1);
});

test('a short direct style followup retains current raw material without another routing round',async()=>{
 const f=fixture(),taskId=await f.start(),beforeRoute=f.routerCalls(),previous=(await f.settle(1))[0].workRun!;
 const follow='继续沿用当前原始材料，把分析写得口语一点，不更换材料。';
 await f.service.direct(scope,taskId,{operationId:'direct_material_brief_0001',text:follow,budget:1},key);await f.service.resume(scope,key);
 const jobs=await f.settle(2),job=jobs[1].workRun!;assert.equal(job.state,'completed',job.error);assert.equal(f.routerCalls(),beforeRoute,'the known brief remains on the direct fast path');assert.equal(job.materialScope,'current');assert.equal(job.materialSource?.inputMessageId,previous.materialSource?.inputMessageId);assert.equal(f.actual.length,2);
 const actual=JSON.stringify(f.actual[1]);assert.ok(actual.includes(follow));for(const marker of ['OLD_HEAD_42','OLD_MIDDLE_17','OLD_TAIL_93'])assert.ok(actual.includes(marker),marker);
});
