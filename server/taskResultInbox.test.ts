import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment, Conversation, Database, ExecutionTask } from './types.js';
import type { ChatOperation } from './chatOperations.js';
import type { WorkRun } from './coordinatorTypes.js';
import { CoordinatorService } from './coordinatorService.js';
import { acknowledgeTaskResults, acknowledgeAllTaskResults, appendTaskResultReport, markTaskResultsReported, pendingTaskResults, unreviewedTaskResults, taskResultIdsReportedInMessage, taskResultConversationContext, captureTaskResults, capturedTaskResultsForReport } from './taskResultInbox.js';
import { saveExecutionReceipt } from './executionService.js';
import {latestTaskResults} from './taskResultInbox.js';

test('one task briefing keeps only its newest result, without erasing history or other owners',()=>{
  const db=fixture();const first=local(db,'first'),last=local(db,'last');last.conversationId=first.conversationId;
  first.updatedAt='2026-10-14T01:00:00Z';last.updatedAt='2026-10-14T02:00:00Z';last.status='cancelled';
  local(db,'foreign',b);const pending=pendingTaskResults(db,a);
  const brief=latestTaskResults(pending);assert.equal(brief.length,1);assert.equal(brief[0].sourceId,'last');assert.equal(brief[0].outcome,'cancelled');
  assert.equal(pending.length,2);assert.equal(pendingTaskResults(db,b).length,1);
});

function recoverReceipt(db: Database, task: ExecutionTask) {
  const id=`execution_receipt_${task.id}_0_recovery_${'a'.repeat(24)}`;
  const message={...a,id,conversationId:task.conversationId,role:'assistant' as const,content:'连接恢复后，已补回本轮真实回答：/QA/result.md 回读正确',createdAt:'2026-10-14T02:00:00.000Z'};
  db.messages.push(message);db.conversations.find(c=>c.id===task.conversationId)!.messages.push(message);
  task.terminalReceipt={id:'receipt',hash:'hash',attemptId:'attempt',round:0,outcome:'completed',disposition:'accepted',receivedAt:message.createdAt,receiptMessageId:id};
  task.status='completed';task.finalResponse=message.content;task.lastError=undefined;task.updatedAt=task.completedAt=message.createdAt;
  task.reportedToCoordinatorAt=task.reportMessageId=undefined;task.reportedRound=task.noticeReadRound=undefined;
  return id;
}

test('recovered answers remain new evidence after the disconnect notice was reported and read',()=>{
  const db=fixture(),task=local(db,'recover');task.status='failed';task.finalResponse=undefined;task.lastError='本机连接中断，结果尚未确认';
  saveExecutionReceipt(db,task);
  const old=pendingTaskResults(db,a)[0];appendTaskResultReport(db,a);acknowledgeTaskResults(db,a,[old.id]);
  const recoveredMessage=recoverReceipt(db,task),fresh=pendingTaskResults(db,a)[0];
  assert.notEqual(fresh.id,old.id);assert.equal(fresh.resultMessageId,recoveredMessage);assert.match(fresh.summary,/回读正确/);
  assert.equal(unreviewedTaskResults(db,a).length,1);assert.equal(pendingTaskResults(db,b).length,0);
  assert.throws(()=>acknowledgeTaskResults(db,a,[old.id]),/不存在/);
  appendTaskResultReport(db,a);assert.equal(pendingTaskResults(db,a).length,0);
  assert.equal(db.messages.filter(m=>m.id===recoveredMessage).length,1);
  acknowledgeTaskResults(db,a,[fresh.id]);assert.equal(unreviewedTaskResults(db,a).length,0);
});

test('a dispatcher reply that saw the old disconnect notice cannot consume a same-round recovered answer',()=>{
  const db=fixture(),task=local(db,'in-flight');task.status='failed';task.finalResponse=undefined;task.lastError='连接中断';saveExecutionReceipt(db,task);
  const old=pendingTaskResults(db,a)[0],captures=captureTaskResults(db,a,[old.id]);
  recoverReceipt(db,task);const fresh=pendingTaskResults(db,a)[0];
  assert.deepEqual(capturedTaskResultsForReport(db,a,captures).map(r=>r.id),[old.id]);
  db.conversations.find(c=>c.id==='main-a')!.messages.push({id:'reply',role:'assistant',content:'我看到这一轮断线了',createdAt:timestamp});
  markTaskResultsReported(db,a,{ids:[old.id],assistantMessageId:'reply',captures});
  assert.equal(task.reportedRound,undefined);assert.equal(task.reportMessageId,undefined);
  assert.deepEqual(pendingTaskResults(db,a).map(r=>r.id),[fresh.id]);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,'reply'),[old.id]);
  const tampered=structuredClone(captures);tampered[0].result.summary='编造结果';
  assert.equal(capturedTaskResultsForReport(db,a,tampered).length,0);
});

test('cancellation remains explicit even when an earlier disconnect receipt exists',()=>{
  const db=fixture(),task=local(db,'cancel-offline');task.status='failed';task.finalResponse=undefined;task.lastError='连接中断';saveExecutionReceipt(db,task);
  task.status='cancelled';task.lastError='停止请求已提交';
  assert.equal(pendingTaskResults(db,a)[0].outcome,'cancelled');assert.match(pendingTaskResults(db,a)[0].summary,/本轮已停止/);
});

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

test('read-all acknowledges every current owned terminal result without reporting or touching running and future rounds', () => {
  const db=fixture();
  for(let i=0;i<55;i++)cloud(db,`own-${i}`,a,{text:`实际成果${i}`});
  const failed=cloud(db,'failed',a,{state:'failed',text:'调用失败'});
  const foreign=cloud(db,'foreign',b,{text:'其他空间成果'});
  const running=cloud(db,'running',a,{state:'running'}),prepared=cloud(db,'prepared',a,{state:'prepared'});
  const execution=local(db,'local-round');
  const result=acknowledgeAllTaskResults(db,a);
  assert.equal(result.count,57);assert.equal(result.ids.length,57);
  assert.equal(unreviewedTaskResults(db,a).length,0);
  assert.equal(failed.operation.workRun!.unread,false);
  assert.equal(foreign.operation.workRun!.unread,true);
  assert.equal(running.operation.workRun!.state,'running');assert.equal(running.operation.workRun!.unread,true);
  assert.equal(prepared.operation.workRun!.state,'prepared');
  assert.equal(db.conversations.find(c=>c.id==='main-a')!.messages.length,0);
  assert.ok(db.chatOperations!.filter(o=>o.workRun).every(o=>!o.workRun!.reportedToCoordinatorAt));
  assert.equal(acknowledgeAllTaskResults(db,a).count,0);
  const refreshed=structuredClone(db);const next=refreshed.executionTasks.find(t=>t.id===execution.id)!;
  next.reportRound=1;next.status='running';
  assert.equal(acknowledgeAllTaskResults(refreshed,a).count,0);assert.equal(next.noticeReadRound,0);
  next.status='completed';next.finalResponse='新一轮回读匹配';
  assert.deepEqual(unreviewedTaskResults(refreshed,a).map(r=>r.id),['local-round_1']);
  cloud(refreshed,'later',a,{text:'之后才完成'});
  assert.deepEqual(unreviewedTaskResults(refreshed,a).map(r=>r.id),['later','local-round_1']);
  refreshed.workspaceMembers[0].status='disabled';assert.throws(()=>acknowledgeAllTaskResults(refreshed,a),/不可用/);
});

test('reported receipt identity remains available for the exact owned answer after user review', () => {
  const db=fixture();cloud(db,'first',a,{text:'真实正文'});const execution=local(db,'local-result');
  const report=appendTaskResultReport(db,a);
  acknowledgeAllTaskResults(db,a);
  assert.equal(unreviewedTaskResults(db,a).length,0);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,report.messageId),['first','local-result']);
  assert.deepEqual(taskResultIdsReportedInMessage(db,b,report.messageId),[]);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,'missing'),[]);
  execution.reportRound=1;execution.finalResponse='第二轮尚未汇报';
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,report.messageId),['first','local-result'],'an exact already-reported old round remains tied to its saved answer');
  assert.equal(pendingTaskResults(db,a)[0].id,'local-result_1');
});

test('friendly result context keeps actual failure and file evidence without quoting internal identifiers', () => {
  const db=fixture();const execution=local(db,'secret-operation');execution.status='failed';execution.lastError='第二个文件写入失败';
  const result=pendingTaskResults(db,a)[0];result.summary='【本机执行回执 · codex · 第 1 轮 · secret-operation】\n第二个文件写入失败；已创建 /QA/result.md';
  const projected=taskResultConversationContext([result]),context=JSON.stringify(projected);
  assert.doesNotMatch(context,/sourceId|resultMessageId/);
  assert.doesNotMatch(projected[0].summary,/secret-operation/);
  assert.match(context,/第二个文件写入失败/);assert.match(context,/\/QA\/result.md/);assert.match(context,/task=/);
  assert.equal(result.id,'secret-operation','source identity remains intact server-side');
});

test('an owned captured old local round reports from immutable evidence without marking the current round', () => {
  const db=fixture(),task=local(db,'same-local'),other=local(db,'foreign-local',b);
  saveExecutionReceipt(db,task);saveExecutionReceipt(db,other);
  const captures=captureTaskResults(db,a,['same-local','foreign-local']);assert.equal(captures.length,1);
  task.reportRound=1;task.status='running';task.finalResponse=undefined;
  assert.deepEqual(capturedTaskResultsForReport(db,a,captures).map(result=>result.id),['same-local']);
  assert.deepEqual(capturedTaskResultsForReport(db,b,captures),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],workspaceId:'wb'}]),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],result:{...captures[0].result,taskId:'task-foreign-local'}}]),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],localEvidence:{...captures[0].localEvidence!,contentHash:'forged'}}]),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],result:{...captures[0].result,summary:'另一件事的秘密'}}]),[]);
  const main=db.conversations.find(c=>c.id==='main-a')!;
  main.messages.push({id:'captured-answer',role:'assistant',content:'上一轮文件的实际结果已返回。',createdAt:timestamp});
  markTaskResultsReported(db,a,{ids:['same-local'],assistantMessageId:'captured-answer',captures});
  assert.equal(db.chatOperations!.filter(o=>o.id==='notice_same-local').length,1);
  assert.equal(task.reportedRound,undefined);assert.equal(task.reportedToCoordinatorAt,undefined);assert.equal(task.reportMessageId,undefined);
  assert.equal(task.status,'running');assert.equal(task.reportRound,1);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,'captured-answer'),['same-local']);
  markTaskResultsReported(db,a,{ids:['same-local'],assistantMessageId:'captured-answer',captures});
  assert.equal(db.chatOperations!.filter(o=>o.id==='notice_same-local').length,1);
  task.status='completed';task.finalResponse='新一轮文件已回读';saveExecutionReceipt(db,task);
  assert.deepEqual(pendingTaskResults(db,a).map(result=>result.id),['same-local_1']);
  assert.deepEqual(unreviewedTaskResults(db,a).map(result=>result.id),['same-local_1']);
  assert.equal(other.reportedToCoordinatorAt,undefined);
});
