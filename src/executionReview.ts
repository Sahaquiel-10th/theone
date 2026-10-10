/** A normal executor exit with a retained answer, but at least one failed tool.
 * This is not proof of goal completion and must never change terminal state. */
export function executionNeedsReview(task: {status: string; finalResponse?: string; lastError?: string} | null | undefined): boolean {
  const answer = task?.finalResponse?.trim();
  return task?.status === 'failed' && Boolean(answer) &&
    task.lastError?.trim() === `${answer}\n\n本轮有工具执行失败，完成情况需检查，不会自动重跑。`;
}
