import type { Attachment, AttachmentSummary, Conversation, Database, ExecutionTask, Message } from './types.js';
import type { ChatOperation } from './chatOperations.js';
import { createHash } from 'node:crypto';
import { localExecutionResultId } from './executionService.js';
import { executionExplicitlyUnfinished } from './executionResultState.js';

export type TaskResultScope = { workspaceId: string; userId: string };
export type TaskResultOutcome = 'completed' | 'returned' | 'failed' | 'partial' | 'needs_input' | 'cancelled' | 'interrupted';
export type TaskResultReceipt = {
  /** Stable per-result identity; local executions include their round. */
  id: string; sourceId: string; source: 'cloud' | 'local'; taskId: string; title: string;
  outcome: TaskResultOutcome; state: TaskResultOutcome; summary: string; createdAt: string;
  resultMessageId?: string; imageUrl?: string; attachments: AttachmentSummary[];
  location?: string; notionUrl?: string; round?: number; reported: boolean; reviewed: boolean;
};
export type TaskResultLimits = { count?: number; summaryChars?: number; totalChars?: number };
/** One user-facing update per task; attempt/round history remains in storage. */
export function latestTaskResults(results: TaskResultReceipt[]) {
  const latest = new Map<string, TaskResultReceipt>();
  for (const result of results) {
    const previous = latest.get(result.taskId);
    if (!previous || result.createdAt >= previous.createdAt) latest.set(result.taskId, result);
  }
  return [...latest.values()];
}
/** Only successful, unseen latest outcomes may accompany an unrelated reply.
 * Failed/uncertain work remains on its note and is available to explicit reads. */
export function automaticTaskResults(results: TaskResultReceipt[]) {
  return latestTaskResults(results).filter(result => !result.reported && !result.reviewed
    && (result.outcome === 'completed' || result.outcome === 'returned'));
}
/** Server-internal snapshot, never accepted from a browser. Old local rounds require durable message evidence. */
export type TaskResultCapture = TaskResultScope & { result: TaskResultReceipt;
  localEvidence?: { messageId: string; createdAt: string; contentHash: string } };

export class TaskResultInboxError extends Error {
  constructor(message: string, readonly status = 403) { super(message); this.name = 'TaskResultInboxError'; }
}

const own = (record: TaskResultScope, scope: TaskResultScope) => record.workspaceId === scope.workspaceId && record.userId === scope.userId;
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const clip = (text: string | undefined, max: number) => (text ?? '').trim().slice(0, max);
function authorize(db: Database, scope: TaskResultScope) {
  if (!db.users.some(user => user.id === scope.userId && user.enabled)
    || !db.workspaces.some(workspace => workspace.id === scope.workspaceId && workspace.status === 'active')
    || !db.workspaceMembers.some(member => own(member, scope) && member.status !== 'disabled'))
    throw new TaskResultInboxError('账号或个人空间不可用');
}
function ownedTask(db: Database, scope: TaskResultScope, id: string | undefined) {
  return db.conversations.find(c => own(c, scope) && c.id === id && !c.coordinatorMain && !c.archived);
}
function marker(db: Database, scope: TaskResultScope, id: string) {
  return db.chatOperations?.find(o => own(o, scope) && o.id === `notice_${id}` && o.status === 'completed');
}
function publicFile(file: Attachment): AttachmentSummary {
  const { id, originalName, mimeType, kind, size, status } = file;
  return { id, originalName, mimeType, kind, size, status, ...(file.welcomeGuide ? { welcomeGuide: true } : {}),...(file.visualDocument?{visualDocument:true}:{}) };
}
function ownedFiles(db: Database, scope: TaskResultScope, task: Conversation, message: Message | undefined) {
  return (message?.attachments ?? []).flatMap(summary => {
    const file = db.attachments.find(a => own(a, scope) && a.id === summary.id
      && (a.conversationId === task.id || a.sharedConversationIds?.includes(task.id)));
    return file ? [publicFile(file)] : [];
  });
}
function cloudResult(db: Database, scope: TaskResultScope, operation: ChatOperation, max: number): TaskResultReceipt | undefined {
  const run = operation.workRun, task = ownedTask(db, scope, operation.conversationId);
  if (!run || !task || !terminal.has(run.state)) return;
  const result = task.messages.find(message => message.id === run.resultMessageId && message.role === 'assistant');
  const attachments = ownedFiles(db, scope, task, result);
  const imageFile = db.attachments.find(file => own(file, scope) && file.kind === 'image'
    && result?.imageUrl === `/api/attachments/${file.id}/content`
    && (file.conversationId === task.id || file.sharedConversationIds?.includes(task.id)));
  const imageUrl = imageFile ? `/api/attachments/${imageFile.id}/content` : undefined;
  const guideFile = run.welcomeGuide && attachments.find(summary => db.attachments.some(file => own(file, scope)
    && file.id === summary.id && file.kind === 'image' && file.status === 'ready' && file.welcomeGuide));
  if (imageFile && !attachments.some(a => a.id === imageFile.id)) attachments.push(publicFile(imageFile));
  let outcome: TaskResultOutcome = run.state === 'completed' ? (run.resultOutcome ?? 'returned')
    : run.state === 'failed' && (run.resultOutcome === 'partial' || run.resultOutcome === 'needs_input') ? run.resultOutcome
    : run.state as TaskResultOutcome;
  let summary = clip([run.userReport||run.error, result?.content].filter(Boolean).join('\n'), max);
  if (run.kind === 'image' && run.state === 'completed') {
    outcome = imageUrl || guideFile ? 'completed' : 'failed';
    if (!imageUrl && !guideFile) summary = '绘图任务没有返回可确认的图片，尚未完成。请查看本轮反馈，不会自动重做。';
  } else if (run.state === 'completed' && run.notionReceipt?.state === 'verified') {
    outcome = 'completed';
  } else if (run.state === 'completed' && !result?.content.trim() && !attachments.length) {
    outcome = 'needs_input';
    summary = '任务已结束，但没有可确认的结果。请查看过程，不会自动重做。';
  }
  if (!summary) summary = outcome === 'cancelled' ? '本轮已停止，已产生的修改不会自动撤销。' : '未取得可确认的结果，请查看本轮反馈。';
  return { id: operation.id, sourceId: operation.id, source: 'cloud', taskId: task.id, title: clip(task.title, 120),
    outcome, state: outcome, summary, createdAt: operation.updatedAt, resultMessageId: run.resultMessageId,
    imageUrl, attachments, notionUrl: run.notionReceipt?.state === 'verified' ? run.notionReceipt.url : undefined,
    reported: Boolean(run.reportedToCoordinatorAt || marker(db, scope, operation.id)), reviewed: run.unread !== true };
}
function localResult(db: Database, scope: TaskResultScope, execution: ExecutionTask, max: number): TaskResultReceipt | undefined {
  const task = ownedTask(db, scope, execution.conversationId);
  if (!task || !terminal.has(execution.status)) return;
  const round = execution.reportRound ?? 0;
  const receiptId = execution.terminalReceipt?.round === round
    ? execution.terminalReceipt.receiptMessageId ?? `execution_receipt_${execution.id}_${round}`
    : `execution_receipt_${execution.id}_${round}`;
  const id = localExecutionResultId(execution.id, round, receiptId);
  const persisted = db.messages.find(m => own(m, scope) && m.conversationId === task.id && m.id === receiptId);
  const answer = execution.finalResponse?.trim() ?? '', error = execution.lastError?.trim() ?? '';
  const result = answer && error.startsWith(answer) ? error : error && answer.startsWith(error) ? answer : [error, answer].filter(Boolean).join('\n');
  let outcome: TaskResultOutcome = execution.status === 'completed' ? (answer ? 'returned' : 'needs_input')
    : execution.status as TaskResultOutcome;
  // A normal process exit is not proof of goal completion. Preserve the full
  // receipt, but don't promote an executor's explicit non-completion to success.
  if (outcome === 'returned' && executionExplicitlyUnfinished(answer)) outcome = 'needs_input';
  const reported = Boolean(marker(db, scope, id) || (execution.reportedToCoordinatorAt
    && (execution.reportedRound === round || execution.reportedRound === undefined && round === 0)));
  const summary = persisted?.content || result || '没有可确认的执行结果，请查看本轮过程。';
  return { id, sourceId: execution.id, source: 'local', taskId: task.id, title: clip(task.title, 120), outcome, state: outcome,
    summary: clip(outcome === 'cancelled' ? `本轮已停止，已产生的修改不会自动撤销。\n${summary}` : summary, max),
    createdAt: execution.terminalReceipt?.round === round ? execution.terminalReceipt.receivedAt : execution.completedAt ?? execution.updatedAt,
    resultMessageId: persisted?.id, attachments: [],
    location: clip(execution.targetName, 500) || undefined, round, reported, reviewed: execution.noticeReadRound === round };
}
function allResults(db: Database, scope: TaskResultScope, max: number) {
  authorize(db, scope);
  return [...(db.chatOperations ?? []).filter(o => own(o, scope)).flatMap(o => cloudResult(db, scope, o, max) ?? []),
    ...(db.executionTasks ?? []).filter(t => own(t, scope)).flatMap(t => localResult(db, scope, t, max) ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function bounded(results: TaskResultReceipt[], limits: TaskResultLimits) {
  const count = Math.max(1, Math.min(limits.count ?? 6, 50));
  let chars = Math.max(100, Math.min(limits.totalChars ?? 6000, 30_000));
  const chosen: TaskResultReceipt[] = [];
  for (const result of results.slice(0, count)) {
    if (chars < 1) break;
    const summary = result.summary.slice(0, chars);
    chosen.push({ ...result, summary }); chars -= summary.length;
  }
  return chosen;
}
/** Read on the server before a dispatcher call. Returned content is evidence, never instructions or new authority. */
export function pendingTaskResults(db: Database, scope: TaskResultScope, limits: TaskResultLimits = {}) {
  return bounded(allResults(db, scope, Math.max(100, Math.min(limits.summaryChars ?? 1200, 6000))).filter(r => !r.reported), limits);
}
export function pendingConversationTaskResults(db: Database, scope: TaskResultScope, limits: TaskResultLimits = {}) {
  return bounded(automaticTaskResults(allResults(db, scope, Math.max(100, Math.min(limits.summaryChars ?? 1200, 6000)))), limits);
}
/** The review badge persists after a result was reported in the main conversation. */
export function unreviewedTaskResults(db: Database, scope: TaskResultScope, limits: TaskResultLimits = {}) {
  return bounded(allResults(db, scope, Math.max(100, Math.min(limits.summaryChars ?? 1200, 6000))).filter(r => !r.reviewed), limits);
}

export function captureTaskResults(db: Database, scope: TaskResultScope, ids: string[]): TaskResultCapture[] {
  const wanted = new Set(ids);
  return allResults(db, scope, 1200).filter(result => wanted.has(result.id) && !result.reported).map(result => {
    const persisted = result.source === 'local' && result.resultMessageId
      ? db.messages.find(message => own(message, scope) && message.conversationId === result.taskId && message.role === 'assistant' && message.id === result.resultMessageId) : undefined;
    return { ...scope, result: structuredClone(result), ...(persisted ? { localEvidence: { messageId: persisted.id,
      createdAt: persisted.createdAt, contentHash: createHash('sha256').update(persisted.content).digest('hex') } } : {}) };
  });
}

/** Validate captured evidence against owned storage. A restarted execution cannot erase an already-read old receipt. */
export function capturedTaskResultsForReport(db: Database, scope: TaskResultScope, captures: TaskResultCapture[]) {
  const current = new Map(allResults(db, scope, 1200).map(result => [result.id, result]));
  return captures.flatMap(capture => {
    if (!own(capture, scope)) return [];
    const result = capture.result, latest = current.get(result.id);
    if (latest && latest.source === result.source && latest.sourceId === result.sourceId && latest.taskId === result.taskId
      && latest.round === result.round) return latest.reported ? [] : [latest];
    if (result.source !== 'local' || !Number.isInteger(result.round) || result.round! < 0 || result.imageUrl || result.attachments.length) return [];
    const task = db.executionTasks.find(task => own(task, scope) && task.id === result.sourceId && task.conversationId === result.taskId);
    const expectedMessage = result.resultMessageId;
    const prefix = `execution_receipt_${result.sourceId}_${result.round}`;
    const validMessage = expectedMessage === prefix || Boolean(expectedMessage?.startsWith(`${prefix}_recovery_`)
      && /^[a-f0-9]{24}$/.test(expectedMessage.slice(`${prefix}_recovery_`.length)));
    const evidence = capture.localEvidence;
    if (!task || (task.reportRound ?? 0) < result.round! || !validMessage
      || result.id !== localExecutionResultId(result.sourceId, result.round!, expectedMessage)
      || !evidence || evidence.messageId !== expectedMessage || !ownedTask(db, scope, result.taskId) || marker(db, scope, result.id)) return [];
    const persisted = db.messages.find(message => own(message, scope) && message.conversationId === result.taskId
      && message.id === expectedMessage && message.role === 'assistant');
    if (!persisted || persisted.createdAt !== evidence.createdAt
      || createHash('sha256').update(persisted.content).digest('hex') !== evidence.contentHash
      || result.summary !== persisted.content.trim().slice(0, result.summary.length)) return [];
    return [{ ...result, reported: false, reviewed: task.noticeReadRound === result.round }];
  });
}

/** Exact receipt IDs tied to an owned saved reply, including already-reviewed results. */
export function taskResultIdsReportedInMessage(db: Database, scope: TaskResultScope, messageId: string | undefined) {
  authorize(db, scope);
  if (!messageId || !db.conversations.some(c => own(c, scope) && c.coordinatorMain && !c.archived
    && c.messages.some(m => m.id === messageId && m.role === 'assistant'))) return [];
  const current = allResults(db, scope, 100).filter(result => {
    if (marker(db, scope, result.id)?.assistantMessageId === messageId) return true;
    if (result.source === 'cloud') return db.chatOperations?.find(o => own(o, scope) && o.id === result.sourceId)?.workRun?.reportMessageId === messageId;
    const task = db.executionTasks.find(t => own(t, scope) && t.id === result.sourceId);
    return task?.reportMessageId === messageId && (task.reportedRound === result.round || task.reportedRound === undefined && result.round === 0);
  }).map(result => result.id);
  const historical = (db.chatOperations ?? []).filter(operation => own(operation, scope) && operation.status === 'completed'
    && operation.requestId === 'result_notice' && operation.id.startsWith('notice_') && operation.assistantMessageId === messageId
    && db.conversations.some(main => own(main, scope) && main.coordinatorMain && !main.archived && main.id === operation.conversationId)
    && ownedTask(db, scope, operation.dispatchedTaskId)).map(operation => operation.id.slice('notice_'.length));
  return [...new Set([...current, ...historical])].slice(-10);
}

/** Model-facing feedback omits storage/operation IDs; its immutable IDs stay server-side for reporting. */
export function taskResultConversationContext(results: TaskResultReceipt[]) {
  return results.map(result => ({ title: result.title, outcome: result.outcome,
    summary: result.summary.replace(/^【本机执行回执[^\n]*】\s*\n?/, ''),
    taskUrl: `/?task=${encodeURIComponent(result.taskId)}`, imageUrl: result.imageUrl,
    location: result.location, notionUrl: result.notionUrl,
    attachments: result.attachments.map(file => ({ name: file.originalName, kind: file.kind })) }));
}

/** Call in the same transaction as saving the dispatcher answer. Only the captured result IDs are marked. */
export function markTaskResultsReported(db: Database, scope: TaskResultScope, input: { ids: string[]; assistantMessageId: string; mainConversationId?: string; timestamp?: string; captures?: TaskResultCapture[] }) {
  authorize(db, scope);
  const main = db.conversations.find(c => own(c, scope) && c.coordinatorMain && !c.archived && (!input.mainConversationId || c.id === input.mainConversationId));
  if (!main?.messages.some(m => m.id === input.assistantMessageId && m.role === 'assistant')) throw new TaskResultInboxError('调度回复尚未保存，结果没有被标为已汇报', 409);
  const selected = new Set(input.ids), timestamp = input.timestamp ?? new Date().toISOString();
  const results = [...new Map([...allResults(db, scope, 1200), ...capturedTaskResultsForReport(db, scope, input.captures ?? [])]
    .map(result => [result.id, result])).values()].filter(result => selected.has(result.id) && !result.reported);
  for (const result of results) {
    if (result.source === 'cloud') {
      const run = db.chatOperations!.find(o => own(o, scope) && o.id === result.sourceId)!.workRun!;
      run.reportedToCoordinatorAt = timestamp; run.reportMessageId = input.assistantMessageId;
    } else {
      const task = db.executionTasks.find(t => own(t, scope) && t.id === result.sourceId)!;
      if ((task.reportRound ?? 0) === result.round && localResult(db, scope, task, 1200)?.id === result.id) {
        task.reportedToCoordinatorAt = timestamp; task.reportMessageId = input.assistantMessageId; task.reportedRound = result.round;
      }
    }
    db.chatOperations ??= [];
    db.chatOperations.push({ id: `notice_${result.id}`, ...scope, operationId: `notice_${result.id}`, payloadHash: 'result-reference',
      requestId: 'result_notice', status: 'completed', conversationId: main.id, dispatchedTaskId: result.taskId,
      assistantMessageId: input.assistantMessageId, createdAt: timestamp, updatedAt: timestamp });
    for (const summary of result.attachments) {
      const file = db.attachments.find(a => own(a, scope) && a.id === summary.id);
      if (file) file.sharedConversationIds = [...new Set([...(file.sharedConversationIds ?? []), main.id])];
    }
  }
  return results;
}

const labels: Record<TaskResultOutcome, string> = {
  completed: '已完成', returned: '已返回结果，待你查看', failed: '未完成', partial: '部分结果已返回，需要核对',
  needs_input: '需要你确认', cancelled: '已停止', interrupted: '结果尚未确认',
};
/** Explicit compatibility delivery only. Completion/polling must not call this; pending replies take priority. */
export function appendTaskResultReport(db: Database, scope: TaskResultScope, input: { ids?: string[]; assistantMessageId?: string; content?: string; mainConversationId?: string; timestamp?: string } = {}) {
  authorize(db, scope);
  if (db.chatOperations?.some(o => own(o, scope) && o.status === 'pending' && o.requestId.startsWith('coord_')))
    return { deferred: true, results: [] as TaskResultReceipt[], messageId: undefined };
  const main = db.conversations.find(c => own(c, scope) && c.coordinatorMain && !c.archived && (!input.mainConversationId || c.id === input.mainConversationId));
  if (!main) return { deferred: false, results: [] as TaskResultReceipt[], messageId: undefined };
  const wanted = input.ids ? new Set(input.ids) : undefined;
  const results = pendingTaskResults(db, scope, { count: 50, totalChars: 30_000 }).filter(r => !wanted || wanted.has(r.id)).slice(0, 10);
  if (!results.length) return { deferred: false, results, messageId: undefined };
  const messageId = input.assistantMessageId ?? `report_${results[0].id}`, timestamp = input.timestamp ?? new Date().toISOString();
  if (!main.messages.some(m => m.id === messageId)) {
    const singleImage = results.length === 1 && results[0].imageUrl;
    const message: Message = { id: messageId, role: 'assistant', createdAt: timestamp,
      content: input.content ?? results.map(r => {
        const preview = r.summary.split('\n').filter(line => !/^【本机执行回执/.test(line))
          .map(line => line.replace(/^\s*[#>*-]+\s*/, '').trim()).find(Boolean) ?? '';
        return `${r.title}：${labels[r.outcome]}。${preview ? ` ${preview.slice(0, 140)}${preview.length > 140 ? '…' : ''}` : ''}\n[查看结果](#task:${encodeURIComponent(r.taskId)})${r.imageUrl && !singleImage ? `\n![生成的图片](${r.imageUrl})` : ''}`;
      }).join('\n\n'),
      ...(singleImage ? { imageUrl: results[0].imageUrl, attachments: results[0].attachments }
        : { attachments: results.flatMap(result => result.attachments.filter(file => file.welcomeGuide||file.visualDocument)) }) };
    main.messages.push(message); main.updatedAt = timestamp;
    db.messages.push({ ...message, id: messageId, ...scope, conversationId: main.id, attachmentIds: message.attachments?.map(a => a.id) });
  }
  markTaskResultsReported(db, scope, { ids: results.map(r => r.id), assistantMessageId: messageId, mainConversationId: main.id, timestamp });
  return { deferred: false, results, messageId };
}

/** Viewing the result clears review badges, without pretending ONE already reported it. Validate all IDs before mutation. */
export function acknowledgeTaskResults(db: Database, scope: TaskResultScope, ids: string[], timestamp = new Date().toISOString()) {
  authorize(db, scope);
  const all = allResults(db, scope, 100), selected = new Set(ids);
  if (ids.some(id => !all.some(result => result.id === id))) throw new TaskResultInboxError('结果不存在', 404);
  for (const result of all.filter(r => selected.has(r.id))) {
    if (result.source === 'cloud') {
      const run = db.chatOperations!.find(o => own(o, scope) && o.id === result.sourceId)!.workRun!;
      run.unread = false; run.reviewedAt = timestamp;
    } else {
      const task = db.executionTasks.find(t => own(t, scope) && t.id === result.sourceId)!;
      task.noticeReadRound = result.round;
    }
  }
}

/** Capture all currently visible terminal results in this transaction, never future rounds or running work. */
export function acknowledgeAllTaskResults(db: Database, scope: TaskResultScope, timestamp = new Date().toISOString()) {
  const ids = allResults(db, scope, 100).filter(result => !result.reviewed).map(result => result.id);
  acknowledgeTaskResults(db, scope, ids, timestamp);
  return { ids, count: ids.length };
}
