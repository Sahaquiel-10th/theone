import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowRun,type WorkflowStep} from './taskWorkflow.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {publicWorkflowProgress,availableWorkflowResults} from './workflowPresentation.js';
import {readAttempt,readFailureRecovery} from './operationRecovery.js';
import type {WorkRun} from './coordinatorTypes.js';
import {taskWorkflowView} from '../src/taskWorkflowView.js';

const owner={workspaceId:'owned_workspace',userId:'owned_user',operationId:'owned_operation'};
function fixture(kind:'model'|'notion'|'tool'='model'){
 const step:WorkflowStep={id:'private_step',title:kind==='notion'?'保存并核对文章':kind==='tool'?'检索资料':'文章成稿',kind,instruction:'PRIVATE_INSTRUCTION',inputs:[],...(kind==='tool'?{tool:'knowledge_search' as const}:{})};
 const run=createWorkflowRun({version:1,steps:[step]},owner),namespace=`workflow:${run.id}`,tool=`workflow:${run.id}:${step.id}`;
 const key=taskStepKey(namespace,tool,JSON.stringify({revision:run.revision,instruction:step.instruction,inputs:step.inputs}));
 const cp:TaskStep={key,namespace,tool,label:step.title,scopeId:owner.operationId,effect:kind==='model'?'model':kind==='notion'?'external_write':'read',state:'completed',updatedAt:'2026-11-03T00:00:00Z',operation:{version:1,execution:'succeeded',verification:kind==='notion'?'verified':'not_required',artifactRef:key},output:{workflow:{version:1,runId:run.id,revision:run.revision,stepId:step.id},outcome:'completed',result:{content:'PRIVATE_MANUSCRIPT',providerJobId:'PRIVATE_PROVIDER_ID',url:'https://private.invalid/secret'}}};
 run.steps[0]={id:step.id,state:'completed',checkpointKey:key,summary:'文章已经写好。'};run.phase='completed';
 const job={workflow:run,steps:[cp]} as WorkRun;
 return {run,cp,job};
}

test('one completed result has the same task detail and rail facts without serializing private evidence',()=>{
 const f=fixture(),view=publicWorkflowProgress(f.job,owner)!;
 assert.equal(view.phase,'completed');assert.equal(view.steps[0].execution,'succeeded');assert.equal(view.steps[0].verification,'not_required');assert.equal(view.steps[0].resultAvailable,true);
 const detail=taskWorkflowView(view)!,rail=taskWorkflowView(structuredClone(view))!;
 assert.deepEqual(rail,detail);assert.equal(detail.completed,1);assert.equal(detail.steps[0].summary,'文章已经写好。');
 const encoded=JSON.stringify(view);
 for(const privateValue of ['PRIVATE_INSTRUCTION','PRIVATE_MANUSCRIPT','PRIVATE_PROVIDER_ID','private.invalid',f.cp.key,f.run.id,owner.operationId,'private_step'])assert.equal(encoded.includes(privateValue),false,privateValue);
});

test('foreign workspace, user, operation or invalid revision cannot project another task',()=>{
 const f=fixture();
 for(const binding of [{...owner,workspaceId:'foreign'},{...owner,userId:'foreign'},{...owner,operationId:'foreign'}])assert.equal(publicWorkflowProgress(f.job,binding),undefined);
 const changed=structuredClone(f.job);changed.workflow!.revision++;assert.equal(publicWorkflowProgress(changed,owner),undefined);
});

test('wrong or duplicate checkpoint evidence never advertises a reusable result',()=>{
 const mutations=[
  (f:ReturnType<typeof fixture>)=>{f.cp.operation!.artifactRef='a'.repeat(64);},
  f=>{f.cp.scopeId='foreign_operation';},
  f=>{f.cp.effect='read';},
  f=>{(f.cp.output as any).workflow.extra='unreviewed';},
  f=>{(f.cp.output as any).workflow.revision=2;},
  f=>{f.job.steps!.push(structuredClone(f.cp));},
  f=>{f.job.steps!.push({...structuredClone(f.cp),scopeId:'foreign_operation'});},
 ] satisfies ((f:ReturnType<typeof fixture>)=>void)[];
 for(const mutate of mutations){const f=fixture();mutate(f);const step=publicWorkflowProgress(f.job,owner)!.steps[0];assert.equal(step.resultAvailable,undefined);assert.equal(step.execution,undefined);}
});

test('Notion completion needs verified evidence rather than a merely successful operation',()=>{
 const f=fixture('notion');assert.equal(publicWorkflowProgress(f.job,owner)!.steps[0].resultAvailable,true);
 f.cp.operation!.verification='not_required';assert.equal(publicWorkflowProgress(f.job,owner)!.steps[0].resultAvailable,undefined);
});

test('durable read recovery appears as background work and never as a completed manuscript',()=>{
 const f=fixture('tool'),now=Date.parse('2026-11-03T00:00:00Z');
 f.run.steps[0]={id:f.run.spec.steps[0].id,state:'waiting',waitingFor:'result',summary:'正在后台重试读取资料。'};f.run.phase='waiting';
 f.cp.state='started';f.cp.output={workflow:{version:1,runId:f.run.id,revision:f.run.revision,stepId:f.run.spec.steps[0].id},outcome:'waiting'};
 f.cp.operation={version:1,execution:'failed',verification:'not_required',recovery:readFailureRecovery(readAttempt(1,now),'timeout',now)};
 const view=publicWorkflowProgress(f.job,owner)!;
 assert.equal(view.phase,'waiting');assert.equal(view.steps[0].waitingFor,'result');assert.equal(view.steps[0].resultAvailable,undefined);
 assert.deepEqual(view.steps[0].recovery,{state:'scheduled',attempt:1,nextRetryAt:'2026-11-03T00:00:02.000Z'});
 assert.equal(view.steps[0].execution,'failed');assert.equal(view.steps[0].verification,'not_required');
 f.cp.operation.recovery!.state='exhausted';f.cp.operation.recovery!.attempt=3;f.cp.state='failed';f.run.steps[0]={id:f.run.spec.steps[0].id,state:'failed',summary:'已经自动试了几次，资料仍未读到。'};f.run.phase='failed';
 assert.equal(publicWorkflowProgress(f.job,owner)!.steps[0].recovery?.state,'exhausted');
});

test('completed manuscripts are readable from their exact saved result while progress contains no private body',()=>{
 const f=fixture();(f.cp.output as any).result.outcome='completed';
 assert.deepEqual(availableWorkflowResults(f.job,owner),[{stepId:'0',title:'文章成稿',content:'PRIVATE_MANUSCRIPT'}]);
 assert.equal(availableWorkflowResults(f.job,{...owner,userId:'foreign'}),undefined);
 assert.equal(JSON.stringify(publicWorkflowProgress(f.job,owner)).includes('PRIVATE_MANUSCRIPT'),false);
 for(const outcome of ['failed','partial','waiting']){const changed=structuredClone(f.job);(changed.steps![0].output as any).outcome=outcome;assert.equal(availableWorkflowResults(changed,owner),undefined);}
 const changed=structuredClone(f.job);changed.steps![0].operation!.artifactRef='a'.repeat(64);assert.equal(availableWorkflowResults(changed,owner),undefined);
});
