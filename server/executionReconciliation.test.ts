import assert from 'node:assert/strict';
import test from 'node:test';
import type {Database, ExecutionTask} from './types.js';
import {reconcileStoppedExecution, type ExecutionReconciliationInput} from './executionReconciliation.js';
import {assertLocalExecutionAvailable, executionDeliveryPending} from './executionService.js';

const beforeAt = '2026-10-20T07:43:14.398Z', afterAt = '2026-10-26T04:00:00.000Z';
const scope = {workspaceId:'wa',userId:'ua',deviceId:'da',installationId:'a'.repeat(32)};
const input: ExecutionReconciliationInput = {...scope,taskId:'old-task',attemptId:'old-attempt',round:0,
  expectedUpdatedAt:beforeAt,reason:'原账号明确同意；已独立核对原进程和测试文件，仅结束这条旧操作。'};
function fixture() {
  const task = {...scope,id:input.taskId,conversationId:'old-conversation',sourceMessageId:'source',provider:'codex',
    status:'cancelled',instruction:'original instruction',reportRound:0,createdAt:beforeAt,updatedAt:beforeAt,completedAt:beforeAt,
    deliveryAttempt:{id:input.attemptId,round:0,issuedAt:beforeAt},
    transportInterruption:{attemptId:input.attemptId,round:0,reason:'cancellation_pending',at:beforeAt},
    finalResponse:'original actual result',lastError:'original warning',providerThreadId:'original-thread'} as ExecutionTask;
  const db = {users:[{id:scope.userId,enabled:true}],workspaces:[{id:scope.workspaceId,status:'active'}],
    workspaceMembers:[{workspaceId:scope.workspaceId,userId:scope.userId,status:'active'}],
    oneKeyDevices:[{id:scope.deviceId,...scope,status:'active'}],executionTasks:[task],auditLogs:[],
    conversations:[{id:task.conversationId,...scope,messages:[{id:'history',content:'immutable history'}]}],
    messages:[{id:'history',...scope,conversationId:task.conversationId,content:'immutable history'}],
    executionEvents:[{id:'event',...scope,taskId:task.id,text:'original event'}]} as unknown as Database;
  return {db,task};
}

test('manual exact reconciliation releases only the old wait, never claims success or replays execution', () => {
  const {db,task} = fixture(), history = JSON.stringify([db.messages,db.conversations,db.executionEvents]);
  const original = structuredClone(task), result = reconcileStoppedExecution(db, scope.userId, input, afterAt);
  assert.equal(result.duplicate, false); assert.equal(result.status, 'cancelled');
  assert.equal(task.status, 'cancelled'); assert.equal(task.finalResponse, original.finalResponse);
  assert.equal(task.instruction, original.instruction); assert.equal(task.deliveryAttempt!.id, input.attemptId);
  assert.equal(task.completedAt, original.completedAt); assert.equal(task.reportRound, 0);
  assert.equal(task.transportInterruption, undefined); assert.equal(task.terminalReceipt, undefined);
  assert.equal(executionDeliveryPending(task), false);
  assert.doesNotThrow(() => assertLocalExecutionAvailable(db, scope));
  assert.match(task.lastError!, /人工核对/); assert.match(task.lastError!, /不代表原任务已经完成/);
  assert.equal(JSON.stringify([db.messages,db.conversations,db.executionEvents]), history);
  const audit = db.auditLogs[0];
  assert.equal(audit.actorUserId, scope.userId); assert.equal(audit.details?.manual, true);
  assert.equal(audit.details?.claimsSuccess, false); assert.equal(audit.details?.reason, input.reason);
  assert.deepEqual((audit.details?.oldCheckpoint as any).transportInterruption, original.transportInterruption);
  assert.doesNotMatch(JSON.stringify(audit), /original instruction|original actual result|immutable history/);
});

test('a held cancelled attempt preserves its real terminal and all unrelated records', () => {
  const {db,task} = fixture(); task.executionSafetyHold = 'command_unconfirmed';
  task.terminalReceipt = {id:'real-terminal',hash:'real-hash',attemptId:input.attemptId,round:0,outcome:'cancelled',
    disposition:'supplemental',receivedAt:beforeAt};
  const terminal = structuredClone(task.terminalReceipt);
  const other = {...structuredClone(task),id:'other-task',conversationId:'other-conversation',workspaceId:'other-workspace'};
  db.executionTasks.push(other); const otherBefore = JSON.stringify(other);
  reconcileStoppedExecution(db, scope.userId, input, afterAt);
  assert.equal(task.executionSafetyHold, undefined); assert.deepEqual(task.terminalReceipt, terminal);
  assert.equal(JSON.stringify(other), otherBefore);
});

test('same exact manual record is idempotent, but a changed reason, task or fresh checkpoint is rejected', () => {
  for (const change of ['none','reason','round','updated','hold'] as const) {
    const {db,task} = fixture(); reconcileStoppedExecution(db, scope.userId, input, afterAt);
    if (change === 'round')task.reportRound = 1;
    if (change === 'updated')task.updatedAt = '2026-10-26T04:01:00.000Z';
    if (change === 'hold')task.executionSafetyHold = 'launcher_interrupted';
    const retry = {...input,...(change === 'reason'?{reason:'different approval'}:{})};
    const before = JSON.stringify(db);
    if (change === 'none') assert.equal(reconcileStoppedExecution(db, scope.userId, retry, afterAt).duplicate, true);
    else assert.throws(() => reconcileStoppedExecution(db, scope.userId, retry, afterAt));
    assert.equal(JSON.stringify(db), before);
  }
});

test('foreign owner, workspace, Key, computer, task, attempt, round and stale timestamp cannot clear anything', () => {
  const patches = [{workspaceId:'wb'}, {userId:'ub'}, {deviceId:'db'}, {installationId:'b'.repeat(32)},
    {taskId:'other-task'}, {attemptId:'other-attempt'}, {round:1}, {expectedUpdatedAt:'2026-10-20T07:43:15.398Z'}];
  for (const patch of patches) {
    const {db} = fixture(), before = JSON.stringify(db);
    assert.throws(() => reconcileStoppedExecution(db, scope.userId, {...input,...patch}, afterAt));
    assert.equal(JSON.stringify(db), before);
  }
  const {db} = fixture(), before = JSON.stringify(db);
  assert.throws(() => reconcileStoppedExecution(db, 'superadmin-who-is-not-owner', input, afterAt), /原账号/);
  assert.equal(JSON.stringify(db), before);
});

test('running, already-settled, mismatched checkpoints and an active newer execution cannot be manually released', () => {
  for (const change of ['running','failed','settled','wrong-checkpoint','newer-active'] as const) {
    const {db,task} = fixture();
    if (change === 'running') task.status = 'running';
    if (change === 'failed') task.status = 'failed';
    if (change === 'settled')task.transportInterruption = undefined;
    if (change === 'wrong-checkpoint')task.transportInterruption!.attemptId = 'different';
    if (change === 'newer-active')db.executionTasks.push({...task,id:'newer',status:'running'});
    const before = JSON.stringify(db);
    assert.throws(() => reconcileStoppedExecution(db, scope.userId, input, afterAt), change);
    assert.equal(JSON.stringify(db), before);
  }
});

test('disabled identity and malformed or missing manual acknowledgement fields fail before mutation', () => {
  for (const change of ['user','workspace','member','device'] as const) {
    const {db} = fixture();
    if (change === 'user')db.users[0].enabled = false;
    if (change === 'workspace')db.workspaces[0].status = 'suspended';
    if (change === 'member')db.workspaceMembers[0].status = 'disabled';
    if (change === 'device')db.oneKeyDevices[0].status = 'revoked';
    const before = JSON.stringify(db); assert.throws(() => reconcileStoppedExecution(db, scope.userId, input, afterAt));
    assert.equal(JSON.stringify(db), before);
  }
  for (const patch of [{reason:''}, {reason:' '}, {reason:'a'.repeat(2001)}, {round:-1}, {round:0.5},
    {round:'0'}, {expectedUpdatedAt:'not-a-time'}, {installationId:undefined}]) {
    const {db} = fixture(), before = JSON.stringify(db);
    assert.throws(() => reconcileStoppedExecution(db, scope.userId, {...input,...patch} as any, afterAt));
    assert.equal(JSON.stringify(db), before);
  }
});
