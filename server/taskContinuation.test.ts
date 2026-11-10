import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Conversation} from './types.js';
import {taskContinuation,actionableTaskSupplement,substantiveTaskSupplement,supplementKnowledgeRequest} from './taskContinuation.js';
import {createWorkflowRun} from './taskWorkflow.js';
import {taskStepKey} from './taskSteps.js';

const scope={workspaceId:'own',userId:'a'},foreign={workspaceId:'other',userId:'b'};
function fixture(){
  const task={...scope,id:'task',workPaused:true,workPauseReason:'needs_input'} as Conversation;
  const run={state:'failed',resultOutcome:'needs_input',steps:[]};
  const op={...scope,id:'original',conversationId:task.id,workRun:run};
  return {task,run,op,db:{chatOperations:[op],executionTasks:[]} as unknown as Database};
}
test('only known missing-input or normal partial pauses can automatically continue',()=>{
  for(const outcome of ['needs_input','partial']){
    const f=fixture();f.run.resultOutcome=outcome;assert.equal(taskContinuation(f.db,scope,f.task).canResume,true);
  }
  const f=fixture();f.task.workPauseReason='user_stopped';assert.equal(taskContinuation(f.db,scope,f.task).canResume,false);
  delete f.task.workPauseReason;assert.equal(taskContinuation(f.db,scope,f.task).canResume,true,'legacy explicit needs_input can continue');
  f.run.resultOutcome='failed';assert.equal(taskContinuation(f.db,scope,f.task).canResume,false);
});
test('an explicit new instruction can continue a partial step-limit or temporary model failure without retrying the old operation',()=>{
 for(const failureCode of ['task_step_limit','model_http_503']){
  const f=fixture();Object.assign(f.run,{resultOutcome:'partial',failureCode,notionReceipt:{state:'verified',pageId:'a'.repeat(32)}});f.task.workPauseReason='failed';
  assert.equal(taskContinuation(f.db,scope,f.task).canResume,true,failureCode);
 }
});
test('uncertain writes, user cancellation, Key failures and local safety holds are not released by a new supplement',()=>{
  for(const kind of ['uncertain','started','cancelled','interrupted','key','authorization','budget','local_hold','local_unknown']){
    const f=fixture(),run=f.run as any;
    if(kind==='uncertain')run.notionReceipt={state:'uncertain',delivery:'unknown'};
    if(kind==='started')run.steps=[{effect:'external_write',state:'started',tool:'save_notion_draft'}];
    if(['cancelled','interrupted'].includes(kind))run.state=kind;
    if(['key','authorization','budget'].includes(kind))run.failureCode=`task_${kind}_required`;
    if(kind.startsWith('local_'))f.db.executionTasks.push({...scope,id:'local',conversationId:'task',status:kind==='local_hold'?'completed':'failed',...(kind==='local_hold'?{executionSafetyHold:'command_unconfirmed'}:{})} as any);
    assert.equal(taskContinuation(f.db,scope,f.task).canResume,false,kind);
  }
});
test('verified and explicitly rejected Notion writes are safe, with exact workspace ownership',()=>{
  for(const receipt of [{state:'verified'},{state:'uncertain',delivery:'not_sent'},{state:'uncertain',delivery:'rejected'}]){
    const f=fixture();Object.assign(f.run,{notionReceipt:receipt});
    f.db.chatOperations!.push({...f.op,...foreign,id:'foreign-write',workRun:{...f.run,notionReceipt:{state:'uncertain'}}} as any);
    f.db.executionTasks.push({...foreign,id:'foreign-hold',conversationId:'task',status:'running'} as any);
    assert.equal(taskContinuation(f.db,scope,f.task).canResume,true);
  }
});
test('new material and explicit continue are actionable; status questions and discussion-only messages cannot resume work',()=>{
  for(const value of ['得到大脑有小小启动器内容，按这个写','继续干','补充素材：今天见了两位客户','人物就用虚构形象'])assert.equal(actionableTaskSupplement(value),true,value);
  for(const value of ['现在怎么了？','完成了吗？','现在执行了吗','只回答，不执行','只讨论，先不执行'])assert.equal(actionableTaskSupplement(value),false,value);
});
test('a known failed stage needs substantive clarification, not a bare continuation or acknowledgement',()=>{
 for(const value of ['继续','继续吧','按原要求继续','好的','嗯','OK'])assert.equal(substantiveTaskSupplement(value),false,value);
 assert.equal(substantiveTaskSupplement('公开案例我是让你自己想，不是找工具，可以上网搜'),true);
});
test('a named material location is a real knowledge request, not a generic keyword guess',()=>{
 assert.match(supplementKnowledgeRequest('得到大脑有小小启动器内容，按这个写'),/从得到大脑查找/);
 assert.equal(supplementKnowledgeRequest('不要用得到大脑的内容，按下面素材写'), '');
 assert.equal(supplementKnowledgeRequest('Notion有内容吗？'), '');
});

function deliveredFixture(){
 const f=fixture(),workflow=createWorkflowRun({version:1,steps:[{id:'save',title:'保存现有正文',kind:'notion',instruction:'保存本轮完整正文',inputs:[]}]},{...scope,operationId:f.op.id});
 const namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:save`,key=taskStepKey(namespace,tool,JSON.stringify({revision:1,instruction:workflow.spec.steps[0].instruction,inputs:[]})),workerKey='a'.repeat(64),expectedDigest='b'.repeat(64),expectedRawDigest='c'.repeat(64),pageId='d'.repeat(32);
 const outer={key,namespace,tool,scopeId:f.op.id,label:'保存现有正文',effect:'external_write',state:'failed',updatedAt:'2026-11-10T01:00:00Z',output:{workflow:{version:1,runId:workflow.id,revision:1,stepId:'save'},outcome:'failed',expectedBodyDigest:expectedDigest,notionCheckpointKey:workerKey}};
 const worker={key:workerKey,namespace:'worker',tool:'save_notion_draft',scopeId:f.op.id,label:'实际保存',effect:'external_write',state:'started',updatedAt:'2026-11-10T01:00:01Z'};
 workflow.steps[0]={id:'save',state:'failed'};workflow.phase='failed';
 Object.assign(f.run,{resultOutcome:'partial',failureCode:'notion_verification_exhausted',workflow,steps:[outer,worker],notionReceipt:{state:'delivered',delivery:'unknown',checkpointKey:workerKey,expectedDigest,expectedRawDigest,pageId,final:true,writeAcknowledgement:{version:1,operationId:f.op.id,checkpointKey:workerKey,expectedDigest,expectedRawDigest,pageId,acknowledgedAt:'2026-11-10T01:00:02Z'},verification:{state:'exhausted',version:17,attempt:3,nextCheckAt:'2026-11-10T01:00:04Z',deadlineAt:'2026-11-10T01:05:02Z'}}});
 return {...f,workflow,outer,worker};
}

test('a supplement can follow an exactly delivered save even when its old body check exhausted',()=>{
 const f=deliveredFixture(),before=structuredClone(f.op),result=taskContinuation(f.db,scope,f.task);
 assert.equal(result.canResume,true);assert.equal(result.canAcceptSupplement,true);assert.deepEqual(f.op,before,'supplement selection never rewrites receipts or stages');
 f.db.chatOperations!.push({...f.op,...foreign,id:'foreign-unconfirmed',workRun:{state:'failed',notionReceipt:{state:'uncertain',delivery:'unknown'}}} as any);
 assert.equal(taskContinuation(f.db,scope,f.task).canResume,true);
});

test('supplements cannot borrow an ACK across body, worker, owner, stop or uncertain sibling boundaries',()=>{
 for(const kind of ['wrong_ack','wrong_body','wrong_artifact','wrong_worker','missing_worker','duplicate','prior_write','nonfinal','unknown_model','unknown_write','stopped','cancelled','key','authorization','budget','local_hold','foreign_task'] as const){
  const f=deliveredFixture(),run=f.run as any;
  if(kind==='wrong_ack')run.notionReceipt.writeAcknowledgement.operationId='foreign';
  if(kind==='wrong_body')f.outer.output.expectedBodyDigest='f'.repeat(64);
  if(kind==='wrong_artifact')(f.outer.output as any).sourceArtifact={id:'existing_article',ref:'another_message',originOperationId:'another_operation',bodyDigest:'f'.repeat(64)};
  if(kind==='wrong_worker')f.worker.scopeId='foreign';
  if(kind==='missing_worker')run.steps=[f.outer];if(kind==='duplicate')run.steps.push(structuredClone(f.worker));
  if(kind==='prior_write')(f.outer.output as any).priorNotionCheckpointKey=f.worker.key;
  if(kind==='nonfinal')run.notionReceipt.final=false;
  if(kind==='unknown_model'||kind==='unknown_write')run.steps.push({key:'other',namespace:'nested',tool:'other',scopeId:f.op.id,effect:kind==='unknown_model'?'model':'external_write',state:'started',updatedAt:f.worker.updatedAt});
  if(kind==='stopped')f.task.workPauseReason='user_stopped';if(kind==='cancelled')run.state='cancelled';
  if(['key','authorization','budget'].includes(kind))run.failureCode=`task_${kind}_required`;
  if(kind==='local_hold')f.db.executionTasks.push({...scope,id:'held',conversationId:f.task.id,status:'failed',executionSafetyHold:'command_unconfirmed'} as any);
  if(kind==='foreign_task')f.task.userId='foreign';
  const result=taskContinuation(f.db,scope,f.task);assert.equal(result.canResume,false,kind);assert.equal(result.canAcceptSupplement,false,kind);
 }
});
