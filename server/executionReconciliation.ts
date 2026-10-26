import {createHash} from 'node:crypto';
import type {Database} from './types.js';
import {executionDeliveryPending, executionTerminal, type ExecutionDeviceScope} from './executionService.js';

/** Support-only input. This is an explicit manual acknowledgement, not a
 * runtime receipt or evidence that a goal was completed. No HTTP API is
 * registered here. Call only within the authenticated owner's store mutation
 * after separately verifying the original process and obtaining approval. */
export type ExecutionReconciliationInput = ExecutionDeviceScope & {
  taskId: string;
  attemptId: string;
  round: number;
  expectedUpdatedAt: string;
  reason: string;
};

export class ExecutionReconciliationError extends Error {
  readonly code = 'EXECUTION_RECONCILIATION_REJECTED';
}

function reject(message: string): never {throw new ExecutionReconciliationError(message);}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (item: {workspaceId: string; userId: string}, input: ExecutionDeviceScope) =>
  item.workspaceId === input.workspaceId && item.userId === input.userId;

/** Clear only a precisely acknowledged old checkpoint. It never invokes the
 * executor, alters files, creates a terminal receipt, changes an outcome to
 * success, or edits conversation/result history. */
export function reconcileStoppedExecution(database: Database, actorUserId: string,
  input: ExecutionReconciliationInput, timestamp = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || ![input.workspaceId, input.userId, input.deviceId, input.taskId, input.attemptId].every(validId)
    || typeof input.installationId !== 'string' || !/^[a-f0-9]{32}$/i.test(input.installationId)
    || !Number.isSafeInteger(input.round) || input.round < 0
    || typeof input.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedUpdatedAt))
    || !Number.isFinite(Date.parse(timestamp))
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000)
    reject('人工结束记录不完整，请重新核对原任务与处理原因。');
  if (actorUserId !== input.userId) reject('只能由原账号确认结束自己的本机操作。');
  const user = database.users.find(user => user.id === input.userId && user.enabled);
  const workspace = database.workspaces.find(workspace => workspace.id === input.workspaceId && workspace.status === 'active');
  const member = database.workspaceMembers.find(member => own(member, input) && member.status !== 'disabled');
  const device = database.oneKeyDevices.find(device => device.id === input.deviceId && own(device, input) && device.status === 'active');
  if (!user || !workspace || !member || !device) reject('原账号、本机连接或个人空间不可用，未解除等待。');
  const task = database.executionTasks.find(task => task.id === input.taskId && own(task, input)
    && task.deviceId === input.deviceId && task.installationId === input.installationId);
  if (!task || task.status !== 'cancelled' || (task.reportRound ?? 0) !== input.round
    || task.deliveryAttempt?.id !== input.attemptId || task.deliveryAttempt.round !== input.round)
    reject('原任务、设备或轮次已变化，未解除等待。');
  if (database.executionTasks.some(other => other !== task && own(other, input)
    && other.conversationId === task.conversationId && !executionTerminal(other.status)))
    reject('这件事还有正在执行的本机操作，未解除等待。');

  const reason = input.reason.trim();
  const binding = [input.workspaceId, input.userId, input.deviceId, input.installationId,
    input.taskId, input.attemptId, input.round, input.expectedUpdatedAt];
  const auditId = `execution_manual_${digest(binding)}`;
  const requestHash = digest([...binding, reason]);
  const existing = database.auditLogs?.find(log => log.id === auditId);
  if (existing) {
    // Idempotency never clears a fresh warning, a new round, or a changed
    // request. It only acknowledges this exact already-recorded reduction.
    if (existing.action !== 'execution.manual_reconciliation' || existing.workspaceId !== input.workspaceId
      || existing.actorUserId !== actorUserId || existing.targetId !== input.taskId
      || existing.details?.requestHash !== requestHash || existing.details?.reconciledAt !== task.updatedAt
      || executionDeliveryPending(task)) reject('原处理记录或任务状态已变化，请重新核对。');
    return {taskId: task.id, round: input.round, status: 'cancelled' as const, manual: true as const,
      auditId, duplicate: true};
  }
  if (task.updatedAt !== input.expectedUpdatedAt || !executionDeliveryPending(task))
    reject('任务状态已变化或无需解除等待，请重新核对。');
  if (task.transportInterruption && (task.transportInterruption.attemptId !== input.attemptId
    || task.transportInterruption.round !== input.round)) reject('等待记录不属于当前这轮，未解除等待。');

  const oldCheckpoint = {
    status: task.status, updatedAt: task.updatedAt,
    ...(task.transportInterruption ? {transportInterruption: structuredClone(task.transportInterruption)} : {}),
    ...(task.executionSafetyHold ? {executionSafetyHold: task.executionSafetyHold} : {}),
    ...(task.terminalReceipt ? {terminalReceipt: structuredClone(task.terminalReceipt)} : {}),
  };
  // Preserve the actual failure/cancellation, result and every original
  // receipt. The audit explicitly records the removed private checkpoint.
  task.transportInterruption = undefined;
  task.executionSafetyHold = undefined;
  task.lastError = '原账号已人工核对并结束这轮操作；不代表原任务已经完成。已有修改和结果保留，不会自动重新执行。';
  task.updatedAt = timestamp;
  database.auditLogs ??= [];
  database.auditLogs.push({id: auditId, workspaceId: input.workspaceId, actorUserId,
    action: 'execution.manual_reconciliation', targetType: 'execution_task', targetId: task.id,
    details: {manual: true, claimsSuccess: false, deviceId: input.deviceId, installationId: input.installationId,
      attemptId: input.attemptId, round: input.round, expectedUpdatedAt: input.expectedUpdatedAt,
      requestHash, reason, oldCheckpoint, reconciledAt: timestamp}, createdAt: timestamp});
  return {taskId: task.id, round: input.round, status: 'cancelled' as const, manual: true as const,
    auditId, duplicate: false};
}
