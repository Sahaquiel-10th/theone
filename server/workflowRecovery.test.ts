import test from 'node:test';
import assert from 'node:assert/strict';
import type {ChatOperation} from './chatOperations.js';
import type {Conversation} from './types.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {createWorkflowRun,workflowPhase,type WorkflowStep} from './taskWorkflow.js';
import {canResumeWorkflowAfterRestart,canContinueKnownFailedWorkflow,reuseCompletedWorkflowReads,workflowSourceBindingsMatch} from './workflowRecovery.js';
import {taskContinuation} from './taskContinuation.js';
import {executeWorkflowStages} from './workflowExecution.js';
import {notionWriteDeliveryProof} from './notionCompletion.js';
import {notionHash,legacyNotionNormalized,canonicalNotionDigest} from './notionCanonical.js';

const scope={workspaceId:'ws_a',userId:'usr_a'},step=(id:string,extra:Partial<WorkflowStep>={}):WorkflowStep=>({id,title:'处理当前步骤',kind:'model',instruction:'当前步骤完整指令',inputs:[],...extra});

test('source binding equality ignores SQL object key order but preserves exact IDs, bindings and array order',()=>{
 const first=[{id:'source_a',binding:'binding_a'},{id:'source_b',binding:'binding_b'}],sql=first.map(source=>({binding:source.binding,id:source.id}));
 assert.equal(workflowSourceBindingsMatch(sql,first),true);assert.equal(workflowSourceBindingsMatch(sql,[...first].reverse()),false);
 assert.equal(workflowSourceBindingsMatch(sql,[{id:'source_a',binding:'rotated'},first[1]]),false);assert.equal(workflowSourceBindingsMatch(sql,[first[0]]),false);
 assert.equal(workflowSourceBindingsMatch([{...sql[0],extra:true},sql[1]] as any,first),false);
});
function fixture(values:WorkflowStep[]=[step('draft')]){
 const task:Conversation={...scope,id:'task_a',modelId:'model_a',title:'当前任务',archived:false,messages:[],createdAt:'2026-10-25T01:00:00Z',updatedAt:'2026-10-25T01:00:00Z'};
 const run=createWorkflowRun({version:1,steps:values},{...scope,operationId:'op_a'});
 const op={...scope,id:'op_a',operationId:'original_operation_00001',requestId:'request_a',payloadHash:'test',status:'pending',conversationId:task.id,createdAt:'2026-10-25T01:00:00Z',updatedAt:'2026-10-25T01:00:00Z',workRun:{state:'running',workflow:run,steps:[]}} as unknown as ChatOperation;
 const checkpoint=(id:string,state:TaskStep['state']='completed',outcome='completed')=>{
  const s=run.spec.steps.find(s=>s.id===id)!,namespace=`workflow:${run.id}`,tool=`workflow:${run.id}:${id}`,key=taskStepKey(namespace,tool,JSON.stringify({revision:run.revision,instruction:s.instruction,inputs:s.inputs}));
  const cp:TaskStep={key,namespace,tool,label:s.title,effect:s.kind==='notion'?'external_write':s.kind==='tool'?'read':'model',state,scopeId:op.id,updatedAt:'2026-10-25T01:00:01Z',output:{workflow:{version:1,runId:run.id,revision:run.revision,stepId:id},outcome,result:{content:'not read by the recovery helper'}}};
  op.workRun!.steps!.push(cp);return cp;
 };
 return {op,task,run,checkpoint,can:()=>canResumeWorkflowAfterRestart(op,task)};
}

test('a new supplement may continue only an exactly evidenced known failed read/model, never unknown writes or protected failure',()=>{
 for(const kind of ['tool','model'] as const){
  const f=fixture([step('stage',{kind,...(kind==='tool'?{tool:'web_search' as const}:{})})]);f.checkpoint('stage','failed','failed');f.run.steps[0]={id:'stage',state:'failed'};f.run.phase='failed';f.op.workRun!.state='failed';f.op.workRun!.resultOutcome='failed';f.op.status='completed';f.task.workPaused=true;f.task.workPauseReason='failed';
  assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),true);
  const db={chatOperations:[f.op],executionTasks:[]} as any;assert.equal(taskContinuation(db,scope,f.task).canResume,true);
  for(const failureCode of ['task_key_required','task_authorization_required','task_budget_required','task_budget_limit']){f.op.workRun!.failureCode=failureCode;assert.equal(taskContinuation(db,scope,f.task).canResume,false);}delete f.op.workRun!.failureCode;
  f.op.workRun!.steps!.push({key:'unknown',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'原保存',updatedAt:'now'});assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),false);f.op.workRun!.steps!.pop();
  for(const effect of ['artifact','external_write'] as const)for(const state of ['completed','failed'] as const){f.op.workRun!.steps!.push({key:'earlier-effect',namespace:'worker',tool:'earlier_effect',effect,state,label:'已有产物或写入',updatedAt:'now'});assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),false);f.op.workRun!.steps!.pop();}
  f.op.workRun!.notionReceipt={state:'verified'};assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),false);delete f.op.workRun!.notionReceipt;
  f.op.workRun!.notionReceipt={state:'uncertain',delivery:'unknown'};assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),false);delete f.op.workRun!.notionReceipt;
  f.task.workPauseReason='user_stopped';assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),false);f.task.workPauseReason='failed';
  f.run.binding.userId='foreign';assert.equal(canContinueKnownFailedWorkflow(f.op,f.task),false);
 }
});

test('exact completed read reuse rebinds owner proof but never imports a write, changed query or foreign result',()=>{
 const f=fixture([step('source',{kind:'tool',tool:'knowledge_search',instruction:'昨天碰一碰产品笔记'})]),cp=f.checkpoint('source');f.run.steps[0]={id:'source',state:'completed',checkpointKey:cp.key};f.run.phase='completed';
 const next=()=>createWorkflowRun({version:1,steps:[step('source_1',{kind:'tool',tool:'knowledge_search',instruction:'昨天碰一碰产品笔记'}),step('draft',{inputs:['source_1']})]},{...scope,operationId:'new_op'});
 const current=next(),imported=reuseCompletedWorkflowReads(f.op.workRun!,current);assert.equal(imported.length,1);assert.equal(imported[0].scopeId,'new_op');assert.equal(current.steps[0].state,'completed');assert.equal(current.phase,'queued');assert.equal(cp.scopeId,'op_a');
 const changed=next();changed.spec.steps[0].instruction='不同的材料';assert.deepEqual(reuseCompletedWorkflowReads(f.op.workRun!,changed),[]);
 const foreign=next();foreign.binding.workspaceId='foreign';assert.deepEqual(reuseCompletedWorkflowReads(f.op.workRun!,foreign),[]);
 for(const tool of ['web_search','read_notion_document'] as const){const fresh=next();fresh.spec.steps[0].tool=tool;assert.deepEqual(reuseCompletedWorkflowReads(f.op.workRun!,fresh),[]);}
 cp.effect='external_write';assert.deepEqual(reuseCompletedWorkflowReads(f.op.workRun!,next()),[]);
});

test('unstarted queued workflow is eligible, but this metadata decision never reads or executes anything',()=>{
 const f=fixture();assert.equal(f.can(),true);assert.equal(f.run.sequence,0);assert.equal(f.run.steps[0].state,'queued');assert.equal(f.op.workRun!.state,'running');
});

test('completed exact outer proof can finalize a pending operation without regenerating its body',()=>{
 const f=fixture(),cp=f.checkpoint('draft');f.run.steps[0]={id:'draft',state:'completed',checkpointKey:cp.key};f.run.phase='completed';
 assert.equal(f.can(),true);delete (cp.output as any).result;assert.equal(f.can(),true,'body is not read as proof');
});

test('a running stage whose result was durably completed before a crash can recover the same attempt',()=>{
 const f=fixture([step('draft'),step('save',{kind:'notion',inputs:['draft']})]);f.checkpoint('draft');f.run.steps[0]={id:'draft',state:'running'};f.run.phase='running';assert.equal(f.can(),true);
});

for(const state of ['failed','needs_input'] as const)test(`known ${state} stage can finish its receipt; independent unstarted work remains eligible`,()=>{
 const f=fixture([step('draft'),step('independent')]);f.checkpoint('draft','failed',state);f.run.steps[0]={id:'draft',state};f.run.phase=state;assert.equal(f.can(),true);
});

test('dependency waiting and optional skipped stages have no attempted checkpoint and do not authorize replay',()=>{
 const f=fixture([step('source',{kind:'tool',tool:'knowledge_search'}),step('dependent',{inputs:['source']}),step('optional',{inputs:['source'],required:false})]);
 f.checkpoint('source','failed','needs_input');f.run.steps[0]={id:'source',state:'needs_input'};f.run.steps[1]={id:'dependent',state:'waiting',waitingFor:'inputs'};f.run.steps[2]={id:'optional',state:'skipped'};f.run.phase='needs_input';assert.equal(f.can(),true);
 f.checkpoint('dependent','started','waiting');assert.equal(f.can(),false);
});

for(const kind of ['model','feature','notion'] as const)test(`unconfirmed started ${kind} remains interrupted instead of reissuing its operation`,()=>{
 const f=fixture([step('stage',{kind,...(kind==='feature'?{featureId:'feature_a'}:{})})]);f.checkpoint('stage','started','waiting');f.run.steps[0]={id:'stage',state:'waiting',waitingFor:'result'};f.run.phase='waiting';assert.equal(f.can(),false);
});

function notionFixture(linked=true,values=[step('save',{kind:'notion'})]){
 const f=fixture(values),cp=f.checkpoint('save','started','waiting'),bodyDigest='a'.repeat(64),actualKey='actual_notion_save';
 const output=cp.output as any;output.expectedBodyDigest=bodyDigest;if(linked)output.notionCheckpointKey=actualKey;
 f.run.steps[f.run.spec.steps.findIndex(step=>step.id==='save')]={id:'save',state:'waiting',waitingFor:'result'};f.run.phase=workflowPhase(f.run.spec,f.run.steps);
 f.op.workRun!.notionReceipt={state:'verified',checkpointKey:actualKey,pageId:'b'.repeat(32),expectedDigest:bodyDigest,digest:'c'.repeat(64),final:true};
 const actual:TaskStep={key:actualKey,namespace:'worker',tool:'save_notion_draft',scopeId:f.op.id,label:'实际保存',effect:'external_write',state:'completed',updatedAt:'2026-10-25T01:00:02Z',output:{state:'verified',pageId:'b'.repeat(32),expectedDigest:bodyDigest,digest:'c'.repeat(64),final:true}};
 f.op.workRun!.steps!.push(actual);return {...f,cp,actual,output};
}

test('Notion awaiting workflow receipt can recover only the exact verified actual-save checkpoint and intended body hash',()=>{
 const f=notionFixture();assert.equal(f.can(),true);assert.equal(f.cp.state,'started');assert.equal(f.run.steps[0].state,'waiting');
});

test('a crash before receipt-key binding needs a new actual write and matching digest, not an old verified page',()=>{
 const f=notionFixture(false);assert.equal(f.can(),true);
 f.output.priorNotionCheckpointKey=f.actual.key;assert.equal(f.can(),false);delete f.output.priorNotionCheckpointKey;
 f.actual.updatedAt='2026-10-25T00:59:59Z';assert.equal(f.can(),false);
});

test('foreign, mismatched, nonfinal or stale Notion proof never resumes an unknown write',()=>{
 const mutations=[(f:ReturnType<typeof notionFixture>)=>{f.actual.scopeId='foreign_op';},f=>{f.actual.namespace='foreign_namespace';},f=>{f.actual.tool='other_write';},f=>{f.actual.state='started';},f=>{f.op.workRun!.notionReceipt!.expectedDigest='d'.repeat(64);},f=>{f.op.workRun!.notionReceipt!.final=false;},f=>{(f.actual.output as any).digest='d'.repeat(64);},f=>{f.output.notionCheckpointKey='another_save';}] satisfies ((f:ReturnType<typeof notionFixture>)=>void)[];
 for(const mutate of mutations){const f=notionFixture();mutate(f);assert.equal(f.can(),false);}
});

test('legacy complete readback with exact final worker evidence is not blocked by redundant background metadata',()=>{
 const f=notionFixture();f.op.workRun!.notionReceipt!.verification={state:'exhausted',version:1,attempt:3,nextCheckAt:'2026-10-25T01:00:00Z',deadlineAt:'2026-10-25T01:00:00Z'};
 assert.equal(f.can(),true);assert.equal(f.op.workRun!.notionReceipt!.verification.state,'exhausted');
});

function deliveredNotionFixture(linked=true,completed=false,followup=false,values=[step('save',{kind:'notion'}),...(followup?[step('read',{kind:'tool',tool:'read_notion_document',inputs:['save']})]:[])]){
 const f=notionFixture(linked,values),receipt=f.op.workRun!.notionReceipt!,key='e'.repeat(64);
 receipt.state='delivered';receipt.delivery='unknown';receipt.checkpointKey=key;receipt.expectedRawDigest='d'.repeat(64);delete receipt.digest;
 receipt.writeAcknowledgement={version:1,operationId:f.op.id,checkpointKey:key,pageId:receipt.pageId!,expectedDigest:receipt.expectedDigest!,expectedRawDigest:receipt.expectedRawDigest,acknowledgedAt:'2026-10-25T01:00:02Z'};
 receipt.verification={state:'scheduled',version:1,attempt:0,nextCheckAt:'2026-10-25T01:00:04Z',deadlineAt:'2026-10-25T01:05:02Z'};
 f.actual.key=key;f.actual.output={state:'delivered',saved:true,pageId:receipt.pageId,expectedDigest:receipt.expectedDigest,final:true};
 if(linked)f.output.notionCheckpointKey=key;
 if(completed){
  f.cp.state='completed';f.output.outcome='completed';f.output.result={state:'delivered',pageId:receipt.pageId,expectedDigest:receipt.expectedDigest,final:true};
  f.cp.operation={version:1,execution:'succeeded',verification:'pending',artifactRef:f.cp.key};
  f.run.steps[f.run.spec.steps.findIndex(step=>step.id==='save')]={id:'save',state:'completed',checkpointKey:f.cp.key};f.run.phase=workflowPhase(f.run.spec,f.run.steps);
 }
 return f;
}

test('exact Notion delivery resumes after restart while background integrity is scheduled, checking or exhausted',()=>{
 for(const completed of [false,true])for(const state of ['scheduled','checking','exhausted'] as const){
  const f=deliveredNotionFixture(true,completed),receipt=f.op.workRun!.notionReceipt!;
  receipt.verification!.state=state;
  if(state==='exhausted'){receipt.verification!.attempt=3;receipt.verification!.lastReason='mismatch';}
  if(completed)f.cp.operation!.verification=state==='exhausted'?'failed':'pending';
  const before=structuredClone(f.op);
  assert.equal(f.can(),true,`${completed}/${state}`);assert.deepEqual(f.op,before,'metadata recovery never resets checks or replays writes');
 }
 const unlinked=deliveredNotionFixture(false);assert.equal(unlinked.can(),true);
 unlinked.actual.updatedAt='2026-10-25T00:59:59Z';assert.equal(unlinked.can(),false,'unbound older write cannot prove this stage');
 const asynchronous=deliveredNotionFixture(),asyncReceipt=asynchronous.op.workRun!.notionReceipt!;
 asyncReceipt.asyncTaskId='confirmed_async_task';asyncReceipt.writeAcknowledgement!.asyncTaskId=asyncReceipt.asyncTaskId;assert.equal(asynchronous.can(),true);
 const checked=deliveredNotionFixture(),checkedReceipt=checked.op.workRun!.notionReceipt!;
 checkedReceipt.state='verified';checkedReceipt.digest='c'.repeat(64);delete checkedReceipt.verification;
 assert.equal(checked.can(),true,'later complete readback need not rewrite an ACK-backed worker result');
});

test('delivered state and completed outer stage cannot replace exact ACK, source, worker and final-manuscript evidence',()=>{
 const mutations=[
  (f:ReturnType<typeof deliveredNotionFixture>)=>{delete f.op.workRun!.notionReceipt!.writeAcknowledgement;},
  f=>{f.op.workRun!.notionReceipt!.writeAcknowledgement!.operationId='foreign_op';},
  f=>{f.op.workRun!.notionReceipt!.writeAcknowledgement!.checkpointKey='f'.repeat(64);},
  f=>{f.op.workRun!.notionReceipt!.writeAcknowledgement!.expectedRawDigest='f'.repeat(64);},
  f=>{f.op.workRun!.notionReceipt!.writeAcknowledgement!.pageId='f'.repeat(32);},
  f=>{f.op.workRun!.notionReceipt!.writeAcknowledgement!.acknowledgedAt='invalid';},
  f=>{f.op.workRun!.notionReceipt!.asyncTaskId='different_async_task';},
  f=>{f.op.workRun!.notionReceipt!.delivery='not_sent';},
  f=>{f.op.workRun!.notionReceipt!.delivery='rejected';},
  f=>{f.op.workRun!.notionReceipt!.final=false;},
  f=>{f.output.expectedBodyDigest='f'.repeat(64);},
  f=>{f.output.notionCheckpointKey='f'.repeat(64);},
  f=>{f.output.priorNotionCheckpointKey=f.actual.key;},
  f=>{f.actual.scopeId='foreign_op';},
  f=>{f.actual.namespace='foreign_namespace';},
  f=>{f.actual.tool='another_save';},
  f=>{f.actual.effect='artifact';},
  f=>{f.actual.state='started';},
  f=>{f.actual.updatedAt='invalid';},
  f=>{(f.actual.output as any).final=false;},
  f=>{(f.actual.output as any).pageId='f'.repeat(32);},
  f=>{(f.actual.output as any).expectedDigest='f'.repeat(64);},
  f=>{f.actual.operation={version:1,execution:'unknown',verification:'pending'};},
  f=>{f.op.workRun!.steps!.push(structuredClone(f.actual));},
  f=>{f.op.workRun!.steps=f.op.workRun!.steps!.filter(cp=>cp!==f.actual);},
  f=>{const receipt=f.op.workRun!.notionReceipt!;receipt.state='verified';receipt.digest='c'.repeat(64);delete receipt.verification;delete receipt.writeAcknowledgement;},
 ] satisfies ((f:ReturnType<typeof deliveredNotionFixture>)=>void)[];
 for(const completed of [false,true])for(const [index,mutate] of mutations.entries()){
  const f=deliveredNotionFixture(true,completed);mutate(f);assert.equal(f.can(),false,`${completed}/${index}`);
 }
 for(const effect of ['model','artifact','external_write'] as const){
  const f=deliveredNotionFixture();f.op.workRun!.steps!.push({key:'other-effect',namespace:'nested',tool:'earlier_operation',scopeId:f.op.id,label:'另一未决操作',effect,state:'started',updatedAt:f.actual.updatedAt});assert.equal(f.can(),false,effect);
 }
});

test('an earlier verified save keeps its own completed proof when a later delivered save owns the latest receipt',()=>{
 const values=[step('saved_before',{kind:'notion'}),step('save',{kind:'notion',inputs:['saved_before']}),step('read',{kind:'tool',tool:'read_notion_document',inputs:['save']})];
 const f=deliveredNotionFixture(true,true,true,values),old=f.checkpoint('saved_before');
 old.operation={version:1,execution:'succeeded',verification:'verified',artifactRef:old.key};
 Object.assign(old.output as object,{result:{state:'verified',pageId:'f'.repeat(32),digest:'f'.repeat(64),expectedDigest:'f'.repeat(64),final:true},expectedBodyDigest:'f'.repeat(64),notionCheckpointKey:'f'.repeat(64)});
 f.run.steps[0]={id:'saved_before',state:'completed',checkpointKey:old.key};f.run.phase=workflowPhase(f.run.spec,f.run.steps);
 assert.equal(f.can(),true,'latest receipt need not be reused as proof of the earlier verified save');
 old.operation.verification='pending';assert.equal(f.can(),false,'a different unverified save cannot borrow the latest ACK');
 old.operation.verification='verified';f.op.workRun!.notionReceipt!.writeAcknowledgement!.operationId='foreign';assert.equal(f.can(),false,'the latest ACK-only save still needs exact proof');
});

function multipleDeliveredSavesFixture(){
 const values=[step('saved_before',{kind:'notion'}),step('save',{kind:'notion',inputs:['saved_before']}),step('read',{kind:'tool',tool:'read_notion_document',inputs:['save']})];
 const f=deliveredNotionFixture(true,true,true,values),old=f.checkpoint('saved_before'),content='第一篇完整原稿。\n\n这个段落在第二次保存后仍然完整保留。',workerKey='f'.repeat(64),pageId='a'.repeat(32);
 const receipt={state:'delivered' as const,delivery:'unknown' as const,checkpointKey:workerKey,pageId,expectedDigest:notionHash(legacyNotionNormalized(content)),expectedRawDigest:notionHash(content),expectedCanonicalDigest:canonicalNotionDigest(content,11),canonicalVersion:11 as const,expectedLength:content.length,final:true,writeAcknowledgement:{version:1 as const,operationId:f.op.id,checkpointKey:workerKey,pageId,expectedDigest:notionHash(legacyNotionNormalized(content)),expectedRawDigest:notionHash(content),acknowledgedAt:'2026-10-25T01:00:01Z'}};
 const worker:TaskStep={key:workerKey,namespace:'worker',tool:'save_notion_draft',scopeId:f.op.id,label:'先前实际保存',effect:'external_write',state:'completed',updatedAt:'2026-10-25T01:00:01Z',operation:{version:1,execution:'succeeded',verification:'pending',artifactRef:workerKey},output:{state:'delivered',pageId,expectedDigest:receipt.expectedDigest,final:true,content}};
 old.operation={version:1,execution:'succeeded',verification:'pending',artifactRef:old.key};
 Object.assign(old.output as object,{result:{state:'delivered',pageId,final:true},expectedBodyDigest:receipt.expectedDigest,notionCheckpointKey:workerKey,notionDeliveryProof:notionWriteDeliveryProof(receipt,f.op.id)});
 f.op.workRun!.steps!.push(worker);f.run.steps[0]={id:'saved_before',state:'completed',checkpointKey:old.key};f.run.phase=workflowPhase(f.run.spec,f.run.steps);
 return {...f,old,oldWorker:worker,oldReceipt:receipt,oldOutput:old.output as any};
}

test('two ACK-delivered saves retain independent full-source proof after the latest receipt rotates',()=>{
 for(const currentCompleted of [false,true])for(const verification of ['pending','failed'] as const){
  const f=multipleDeliveredSavesFixture();f.old.operation!.verification=verification;
  if(!currentCompleted){f.cp.state='started';f.output.outcome='waiting';delete f.cp.operation;f.run.steps[1]={id:'save',state:'waiting',waitingFor:'result'};f.run.phase=workflowPhase(f.run.spec,f.run.steps);}
  const before=structuredClone(f.op);assert.equal(f.can(),true,`${currentCompleted}/${verification}`);assert.deepEqual(f.op,before);
 }
 const asynchronous=multipleDeliveredSavesFixture();
 const receipt={...asynchronous.oldReceipt,asyncTaskId:'confirmed_first_save',writeAcknowledgement:{...asynchronous.oldReceipt.writeAcknowledgement,asyncTaskId:'confirmed_first_save'}};
 asynchronous.oldOutput.notionDeliveryProof=notionWriteDeliveryProof(receipt,asynchronous.op.id);assert.equal(asynchronous.can(),true,'the frozen ACK retains exact asynchronous identity');
 const quality=multipleDeliveredSavesFixture();(quality.actual.output as any).digest='9'.repeat(64);assert.equal(quality.can(),true,'independent readback metadata cannot retract an exact write ACK');
});

test('frozen earlier-save proof cannot borrow a current ACK or bypass exact scope, source, worker and workflow identity',()=>{
 const mutations=[
  (f:ReturnType<typeof multipleDeliveredSavesFixture>)=>{delete f.oldOutput.notionDeliveryProof;},
  f=>{f.oldOutput.notionDeliveryProof.writeAcknowledgement.operationId='foreign_op';},
  f=>{f.oldOutput.notionDeliveryProof.writeAcknowledgement.expectedRawDigest='8'.repeat(64);},
  f=>{f.oldOutput.notionDeliveryProof.writeAcknowledgement.checkpointKey='8'.repeat(64);},
  f=>{f.oldOutput.notionDeliveryProof.pageId='8'.repeat(32);},
  f=>{f.oldOutput.notionDeliveryProof.final=false;},
  f=>{const receipt=f.oldOutput.notionDeliveryProof;delete receipt.writeAcknowledgement;receipt.state='verified';receipt.digest='8'.repeat(64);Object.assign(f.oldWorker.output as object,{state:'verified',digest:receipt.digest});},
  f=>{f.oldOutput.notionDeliveryProof.expectedLength++;},
  f=>{f.oldOutput.notionDeliveryProof.expectedCanonicalDigest='8'.repeat(64);},
  f=>{f.oldOutput.expectedBodyDigest='8'.repeat(64);},
  f=>{f.oldOutput.priorNotionCheckpointKey=f.oldWorker.key;},
  f=>{f.oldOutput.workflow.stepId='save';},
  f=>{f.old.scopeId='foreign_op';},
  f=>{f.oldWorker.scopeId='foreign_op';},
  f=>{f.oldWorker.state='started';},
  f=>{f.oldWorker.operation!.execution='unknown';},
  f=>{delete (f.oldWorker.output as any).content;},
  f=>{(f.oldWorker.output as any).content='其他完整原稿';},
  f=>{(f.oldWorker.output as any).pageId='8'.repeat(32);},
  f=>{f.op.workRun!.steps!.push(structuredClone(f.oldWorker));},
  f=>{f.op.workRun!.steps=f.op.workRun!.steps!.filter(cp=>cp!==f.oldWorker);},
  f=>{f.old.state='started';f.oldOutput.outcome='waiting';f.run.steps[0]={id:'saved_before',state:'waiting',waitingFor:'result'};f.run.phase=workflowPhase(f.run.spec,f.run.steps);},
  f=>{f.op.workRun!.steps!.push({key:'unknown_write',namespace:'worker',tool:'other_write',scopeId:f.op.id,label:'另一未决写入',effect:'external_write',state:'started',updatedAt:f.old.updatedAt});},
 ] satisfies ((f:ReturnType<typeof multipleDeliveredSavesFixture>)=>void)[];
 for(const [index,mutate] of mutations.entries()){const f=multipleDeliveredSavesFixture();mutate(f);assert.equal(f.can(),false,String(index));}
});

test('restarting two delivered saves executes only the queued dependent read and preserves both writes',async()=>{
 const f=multipleDeliveredSavesFixture();assert.equal(f.can(),true);
 const original=structuredClone(f.op.workRun!.steps!),receipt=structuredClone(f.op.workRun!.notionReceipt);let run=structuredClone(f.run),reads=0;
 const execute=()=>executeWorkflowStages({binding:run.binding,run:structuredClone(run),goal:'读取第二篇已保存文章。',modelSystemPrompt:'完整任务指令',history:[],inputs:[],
  checkpoints:{namespace:`workflow:${run.id}`,steps:f.op.workRun!.steps!,save:async cp=>{const steps=f.op.workRun!.steps!,index=steps.findIndex(saved=>saved.key===cp.key);if(index<0)steps.push(structuredClone(cp));else steps[index]=structuredClone(cp);}},
  tools:[{name:'read_notion_document',label:'读取当前成果',effect:'read',description:'读取已保存文章。',run:async()=>assert.fail('requires structured arguments'),structured:{schema:{type:'object',properties:{}},validate:value=>value,run:async()=>{reads++;return {status:'read',content:'第二篇已保存文章的完整正文。',complete:true};}}}],featureTools:{},verify:async()=>{},
  persist:async(next,expected)=>{if(run.sequence!==expected)return false;run=structuredClone(next);return true;},
  callModel:async()=>assert.fail('completed manuscripts cannot be regenerated'),saveNotion:async()=>assert.fail('neither acknowledged save may be submitted again'),receipt:async()=>structuredClone(f.op.workRun!.notionReceipt),
 });
 const result=await execute();assert.equal(result.outcome,'completed',JSON.stringify(result));assert.equal(reads,1);assert.equal(result.run.steps[2].state,'completed');
 for(const cp of original)assert.deepEqual(f.op.workRun!.steps!.find(saved=>saved.key===cp.key),cp);
 assert.deepEqual(f.op.workRun!.notionReceipt,receipt);assert.equal((await execute()).outcome,'completed');assert.equal(reads,1);
});

test('restart continues a delivered Notion stage to its dependent read without another model or write',async()=>{
 for(const completed of [false,true]){
  const f=deliveredNotionFixture(true,completed,true);assert.equal(f.can(),true);
  const actualBefore=structuredClone(f.actual),receiptBefore=structuredClone(f.op.workRun!.notionReceipt);
  let run=structuredClone(f.run),reads=0;
  const execute=()=>executeWorkflowStages({
   binding:run.binding,run:structuredClone(run),goal:'复用已保存文章并读取同一页。',modelSystemPrompt:'本轮完整指令',history:[],inputs:[],
   checkpoints:{namespace:`workflow:${run.id}`,steps:f.op.workRun!.steps!,save:async cp=>{const steps=f.op.workRun!.steps!,index=steps.findIndex(saved=>saved.key===cp.key);if(index<0)steps.push(structuredClone(cp));else steps[index]=structuredClone(cp);}},
   tools:[{name:'read_notion_document',label:'读取当前成果',effect:'read',description:'读取已绑定的保存成果。',run:async()=>assert.fail('page read requires bound structured arguments'),structured:{schema:{type:'object',additionalProperties:false,properties:{}},validate:value=>value,run:async()=>{reads++;return {status:'read',content:'已保存文章的完整只读正文。',complete:true};}}}],featureTools:{},verify:async()=>{},
   persist:async(next,expected)=>{if(run.sequence!==expected)return false;run=structuredClone(next);return true;},
   callModel:async()=>assert.fail('completed manuscript cannot be regenerated'),saveNotion:async()=>assert.fail('acknowledged write cannot be submitted again'),receipt:async()=>structuredClone(f.op.workRun!.notionReceipt),
  });
  const result=await execute();assert.equal(result.outcome,'completed',JSON.stringify(result));assert.equal(result.run.steps[0].state,'completed');assert.equal(result.run.steps[1].state,'completed');assert.equal(reads,1);
  assert.deepEqual(f.op.workRun!.steps!.find(cp=>cp.key===f.actual.key),actualBefore);assert.deepEqual(f.op.workRun!.notionReceipt,receiptBefore);
  const repeat=await execute();assert.equal(repeat.outcome,'completed');assert.equal(reads,1);
 }
});

test('every exact workflow checkpoint field is bound and a malformed marker or state cannot authorize recovery',()=>{
 const mutations=[(f:ReturnType<typeof fixture>,cp:TaskStep)=>{cp.namespace='worker';},(_f,cp)=>{cp.scopeId='foreign_op';},(_f,cp)=>{cp.tool='workflow:other:step';},(_f,cp)=>{cp.key='arbitrary_key';},(_f,cp)=>{(cp.output as any).workflow.stepId='other';},(_f,cp)=>{(cp.output as any).workflow.revision=2;},(_f,cp)=>{(cp.output as any).workflow.runId='other';},(_f,cp)=>{(cp.output as any).workflow.version=2;},(_f,cp)=>{cp.effect='read';},(_f,cp)=>{cp.state='started';},(_f,cp)=>{(cp.output as any).outcome='failed';},(f,cp)=>{f.op.workRun!.steps!.push(structuredClone(cp));}] satisfies ((f:ReturnType<typeof fixture>,cp:TaskStep)=>void)[];
 for(const mutate of mutations){const f=fixture(),cp=f.checkpoint('draft');f.run.steps[0]={id:'draft',state:'completed',checkpointKey:cp.key};f.run.phase='completed';mutate(f,cp);assert.equal(f.can(),false);}
});

test('other unfinished model, artifact or external-write checkpoint remains a global safety hold',()=>{
 for(const effect of ['model','artifact','external_write'] as const){const f=fixture(),cp=f.checkpoint('draft');f.run.steps[0]={id:'draft',state:'completed',checkpointKey:cp.key};f.run.phase='completed';f.op.workRun!.steps!.push({key:'unresolved',namespace:'feature:old',tool:'old_operation',label:'未知步骤',effect,state:'started',scopeId:f.op.id,updatedAt:cp.updatedAt});assert.equal(f.can(),false);}
});

test('scope, operation owner, cancellation, task archival and explicit stop all reject startup recovery',()=>{
 const mutations=[(f:ReturnType<typeof fixture>)=>{f.task.workspaceId='ws_b';},f=>{f.task.userId='usr_b';},f=>{f.task.id='other_task';},f=>{f.run.binding.operationId='other_operation';},f=>{f.run.binding.workspaceId='ws_b';},f=>{f.run.id='other_run';},f=>{f.op.status='completed';},f=>{f.op.status='interrupted';},f=>{f.op.workRun!.state='cancelled';},f=>{f.op.executionCancelled=true;},f=>{f.task.archived=true;},f=>{f.task.workPauseReason='user_stopped';},f=>{f.task.coordinatorMain=true;},f=>{f.op.workRun!.workflow=undefined;}] satisfies ((f:ReturnType<typeof fixture>)=>void)[];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(f.can(),false);}
});

function retryFixture(tool:'knowledge_search'|'read_notion_document'|'web_search'='knowledge_search'){
 const f=fixture([step('draft'),step('read',{kind:'tool',tool,inputs:['draft']})]),draft=f.checkpoint('draft'),cp=f.checkpoint('read','started','waiting');
 f.run.steps[0]={id:'draft',state:'completed',checkpointKey:draft.key};f.run.steps[1]={id:'read',state:'waiting',waitingFor:'result'};f.run.phase='waiting';
 const first=Date.parse('2026-11-03T00:00:00Z');cp.operation={version:1,execution:'failed',verification:'not_required',recovery:{strategy:'retry_read',state:'scheduled',attempt:1,maxAttempts:3,firstAttemptAt:new Date(first).toISOString(),nextRetryAt:new Date(first+2000).toISOString(),deadlineAt:new Date(first+120000).toISOString(),reason:'timeout'}};
 return {...f,cp,draft};
}

test('startup preserves exactly scoped safe-read retry counts beside already completed paid work',()=>{
 for(const tool of ['knowledge_search','read_notion_document'] as const){
  const f=retryFixture(tool);assert.equal(f.can(),true);assert.equal(f.cp.operation?.recovery?.attempt,1);assert.equal(f.cp.state,'started');assert.equal(f.run.sequence,0);
  f.cp.operation!.execution='running';f.cp.operation!.recovery!.state='executing';assert.equal(f.can(),true,'an interrupted idempotent read may consume the next bounded attempt');
  f.cp.operation!.recovery!.attempt=3;assert.equal(f.can(),true,'exhausted unknown last read may be finalized, never a fourth request');
 }
});

test('startup does not mistake read effect labels or copied recovery envelopes for permission to repeat paid/search/write actions',()=>{
 assert.equal(retryFixture('web_search').can(),false,'native search may charge a model even with effect read');
 const mutations=[(f:ReturnType<typeof retryFixture>)=>{f.cp.effect='model';},f=>{f.cp.scopeId='foreign';},f=>{f.cp.namespace='worker';},f=>{f.cp.tool='workflow:another:read';},f=>{(f.cp.output as any).workflow.revision=2;},f=>{(f.cp.output as any).workflow.stepId='draft';},f=>{f.cp.operation!.recovery!.maxAttempts=8 as 3;},f=>{f.cp.operation!.recovery!.nextRetryAt='invalid';},f=>{f.cp.operation!.artifactRef=f.cp.key;},f=>{f.cp.operation!.execution='succeeded';},f=>{f.cp.operation!.verification='verified';},f=>{(f.cp.output as any).sourceArtifact={id:'foreign_article'};},f=>{delete f.cp.operation;},f=>{f.op.workRun!.steps!.push(structuredClone(f.cp));},f=>{f.cp.operation!.recovery!.state='finished';}] satisfies ((f:ReturnType<typeof retryFixture>)=>void)[];
 for(const mutate of mutations){const f=retryFixture();mutate(f);assert.equal(f.can(),false);}
 for(const effect of ['model','external_write','artifact'] as const){const f=retryFixture();f.op.workRun!.steps!.push({key:'uncertain',namespace:'nested',tool:'earlier',effect,state:'started',scopeId:f.op.id,label:'未知原操作',updatedAt:f.cp.updatedAt});assert.equal(f.can(),false);}
});

test('explicit stop, protected authorization and budget failures cannot wake a scheduled safe read',()=>{
 const mutations=[(f:ReturnType<typeof retryFixture>)=>{f.op.executionCancelled=true;},f=>{f.task.workPauseReason='user_stopped';},f=>{f.task.archived=true;},f=>{f.op.workRun!.state='cancelled';},f=>{f.task.workspaceId='foreign';},f=>{f.task.userId='foreign';}] satisfies ((f:ReturnType<typeof retryFixture>)=>void)[];
 for(const mutate of mutations){const f=retryFixture();mutate(f);assert.equal(f.can(),false);}
 for(const code of ['task_key_required','task_authorization_required','task_budget_required','task_budget_limit']){const f=retryFixture();f.op.workRun!.failureCode=code;assert.equal(f.can(),false);}
});

test('imported completed safe reads rebind public-neutral artifact evidence to the new exact checkpoint',()=>{
 const f=fixture([step('source',{kind:'tool',tool:'knowledge_search',instruction:'同一份已授权资料'})]),cp=f.checkpoint('source');f.run.steps[0]={id:'source',state:'completed',checkpointKey:cp.key};f.run.phase='completed';
 cp.operation={version:1,execution:'succeeded',verification:'not_required',artifactRef:cp.key};
 const next=()=>createWorkflowRun({version:1,steps:[step('next_source',{kind:'tool',tool:'knowledge_search',instruction:'同一份已授权资料'}),step('draft',{inputs:['next_source']})]},{...scope,operationId:'next_op'},2);
 const run=next(),records=reuseCompletedWorkflowReads(f.op.workRun!,run);assert.equal(records.length,1);assert.notEqual(records[0].key,cp.key);assert.equal(records[0].operation?.artifactRef,records[0].key);assert.equal(cp.operation.artifactRef,cp.key);assert.equal(cp.scopeId,'op_a');
 const task={...f.task,id:'next_task'},op={...f.op,id:'next_op',conversationId:task.id,workRun:{...f.op.workRun!,state:'queued' as const,workflow:run,steps:records}};assert.equal(canResumeWorkflowAfterRestart(op,task),true);
 for(const mutate of [(c:TaskStep)=>{c.operation!.artifactRef='a'.repeat(64);},c=>{c.operation!.execution='unknown';},c=>{c.operation!.verification='pending';},c=>{c.scopeId='foreign';}] satisfies ((c:TaskStep)=>void)[]){const original=structuredClone(cp);mutate(cp);assert.deepEqual(reuseCompletedWorkflowReads(f.op.workRun!,next()),[]);Object.assign(cp,original);}
});
