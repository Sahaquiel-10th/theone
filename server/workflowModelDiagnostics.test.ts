import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowRun} from './taskWorkflow.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {workflowModelDiagnostic} from './workflowModelDiagnostics.js';

const binding={workspaceId:'workspace-a',userId:'user-a',operationId:'operation-a'};
function fixture(){
 const step={id:'draft',title:'撰写正文',kind:'model' as const,instruction:'依据已有材料撰写正文。',inputs:[]};
 const workflow=createWorkflowRun({version:1,steps:[step]},binding);
 workflow.steps[0].state='failed';workflow.phase='failed';
 const namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:${step.id}`;
 const checkpoint:TaskStep={key:taskStepKey(namespace,tool,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs})),namespace,tool,label:step.title,effect:'model',state:'failed',scopeId:binding.operationId,updatedAt:'2026-11-16T00:00:00Z',output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:step.id},outcome:'failed',result:{content:'处理前言 PRIVATE_BODY',summary:'PRIVATE_SUMMARY',finishReason:'tool_calls',toolCalls:[{arguments:'PRIVATE_ARGUMENTS'}]}}};
 return {workflow,steps:[checkpoint],state:'failed' as const};
}
test('legacy tool-call failures expose precise reviewed diagnostics without model text or arguments',()=>{
 const run=fixture(),value=workflowModelDiagnostic(run,binding)!;
 assert.equal(value.failure.code,'model_invalid_response');assert.equal(value.automaticRetryScheduled,false);
 assert.match(value.summary,/操作指令/);assert.match(value.next,/不用补材料/);
 assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|toolCalls|arguments/);
});
test('model diagnostics reject foreign workspace, user, operation, checkpoint and revision bindings',()=>{
 for(const field of ['workspaceId','userId','operationId'] as const)assert.equal(workflowModelDiagnostic(fixture(),{...binding,[field]:'foreign'}),undefined);
 for(const change of ['scope','namespace','tool','key','marker','duplicate'] as const){
  const run=fixture(),cp=run.steps[0];
  if(change==='scope')cp.scopeId='foreign';
  if(change==='namespace')cp.namespace='foreign';
  if(change==='tool')cp.tool='foreign';
  if(change==='key')cp.key='foreign';
  if(change==='marker')(cp.output as any).workflow.revision++;
  if(change==='duplicate')run.steps.push(structuredClone(cp));
  assert.equal(workflowModelDiagnostic(run,binding),undefined,change);
 }
});
test('completed workflows and model-supplied arbitrary diagnostics never create a failure',()=>{
 const run=fixture();run.workflow.steps[0].state='completed';assert.equal(workflowModelDiagnostic(run,binding),undefined);
 const other=fixture();(other.steps[0].output as any).result={content:'正常正文',summary:'PRIVATE_SUMMARY',finishReason:'stop',failure:{code:'PRIVATE_CODE',stage:'model',outcome:'failed'}};
 assert.equal(workflowModelDiagnostic(other,binding),undefined);
});
