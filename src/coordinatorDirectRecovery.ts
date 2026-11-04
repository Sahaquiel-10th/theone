type DirectSubmissionScope = {
  userId: string;
  workspaceId: string;
  taskId: string;
  operationId: string;
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** An authenticated task detail can prove acceptance, not successful execution.
 * Parent IDs are supplied by the server; never infer them from child prefixes. */
export function coordinatorDirectSubmissionAccepted(detail: unknown, expected: DirectSubmissionScope): boolean {
  if (!Object.values(expected).every(value => typeof value === 'string' && value.length > 0)
    || !record(detail) || !record(detail.conversation) || !Array.isArray(detail.jobs)) return false;
  const owner = detail.conversation;
  if (owner.id !== expected.taskId || owner.userId !== expected.userId || owner.workspaceId !== expected.workspaceId) return false;
  return detail.jobs.some(job => record(job)
    && (job.operationId === expected.operationId || job.submissionOperationId === expected.operationId));
}
