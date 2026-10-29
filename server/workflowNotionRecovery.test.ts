import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowRun,workflowProgress,type WorkflowStep} from './taskWorkflow.js';
import {recoverVerifiedNotionWorkflow} from './workflowExecution.js';
import {notionHash,legacyNotionNormalized} from './notionCanonical.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import type {WorkRun} from './coordinatorTypes.js';

const owner={workspaceId:'wa',userId:'a',operationId:'original-save-operation'},body='# 合成验收\n\n青色42\n唯一自然结尾。',pageId='c'.repeat(32);
function fixture(options:{missingDigest?:boolean;missingLink?:boolean;multi?:boolean}={}){
 const save:WorkflowStep={id:options.multi?'save':'save_existing',title:'保存原文',kind:'notion',instruction:'保存指定原文，不重写。',inputs:options.multi?['draft']:[]};
 const spec={version:1 as const,steps:options.multi?[{id:'draft',title:'写作',kind:'model' as const,instruction:'写成完整原文。',inputs:[]},save,{id:'followup',title:'后续分析',kind:'model' as const,instruction:'分析前一步结果。',inputs:['save']}]:[save]};
 const workflow=createWorkflowRun(spec,owner),namespace=`workflow:${workflow.id}`,key=(step:WorkflowStep)=>taskStepKey(namespace,`workflow:${workflow.id}:${step.id}`,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));
 const source={conversationId:'source-main',operationId:'source-operation',messageId:'source-message',messageDigest:notionHash(body),digest:notionHash(body)};
 const sourceArtifact={id:'existing_article',ref:source.messageId,originOperationId:source.operationId,bodyDigest:source.digest};
 const digest=notionHash(legacyNotionNormalized(body)),receipt={state:'verified' as const,pageId,url:`https://www.notion.so/${pageId}`,expectedDigest:digest,expectedRawDigest:notionHash(body),digest,checkpointKey:'worker-save-key',final:true};
 const worker:TaskStep={key:receipt.checkpointKey,namespace:'worker',scopeId:owner.operationId,tool:'save_notion_draft',label:'保存',effect:'external_write',state:'completed',updatedAt:'2026-10-29T00:00:00Z',output:{state:'verified',pageId,digest,expectedDigest:digest,final:true}};
 const steps:TaskStep[]=[worker,...workflow.spec.steps.flatMap(step=>step.id==='followup'?[]:[{key:key(step),namespace,scopeId:owner.operationId,tool:`workflow:${workflow.id}:${step.id}`,label:step.title,effect:step.kind==='model'?'model' as const:'external_write' as const,state:step.kind==='model'?'completed' as const:'failed' as const,updatedAt:'2026-10-29T00:00:00Z',output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:step.id},outcome:step.kind==='model'?'completed':'failed',...(step.kind==='model'?{result:{outcome:'completed',content:body,summary:'完整正文。'}}:{notionCheckpointKey:receipt.checkpointKey,...(!options.missingDigest?{expectedBodyDigest:digest}:{})}),...(!options.multi?{sourceArtifact}:{})}}])];
 workflow.steps=workflow.spec.steps.map(step=>step.id==='followup'?{id:step.id,state:'waiting' as const,waitingFor:'inputs' as const}:step.kind==='model'?{id:step.id,state:'completed' as const,checkpointKey:key(step)}:{id:step.id,state:'failed' as const,summary:'保存待核对。'});workflow.phase='failed';workflow.sequence=4;
 if(options.missingLink)delete (steps.find(cp=>cp.key===key(save))!.output as any).notionCheckpointKey;
 const job:Pick<WorkRun,'workflow'|'steps'|'notionReceipt'|'notionArticleSource'>={workflow,steps,notionReceipt:receipt,...(!options.multi?{notionArticleSource:source}:{})};
 return {job,key,save,worker,source};
}

for(const missingDigest of [false,true])for(const missingLink of [false,true])test(`manual exact save proof repairs only its persisted workflow checkpoint; old normalized digest absent=${missingDigest}, old link absent=${missingLink}`,()=>{
 const f=fixture({missingDigest,missingLink}),before=structuredClone(f.job),result=recoverVerifiedNotionWorkflow(f.job,owner)!;
 assert.ok(result);assert.equal(result.complete,true);assert.equal(result.changed,true);assert.equal(result.workflow.phase,'completed');assert.equal(result.workflow.sequence,5);assert.equal(result.workflow.steps[0].state,'completed');assert.equal(workflowProgress(result.workflow).status,'completed');
 const cp=result.steps.find(step=>step.key===f.key(f.save))!;assert.equal(cp.state,'completed');assert.equal((cp.output as any).outcome,'completed');assert.equal((cp.output as any).expectedBodyDigest,f.job.notionReceipt!.expectedDigest);assert.equal((cp.output as any).notionCheckpointKey,f.job.notionReceipt!.checkpointKey);assert.deepEqual((cp.output as any).sourceArtifact,(f.job.steps!.find(step=>step.key===cp.key)!.output as any).sourceArtifact);assert.deepEqual(f.job,before,'pure recovery never mutates original evidence');
 const again=recoverVerifiedNotionWorkflow({...f.job,workflow:result.workflow,steps:result.steps},owner)!;assert.equal(again.changed,false);assert.equal(again.workflow.sequence,5);assert.equal(again.complete,true);
});

for(const mutation of ['owner','workflow-marker','workflow-key','worker-scope','worker-page','worker-digest','worker-final','receipt-final','receipt-pending','link','body-digest','raw-digest','source-ref','source-origin','source-hash','source-extra','missing-raw'] as const)test(`manual recovery refuses conflicting or incomplete ${mutation} evidence`,()=>{
 const f=fixture({missingDigest:true}),cp=f.job.steps!.find(step=>step.key===f.key(f.save))!,value=cp.output as any;
 if(mutation==='owner')f.job.workflow!.binding.workspaceId='foreign';
 if(mutation==='workflow-marker')value.workflow.revision++;
 if(mutation==='workflow-key')cp.key='different-key';
 if(mutation==='worker-scope')f.worker.scopeId='other-operation';
 if(mutation==='worker-page')(f.worker.output as any).pageId='d'.repeat(32);
 if(mutation==='worker-digest')(f.worker.output as any).digest='d'.repeat(64);
 if(mutation==='worker-final')(f.worker.output as any).final=false;
 if(mutation==='receipt-final')f.job.notionReceipt!.final=false;
 if(mutation==='receipt-pending')f.job.notionReceipt!.verification={state:'scheduled',version:1,attempt:0,nextCheckAt:'now',deadlineAt:'later'};
 if(mutation==='link')value.notionCheckpointKey='other-worker-key';
 if(mutation==='body-digest')value.expectedBodyDigest='d'.repeat(64);
 if(mutation==='raw-digest')f.job.notionReceipt!.expectedRawDigest='d'.repeat(64);
 if(mutation==='source-ref')value.sourceArtifact.ref='another-message';
 if(mutation==='source-origin')value.sourceArtifact.originOperationId='another-operation';
 if(mutation==='source-hash')value.sourceArtifact.bodyDigest='d'.repeat(64);
 if(mutation==='source-extra')value.sourceArtifact.extra='untrusted';
 if(mutation==='missing-raw')f.job.notionReceipt!.expectedRawDigest=undefined;
 assert.equal(recoverVerifiedNotionWorkflow(f.job,owner),undefined);
});

test('a proved multi-stage save is repaired without completing or executing its queued successor',()=>{
 const f=fixture({multi:true}),before=structuredClone(f.job),result=recoverVerifiedNotionWorkflow(f.job,owner)!;
 assert.ok(result);assert.equal(result.complete,false);assert.equal(result.workflow.steps[1].state,'completed');assert.deepEqual(result.workflow.steps[0],before.workflow!.steps[0]);assert.deepEqual(result.workflow.steps[2],before.workflow!.steps[2]);assert.equal(result.workflow.phase,'waiting');assert.deepEqual(f.job,before);
});

test('a multi-stage save cannot borrow canonical raw-source fallback when its expected digest is missing',()=>{
 assert.equal(recoverVerifiedNotionWorkflow(fixture({multi:true,missingDigest:true}).job,owner),undefined);
});

test('an existing-message recovery also requires the exact raw source hash when the normalized digest was retained',()=>{
 const f=fixture();f.job.notionReceipt!.expectedRawDigest='d'.repeat(64);assert.equal(recoverVerifiedNotionWorkflow(f.job,owner),undefined);
});

test('a missing save link cannot be inferred when two same-operation verified worker saves exist',()=>{
 const f=fixture({missingDigest:true,missingLink:true});f.job.steps!.push({...structuredClone(f.worker),key:'another-verified-save'});assert.equal(recoverVerifiedNotionWorkflow(f.job,owner),undefined);
});

test('a multi-stage save with a missing link cannot use the canonical source fallback',()=>{
 assert.equal(recoverVerifiedNotionWorkflow(fixture({multi:true,missingLink:true}).job,owner),undefined);
});

test('explicit null and conflicting old fields are not silently overwritten as missing evidence',()=>{
 for(const field of ['notionCheckpointKey','expectedBodyDigest']){const f=fixture({missingDigest:true,missingLink:true}),cp=f.job.steps!.find(step=>step.key===f.key(f.save))!;(cp.output as any)[field]=null;assert.equal(recoverVerifiedNotionWorkflow(f.job,owner),undefined);}
});

test('a declared prerequisite with no usable completed result cannot be retroactively satisfied by a saved page',()=>{
 const f=fixture({multi:true}),draft=f.job.steps!.find(step=>step.tool.endsWith(':draft'))!;(draft.output as any).result={outcome:'completed',content:'',summary:'没有正文'};
 assert.equal(recoverVerifiedNotionWorkflow(f.job,owner),undefined);
});
