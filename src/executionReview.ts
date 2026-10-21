import {executionExplicitlyUnfinished} from '../server/executionResultState';
/** A normal executor exit with a retained answer, but at least one failed tool.
 * This is not proof of goal completion and must never change terminal state. */
export function executionNeedsReview(task: {status: string; finalResponse?: string; lastError?: string} | null | undefined): boolean {
  const answer = task?.finalResponse?.trim();
  if(task?.status==='completed'&&executionExplicitlyUnfinished(answer))return true;
  const appServerWarning = '\n\n本轮有工具未能完成，请查看工具反馈；不会自动重跑。';
  if(task?.status==='failed' && task.lastError==='execution_unconfirmed' && answer?.endsWith(appServerWarning)
    && answer.length>appServerWarning.length)return true;
  return task?.status === 'failed' && Boolean(answer) && [
    '本轮有工具执行失败，完成情况需检查，不会自动重跑。',
    // app-server launcher wording; retain failure, but distinguish a settled
    // turn with warnings from a lost/unknown execution receipt.
    '本轮有工具未能完成，请查看工具反馈；不会自动重跑。',
  ].some(warning => task.lastError?.trim() === `${answer}\n\n${warning}`);
}
