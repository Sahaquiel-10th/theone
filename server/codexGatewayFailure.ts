import { safeProviderReason } from './modelGateway.js';
import type { ExecutionTask } from './types.js';

/** Reviewed diagnostics only. Neither model output nor a launcher-supplied
 * error string can create one of these server-owned failure facts. */
export function codexGatewayFailureMessage(code: string): string | undefined {
  const http = /^ONE_CODEX_UPSTREAM_HTTP_([45][0-9]{2})$/.exec(code);
  if (http) return `喵，本机任务卡在模型调用：${safeProviderReason(undefined, Number(http[1]))}。已有进度会保留，不会自动重复执行；请联系管理员核对模型连接。`;
  const reasons: Record<string, string> = {
    ONE_CODEX_UPSTREAM_PROTOCOL: '模型返回格式不兼容，请联系管理员核对模型接口。',
    ONE_CODEX_UPSTREAM_RESPONSE_FAILED: '模型没有完成这一步，请稍后再试或联系管理员核对模型服务。',
    ONE_CODEX_UPSTREAM_INCOMPLETE: '模型回复中断了，没有拿到完整结果。请稍后再试；继续时会先核对已有进度。',
    ONE_CODEX_UPSTREAM_CONNECTION_FAILED: '暂时连不上模型服务，请稍后再试或联系管理员检查连接。',
    ONE_CODEX_POWER_INSUFFICIENT: '可用电力不足，请到“会员与额度”补充额度后再继续。',
    ONE_CODEX_POWER_ACCOUNT_MISSING: '电力账户暂时不可用，请联系管理员检查账户。',
    ONE_CODEX_BUDGET_UNAVAILABLE: '这次任务的预算授权需要核对，请确认可用预算后再继续。',
    ONE_CODEX_BILLING_REVIEW: '有一笔模型用量需要核对，请联系管理员处理后再继续。',
    ONE_CODEX_BILLING_SETTLEMENT: '模型用量结算没有完成，请联系管理员核对；不要重复提交这一步。',
  };
  return reasons[code] && `喵，本机任务卡在模型调用：${reasons[code]}已有进度会保留，不会自动重复执行。`;
}

export function currentCodexGatewayFailure(task: ExecutionTask) {
  const failure = task.executorFailure;
  if (task.provider !== 'codex' || task.status !== 'failed' || !failure || task.executionSafetyHold || task.transportInterruption
    || failure.round !== (task.reportRound ?? 0) || task.deliveryAttempt?.round !== failure.round
    || task.deliveryAttempt.id !== failure.attemptId) return undefined;
  return codexGatewayFailureMessage(failure.code);
}
