import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Conversation} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import {createWorkflowRun} from './taskWorkflow.js';
import {taskStepKey} from './taskSteps.js';
import {connectionRecoveryPlan,selectConnectionRecovery,connectionResumeRequested} from './connectionRecovery.js';
const scope={workspaceId:'own',userId:'person'};
function fixture(followup=false){
 const task={...scope,id:'task',modelId:'worker',title:'合成任务',archived:false,workPaused:true,workPauseReason:'failed',messages:[],createdAt:'2026-11-03T01:00:00.000Z',updatedAt:'2026-11-03T01:00:00.000Z'} as Conversation;
 const workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'正文',kind:'model',instruction:'写合成正文',inputs:[]},{id:'save',title:'保存',kind:'notion',instruction:'保存原正文',inputs:['draft']},...(followup?[{id:'read',title:'读取成果',kind:'tool' as const,tool:'read_notion_document' as const,instruction:'读取同一页成果',inputs:['save']}]:[])]},{...scope,operationId:'original'});
 const step=workflow.spec.steps[0],namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:draft`,key=taskStepKey(namespace,tool,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));
 workflow.steps[0]={id:'draft',state:'running'};workflow.phase='running';
 const checkpoint={key,namespace,tool,scopeId:'original',label:'正文',effect:'model',state:'completed',updatedAt:'2026-11-03T01:00:01.000Z',operation:{version:1,execution:'succeeded',verification:'not_required',artifactRef:key},output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:'draft'},outcome:'completed',result:{outcome:'completed',content:'完整合成正文',summary:'已完成'}}};
 const operation={...scope,id:'original',operationId:'original_submission_001',status:'failed',conversationId:task.id,updatedAt:task.updatedAt,workRun:{state:'failed',failureCode:'task_key_required',workflow,steps:[checkpoint],sources:[],credentials:[],skills:[],budget:.5}} as unknown as ChatOperation;
 const db={conversations:[task],chatOperations:[operation],executionTasks:[]} as unknown as Database;
 return {db,task,operation,checkpoint,plan:()=>connectionRecoveryPlan(db,scope,task,operation)};
}
test('connection recovery preserves completed model evidence in the same run and resets only an unstarted slot',()=>{
 const f=fixture(),original=structuredClone(f.operation);const plan=f.plan();assert.ok('workflow' in plan);
 assert.equal(plan.workflow.id,f.operation.workRun!.workflow!.id);assert.equal(plan.workflow.revision,1);assert.deepEqual(plan.workflow.binding,{...scope,operationId:'original'});
 assert.deepEqual(f.operation,original,'the plan cannot authorize or mutate the task');
 f.operation.workRun!.steps=[];const missing=f.plan();assert.ok('workflow' in missing);assert.equal(missing.workflow.steps[0].state,'queued');assert.equal(missing.workflow.sequence,f.operation.workRun!.workflow!.sequence+1);
});
test('connection recovery cannot reuse forged checkpoint bindings, unknown paid effects, local holds or user stops',()=>{
 for(const kind of ['foreign','stop','cancel','local','unknown-model','unknown-write','unknown-artifact','uncertain-notion','budget','missing-steps','duplicate','wrong-marker','wrong-scope']){
  const f=fixture(),job=f.operation.workRun!;
  if(kind==='foreign')f.task.workspaceId='foreign';if(kind==='stop')f.task.workPauseReason='user_stopped';if(kind==='cancel')f.operation.executionCancelled=true;
  if(kind==='local')f.db.executionTasks.push({...scope,id:'held',conversationId:f.task.id,status:'failed',executionSafetyHold:'command_unconfirmed'} as any);
  if(kind.startsWith('unknown-'))job.steps!.push({...f.checkpoint,key:'unknown',state:'started',effect:kind.slice(8).replace('write','external_write')} as any);
  if(kind==='uncertain-notion')job.notionReceipt={state:'uncertain',delivery:'unknown'} as any;
  if(kind==='budget')job.failureCode='task_budget_required';if(kind==='missing-steps')delete job.steps;
  if(kind==='duplicate')job.steps!.push(structuredClone(job.steps![0]));if(kind==='wrong-marker')(job.steps![0].output as any).workflow.stepId='other';if(kind==='wrong-scope')job.steps![0].scopeId='other';
  assert.ok('blocked' in f.plan(),kind);
 }
});
test('an explicit continuation selects one current same-owner task, never a foreign or ambiguous goal',()=>{
 const f=fixture();assert.equal(selectConnectionRecovery(f.db,scope,'现在怎么了？').kind,'none');assert.equal(selectConnectionRecovery(f.db,scope,'继续').kind,'candidate');
 f.db.conversations.push({...f.task,id:'second'});f.db.chatOperations!.push({...f.operation,id:'second-op',conversationId:'second'});
 assert.equal(selectConnectionRecovery(f.db,scope,'继续').kind,'ambiguous');assert.equal(selectConnectionRecovery(f.db,scope,'继续','task').kind,'candidate');
 assert.equal(selectConnectionRecovery(f.db,{...scope,userId:'other'},'继续','task').kind,'none');
 for(const value of ['继续','继续吧','Key恢复了，继续','授权好了，继续'])assert.equal(connectionResumeRequested(value),true,value);
 for(const value of ['继续了吗？','不要继续','我想了解怎么继续','只讨论继续的方法'])assert.equal(connectionResumeRequested(value),false,value);
});

function deliveredConnectionFixture(){
 const f=fixture(true),job=f.operation.workRun!,workflow=job.workflow!,step=workflow.spec.steps[1],namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:save`;
 const key=taskStepKey(namespace,tool,JSON.stringify({revision:1,instruction:step.instruction,inputs:step.inputs})),workerKey='a'.repeat(64),expectedDigest='b'.repeat(64),expectedRawDigest='c'.repeat(64),pageId='d'.repeat(32);
 const outer={key,namespace,tool,scopeId:f.operation.id,label:'保存',effect:'external_write' as const,state:'started' as const,updatedAt:'2026-11-03T01:00:02Z',output:{workflow:{version:1,runId:workflow.id,revision:1,stepId:'save'},outcome:'waiting',expectedBodyDigest:expectedDigest,notionCheckpointKey:workerKey}};
 const worker={key:workerKey,namespace:'worker',tool:'save_notion_draft',scopeId:f.operation.id,label:'实际保存',effect:'external_write' as const,state:'started' as const,updatedAt:'2026-11-03T01:00:03Z'};
 workflow.steps[0]={id:'draft',state:'completed',checkpointKey:f.checkpoint.key};workflow.steps[1]={id:'save',state:'waiting',waitingFor:'result'};workflow.phase='waiting';job.steps!.push(outer,worker);
 job.notionReceipt={state:'delivered',delivery:'unknown',checkpointKey:workerKey,expectedDigest,expectedRawDigest,pageId,final:true,writeAcknowledgement:{version:1,operationId:f.operation.id,checkpointKey:workerKey,expectedDigest,expectedRawDigest,pageId,acknowledgedAt:'2026-11-03T01:00:04Z'},verification:{state:'scheduled',version:17,attempt:1,nextCheckAt:'2026-11-03T01:00:06Z',deadlineAt:'2026-11-03T01:05:04Z'}};
 return {...f,outer,worker};
}

test('explicit Key recovery carries the exact delivered checkpoints forward while body checking stays in the background',()=>{
 const f=deliveredConnectionFixture(),before=structuredClone(f.operation),selected=selectConnectionRecovery(f.db,scope,'Key恢复了，继续',f.task.id);
 assert.equal(selected.kind,'candidate');const result=f.plan();assert.ok('workflow' in result);
 assert.equal(result.workflow.id,f.operation.workRun!.workflow!.id);assert.equal(result.workflow.steps[0].state,'completed');assert.equal(result.workflow.steps[1].state,'completed');assert.equal(result.workflow.steps[2].state,'queued');
 const worker=result.steps.find(cp=>cp.key===f.worker.key)!;assert.equal(worker.state,'completed');assert.equal((worker.output as any).state,'delivered');
 assert.deepEqual(f.operation,before,'planning is pure metadata and cannot call or mutate the old operation');
});

test('connection recovery keeps source, ACK, worker and protected-state boundaries around a delivered save',()=>{
 for(const kind of ['wrong_ack','wrong_body','wrong_artifact','wrong_worker','missing_worker','duplicate','prior_write','nonfinal','unknown_model','unknown_write','stopped','cancelled','budget','local_hold','foreign_task','other_failed'] as const){
  const f=deliveredConnectionFixture(),job=f.operation.workRun!;
  if(kind==='wrong_ack')job.notionReceipt!.writeAcknowledgement!.operationId='foreign';if(kind==='wrong_body')f.outer.output.expectedBodyDigest='f'.repeat(64);if(kind==='wrong_worker')f.worker.scopeId='foreign';
  if(kind==='wrong_artifact')(f.outer.output as any).sourceArtifact={id:'existing_article',ref:'another_message',originOperationId:'another_operation',bodyDigest:'f'.repeat(64)};
  if(kind==='missing_worker')job.steps=job.steps!.filter(cp=>cp.key!==f.worker.key);if(kind==='duplicate')job.steps!.push(structuredClone(f.worker));
  if(kind==='prior_write')(f.outer.output as any).priorNotionCheckpointKey=f.worker.key;if(kind==='nonfinal')job.notionReceipt!.final=false;
  if(kind==='unknown_model'||kind==='unknown_write')job.steps!.push({key:'other',namespace:'nested',tool:'other',scopeId:f.operation.id,label:'其他未决效果',effect:kind==='unknown_model'?'model':'external_write',state:'started',updatedAt:f.worker.updatedAt});
  if(kind==='stopped')f.task.workPauseReason='user_stopped';if(kind==='cancelled')f.operation.executionCancelled=true;if(kind==='budget')job.failureCode='task_budget_required';
  if(kind==='local_hold')f.db.executionTasks.push({...scope,id:'held',conversationId:f.task.id,status:'failed',executionSafetyHold:'command_unconfirmed'} as any);if(kind==='foreign_task')f.task.userId='foreign';
  if(kind==='other_failed'){job.workflow!.steps[2]={id:'read',state:'failed'};job.workflow!.phase='failed';}
  assert.ok('blocked' in f.plan(),kind);
 }
});
