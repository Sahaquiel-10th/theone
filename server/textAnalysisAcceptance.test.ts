import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {Store} from './db.js';
import type {Database,ModelConfig,Attachment} from './types.js';
import {CoordinatorService} from './coordinatorService.js';
import {updateTaskConfig,defaultTaskValues} from './aiTaskConfig.js';
import {ModelRequestError,type ToolChatResult,type ModelToolMessage} from './modelGateway.js';
import {OneKeyPresenceError} from './oneKeyPresence.js';
import {attachmentPreparationNamespace} from './attachmentPreparation.js';

// Real service/queue/billing/material sidecars; every model and knowledge
// boundary is injected. Nothing in this file reaches a provider or production.
const owner={workspaceId:'wa',userId:'a'},foreign={workspaceId:'wb',userId:'b'};
const response=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}});
const marker=(doc:number,part:number)=>`DOC${doc}_${part===0?'HEAD_':part===3?'MIDDLE_':part===6?'TAIL_':''}SEG_${part}`;
const expectedMarkers=[1,2].flatMap(doc=>Array.from({length:7},(_,part)=>marker(doc,part)));
const brief='完整分析本轮两份材料的结构、论证和相互关系，交付分析正文；不联网、不查知识库、不制作文件。';
async function fixture(options:{summaryFault?:503|408;finalFailure?:boolean;stop?:'key'|'source'}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'one-text-acceptance-'));
 const models=['router','worker','summary'].map(id=>({id,name:id,enabled:true,kind:'chat',apiKey:'synthetic-only',baseUrl:'https://invalid.example',model:id,protocol:'openai',systemPrompt:'',isDefault:id==='worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig));
 const files:Attachment[]=[];
 for(const doc of [1,2]){
  const chunks=Array.from({length:7},(_,part)=>{const start=marker(doc,part)+'\n';return start+(doc===1?'甲':'乙').repeat(4000-start.length);});
  const storagePath=path.join(directory,`document-${doc}.txt`),body=chunks.join('');
  await writeFile(storagePath,body,{mode:0o600});await writeFile(storagePath+'.segments',chunks.map((text,index)=>JSON.stringify({index,text})).join('\n')+'\n',{mode:0o600});
  files.push({...owner,id:`text-${doc}`,originalName:`synthetic-${doc}.txt`,storagePath,size:Buffer.byteLength(body),kind:'text',mimeType:'text/plain',extractedText:'',segmentCount:chunks.length,textChars:body.length,status:'ready',createdAt:new Date().toISOString()});
 }
 assert.equal(files.reduce((n,file)=>n+file.textChars!,0),56000);
 let db={users:[{id:'a',enabled:true,role:'admin',defaultWorkspaceId:'wa',createdAt:'now'},{id:'b',enabled:true,role:'user',defaultWorkspaceId:'wb',createdAt:'now'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[owner,foreign],models,settings:{safetyRules:'synthetic safety',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[owner,foreign].map(s=>({...s,id:s.userId,balanceMicros:100e6,reservedMicros:0})),powerLedger:[],attachments:files} as unknown as Database;
 // Workspace members use the repository's workspaceId/userId record shape.
 for(const [task,modelId] of [['coordinator','router'],['task_worker','worker'],['attachment_summary','summary']] as const){
  updateTaskConfig(db.settings,models,task,{revision:0,action:'draft',values:{...defaultTaskValues(task),modelId,enabled:true}},'a','now');
  updateTaskConfig(db.settings,models,task,{revision:1,action:'publish'},'a','now');
 }
 let chain=Promise.resolve();const store={read:async()=>structuredClone(db),mutate:<T>(fn:(value:Database)=>T)=>{const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.then(()=>{},()=>{});return next;}} as Store;
 const batches=new Map<string,{calls:number;messages:ModelToolMessage[];markers:string[]}>(),finalInputs:ModelToolMessage[][]=[];
 let finalFailure=options.finalFailure===true,summaryCount=0,modelCount=0,sourceRevoked=false;
 const key=async()=>{
  if(!options.stop)return;
  const snapshot=await store.read(),completed=snapshot.chatOperations?.some(op=>op.workRun?.steps?.some(step=>step.namespace===attachmentPreparationNamespace&&step.state==='completed'));
  if(!completed)return;
  if(options.stop==='key')throw new OneKeyPresenceError('synthetic key revoked');
  if(!sourceRevoked){sourceRevoked=true;await store.mutate(d=>{d.attachments.find(file=>file.id==='text-2')!.status='failed';});}
 };
 const service=new CoordinatorService(store,{recallWithDiagnostics:async()=>assert.fail('knowledge was never authorized')},{contextMode:'adaptive',reportCall:async()=>response('这轮还没完成，资料与已有部分都保留着。'),modelCall:async(model,messages,tools)=>{
  modelCount++;
  if(model.id==='router'){
   if(messages.at(-1)?.role==='tool')return response('任务已经接到。');
   assert.ok(tools.some(tool=>tool.function.name==='delegate_task'));
   return {...response(''),toolCalls:[{id:'synthetic-plan',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'双材料完整分析',instruction:brief,executorId:'general',featureIds:[],materialScope:'current'})}}]};
  }
  assert.deepEqual(tools,[],'summary and final analysis must never receive tools');
  if(model.id==='summary'){
   summaryCount++;const digest=createHash('sha256').update(JSON.stringify(messages)).digest('hex');
   let batch=batches.get(digest);if(!batch){const text=messages.map(message=>message.content).join('\n');batch={calls:0,messages:structuredClone(messages),markers:[...new Set(text.match(/DOC[12]_(?:(?:HEAD|MIDDLE|TAIL)_)?SEG_\d/g)??[])]};batches.set(digest,batch);}
   batch.calls++;
   if(options.summaryFault&&[...batches.keys()].indexOf(digest)===1&&batch.calls===1)throw new ModelRequestError(options.summaryFault,'synthetic transient summary failure');
   return response('本批完整阅读笔记：'+batch.markers.join('、'));
  }
  assert.equal(model.id,'worker');finalInputs.push(structuredClone(messages));
  if(finalFailure)throw new ModelRequestError(503,'synthetic final analysis unavailable');
  const context=JSON.stringify(messages);for(const value of expectedMarkers)assert.ok(context.includes(value),`final material context lost ${value}`);
  return response(JSON.stringify({outcome:'completed',content:'已依据两份完整材料形成结构与论证分析。',summary:'双材料分析完成。'}));
 }});
 const jobs=async(taskId:string)=>(await store.read()).chatOperations!.filter(op=>op.conversationId===taskId&&op.workRun);
 const settle=async(taskId:string,count=1)=>{
  for(let i=0;i<500;i++){const runs=await jobs(taskId);if(runs.length===count&&['completed','failed','cancelled'].includes(runs.at(-1)!.workRun!.state))return runs;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('synthetic analysis did not settle');
 };
 const start=async()=>{
  const result=await service.dispatch(owner,{operationId:'text_acceptance_original_001',text:'完整分析本次上传的两份合成材料，只给分析正文，不联网、不查知识库、不生成文件。',attachmentIds:files.map(file=>file.id),budget:1,routeBudget:1},key);
  assert.ok(result.taskId,JSON.stringify(result));await service.resume(owner,key);return result.taskId!;
 };
 return {service,store,key,start,jobs,settle,batches,finalInputs,setFinalFailure:(value:boolean)=>{finalFailure=value;},summaryCount:()=>summaryCount,modelCount:()=>modelCount,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

for(const status of [503,408] as const)test(`real text-analysis service covers both 56k sidecars with one bounded second-batch ${status} retry and one final model`,{timeout:15000},async()=>{
 const f=await fixture({summaryFault:status});
 try{
  const taskId=await f.start(),runs=await f.settle(taskId),job=runs[0].workRun!;assert.equal(job.state,'completed',job.error);
  const batchCalls=[...f.batches.values()];assert.ok(batchCalls.length>=3);assert.equal(batchCalls[0].calls,1,'first batch must not be repurchased');assert.equal(batchCalls[1].calls,2,'only the injected failing batch retries');assert.ok(batchCalls.slice(2).every(batch=>batch.calls===1));
  const observed=new Set(batchCalls.flatMap(batch=>batch.markers));for(const value of expectedMarkers)assert.ok(observed.has(value),value);
  assert.equal(f.finalInputs.length,1);assert.equal(job.workflow!.spec.steps.length,1);assert.equal(job.workflow!.spec.steps[0].kind,'model');assert.equal(job.workflow!.phase,'completed');
  const references=f.finalInputs[0].flatMap(message=>{if(typeof message.content!=='string')return [];try{const at=message.content.indexOf('\n'),payload=JSON.parse(at>=0?message.content.slice(at+1):message.content);return Array.isArray(payload.inputs)?payload.inputs:[];}catch{return [];}});
  const attachmentReference=references.find((entry:any)=>entry.id==='current_attachments');assert.ok(attachmentReference,'the actual final model input has the material reference');
  const coverage=JSON.parse(attachmentReference.content).coverage;assert.equal(coverage.representation,'all_segments_summary');assert.equal(coverage.complete,true);assert.equal(coverage.totalSegments,14);assert.equal(coverage.coveredSegments,14);assert.equal(coverage.totalTextChars,56000);
  const privateBatches=job.steps!.filter(step=>step.namespace===attachmentPreparationNamespace);assert.equal(privateBatches.length,batchCalls.length);assert.ok(privateBatches.every(step=>step.state==='completed'&&step.scopeId===runs[0].id));
  const attempts=Object.values(job.textModelAttempts??{});assert.ok(attempts.some(attempt=>attempt.uncertainMicros>0),'the failed upstream attempt still consumes internal budget headroom');assert.ok(attempts.every(attempt=>attempt.attempt<=2));
  const before=f.modelCount();await assert.rejects(()=>f.service.task(foreign,taskId));await assert.rejects(()=>f.service.dispatch(foreign,{operationId:'text_foreign_attempt_001',text:'读取这两份文件',attachmentIds:['text-1','text-2']},async()=>{}));assert.equal(f.modelCount(),before,'foreign access starts zero model calls');
 }finally{await f.cleanup();}
});

test('explicit authorized pure-analysis retry reuses completed source batches after final model exhaustion', {timeout:15000},async()=>{
 const f=await fixture({finalFailure:true});
 try{
  const taskId=await f.start(),first=(await f.settle(taskId))[0];assert.equal(first.workRun!.state,'failed');assert.equal(f.finalInputs.length,2,'initial final-model recovery is bounded to two calls');
  const paidSummaries=f.summaryCount();assert.ok(paidSummaries>=3);assert.ok(first.workRun!.steps!.filter(step=>step.namespace===attachmentPreparationNamespace).every(step=>step.state==='completed'));
  assert.equal(first.workRun!.notionReceipt,undefined);assert.equal(first.workRun!.localExecution,undefined);assert.deepEqual(first.workRun!.skills,[]);
  f.setFinalFailure(false);
  await f.service.retryLatest(owner,taskId,first.id,undefined,f.key,1);await f.service.resume(owner,f.key);
  const runs=await f.settle(taskId,2),last=runs.at(-1)!;assert.equal(last.workRun!.state,'completed',last.workRun!.error);
  assert.equal(f.summaryCount(),paidSummaries,'completed material preparation is reused across this explicit same-task revision');assert.equal(f.finalInputs.length,3,'only one newly authorized final model call is made');
  const oldBatches=first.workRun!.steps!.filter(step=>step.namespace===attachmentPreparationNamespace),newBatches=last.workRun!.steps!.filter(step=>step.namespace===attachmentPreparationNamespace);assert.equal(newBatches.length,oldBatches.length);assert.ok(newBatches.every(step=>step.scopeId===last.id));assert.deepEqual(runs[0].workRun,first.workRun,'the exhausted original attempt remains unchanged');
 }finally{await f.cleanup();}
});

for(const stop of ['key','source'] as const)test(`a ${stop} revocation after the first saved material batch stops all later analysis`,{timeout:10000},async()=>{
 const f=await fixture({stop});
 try{
  const taskId=await f.start(),runs=await f.settle(taskId);assert.equal(runs[0].workRun!.state,'failed');assert.equal(f.summaryCount(),1);assert.equal(f.finalInputs.length,0);assert.equal(runs[0].workRun!.steps!.filter(step=>step.namespace===attachmentPreparationNamespace&&step.state==='completed').length,1);
  const before=f.modelCount();await assert.rejects(()=>f.service.task(foreign,taskId));assert.equal(f.modelCount(),before);
 }finally{await f.cleanup();}
});
