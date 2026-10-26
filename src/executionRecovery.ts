import {executionNeedsReview} from './executionReview';

export type RecoverableExecution = {
  id: string;
  status: string;
  lastError?: string;
  finalResponse?: string;
  resultDeliveryPending?: boolean;
  requiresExecutionCheck?: boolean;
  reportRound?: number;
};

export const executionResumeInstruction = '请先核对本轮目标和已经产生的文件，只继续原任务未完成的部分，不要重复已有修改。沿用这件事原来的工作文件夹，不读取无关文件；若原文件已存在，先核对实际内容，不擅自覆盖、删除或另建重复项目。';

/** Presentation is not permission: the server rechecks device, owner and round. */
export function executionCanContinue(task?: RecoverableExecution | null) {
  return Boolean(task && ['completed','failed','cancelled'].includes(task.status)
    && !task.resultDeliveryPending && !task.requiresExecutionCheck);
}

function readableReason(reason?: string) {
  const text = reason?.trim();
  if (!text || /^[A-Za-z0-9_.:-]+$/.test(text)) return '';
  return text;
}

export function executionRecovery(task?: RecoverableExecution | null) {
  if (!task || !['completed','failed','cancelled'].includes(task.status)) return undefined;
  if (task.requiresExecutionCheck) return {
    title: '本机操作的结束情况还需要确认',
    message: readableReason(task.lastError) || '本机程序此前中断，原操作是否结束还没确认。请保持 ONE Key 连接并检查本轮文件和操作记录；确认前不会再次改动文件。',
    canContinue: false,
  };
  if (task.resultDeliveryPending) return {
    title: task.status === 'cancelled' ? '已请求停止，正在等本机确认' : '正在接收本机结果',
    message: task.status === 'cancelled'
      ? '停止请求已经发出，但还没收到电脑的结束反馈。请保持 ONE Key 连接；确认结束前不会重复启动。'
      : '电脑连接曾中断，正在等原结果补回。请保持 ONE Key 连接，不需要重新提交。',
    canContinue: false,
  };
  if (task.status === 'completed' && !executionNeedsReview(task)) return undefined;
  return {
    title: task.status === 'cancelled' ? '这轮本机操作已停止' : '这轮还有部分没做好',
    message: `${readableReason(task.lastError) || (task.status === 'cancelled'
      ? '本轮已经结束，已产生的文件会保留，不会自动撤销。'
      : '本轮没有完整做成，原要求和已有文件都保留。')} 可以继续这件事，先核对已有结果，再做未完成部分。`,
    canContinue: true,
  };
}

/** A follow-up stays on the selected execution, never on a global/latest task. */
export function executionContinuationRequest(task: RecoverableExecution, operationId: string, content: string) {
  if (!executionCanContinue(task) || !content.trim()) return undefined;
  return {
    path: `/api/executions/${encodeURIComponent(task.id)}/messages`,
    body: {content: content.trim(), operationId},
  };
}

/** Stop the exact round the person saw, not a later round in another tab. */
export function executionCancellationRequest(task: RecoverableExecution) {
  const expectedRound = task.reportRound ?? 0;
  if (!Number.isSafeInteger(expectedRound) || expectedRound < 0) return undefined;
  return {path: `/api/executions/${encodeURIComponent(task.id)}/cancel`, body: {expectedRound}};
}

type HandoffExecution = RecoverableExecution & {
  conversationId: string;
  sourceMessageId: string;
  createdAt: string;
};

/** Recovery is anchored to the latest saved handoff. A diagnostic arriving
 * late can update an older execution, but cannot make it the current task. */
export function executionForHandoff<T extends HandoffExecution>(tasks: T[], conversationId: string, inputMessageId?: string) {
  if (!inputMessageId) return null;
  const active = new Set(['queued','selecting_target','running']);
  return tasks.filter(task=>task.conversationId===conversationId&&task.sourceMessageId===inputMessageId)
    .sort((a,b)=>Number(active.has(b.status))-Number(active.has(a.status))
      || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0] ?? null;
}
