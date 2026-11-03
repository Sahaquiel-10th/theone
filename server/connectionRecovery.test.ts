import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Conversation} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import {createWorkflowRun} from './taskWorkflow.js';
import {taskStepKey} from './taskSteps.js';
import {connectionRecoveryPlan,selectConnectionRecovery,connectionResumeRequested} from './connectionRecovery.js';
const scope={workspaceId:'own',userId:'person'};
function fixture(){
 const task={...scope,id:'task',modelId:'worker',title:'合成任务',archived:false,workPaused:true,workPauseReason:'failed',messages:[],createdAt:'2026-11-03T01:00:00.000Z',updatedAt:'2026-11-03T01:00:00.000Z'} as Conversation;
 const workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'正文',kind:'model',instruction:'写合成正文',inputs:[]},{id:'save',title:'保存',kind:'notion',instruction:'保存原正文',inputs:['draft']}]},{...scope,operationId:'original'});
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
