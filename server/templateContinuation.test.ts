import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Conversation} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import {createWorkflowRun,workflowPhase} from './taskWorkflow.js';
import {taskStepKey} from './taskSteps.js';
import {templateContinuationPlan,reuseTemplateCompletedStages,templateMaterialReply} from './templateContinuation.js';
const scope={workspaceId:'own',userId:'person'};
function fixture(){
 const task={...scope,id:'task',title:'填写模板',archived:false,workPaused:true,workPauseReason:'needs_input'} as Conversation;
 const workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'完整稿',kind:'model',instruction:'写完整稿',inputs:[]},{id:'fill',title:'填模板',kind:'feature',featureId:'fill-template',instruction:'依据完整稿填写原模板',inputs:['draft']}]},{...scope,operationId:'original'});
 const diagnostic={version:1,kind:'missing_input',code:'template_required',repair:'not_applicable',field:'template_file'};
 const steps=workflow.spec.steps.map(step=>{const namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:${step.id}`,key=taskStepKey(namespace,tool,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));return {key,namespace,tool,label:step.title,scopeId:'original',state:step.id==='draft'?'completed':'failed',effect:'model',updatedAt:'2026-11-03T01:00:00.000Z',operation:{version:1,execution:step.id==='draft'?'succeeded':'failed',verification:'not_required',...(step.id==='draft'?{artifactRef:key}:{})},output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:step.id},outcome:step.id==='draft'?'completed':'needs_input',...(step.id==='draft'?{result:{outcome:'completed',content:'逐字完整正文_42',summary:'成稿'}}:{toolFailure:diagnostic})}};});
 workflow.steps[0]={id:'draft',state:'completed',checkpointKey:steps[0].key};workflow.steps[1]={id:'fill',state:'needs_input',summary:'需要模板'};workflow.phase=workflowPhase(workflow.spec,workflow.steps);
 const operation={...scope,id:'original',operationId:'original_submission_001',conversationId:'task',updatedAt:'now',workRun:{workflow,steps,state:'failed',resultOutcome:'needs_input',toolRecovery:diagnostic,sources:[],skills:[],credentials:[]}} as unknown as ChatOperation;
 const db={conversations:[task],chatOperations:[operation],executionTasks:[],attachments:[{...scope,id:'template',originalName:'同名模板.xlsx',status:'ready'}]} as unknown as Database;
 return {db,task,operation,plan:(text='这是模板，按原要求继续',ids=['template'])=>templateContinuationPlan(db,scope,task,operation,ids,text)};
}
test('a template-only material revision copies strict completed body bytes and rebinds its exact input/checkpoint identity',()=>{
 const f=fixture(),plan=f.plan();assert.ok(plan);const before=structuredClone(f.operation.workRun!);
 const next=createWorkflowRun(plan.spec,{...scope,operationId:'material-revision'}),imported=reuseTemplateCompletedStages(before,next);
 assert.equal(imported.length,1);assert.equal(next.steps[0].state,'completed');assert.equal(next.steps[1].state,'queued');assert.equal(imported[0].scopeId,'material-revision');assert.notEqual(imported[0].key,before.steps![0].key);assert.deepEqual((imported[0].output as any).result,(before.steps![0].output as any).result);
 assert.deepEqual(f.operation.workRun,before,'old failure and bodies remain unchanged');
 f.operation.workRun!.steps![0].output={...(f.operation.workRun!.steps![0].output as any),result:{outcome:'completed',content:'changed',summary:'成稿'}};
 assert.notEqual(f.plan()!.evidenceDigest,plan.evidenceDigest,'CAS includes the actual body, not its title or completed flag');
});
test('foreign same-name templates, no parent proof, partial saves, changed goals and broken input refs never reuse the draft',()=>{
 for(const mode of ['foreign','other-user','not-ready','no-template','two-templates','unknown-parent','missing-proof','prior-save','other-feature','wrong-checkpoint','wrong-marker','bad-model-content','truncated-model','input-ref','wrong-scope','user-stop','newer-request'] as const){
  const f=fixture(),job=f.operation.workRun!,steps=job.steps!;
  if(mode==='foreign')f.db.attachments[0].workspaceId='foreign';if(mode==='other-user')f.db.attachments[0].userId='other';if(mode==='not-ready')f.db.attachments[0].status='parsing';
  if(mode==='no-template')f.db.attachments[0].originalName='同名模板.jpg';
  if(mode==='unknown-parent')steps[1].operation!.execution='unknown';if(mode==='missing-proof')delete steps[1].operation;
  if(mode==='prior-save')steps.push({...steps[0],key:'saved-artifact',effect:'artifact'});
  if(mode==='other-feature')job.workflow!.spec.steps[0]={...job.workflow!.spec.steps[0],kind:'feature',featureId:'other'};
  if(mode==='wrong-checkpoint')steps[0].scopeId='foreign';if(mode==='wrong-marker')(steps[0].output as any).workflow.revision=2;
  if(mode==='bad-model-content')(steps[0].output as any).result.content='';if(mode==='truncated-model')(steps[0].output as any).result.finishReason='length';
  if(mode==='input-ref')job.workflow!.spec.steps[1].inputs=['not-existing'];if(mode==='wrong-scope')job.workflow!.binding.workspaceId='foreign';
  if(mode==='user-stop')f.task.workPauseReason='user_stopped';if(mode==='newer-request')f.db.chatOperations!.push({...f.operation,id:'newer'});
  assert.equal(f.plan(undefined,mode==='two-templates'?['template','another']:undefined),undefined,mode);
 }
 const f=fixture();for(const text of ['改成英文方案，再填写模板','重新写一篇稿','这是模板，顺便更改金额','只讨论如何上传模板'])assert.equal(f.plan(text),undefined,text);
 for(const value of ['这是模板，按原要求继续','模板见附件，继续','继续'])assert.equal(templateMaterialReply(value),true,value);
});
