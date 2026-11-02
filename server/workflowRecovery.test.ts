import test from 'node:test';
import assert from 'node:assert/strict';
import type {ChatOperation} from './chatOperations.js';
import type {Conversation} from './types.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {createWorkflowRun,type WorkflowStep} from './taskWorkflow.js';
import {canResumeWorkflowAfterRestart,canContinueKnownFailedWorkflow,reuseCompletedWorkflowReads,workflowSourceBindingsMatch} from './workflowRecovery.js';
import {taskContinuation} from './taskContinuation.js';

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

function notionFixture(linked=true){
 const f=fixture([step('save',{kind:'notion'})]),cp=f.checkpoint('save','started','waiting'),bodyDigest='a'.repeat(64),actualKey='actual_notion_save';
 const output=cp.output as any;output.expectedBodyDigest=bodyDigest;if(linked)output.notionCheckpointKey=actualKey;
 f.run.steps[0]={id:'save',state:'waiting',waitingFor:'result'};f.run.phase='waiting';
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
 const mutations=[(f:ReturnType<typeof notionFixture>)=>{f.actual.scopeId='foreign_op';},f=>{f.actual.namespace='foreign_namespace';},f=>{f.actual.tool='other_write';},f=>{f.actual.state='started';},f=>{f.op.workRun!.notionReceipt!.expectedDigest='d'.repeat(64);},f=>{f.op.workRun!.notionReceipt!.verification={state:'exhausted',version:1,attempt:3,nextCheckAt:'2026-10-25T01:00:00Z',deadlineAt:'2026-10-25T01:00:00Z'};},f=>{f.op.workRun!.notionReceipt!.final=false;},f=>{(f.actual.output as any).digest='d'.repeat(64);},f=>{f.output.notionCheckpointKey='another_save';}] satisfies ((f:ReturnType<typeof notionFixture>)=>void)[];
 for(const mutate of mutations){const f=notionFixture();mutate(f);assert.equal(f.can(),false);}
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
