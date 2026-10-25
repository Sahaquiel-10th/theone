import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,Conversation} from './types.js';
import {taskContinuation,actionableTaskSupplement,supplementKnowledgeRequest} from './taskContinuation.js';

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
test('a named material location is a real knowledge request, not a generic keyword guess',()=>{
 assert.match(supplementKnowledgeRequest('得到大脑有小小启动器内容，按这个写'),/从得到大脑查找/);
 assert.equal(supplementKnowledgeRequest('不要用得到大脑的内容，按下面素材写'), '');
 assert.equal(supplementKnowledgeRequest('Notion有内容吗？'), '');
});
