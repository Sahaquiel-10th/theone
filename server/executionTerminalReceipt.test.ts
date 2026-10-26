import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptTerminalReceipt, maxTerminalReceiptBytes, parseTerminalReceipt, recordExecutionAttempt,
  terminalReceiptHash, type TerminalReceipt } from './executionTerminalReceipt.js';
import { assertLocalExecutionAvailable, executionDeliveryPending, requestExecutionCancellation } from './executionService.js';

const now = '2026-10-14T06:00:00.000Z';
const owner = { workspaceId: 'workspace-a', userId: 'user-a', deviceId: 'device-a', installationId: 'a'.repeat(32) };
function fixture() {
  const task = { id: 'task-a', ...owner, conversationId: 'conversation-a', sourceMessageId: 'message-a',
    provider: 'codex', status: 'running', instruction: 'only authorized folder', reportRound: 1,
    createdAt: now, updatedAt: now } as any;
  const db = { oneKeyDevices: [{ id: owner.deviceId, ...owner, status: 'active' }],
    users: [{ id: owner.userId, enabled: true }], workspaces: [{ id: owner.workspaceId, status: 'active' }],
    workspaceMembers: [{ workspaceId: owner.workspaceId, userId: owner.userId, status: 'active' }],
    executionTasks: [task], executionEvents: [], auditLogs: [], messages: [],
    conversations: [{ id: task.conversationId, ...owner, messages: [], updatedAt: now }] } as any;
  recordExecutionAttempt(db, task, 'attempt-a', now);
  return { db, task };
}
function receipt(patch: Partial<TerminalReceipt> = {}): TerminalReceipt {
  const value = { type: 'execution_terminal_receipt' as const, schemaVersion: 1 as const,
    receiptId: 'b58901b7-8c0e-4c7b-9074-a6cc72065b8a', attemptId: 'attempt-a', ...owner,
    taskId: 'task-a', round: 1, outcome: 'completed' as const,
    finalResponse: '文件已回读：/授权目录/结果.md\n内容：ONE_LOCAL_NOTE_OK', occurredAt: now, ...patch };
  return { ...value, receiptHash: terminalReceiptHash(value) };
}

test('terminal receipt framing is byte-based, stable for unicode and delimiter text', () => {
  const value = receipt({ finalResponse: '🙂中文/\n3:abc"\\', error: '1:2' });
  assert.equal(parseTerminalReceipt(JSON.parse(JSON.stringify(value)))?.receiptHash, value.receiptHash);
  assert.notEqual(terminalReceiptHash({ ...value, finalResponse: '🙂中文/\n3:abc"\\ ' }), value.receiptHash);
  assert.equal(terminalReceiptHash(value), '5d0c2b4a5fe116e75b3bb1e7b79d0b485645aa32f63a9d7a541da47e1b8a80e2');
});

test('parser rejects tampered hashes, oversized bodies, unsafe identity and missing outcome', () => {
  const good = receipt();
  for (const bad of [{ ...good, finalResponse: good.finalResponse + 'changed' },
    { ...good, taskId: '../foreign' }, { ...good, round: -1 }, { ...good, outcome: 'success' },
    receipt({ finalResponse: 'a'.repeat(maxTerminalReceiptBytes) }), receipt({ error: 'e'.repeat(20_001) })]) {
    assert.equal(parseTerminalReceipt(bad), undefined);
  }
});

test('real completion is committed once, duplicate receipt has an idempotent ACK', () => {
  const { db, task } = fixture(); const value = receipt();
  assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'accepted');
  assert.equal(task.status, 'completed'); assert.equal(task.finalResponse, value.finalResponse);
  assert.equal(db.messages.length, 1); assert.equal(db.executionEvents.length, 1);
  assert.equal(task.terminalReceipt.receiptMessageId, 'execution_receipt_task-a_1');
  assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'duplicate');
  assert.equal(db.messages.length, 1); assert.equal(db.executionEvents.length, 1);
  assert.equal(acceptTerminalReceipt(db, owner, receipt({ finalResponse: 'collision' }), now), undefined);
});

test('disconnect recovery preserves failure history and exposes a new sourced result revision', () => {
  const { db, task } = fixture(); task.status = 'failed'; task.lastError = '本机连接中断';
  task.transportInterruption = { attemptId: 'attempt-a', round: 1, at: now, reason: 'socket_close' };
  task.reportedRound = task.noticeReadRound = 1;
  const old = { id: 'execution_receipt_task-a_1', role: 'assistant', content: '原失败回执', createdAt: now,
    workspaceId: owner.workspaceId, userId: owner.userId, conversationId: task.conversationId };
  db.messages.push(old); db.conversations[0].messages.push({ ...old });
  const value = receipt(); assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'accepted');
  assert.equal(task.status, 'completed'); assert.equal(task.transportInterruption, undefined);
  assert.equal(task.reportedRound, undefined); assert.equal(task.noticeReadRound, undefined);
  assert.equal(db.messages[0].content, '原失败回执'); assert.equal(db.messages.length, 2);
  assert.match(task.terminalReceipt.receiptMessageId, /_recovery_/);
  assert.match(db.messages[1].content, /ONE_LOCAL_NOTE_OK/);
});

test('ordinary tool failure does not become completed through a late transport receipt', () => {
  const { db, task } = fixture(); task.status = 'failed'; task.lastError = 'command exit 1';
  assert.equal(acceptTerminalReceipt(db, owner, receipt(), now)?.disposition, 'supplemental');
  assert.equal(task.status, 'failed'); assert.equal(task.lastError, 'command exit 1');
  assert.equal(task.finalResponse, undefined); assert.equal(task.terminalReceipt.disposition, 'supplemental');
  assert.match(db.messages[0].content, /本轮仍未完成/);
});

test('cancelled round is immutable and a late real answer is supplementary only', () => {
  const { db, task } = fixture(); task.status = 'cancelled'; task.lastError = '用户停止';
  task.transportInterruption = { attemptId: 'attempt-a', round: 1, at: now, reason: 'proof_timeout' };
  assert.equal(acceptTerminalReceipt(db, owner, receipt(), now)?.disposition, 'supplemental');
  assert.equal(task.status, 'cancelled'); assert.equal(task.lastError, '用户停止');
  assert.equal(task.finalResponse, undefined); assert.match(db.messages[0].content, /仍保持已取消/);
  assert.equal(task.terminalReceipt.disposition, 'supplemental'); assert.equal(executionDeliveryPending(task), false);
  assert.equal(task.transportInterruption, undefined);
});

test('a matching real stopped terminal retires transient cancellation diagnostics without rewriting history', () => {
  const diagnostics = [
    '停止请求已提交，正在等本机确认原操作结束；已产生的文件修改不会自动撤销。',
    '当前本机连接找不到这轮原操作的结束记录，尚不能确认它已退出。请先核对原操作和文件；新要求仍保留，不会自动重跑。',
    '正在停止这轮原操作，仍需等本机确认结束；已产生的修改不会自动撤销。',
    '正在检查这轮原操作的收尾情况，不会重新开始任务。',
    '本机记录显示这轮结果已交回，正在核对已有结果；不会重新执行原操作。',
    '本机已找到这轮结束记录，正在补回结果；不会重新执行原操作。'
  ];
  for (const diagnostic of diagnostics) {
    const { db, task } = fixture();
    requestExecutionCancellation(db, task, now);
    task.lastError = diagnostic;
    db.executionEvents.push({ id: 'original-diagnostic', taskId: task.id, ...owner,
      round: 1, kind: 'status', text: diagnostic, createdAt: now });
    const originalMessages = structuredClone(db.messages);
    const originalEvents = structuredClone(db.executionEvents);
    const unrelated = { ...task, id: 'unrelated-task', userId: 'another-user' };
    db.executionTasks.push(unrelated);
    const unrelatedBefore = structuredClone(unrelated);
    const actual = receipt({ outcome: 'cancelled', finalResponse: '原操作已确认退出，已有修改保留。' });
    assert.equal(acceptTerminalReceipt(db, owner, actual, now)?.disposition, 'supplemental');
    assert.equal(task.status, 'cancelled');
    assert.equal(task.lastError, '已停止，本轮不再继续执行；已产生的文件修改不会自动撤销。');
    assert.equal(task.finalResponse, undefined, 'a stopped process must not become a completed goal');
    assert.equal(task.executionSafetyHold, undefined);
    assert.equal(task.transportInterruption, undefined);
    assert.equal(executionDeliveryPending(task), false);
    assert.doesNotThrow(() => assertLocalExecutionAvailable(db, owner));
    assert.deepEqual(db.messages.slice(0, originalMessages.length), originalMessages);
    assert.deepEqual(db.executionEvents, originalEvents);
    assert.deepEqual(unrelated, unrelatedBefore);
    assert.match(db.messages.at(-1).content, /仍保持已取消/);
    assert.equal(acceptTerminalReceipt(db, owner, actual, now)?.disposition, 'duplicate');
  }
});

test('an answerless terminal can settle a stopped attempt without leaving its pending diagnostic', () => {
  const { db, task } = fixture(); requestExecutionCancellation(db, task, now);
  const actual = receipt({ outcome: 'cancelled', finalResponse: '' });
  assert.equal(acceptTerminalReceipt(db, owner, actual, now)?.disposition, 'superseded');
  assert.equal(task.status, 'cancelled'); assert.match(task.lastError, /^已停止/);
  assert.equal(task.finalResponse, undefined); assert.equal(executionDeliveryPending(task), false);
  assert.equal(task.terminalReceipt.disposition, 'supplemental');
});

test('normal late terminals preserve existing unknown-process holds and genuine stopped errors', () => {
  for (const hold of ['command_unconfirmed', 'launcher_interrupted', undefined] as const) {
    const { db, task } = fixture(); requestExecutionCancellation(db, task, now);
    task.executionSafetyHold = hold;
    task.lastError = hold ? '正在停止这轮原操作，仍需等本机确认结束；已产生的修改不会自动撤销。'
      : '工具退出失败：command exit 1';
    const before = task.lastError;
    assert.equal(acceptTerminalReceipt(db, owner, receipt({ outcome: 'cancelled' }), now)?.disposition, 'supplemental');
    assert.equal(task.status, 'cancelled'); assert.equal(task.lastError, before);
    assert.equal(task.executionSafetyHold, hold); assert.equal(executionDeliveryPending(task), Boolean(hold));
  }
});

test('a second terminal or an old-round terminal cannot retire a current pending diagnostic', () => {
  for (const oldRound of [false, true]) {
    const { db, task } = fixture(); requestExecutionCancellation(db, task, now);
    const actual = receipt({ outcome: 'cancelled' });
    if (oldRound) {
      task.reportRound = 2; recordExecutionAttempt(db, task, 'attempt-new', now);
    } else {
      acceptTerminalReceipt(db, owner, actual, now);
    }
    task.lastError = '正在检查这轮原操作的收尾情况，不会重新开始任务。';
    const before = JSON.stringify(task);
    assert.equal(acceptTerminalReceipt(db, owner, receipt({ outcome: 'cancelled', receiptId: 'second-terminal' }), now)?.disposition, 'supplemental');
    assert.equal(JSON.stringify(task), before);
  }
});

test('old round may return a sourced supplement without touching the newer round', () => {
  const { db, task } = fixture(); const old = receipt();
  task.reportRound = 2; recordExecutionAttempt(db, task, 'attempt-new', now);
  const before = JSON.stringify(task);
  assert.equal(acceptTerminalReceipt(db, owner, old, now)?.disposition, 'supplemental');
  assert.equal(JSON.stringify(task), before); assert.match(db.messages[0].content, /较早一轮/);
  assert.equal(acceptTerminalReceipt(db, owner, old, now)?.disposition, 'duplicate');
});

test('one attempt cannot overwrite its first committed terminal through a second receipt ID', () => {
  const { db, task } = fixture(); const first = receipt({ outcome: 'failed', finalResponse: '真实工具失败', error: 'exit 1' });
  acceptTerminalReceipt(db, owner, first, now);
  assert.equal(acceptTerminalReceipt(db, owner, receipt({ receiptId: 'new-receipt-id' }), now)?.disposition, 'supplemental');
  assert.equal(task.status, 'failed'); assert.equal(task.finalResponse, '真实工具失败');
  assert.equal(task.terminalReceipt.id, first.receiptId);
});

test('same Key cannot inject across workspace, user, device, installation or unissued attempt', () => {
  for (const patch of [{ workspaceId: 'workspace-b' }, { userId: 'user-b' }, { deviceId: 'device-b' },
    { installationId: 'b'.repeat(32) }, { taskId: 'task-b' }, { attemptId: 'unissued' }, { round: 9 }]) {
    const { db, task } = fixture(); const before = JSON.stringify(db);
    assert.equal(acceptTerminalReceipt(db, owner, receipt(patch), now), undefined);
    assert.equal(task.status, 'running'); assert.equal(JSON.stringify(db), before);
  }
});

test('revocation, disabled user or membership, and disabled workspace reject without ACK', () => {
  for (const revoke of [(db: any) => { db.oneKeyDevices[0].status = 'revoked'; },
    (db: any) => { db.users[0].enabled = false; }, (db: any) => { db.workspaces[0].status = 'disabled'; },
    (db: any) => { db.workspaceMembers[0].status = 'disabled'; }]) {
    const { db } = fixture(); revoke(db);
    assert.equal(acceptTerminalReceipt(db, owner, receipt(), now), undefined);
    assert.equal(db.messages.length, 0);
  }
});

test('no returned answer never becomes goal success despite completed process outcome', () => {
  for (const finalResponse of ['', '   ', 'Codex 本轮已结束，请查看执行结果']) {
    const { db, task } = fixture(); acceptTerminalReceipt(db, owner, receipt({ finalResponse }), now);
    assert.equal(task.status, 'failed'); assert.match(task.lastError, /没有返回可确认/);
  }
});

test('recovered launcher reservation does not pretend the orphan process stopped or permit rerun', () => {
  const { db, task } = fixture(); task.status = 'failed';
  task.transportInterruption = { attemptId: 'attempt-a', round: 1, at: now, reason: 'socket_close' };
  const value = receipt({ outcome: 'failed', error: 'launcher_interrupted', finalResponse: '没有重新执行。原操作情况需要核对。' });
  assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'accepted');
  assert.equal(task.status, 'failed'); assert.equal(task.executionSafetyHold, 'launcher_interrupted');
  assert.equal(executionDeliveryPending(task), true); assert.match(task.lastError, /是否仍在运行尚未确认/);
  assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'duplicate');
});

test('a final answer with unconfirmed commands is preserved but never completed or automatically dispatched again', () => {
  for (const outcome of ['failed', 'completed'] as const) {
    const { db, task } = fixture();
    const actual = '已输出 QA_CANCEL_B_STARTED，指定命令正在授权目录内等待 sleep 180。';
    const value = receipt({ outcome, error: 'command_unconfirmed', finalResponse: actual });
    assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'accepted');
    assert.equal(task.status, 'failed'); assert.equal(task.finalResponse, actual);
    assert.equal(task.executionSafetyHold, 'command_unconfirmed'); assert.equal(executionDeliveryPending(task), true);
    assert.match(task.lastError, /工具没有确认结束/);
    assert.throws(() => assertLocalExecutionAvailable(db, owner), /上一轮/);
    assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'duplicate');
    assert.equal(task.executionSafetyHold, 'command_unconfirmed');
    const later = receipt({ receiptId: 'later-result-after-unknown', finalResponse: 'late completed' });
    assert.equal(acceptTerminalReceipt(db, owner, later, now)?.disposition, 'supplemental');
    assert.equal(task.status, 'failed'); assert.equal(task.finalResponse, actual);
    assert.equal(task.executionSafetyHold, 'command_unconfirmed'); assert.equal(executionDeliveryPending(task), true);
  }
});

test('cancellation plus an unconfirmed command stays cancelled and blocked while preserving the actual reply', () => {
  const { db, task } = fixture(); task.status = 'cancelled'; task.lastError = '停止请求已提交';
  task.transportInterruption = { attemptId: 'attempt-a', round: 1, at: now, reason: 'cancellation_pending' };
  const actual = '命令仍没有确认结束，已产生的修改不会自动撤销。';
  const value = receipt({ outcome: 'cancelled', error: 'command_unconfirmed', finalResponse: actual });
  assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'supplemental');
  assert.equal(task.status, 'cancelled'); assert.equal(task.executionSafetyHold, 'command_unconfirmed');
  assert.equal(executionDeliveryPending(task), true); assert.match(task.lastError, /已收到停止请求/);
  assert.match(db.messages[0].content, new RegExp(actual));
  assert.throws(() => assertLocalExecutionAvailable(db, owner));
  assert.equal(acceptTerminalReceipt(db, owner, value, now)?.disposition, 'duplicate');
  assert.equal(task.executionSafetyHold, 'command_unconfirmed');
});

test('old-round or foreign command warnings cannot set a hold on the current owned attempt', () => {
  const { db, task } = fixture(); const old = receipt({ error: 'command_unconfirmed', outcome: 'failed' });
  task.reportRound = 2; recordExecutionAttempt(db, task, 'attempt-new', now);
  const before = JSON.stringify(task);
  assert.equal(acceptTerminalReceipt(db, owner, old, now)?.disposition, 'supplemental');
  assert.equal(JSON.stringify(task), before); assert.equal(task.executionSafetyHold, undefined);
  const foreign = receipt({ userId: 'foreign-user', error: 'command_unconfirmed', outcome: 'failed' });
  assert.equal(acceptTerminalReceipt(db, owner, foreign, now), undefined);
  assert.equal(JSON.stringify(task), before);
});
