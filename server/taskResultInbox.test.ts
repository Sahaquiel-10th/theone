import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment, Conversation, Database, ExecutionTask } from './types.js';
import type { ChatOperation } from './chatOperations.js';
import type { WorkRun } from './coordinatorTypes.js';
import { CoordinatorService } from './coordinatorService.js';
import { acknowledgeTaskResults, appendTaskResultReport, markTaskResultsReported, pendingTaskResults, unreviewedTaskResults } from './taskResultInbox.js';

const a = { workspaceId: 'wa', userId: 'a' }, b = { workspaceId: 'wb', userId: 'b' };
const timestamp = '2026-10-14T01:00:00.000Z';
function conversation(id: string, scope = a, main = false): Conversation {
  return { ...scope, id, modelId: 'worker', title: id, coordinatorMain: main, archived: false, messages: [], createdAt: timestamp, updatedAt: timestamp };
}
function fixture() {
  return { users: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }],
    workspaceMembers: [{ ...a }, { ...b }], conversations: [conversation('main-a', a, true), conversation('main-b', b, true)],
    chatOperations: [], executionTasks: [], messages: [], attachments: [], settings: {} } as unknown as Database;
}
function cloud(db: Database, id: string, scope = a, input: { state?: WorkRun['state']; text?: string; outcome?: WorkRun['resultOutcome']; kind?: 'image' } = {}) {
  const task = conversation(`task-${id}`, scope), resultMessageId = `result-${id}`;
  if (input.text !== undefined) task.messages.push({ id: resultMessageId, role: 'assistant', content: input.text, createdAt: timestamp });
  db.conversations.push(task);
  const operation = { ...scope, id, conversationId: task.id, operationId: `operation_${id}`, requestId: `work_${id}`, payloadHash: id, status: 'completed', createdAt: timestamp, updatedAt: timestamp,
    workRun: { state: input.state ?? 'completed', kind: input.kind, inputMessageId: 'input', instruction: 'do not leak full handoff', resultMessageId,
      resultOutcome: input.outcome, unread: true } } as ChatOperation;
  db.chatOperations!.push(operation);
  return { task, operation };
}
function local(db: Database, id: string, scope = a): ExecutionTask {
  db.conversations.push(conversation(`task-${id}`, scope));
  const task: ExecutionTask = { ...scope, id, conversationId: `task-${id}`, sourceMessageId: 'input', provider: 'codex', status: 'completed',
    instruction: 'private compiled instructions', deviceId: 'private-key', finalResponse: '创建了 /QA/result.md，回读内容匹配', targetName: '/QA', createdAt: timestamp, updatedAt: timestamp };
  db.executionTasks.push(task); return task;
}

test('durable grouped delivery survives refresh and reports once without clearing user review', () => {
  const db = fixture(); cloud(db, 'one', a, { text: '合作方案实际正文' }); local(db, 'two'); cloud(db, 'foreign', b, { text: 'other workspace secret' });
  const pending = pendingTaskResults(db, a);
  assert.deepEqual(pending.map(r => r.id), ['one', 'two']);
  assert.equal(pending[0].outcome, 'returned', 'model answer alone is not proof of the deliverable');
  const report = appendTaskResultReport(db, a, { ids: pending.map(r => r.id) });
  assert.equal(report.deferred, false); assert.equal(report.results.length, 2);
  const main = db.conversations.find(c => c.id === 'main-a')!;
  assert.equal(main.messages.length, 1); assert.match(main.messages[0].content, /合作方案实际正文/); assert.match(main.messages[0].content, /\/QA\/result.md/);
  assert.doesNotMatch(main.messages[0].content, /other workspace secret|private compiled|private-key/);
  assert.deepEqual(db.chatOperations!.filter(o => o.requestId === 'result_notice').map(o => o.assistantMessageId), [main.messages[0].id, main.messages[0].id]);
  const refreshed = JSON.parse(JSON.stringify(db)) as Database;
  assert.equal(pendingTaskResults(refreshed, a).length, 0);
  assert.equal(appendTaskResultReport(refreshed, a).results.length, 0);
  assert.equal(refreshed.conversations.find(c => c.id === 'main-a')!.messages.length, 1);
  assert.equal(unreviewedTaskResults(refreshed, a).length, 2);
  assert.ok(unreviewedTaskResults(refreshed, a).every(r => r.reported));
  assert.equal(refreshed.chatOperations!.find(o => o.id === 'one')!.workRun!.unread, true);
  acknowledgeTaskResults(refreshed, a, ['one']); assert.deepEqual(unreviewedTaskResults(refreshed, a).map(r => r.id), ['two']);
  assert.equal(pendingTaskResults(refreshed, b).length, 1);
});

test('viewing an owned result is independent of dispatcher reporting and rejects all foreign IDs atomically', () => {
  const db = fixture(); const { operation } = cloud(db, 'own', a, { text: 'own result' }); cloud(db, 'foreign', b, { text: 'secret' });
  assert.throws(() => acknowledgeTaskResults(db, a, ['own', 'foreign']), /不存在/);
  assert.equal(operation.workRun!.unread, true);
  acknowledgeTaskResults(db, a, ['own']);
  assert.equal(unreviewedTaskResults(db, a).length, 0); assert.equal(pendingTaskResults(db, a).length, 1);
  assert.equal(operation.workRun!.reportedToCoordinatorAt, undefined);
  db.workspaceMembers[0].status = 'disabled';
  assert.throws(() => pendingTaskResults(db, a), /不可用/);
});

test('legacy notice markers suppress old result replay without crossing scope', () => {
  const db = fixture(); const own = cloud(db, 'already-shown', a, { text: 'old answer' }); const fresh = cloud(db, 'fresh', a, { text: 'new answer' });
  own.operation.workRun!.unread = false;
  db.chatOperations!.push({ ...a, id: 'notice_already-shown', operationId: 'notice_already-shown', requestId: 'result_notice', status: 'completed', payloadHash: '', createdAt: timestamp, updatedAt: timestamp });
  db.chatOperations!.push({ ...b, id: 'notice_fresh', operationId: 'notice_fresh', requestId: 'result_notice', status: 'completed', payloadHash: '', createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual(pendingTaskResults(db, a).map(r => r.id), ['fresh']);
  appendTaskResultReport(db, a);
  assert.ok(fresh.operation.workRun!.reportedToCoordinatorAt); assert.equal(unreviewedTaskResults(db, a).length, 1);
});

test('pending dispatcher reply defers automatic reports and explicit snapshot marks never swallow new results', () => {
  const db = fixture(); cloud(db, 'before', a, { text: 'first result' });
  const snapshot = pendingTaskResults(db, a);
  db.chatOperations!.push({ ...a, id: 'pending-router', operationId: 'pending-router', requestId: 'coord_wait', status: 'pending', payloadHash: '', createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual(appendTaskResultReport(db, a), { deferred: true, results: [], messageId: undefined });
  assert.equal(db.conversations.find(c => c.id === 'main-a')!.messages.length, 0);
  assert.throws(() => markTaskResultsReported(db, a, { ids: snapshot.map(r => r.id), assistantMessageId: 'answer' }), /尚未保存/);
  cloud(db, 'after', a, { text: 'later result' });
  db.conversations.find(c => c.id === 'main-a')!.messages.push({ id: 'answer', role: 'assistant', content: 'Respond to user and mention first result', createdAt: timestamp });
  markTaskResultsReported(db, a, { ids: snapshot.map(r => r.id), assistantMessageId: 'answer' });
  assert.deepEqual(pendingTaskResults(db, a).map(r => r.id), ['after']);
  markTaskResultsReported(db, a, { ids: snapshot.map(r => r.id), assistantMessageId: 'answer' });
  assert.equal(db.chatOperations!.filter(o => o.id === 'notice_before').length, 1);
});

test('local review and reports are per round and old snapshots cannot acknowledge a later round', () => {
  const db = fixture(), task = local(db, 'same-task');
  const initial = pendingTaskResults(db, a);
  appendTaskResultReport(db, a); acknowledgeTaskResults(db, a, initial.map(r => r.id));
  assert.equal(task.reportedRound, 0); assert.equal(task.noticeReadRound, 0);
  task.reportRound = 1; task.finalResponse = '第二轮改了标题并回读';
  assert.deepEqual(pendingTaskResults(db, a).map(r => r.id), ['same-task_1']);
  assert.deepEqual(unreviewedTaskResults(db, a).map(r => r.id), ['same-task_1']);
  markTaskResultsReported(db, a, { ids: initial.map(r => r.id), assistantMessageId: db.conversations.find(c => c.id === 'main-a')!.messages[0].id! });
  assert.equal(pendingTaskResults(db, a).length, 1);
  assert.throws(() => acknowledgeTaskResults(db, a, initial.map(r => r.id)), /不存在/);
  appendTaskResultReport(db, a); assert.equal(pendingTaskResults(db, a).length, 0); assert.equal(task.reportedRound, 1);
});

test('image completion requires actual owned private image and report shares access only to owned main chat', () => {
  const db = fixture(), { task, operation } = cloud(db, 'image', a, { text: 'cannot draw here', kind: 'image' });
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'failed');
  assert.match(pendingTaskResults(db, a)[0].summary, /没有返回可确认的图片/);
  const image: Attachment = { ...a, id: 'own-image', conversationId: task.id, originalName: 'result.png', mimeType: 'image/png', kind: 'image', size: 25, storagePath: '/private/not-for-api', extractedText: '', createdAt: timestamp };
  db.attachments.push(image);
  task.messages[0].imageUrl = '/api/attachments/own-image/content'; task.messages[0].attachments = [{ id: image.id, kind: image.kind, originalName: image.originalName, mimeType: image.mimeType, size: image.size }];
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'completed');
  const report = appendTaskResultReport(db, a);
  assert.equal(db.conversations.find(c => c.id === 'main-a')!.messages[0].imageUrl, '/api/attachments/own-image/content');
  assert.deepEqual(image.sharedConversationIds, ['main-a']); assert.equal(operation.workRun!.unread, true);
  assert.doesNotMatch(JSON.stringify(report), /private\/not-for-api/);
  const other = cloud(db, 'foreign-image', a, { text: 'image', kind: 'image' });
  db.attachments.push({ ...image, ...b, id: 'other-image', conversationId: other.task.id });
  other.task.messages[0].imageUrl = '/api/attachments/other-image/content';
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'failed');
});

test('failed partial, no-result and needs-input receipts remain truthful and bounded', () => {
  const db = fixture(); const failed = cloud(db, 'failed', a, { state: 'failed', text: '部分正文', outcome: 'partial' });
  failed.operation.workRun!.resultOutcome = 'partial';
  cloud(db, 'empty', a); cloud(db, 'needs-input', a, { text: '请确认标题', outcome: 'needs_input' });
  cloud(db, 'long', a, { text: 'long result '.repeat(1000), outcome: 'completed' });
  const localFailed = local(db, 'local-partial'); localFailed.status = 'failed'; localFailed.lastError = '写入第二个文件失败';
  const outcomes = new Map(pendingTaskResults(db, a).map(r => [r.id, r.outcome]));
  assert.equal(outcomes.get('failed'), 'partial'); assert.equal(outcomes.get('empty'), 'needs_input');
  assert.equal(outcomes.get('needs-input'), 'needs_input'); assert.equal(outcomes.get('local-partial'), 'partial');
  assert.equal(outcomes.get('long'), 'completed');
  const bounded = pendingTaskResults(db, a, { count: 2, summaryChars: 100, totalChars: 150 });
  assert.equal(bounded.length, 2); assert.ok(bounded.reduce((n, r) => n + r.summary.length, 0) <= 150);
  assert.equal(db.chatOperations!.find(o => o.id === 'long')!.workRun!.reportedToCoordinatorAt, undefined);
});

function service(db: Database) {
  return new CoordinatorService({ read: async () => db, mutate: async fn => fn(db) },
    { recallWithDiagnostics: async () => ({ chunks: [], failures: [], status: 'no_match' }) });
}
test('coordinator snapshot keeps reported but unreviewed results, correct badge count and all batch links', async () => {
  const db = fixture(), own = cloud(db, 'one', a, { text: '第一任务结果' }), second = cloud(db, 'two', a, { text: '第二任务结果' });
  cloud(db, 'other', b, { text: 'foreign secret' });
  db.chatOperations!.push({ ...a, id: 'batch-accept', operationId: 'batch-accept', payloadHash: '', requestId: 'coord_batch', status: 'completed',
    assistantMessageId: 'accepted', conversationId: 'main-a', dispatchedTaskId: own.task.id, dispatchedTaskIds: [own.task.id, second.task.id, 'foreign-task'], createdAt: timestamp, updatedAt: timestamp });
  const coordinator = service(db);
  assert.equal((await coordinator.state(a)).notices.length, 2);
  await coordinator.report(a, ['one', 'two'], async () => {});
  const state = await coordinator.state(a);
  assert.equal(state.notices.length, 2); assert.ok(state.notices.every(n => n.reported && !n.read));
  assert.ok(state.tasks.every(t => t.unreadCount === 1));
  assert.deepEqual(state.links.filter(l => l.messageId === 'accepted').map(l => l.taskId).sort(), [own.task.id, second.task.id].sort());
  await coordinator.acknowledge(a, ['one']);
  assert.deepEqual((await coordinator.state(a)).notices.map(n => n.id), ['two']);
  await coordinator.report(b, ['two'], async () => {});
  assert.equal(db.conversations.find(c => c.id === 'main-b')!.messages.length, 0);
});
test('coordinator report defers for active reply and task transfers survive pagination with local and dependencies', async () => {
  const db = fixture(); cloud(db, 'result', a, { text: '实际结果' });
  const dependency = cloud(db, 'dependency', a, { state: 'running' }), waiting = cloud(db, 'waiting', a, { state: 'queued' });
  waiting.operation.workRun!.dependsOnOperationIds = [dependency.operation.operationId];
  const prepared = cloud(db, 'prepared', a, { state: 'prepared' });
  const execution = local(db, 'local'); execution.status = 'selecting_target';
  db.chatOperations!.push({ ...a, id: 'router', operationId: 'router', requestId: 'coord_wait', payloadHash: '', status: 'pending', createdAt: timestamp, updatedAt: timestamp });
  const coordinator = service(db), report = await coordinator.report(a, ['result'], async () => {});
  assert.equal(report.deferred, true); assert.equal(pendingTaskResults(db, a).length, 1);
  const state = await coordinator.state(a, 2);
  assert.equal(state.tasks.length, 0); assert.equal(state.transfers.length, 4);
  assert.equal(state.transfers.find(t => t.id === waiting.task.id)!.state, 'waiting');
  assert.equal(state.transfers.find(t => t.id === prepared.task.id)!.localPrepared, true);
  assert.equal(state.transfers.find(t => t.id === execution.conversationId)!.queued, 1);
});

test('an earlier local round finishing after a new prepared requirement cannot hide its pending execution card', async () => {
  const db = fixture(), { task, operation } = cloud(db, 'followup', a, { state: 'prepared' });
  operation.workRun!.inputMessageId = 'new-requirement';
  const oldExecution: ExecutionTask = { ...a, id: 'earlier-local-round', conversationId: task.id, sourceMessageId: 'old-requirement',
    provider: 'codex', status: 'completed', instruction: 'prior task', deviceId: 'fixture-key', finalResponse: '上一轮实际结果',
    createdAt: '2026-10-14T00:59:00.000Z', updatedAt: '2026-10-14T01:01:00.000Z' };
  db.executionTasks.push(oldExecution);
  const coordinator = service(db);
  let state = await coordinator.state(a);
  assert.equal(state.transfers.find(t => t.id === task.id)?.state, 'prepared_local');
  assert.equal(state.transfers.find(t => t.id === task.id)?.localPrepared, true);
  await coordinator.report(a, [oldExecution.id], async () => {});
  await coordinator.acknowledge(a, [oldExecution.id]);
  state = await coordinator.state(a);
  assert.equal(state.notices.length, 0);
  assert.equal(state.transfers.find(t => t.id === task.id)?.state, 'prepared_local', 'a reported and viewed earlier result does not consume the next requirement');
  db.executionTasks.push({ ...oldExecution, id: 'accepted-new-local', sourceMessageId: 'new-requirement', status: 'queued' });
  state = await coordinator.state(a);
  assert.equal(state.transfers.find(t => t.id === task.id)?.localPrepared, false);
  assert.equal(state.transfers.find(t => t.id === task.id)?.queued, 1);
});
