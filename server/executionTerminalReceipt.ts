import { createHash } from 'node:crypto';
import type { Database, ExecutionTask, Message } from './types.js';
import { appendExecutionEvent, executionTerminal, saveExecutionReceipt } from './executionService.js';

export const terminalReceiptCapability = 'execution_terminal_receipt_v1';
export const maxTerminalReceiptBytes = 512 * 1024;
export type TerminalOutcome = 'completed' | 'failed' | 'cancelled';
export type TerminalReceipt = {
  type: 'execution_terminal_receipt'; schemaVersion: 1; receiptId: string; receiptHash: string;
  attemptId: string; workspaceId: string; userId: string; deviceId: string; installationId: string;
  taskId: string; round: number; outcome: TerminalOutcome; finalResponse: string;
  error?: string; targetName?: string; providerThreadId?: string; occurredAt?: string;
};
export type TerminalAck = {
  type: 'execution_terminal_ack'; accepted: true; receiptId: string; receiptHash: string;
  attemptId: string; workspaceId: string; userId: string; deviceId: string; installationId: string;
  taskId: string; round: number; disposition: 'accepted' | 'duplicate' | 'supplemental' | 'superseded';
};
export type TerminalOwner = Pick<TerminalReceipt, 'deviceId' | 'installationId' | 'workspaceId' | 'userId'>;

// This framing is shared with Swift: decimal UTF-8 byte count, colon, bytes.
// No JSON escaping, newline normalization or trimming participates in the hash.
export function terminalReceiptHash(receipt: Omit<TerminalReceipt, 'receiptHash'> | TerminalReceipt) {
  const hash = createHash('sha256');
  for (const field of ['one-terminal-receipt-v1', receipt.receiptId, receipt.attemptId,
    receipt.workspaceId, receipt.userId, receipt.deviceId, receipt.installationId,
    receipt.taskId, String(receipt.round), receipt.outcome, receipt.finalResponse,
    receipt.error ?? '', receipt.targetName ?? '', receipt.providerThreadId ?? '', receipt.occurredAt ?? '']) {
    const bytes = Buffer.from(field, 'utf8');
    hash.update(String(bytes.length)); hash.update(':'); hash.update(bytes);
  }
  return hash.digest('hex');
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export function parseTerminalReceipt(value: unknown): TerminalReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (v.type !== 'execution_terminal_receipt' || v.schemaVersion !== 1
    || !['receiptId', 'attemptId', 'workspaceId', 'userId', 'deviceId', 'taskId'].every(key => validId(v[key]))
    || typeof v.installationId !== 'string' || !/^[a-f0-9]{32}$/i.test(v.installationId)
    || typeof v.receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.receiptHash)
    || !Number.isSafeInteger(v.round) || (v.round as number) < 0
    || !['completed', 'failed', 'cancelled'].includes(v.outcome as string)
    || typeof v.finalResponse !== 'string') return;
  for (const [key, limit] of [['error', 20_000], ['targetName', 4096], ['providerThreadId', 1024], ['occurredAt', 100]] as const) {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || Buffer.byteLength(v[key] as string, 'utf8') > limit)) return;
  }
  if (v.occurredAt !== undefined && !Number.isFinite(Date.parse(v.occurredAt as string))) return;
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > maxTerminalReceiptBytes) return;
  const receipt = v as unknown as TerminalReceipt;
  if (terminalReceiptHash(receipt) !== receipt.receiptHash) return;
  return receipt;
}

export function recordExecutionAttempt(database: Database, task: ExecutionTask, attemptId: string, timestamp: string) {
  task.deliveryAttempt = { id: attemptId, round: task.reportRound ?? 0, issuedAt: timestamp };
  database.auditLogs ??= [];
  if (!database.auditLogs.some(log => log.id === `execution_attempt_${attemptId}`)) database.auditLogs.push({
    id: `execution_attempt_${attemptId}`, workspaceId: task.workspaceId, actorUserId: task.userId,
    action: 'execution.delivery.attempt', targetType: 'execution_task', targetId: task.id,
    details: { deviceId: task.deviceId, installationId: task.installationId, round: task.reportRound ?? 0 }, createdAt: timestamp
  });
}

function issuedAttempt(database: Database, task: ExecutionTask, receipt: TerminalReceipt) {
  return database.auditLogs?.some(log => log.id === `execution_attempt_${receipt.attemptId}`
    && log.action === 'execution.delivery.attempt' && log.targetId === task.id
    && log.workspaceId === task.workspaceId && log.actorUserId === task.userId
    && log.details?.deviceId === receipt.deviceId && log.details?.installationId === receipt.installationId
    && log.details?.round === receipt.round);
}

function supplement(database: Database, task: ExecutionTask, receipt: TerminalReceipt, timestamp: string, currentRound: boolean) {
  const conversation = database.conversations?.find(c => c.id === task.conversationId
    && c.workspaceId === task.workspaceId && c.userId === task.userId);
  if (!conversation) return;
  const id = `execution_receipt_${task.id}_${receipt.round}_recovery_${receipt.receiptHash.slice(0, 24)}`;
  if (conversation.messages?.some(m => m.id === id)) return id;
  const explanation = !currentRound ? '这是较早一轮补回的执行结果，当前一轮保持不变。'
    : task.status === 'cancelled' ? '任务仍保持已取消；下面只是执行器补回的结果，已产生的修改不会自动撤销。'
    : task.status === 'completed' ? '连接恢复后，已补回本轮真实回答；是否达到目标请以验证证据为准。'
    : '连接恢复后，已补回执行器说明；本轮仍未完成或需要核对，不会自动重跑。';
  const body = [receipt.error?.trim(), receipt.finalResponse.trim()].filter(Boolean).join('\n');
  const message: Message = { id, role: 'assistant', createdAt: timestamp,
    content: `【本机执行回执 · ${task.provider} · 第 ${receipt.round + 1} 轮 · ${task.id}】\n${explanation}\n${receipt.targetName ? `工作位置：${receipt.targetName}\n` : ''}${body || '没有可确认的最终回答。'}` };
  conversation.messages ??= []; conversation.messages.push(message); conversation.updatedAt = timestamp;
  database.messages ??= [];
  database.messages.push({ ...message, id, conversationId: conversation.id, workspaceId: task.workspaceId, userId: task.userId });
  return id;
}

/** Called only within a durable store mutation after signed socket authentication. */
export function acceptTerminalReceipt(database: Database, owner: TerminalOwner, receipt: TerminalReceipt,
  timestamp = new Date().toISOString()): TerminalAck | undefined {
  if (!parseTerminalReceipt(receipt)) return;
  if (Object.entries(owner).some(([key, value]) => receipt[key as keyof TerminalOwner] !== value)) return;
  const device = database.oneKeyDevices.find(d => d.id === owner.deviceId && d.status === 'active'
    && d.workspaceId === owner.workspaceId && d.userId === owner.userId);
  const user = database.users.find(u => u.id === owner.userId && u.enabled);
  const workspace = database.workspaces.find(w => w.id === owner.workspaceId && w.status === 'active');
  const member = database.workspaceMembers.find(m => m.workspaceId === owner.workspaceId
    && m.userId === owner.userId && m.status !== 'disabled');
  const task = database.executionTasks.find(t => t.id === receipt.taskId && t.workspaceId === owner.workspaceId
    && t.userId === owner.userId && t.deviceId === owner.deviceId && t.installationId === owner.installationId);
  if (!device || !user || !workspace || !member || !task || !issuedAttempt(database, task, receipt)) return;
  database.auditLogs ??= [];
  const auditId = `execution_terminal_${createHash('sha256').update(JSON.stringify([owner.workspaceId,
    owner.userId, owner.deviceId, owner.installationId, receipt.receiptId])).digest('hex')}`;
  const existing = database.auditLogs.find(log => log.id === auditId);
  const ack = (disposition: TerminalAck['disposition']): TerminalAck => ({
    type: 'execution_terminal_ack', accepted: true, receiptId: receipt.receiptId, receiptHash: receipt.receiptHash,
    attemptId: receipt.attemptId, ...owner, taskId: receipt.taskId, round: receipt.round, disposition
  });
  if (existing) return existing.details?.receiptHash === receipt.receiptHash ? ack('duplicate') : undefined;
  const currentRound = (task.reportRound ?? 0) === receipt.round && task.deliveryAttempt?.id === receipt.attemptId
    && task.deliveryAttempt.round === receipt.round;
  const firstForAttempt = !database.auditLogs.some(log => log.action === 'execution.delivery.terminal'
    && log.targetId === task.id && log.workspaceId === owner.workspaceId && log.actorUserId === owner.userId
    && log.details?.attemptId === receipt.attemptId && log.details?.round === receipt.round);
  const interrupted = task.transportInterruption?.attemptId === receipt.attemptId && task.transportInterruption.round === receipt.round;
  const canApply = currentRound && firstForAttempt && task.status !== 'cancelled'
    && (!executionTerminal(task.status) || task.status === 'failed' && interrupted);
  const oldReceipt = database.messages?.some(m => m.id === `execution_receipt_${task.id}_${receipt.round}`
    && m.workspaceId === owner.workspaceId && m.userId === owner.userId);
  const disposition: TerminalAck['disposition'] = canApply ? 'accepted' : receipt.finalResponse.trim() || receipt.error?.trim() ? 'supplemental' : 'superseded';
  const safetyHold = receipt.error === 'launcher_interrupted' ? 'launcher_interrupted'
    : receipt.error === 'command_unconfirmed' ? 'command_unconfirmed' : undefined;
  if (currentRound && firstForAttempt && safetyHold) {
    // A restarted launcher cannot prove that its old child has stopped. Do not
    // turn a recovered reservation marker into authority to run again.
    task.executionSafetyHold = safetyHold;
    if (safetyHold === 'command_unconfirmed') task.lastError = task.status === 'cancelled'
      ? '已收到停止请求，但仍有工具没有确认结束。请先核对本机文件，不要重复操作；不会自动重跑。'
      : '这轮还有工具没有确认结束，暂时不能算完成。请先核对本机文件，不要重复操作；不会自动重跑。';
  }
  if (canApply) {
    const meaningful = receipt.finalResponse.trim() && !/^Codex 本轮已结束/.test(receipt.finalResponse.trim());
    task.status = receipt.outcome === 'cancelled' ? 'cancelled'
      : safetyHold || receipt.outcome === 'completed' && !meaningful ? 'failed' : receipt.outcome;
    task.finalResponse = receipt.finalResponse || undefined;
    task.lastError = task.status === 'completed' ? undefined : receipt.error || (task.status === 'cancelled'
      ? '执行已取消；已产生的修改不会自动撤销。' : '执行器已退出，但没有返回可确认的结果。不会自动重跑。');
    if (receipt.error === 'launcher_interrupted') task.lastError = 'ONE 本机程序此前中断，原操作是否仍在运行尚未确认。请先核对本机文件与进程，不会自动重跑。';
    if (receipt.error === 'command_unconfirmed') task.lastError = task.status === 'cancelled'
      ? '已收到停止请求，但仍有工具没有确认结束。请先核对本机文件，不要重复操作；不会自动重跑。'
      : '这轮还有工具没有确认结束，暂时不能算完成。请先核对本机文件，不要重复操作；不会自动重跑。';
    if (receipt.targetName) task.targetName = receipt.targetName;
    if (receipt.providerThreadId) task.providerThreadId = receipt.providerThreadId;
    task.updatedAt = task.completedAt = timestamp;
    task.terminalReceipt = { id: receipt.receiptId, hash: receipt.receiptHash, attemptId: receipt.attemptId,
      round: receipt.round, outcome: receipt.outcome, receivedAt: timestamp, disposition: 'accepted' };
    task.transportInterruption = undefined;
    if (interrupted) {
      task.reportedRound = undefined; task.reportedToCoordinatorAt = undefined; task.reportMessageId = undefined;
      task.noticeReadRound = undefined;
    }
    appendExecutionEvent(database, { id: `exe_terminal_${receipt.receiptHash}`, workspaceId: task.workspaceId,
      userId: task.userId, taskId: task.id, round: receipt.round, kind: task.status === 'failed' ? 'error' : 'message',
      text: receipt.finalResponse || receipt.error || '执行器本轮已结束，没有可确认的回答。', createdAt: timestamp });
    if (oldReceipt) task.terminalReceipt.receiptMessageId = supplement(database, task, receipt, timestamp, true);
    else { saveExecutionReceipt(database, task); task.terminalReceipt.receiptMessageId = `execution_receipt_${task.id}_${receipt.round}`; }
  } else if (disposition === 'supplemental') {
    const receiptMessageId = supplement(database, task, receipt, timestamp, currentRound);
    if (currentRound && firstForAttempt) {
      // A late terminal settles delivery, not an unknown child process. Keep
      // cancellation, genuine tool failure and any safety hold authoritative.
      task.terminalReceipt = { id: receipt.receiptId, hash: receipt.receiptHash, attemptId: receipt.attemptId,
        round: receipt.round, outcome: receipt.outcome, receivedAt: timestamp, disposition: 'supplemental', receiptMessageId };
      task.updatedAt = timestamp;
      task.transportInterruption = undefined;
      task.reportedRound = undefined; task.reportedToCoordinatorAt = undefined; task.reportMessageId = undefined;
      task.noticeReadRound = undefined;
    }
  } else if (currentRound && firstForAttempt) {
    task.terminalReceipt = { id: receipt.receiptId, hash: receipt.receiptHash, attemptId: receipt.attemptId,
      round: receipt.round, outcome: receipt.outcome, receivedAt: timestamp, disposition: 'supplemental' };
    task.updatedAt = timestamp;
    task.transportInterruption = undefined;
  }
  database.auditLogs.push({ id: auditId, workspaceId: owner.workspaceId, actorUserId: owner.userId,
    action: 'execution.delivery.terminal', targetType: 'execution_task', targetId: task.id,
    details: { receiptId: receipt.receiptId, receiptHash: receipt.receiptHash, attemptId: receipt.attemptId,
      deviceId: owner.deviceId, installationId: owner.installationId, round: receipt.round,
      outcome: receipt.outcome, disposition }, createdAt: timestamp });
  return ack(disposition);
}
