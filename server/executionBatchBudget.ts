import type { ChatOperation } from './chatOperations.js';
import type { Database } from './types.js';

/** Server-saved authorization for one dispatch, shared by cloud work and local execution phases. */
export type ExecutionBatchBudget = { parentOperationId: string; budget: number; startedAt: string };
type Scope = { workspaceId: string; userId: string };
const own = (record: Scope, scope: Scope) => record.workspaceId === scope.workspaceId && record.userId === scope.userId;

export class ExecutionBatchBudgetError extends Error {
  readonly status = 402;
  constructor(message = '本批任务达到已授权预算，已停止新的模型调用；已产生的结果与用量保留。') {
    super(message); this.name = 'ExecutionBatchBudgetError';
  }
}

/** Never infer a batch from a conversation: only its owned, immutable dispatch record is an authority. */
export function workBatchBudget(db: Database, scope: Scope, operation: ChatOperation | undefined): ExecutionBatchBudget | undefined {
  if (!operation?.workRun?.parentOperationId) return;
  const saved = db.chatOperations?.find(o => own(o, scope) && o.id === operation.id && o.requestId === operation.requestId);
  if (!saved?.workRun?.parentOperationId) throw new ExecutionBatchBudgetError('任务预算归属不可用，尚未开始新的模型调用。');
  const parent = db.chatOperations?.find(o => own(o, scope) && o.operationId === saved.workRun!.parentOperationId);
  // Older records without a dispatcher parent remain compatible. They never get
  // mixed into a different batch merely because they used the same project.
  if (!parent) return;
  const budget = saved.workRun.budget;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10 || !Number.isFinite(Date.parse(parent.createdAt)))
    throw new ExecutionBatchBudgetError('任务预算记录不可用，尚未开始新的模型调用。');
  return { parentOperationId: parent.operationId, budget, startedAt: parent.createdAt };
}

function validateSnapshot(db: Database, scope: Scope, snapshot: ExecutionBatchBudget) {
  if (!snapshot || typeof snapshot.parentOperationId !== 'string' || !snapshot.parentOperationId
    || !Number.isFinite(snapshot.budget) || snapshot.budget <= 0 || snapshot.budget > 10
    || typeof snapshot.startedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.startedAt)))
    throw new ExecutionBatchBudgetError('任务预算记录不可用，尚未开始新的模型调用。');
  const parent = db.chatOperations?.find(o => own(o, scope) && o.operationId === snapshot.parentOperationId && o.createdAt === snapshot.startedAt);
  if (!parent) throw new ExecutionBatchBudgetError('任务预算归属已变化，尚未开始新的模型调用。');
  const work = (db.chatOperations ?? []).filter(o => own(o, scope) && o.workRun?.parentOperationId === parent.operationId && Date.parse(o.createdAt) >= Date.parse(snapshot.startedAt));
  if (!work.length || work.some(o => o.workRun!.budget !== snapshot.budget))
    throw new ExecutionBatchBudgetError('任务预算记录已变化，请核对后重新授权。');
  return work;
}

/** Call INSIDE the atomic reservation transaction, before reserving power or creating the usage row. */
export function reserveExecutionBatchBudget(db: Database, scope: Scope, requestId: string, amountMicros: number, explicit?: ExecutionBatchBudget): ExecutionBatchBudget | undefined {
  const operation = db.chatOperations?.find(o => own(o, scope) && o.requestId === requestId && o.workRun);
  const derived = workBatchBudget(db, scope, operation);
  if (derived && explicit && (derived.parentOperationId !== explicit.parentOperationId || derived.startedAt !== explicit.startedAt || derived.budget !== explicit.budget))
    throw new ExecutionBatchBudgetError('模型调用与任务预算归属不一致，尚未开始调用。');
  const snapshot = explicit ?? derived;
  if (!snapshot) return;
  const work = validateSnapshot(db, scope, snapshot), requests = new Set(work.map(o => o.requestId));
  const start = Date.parse(snapshot.startedAt);
  const used = db.modelUsageRecords.filter(row => own(row, scope) && Date.parse(row.createdAt) >= start
    && (requests.has(row.requestId ?? '') || (row.batchBudget?.parentOperationId === snapshot.parentOperationId && row.batchBudget.startedAt === snapshot.startedAt)))
    .reduce((total, row) => total + (row.chargedMicros ?? 0) + (row.reservedMicros ?? 0), 0);
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || used + amountMicros > Math.floor(snapshot.budget * 1e6))
    throw new ExecutionBatchBudgetError();
  return structuredClone(snapshot);
}
