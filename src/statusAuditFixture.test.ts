import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatusAuditFixture,STATUS_AUDIT_CASES,STATUS_TASK_STATES,STATUS_MAIN_OPERATION,STATUS_TASK_ID,STATUS_EXECUTION_ID} from '../output/playwright/status-audit-fixture';

const now=Date.parse('2026-10-28T00:00:00.000Z');
const url=(path:string)=>new URL(path,'http://127.0.0.1:5354');

test('waiting fixture recovers the real pending API contract, without inventing percent complete',()=>{
 const fixture=createStatusAuditFixture(new URLSearchParams('statusAudit=1'),now);
 const snapshot=fixture.handle('GET',url('/api/coordinator?page=1'))!.body;
 const receipt=fixture.handle('GET',url(`/api/coordinator/messages/${snapshot.pendingOperationId}`))!.body;
 assert.equal(receipt.status,'pending');
 assert.equal(receipt.operationId,STATUS_MAIN_OPERATION);
 assert.equal(receipt.progress.phase,'正在查找已授权知识库');
 assert.equal(now-Date.parse(receipt.progress.startedAt),65000);
 assert.equal('percent' in receipt.progress,false);
 assert.equal(snapshot.conversation.workspaceId,'preview');
 assert.equal(snapshot.conversation.userId,'preview');
 assert.equal(snapshot.tasks.length,1);
 assert.equal(snapshot.tasks[0].running,true);
 assert.equal(snapshot.tasks[0].phase,undefined);
 assert.equal(snapshot.conversation.messages.at(-1).role,'user');
 assert.deepEqual(fixture.handle('GET',url('/api/executions'))!.body,{tasks:[]});
});

test('main reply cancellation does not falsely cancel an independent delegated task',()=>{
 const fixture=createStatusAuditFixture(new URLSearchParams(),now);
 const before=fixture.snapshot().conversation.messages.map(message=>({...message}));
 assert.equal(fixture.handle('POST',url(`/api/coordinator/messages/${STATUS_MAIN_OPERATION}/stop`))!.status,200);
 assert.equal(fixture.handle('GET',url(`/api/coordinator/messages/${STATUS_MAIN_OPERATION}`))!.body.status,'interrupted');
 assert.equal(fixture.snapshot().pendingOperationId,undefined);
 assert.equal(fixture.snapshot().tasks[0].running,true);
 assert.deepEqual(fixture.snapshot().conversation.messages,before);
});

test('task cancellation affects only its own task and leaves main reply pending',()=>{
 const fixture=createStatusAuditFixture(new URLSearchParams(),now);
 fixture.handle('POST',url(`/api/coordinator/tasks/${STATUS_TASK_ID}/stop`));
 assert.equal(fixture.snapshot().tasks[0].running,false);
 assert.equal(fixture.snapshot().pendingOperationId,STATUS_MAIN_OPERATION);
 const detail=fixture.handle('GET',url(`/api/coordinator/tasks/${STATUS_TASK_ID}`))!.body;
 assert.equal(detail.jobs[0].state,'cancelled');
 assert.equal(detail.conversation.messages.length,1);
});

test('rejected stop requests preserve pending state and real failure responses',()=>{
 const main=createStatusAuditFixture(new URLSearchParams('statusCase=stop-rejected'),now);
 const response=main.handle('POST',url(`/api/coordinator/messages/${STATUS_MAIN_OPERATION}/stop`))!;
 assert.equal(response.status,503);
 assert.match(response.body.error,/停止/);
 assert.equal(main.snapshot().pendingOperationId,STATUS_MAIN_OPERATION);
 const task=createStatusAuditFixture(new URLSearchParams('statusCase=stop-task-rejected'),now);
 assert.equal(task.handle('POST',url(`/api/coordinator/tasks/${STATUS_TASK_ID}/stop`))!.status,503);
 assert.equal(task.snapshot().tasks[0].running,true);
});

test('empty, local and offline cases have distinct API evidence',()=>{
 const empty=createStatusAuditFixture(new URLSearchParams('statusCase=empty'),now);
 assert.equal(empty.snapshot().pendingOperationId,undefined);
 assert.equal(empty.snapshot().tasks.length,0);
 assert.equal(empty.localRuns.length,0);
 const local=createStatusAuditFixture(new URLSearchParams('statusCase=local'),now);
 const executions=local.handle('GET',url('/api/executions?conversationId='+STATUS_TASK_ID))!.body.tasks;
 assert.equal(executions.length,1);
 assert.equal(executions[0].id,STATUS_EXECUTION_ID);
 assert.equal(executions[0].workspaceId,'preview');
 assert.equal(local.handle('GET',url('/api/executions?conversationId=another-task'))!.body.tasks.length,0);
 const offline=createStatusAuditFixture(new URLSearchParams('statusCase=offline'),now);
 assert.equal(offline.handle('GET',url('/api/runtime/update'))!.body.connectionState,'reconnecting');
 assert.equal(offline.handle('GET',url('/api/me/local-device'))!.status,503);
 assert.equal(offline.handle('GET',url('/api/me/executor'))!.status,503);
 assert.equal(offline.localRuns.length,0);
});

test('all cases reject new execution/model/installation mutation, even with a real-service query',()=>{
 for(const variant of STATUS_AUDIT_CASES){
  const fixture=createStatusAuditFixture(new URLSearchParams(`statusAudit=1&realService=1&statusCase=${variant}`),now);
  const before=fixture.snapshot().conversation.messages.length;
  for(const path of ['/api/coordinator/messages','/api/coordinator/tasks/unknown/stop','/api/executions/from-input','/api/executions/from-message','/api/me/executor','/api/me/local-device','/api/runtime/update']){
   assert.ok([404,409].includes(fixture.handle('POST',url(path),{text:'Do not execute'})!.status),`${variant}: ${path}`);
  }
  assert.equal(fixture.snapshot().conversation.messages.length,before);
 }
});

test('unavailable execution listing does not fabricate an offline device or empty confirmed task list',()=>{
 const fixture=createStatusAuditFixture(new URLSearchParams('statusCase=unavailable'),now);
 const response=fixture.handle('GET',url('/api/executions'))!;
 assert.equal(response.status,503);
 assert.equal(response.body.tasks,undefined);
 assert.equal(fixture.handle('GET',url('/api/me/local-device'))!.status,200);
 assert.equal(fixture.handle('GET',url('/api/runtime/update'))!.body.connectionState,'connected');
 assert.equal(fixture.snapshot().tasks[0].running,true);
});

test('five tasks carry independent detail identities and truthful running, needs-input, paused and verification structures',()=>{
 for(const state of STATUS_TASK_STATES){
  const fixture=createStatusAuditFixture(new URLSearchParams(`taskCount=5&taskState=${state}`),now);
  const snapshot=fixture.snapshot();
  assert.equal(snapshot.total,5);
  assert.equal(new Set(snapshot.tasks.map(task=>task.id)).size,5);
  assert.equal(snapshot.transfers.length,5);
  for(const task of snapshot.tasks){
   const detail=fixture.handle('GET',url(`/api/coordinator/tasks/${task.id}`))!.body;
   assert.equal(detail.conversation.id,task.id);
   assert.equal(detail.conversation.workspaceId,'preview');
   assert.equal(task.running,state==='running');
   assert.equal(task.reconciling,state==='reconciling');
   if(state==='needs_input'){
    assert.equal(task.state,'paused','needs-input is a receipt outcome, not an invented active state');
    assert.equal(detail.jobs[0].state,'failed');
    assert.equal(detail.jobs[0].resultOutcome,'needs_input');
    assert.equal(snapshot.notices.find(notice=>notice.taskId===task.id)?.state,'needs_input');
   }else if(state==='paused'){
    assert.equal(task.paused,true);
    assert.equal(task.state,'paused');
    assert.equal(snapshot.notices.find(notice=>notice.taskId===task.id)?.outcome,'failed');
   }else if(state==='reconciling'){
    assert.equal(detail.jobs[0].verificationPending,true);
    assert.match(task.phase!,/核对保存结果/);
    assert.equal(snapshot.notices.length,0,'verification must not expose an obsolete failure receipt');
   }
  }
  fixture.handle('POST',url(`/api/coordinator/tasks/${snapshot.tasks[1].id}/stop`));
  assert.equal(fixture.handle('GET',url(`/api/coordinator/tasks/${snapshot.tasks[1].id}`))!.body.jobs[0].state,'cancelled');
  assert.notEqual(fixture.handle('GET',url(`/api/coordinator/tasks/${snapshot.tasks[0].id}`))!.body.jobs[0].state,'cancelled');
 }
});

test('task count is bounded and empty case remains empty even when a count is requested',()=>{
 assert.equal(createStatusAuditFixture(new URLSearchParams('taskCount=999'),now).snapshot().tasks.length,12);
 assert.equal(createStatusAuditFixture(new URLSearchParams('taskCount=NaN'),now).snapshot().tasks.length,1);
 assert.equal(createStatusAuditFixture(new URLSearchParams('taskCount=5&statusCase=empty'),now).snapshot().tasks.length,0);
});

test('phase and elapsed variants use the same receipt shape and safe bounded times',()=>{
 const fixture=createStatusAuditFixture(new URLSearchParams('statusPhase=model&statusElapsed=2'),now);
 assert.equal(fixture.phase,'正在等待模型回答');
 assert.equal(now-Date.parse(fixture.startedAt),2000);
 const invalid=createStatusAuditFixture(new URLSearchParams('statusCase=bogus&statusElapsed=NaN'),now);
 assert.equal(invalid.variant,'waiting');
 assert.equal(now-Date.parse(invalid.startedAt),65000);
 assert.equal(now-Date.parse(createStatusAuditFixture(new URLSearchParams('statusElapsed=-5'),now).startedAt),0);
});
