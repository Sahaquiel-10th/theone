import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import type { Database, User } from './types.js';
import type { CommerceJob, CommerceSavedProduct, CommerceSavedTemplate } from './commerceTypes.js';
import type { ReviewProfile, ReviewRun } from './reviewReplyTypes.js';
import { uid } from './security.js';

export type IndustryTool = 'product_creative' | 'image_edit' | 'review_reply';
export type IndustryScope = { workspaceId: string; userId: string };
export type IndustryActor = { id: string; workspaceId: string };
export type IndustryUsageSession = IndustryScope & {
  id: string; tool: IndustryTool; requestKey: string; budgetMicros: number;
  createdAt: string; expiresAt: string; keyDeviceId?: string;
};
export type IndustryOperation = IndustryScope & {
  id: string; requestKey: string; tool: IndustryTool; kind: string; usageSessionId: string;
  payloadHash: string; status: 'running' | 'completed' | 'failed' | 'uncertain';
  result?: unknown; error?: string; createdAt: string; updatedAt: string;
};
/** Private user JSON is already transactionally persisted by both ONE stores. */
export type IndustryState = {
  commerceJobs: CommerceJob[]; commerceProducts: CommerceSavedProduct[]; commerceTemplates: CommerceSavedTemplate[];
  reviewReplyProfiles: ReviewProfile[]; reviewReplyRuns: ReviewRun[];
  usageSessions: IndustryUsageSession[]; operations: IndustryOperation[];
};
export type IndustryDatabase = Database & Pick<IndustryState,
  'commerceJobs' | 'commerceProducts' | 'commerceTemplates' | 'reviewReplyProfiles' | 'reviewReplyRuns'>;

export class IndustryError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INDUSTRY_INVALID') { super(message); }
}
export function assertIndustryActor(db: Database, actor: IndustryActor): User {
  const user = db.users.find(u => u.id === actor.id && u.enabled);
  if (!user || !db.workspaces.some(w => w.id === actor.workspaceId && w.status === 'active')
    || !db.workspaceMembers.some(m => m.userId === actor.id && m.workspaceId === actor.workspaceId && m.status !== 'disabled')) {
    throw new IndustryError('账号或空间授权已失效，请重新进入工作台', 403, 'INDUSTRY_ACCESS_REVOKED');
  }
  return user;
}
export function industryScope(actor: IndustryActor): IndustryScope { return { userId: actor.id, workspaceId: actor.workspaceId }; }
export function emptyIndustryState(): IndustryState {
  return { commerceJobs: [], commerceProducts: [], commerceTemplates: [], reviewReplyProfiles: [], reviewReplyRuns: [], usageSessions: [], operations: [] };
}
export function privateIndustryState(db: Database, actor: IndustryActor, create = false): IndustryState | undefined {
  const user = assertIndustryActor(db, actor);
  if (create && !user.industry) user.industry = emptyIndustryState();
  return user.industry;
}
const collections = ['commerceJobs', 'commerceProducts', 'commerceTemplates', 'reviewReplyProfiles', 'reviewReplyRuns'] as const;
type Collection = typeof collections[number];
type OwnedRow = { id: string; workspaceId: string; userId?: string; ownerId?: string };
const rowOwner = (row: OwnedRow) => row.userId ?? row.ownerId;

/** Read-only projection; opening a directory/config never creates user state. */
export function industryDatabase(db: Database): IndustryDatabase {
  const result = { ...db } as IndustryDatabase;
  for (const name of collections) {
    const rows = db.users.flatMap(user => (user.industry?.[name] ?? []) as OwnedRow[])
      .filter(row => typeof row.workspaceId === 'string' && typeof rowOwner(row) === 'string');
    (result as unknown as Record<string, unknown>)[name] = rows;
  }
  return result;
}

/** Business services reuse their collection API without introducing SQL tables. */
export class IndustryStore {
  constructor(readonly base: Store) {}
  async read(): Promise<IndustryDatabase> { return industryDatabase(await this.base.read()); }
  async mutate<T>(fn: (db: IndustryDatabase) => T): Promise<T> {
    return this.base.mutate(db => {
      const view = industryDatabase(db);
      const before = new Map<Collection, Map<string, string>>();
      for (const name of collections) before.set(name, new Map((view[name] as OwnedRow[]).map(row => [row.id, `${row.workspaceId}:${rowOwner(row)}`])));
      const value = fn(view);
      for (const name of collections) {
        const rows = view[name] as OwnedRow[], ids = new Set<string>();
        for (const row of rows) {
          const owner = rowOwner(row), binding = `${row.workspaceId}:${owner}`;
          if (!row.id || ids.has(row.id) || !owner || !db.users.some(u => u.id === owner)
            || !db.workspaces.some(w => w.id === row.workspaceId)
            || (before.get(name)!.has(row.id) && before.get(name)!.get(row.id) !== binding)) {
            throw new IndustryError('工作台记录归属不一致，已停止保存', 409, 'INDUSTRY_BINDING_CONFLICT');
          }
          ids.add(row.id);
        }
        for (const user of db.users) {
          const owned = rows.filter(row => rowOwner(row) === user.id);
          if (!user.industry && !owned.length) continue;
          user.industry ??= emptyIndustryState();
          (user.industry as unknown as Record<string, unknown>)[name] = owned;
        }
      }
      // Domain services may add/remove owned generated assets; all other ONE
      // collections retain their original transaction-owned references.
      db.attachments = view.attachments;
      return value;
    });
  }
}

export const INDUSTRY_CID = 'industry:commerce';
export const validIndustryKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
export function industryUsagePrefix(sessionId: string) { return `industry_${sessionId}_`; }
export function industryUsage(db: Database, scope: IndustryScope, session: IndustryUsageSession) {
  const prefix = industryUsagePrefix(session.id);
  return db.modelUsageRecords.filter(row => row.workspaceId === scope.workspaceId && row.userId === scope.userId && row.requestId?.startsWith(prefix))
    .reduce((sum, row) => sum + (row.chargedMicros ?? 0) + (row.reservedMicros ?? 0), 0);
}
export function assertIndustryBudget(db: Database, scope: IndustryScope, sessionId: string, amountMicros: number, requestId?: string): IndustryUsageSession {
  const state = privateIndustryState(db, { id: scope.userId, workspaceId: scope.workspaceId });
  const session = state?.usageSessions.find(item => item.id === sessionId && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  if (!session || session.expiresAt <= new Date().toISOString()) throw new IndustryError('请先确认本轮工作台的 AI 用量上限', 409, 'INDUSTRY_BUDGET_REQUIRED');
  if (session.keyDeviceId && !db.oneKeyDevices.some(key => key.id === session.keyDeviceId && key.userId === scope.userId && key.workspaceId === scope.workspaceId && key.status === 'active')) {
    throw new IndustryError('本轮授权使用的 ONE Key 已失效，请重新进入并确认用量', 403, 'INDUSTRY_KEY_REVOKED');
  }
  if (requestId !== undefined && !requestId.startsWith(industryUsagePrefix(session.id))) throw new IndustryError('本次用量归属不一致', 409, 'INDUSTRY_BUDGET_MISMATCH');
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || industryUsage(db, scope, session) + amountMicros > session.budgetMicros) {
    throw new IndustryError('本轮工作台用量已接近上限，请核对用量后明确开启新一轮', 402, 'INDUSTRY_BUDGET_EXCEEDED');
  }
  return session;
}
export function createIndustryUsageSession(db: Database, actor: IndustryActor, input: Record<string, unknown>, authorization: { keyDeviceId?: string } = {}) {
  if (input.confirmed !== true || !validIndustryKey(input.requestKey) || !['product_creative', 'image_edit', 'review_reply'].includes(String(input.tool))
    || !Number.isSafeInteger(input.budgetMicros) || Number(input.budgetMicros) < 100_000 || Number(input.budgetMicros) > 10_000_000_000) {
    throw new IndustryError('请确认本轮 AI 用量与电力上限');
  }
  const state = privateIndustryState(db, actor, true)!;
  const old = state.usageSessions.find(item => item.workspaceId === actor.workspaceId && item.userId === actor.id && item.requestKey === input.requestKey);
  if (old) {
    if (old.tool !== input.tool || old.budgetMicros !== input.budgetMicros || old.keyDeviceId !== authorization.keyDeviceId) throw new IndustryError('用量确认内容已变化，请重新确认', 409);
    return old;
  }
  if (state.usageSessions.length >= 2000) throw new IndustryError('工作台用量记录已达上限，请联系管理员', 429);
  const session: IndustryUsageSession = { id: uid('ibus'), ...industryScope(actor), requestKey: input.requestKey,
    tool: input.tool as IndustryTool, budgetMicros: Number(input.budgetMicros), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), keyDeviceId: authorization.keyDeviceId };
  state.usageSessions.push(session);
  return session;
}

type OperationInput = { requestKey: string; tool: IndustryTool; kind: string; usageSessionId: string; payload: unknown };
const runningOperations = new Map<string, Promise<unknown>>();
const operationHash = (input: OperationInput) => createHash('sha256').update(JSON.stringify([input.tool, input.kind, input.usageSessionId, input.payload])).digest('hex');
function ownedOperation(db: Database, actor: IndustryActor, key: string) {
  return privateIndustryState(db, actor)?.operations.find(item => item.workspaceId === actor.workspaceId && item.userId === actor.id && (item.id === key || item.requestKey === key));
}
export function readIndustryOperation(db: Database, actor: IndustryActor, key: string) {
  const item = ownedOperation(db, actor, key);
  if (!item) throw new IndustryError('未找到本次工作台操作', 404, 'INDUSTRY_OPERATION_NOT_FOUND');
  return structuredClone(item);
}

export type IndustryReceipt = {
  requestKey: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'unconfirmed' | 'not_accepted';
  retryAllowed: boolean;
  message: string;
  jobId?: string;
  runId?: string;
  variantId?: string;
};
/** Resolve the original lane, rather than interpreting an auxiliary-table 404 as
 * proof that an accepted image job or review run never existed. No prompts,
 * source material, hashes, credentials or another owner's bindings leave here. */
export function readIndustryReceipt(db: Database, actor: IndustryActor, key: string, input: { tool: unknown; path: unknown }): IndustryReceipt {
  assertIndustryActor(db, actor);
  if (!validIndustryKey(key) || !['product_creative', 'image_edit', 'review_reply'].includes(String(input.tool)) || typeof input.path !== 'string' || input.path.length > 500) throw new IndustryError('请从原操作核对回执', 400, 'INDUSTRY_RECEIPT_INVALID');
  const state = privateIndustryState(db, actor), view = industryDatabase(db);
  const jobs = view.commerceJobs.filter(row => row.workspaceId === actor.workspaceId && row.userId === actor.id);
  const runs = view.reviewReplyRuns.filter(row => row.workspaceId === actor.workspaceId && row.ownerId === actor.id);
  const operations = (state?.operations ?? []).filter(row => row.workspaceId === actor.workspaceId && row.userId === actor.id);
  const anyOwnKey = operations.some(row => row.requestKey === key)
    || jobs.some(row => row.requestKey === key || row.mutations?.some(mutation => mutation.requestKey === key) || row.lastPlanningRetryRequestKey === key || row.variants.some(variant => variant.lastRetryRequestKey === key))
    || runs.some(row => row.requestKey === key || row.mutations.some(mutation => mutation.requestKey === key));
  const receipt = (status: IndustryReceipt['status'], message: string, target: Pick<IndustryReceipt, 'jobId' | 'runId' | 'variantId'> = {}): IndustryReceipt => ({ requestKey: key, status, retryAllowed: ['failed', 'interrupted', 'uncertain', 'not_accepted'].includes(status), message, ...target });
  const unknown = () => receipt('unconfirmed', '找到原操作线索，但尚不能精确核对这一步。请从任务历史查看已有结果，未开启新的付费尝试。');
  const absent = () => anyOwnKey ? unknown() : receipt('not_accepted', '当前账号与空间没有这次操作的接收记录。再次点原操作可沿用原编号；另开操作可能产生新的用量。');
  const wrongTarget = () => { throw new IndustryError('无法核对原任务，请从本工作台历史查看', 404, 'INDUSTRY_RECEIPT_TARGET_UNAVAILABLE'); };
  const commerceStatus = (job: CommerceJob): IndustryReceipt => {
    const target = { jobId: job.id };
    if (['planning', 'queued', 'generating'].includes(job.status)) return receipt('running', '原图片任务正在处理，请查看任务进度，不要另开相同操作。', target);
    if (['review', 'completed'].includes(job.status)) return receipt('completed', '已找到原图片任务与结果。请从任务历史查看，或沿用原编号取回；不会重新生成。', target);
    if (job.status === 'failed' || job.status === 'interrupted') return receipt(job.status, '原任务未完整完成，已付费的图片和资料保留在任务历史。请先核对，再决定是否明确另开。', target);
    return receipt('unconfirmed', '原图片任务已有部分结果。请从任务历史核对并仅处理未完成图片，未开启整批重新执行。', target);
  };
  const path = input.path;
  const aux: Record<string, { tool: IndustryTool; kind: string }> = {
    '/api/commerce/recognize': { tool: 'product_creative', kind: 'recognize' },
    '/api/commerce/reference/recognize': { tool: 'product_creative', kind: 'reference' },
    '/api/commerce/modules/suggest': { tool: 'product_creative', kind: 'module' },
    '/api/commerce/materials/recognize': { tool: 'product_creative', kind: 'materials' },
    '/api/review-replies/analyze': { tool: 'review_reply', kind: 'analyze' },
    '/api/review-replies/recognize': { tool: 'review_reply', kind: 'recognize' },
  };
  const auxiliary = Object.hasOwn(aux, path) ? aux[path] : undefined;
  const proposal = /^\/api\/review-replies\/runs\/([\w-]{1,160})\/propose-rule$/.exec(path);
  if (auxiliary || proposal) {
    const expected = auxiliary ?? { tool: 'review_reply' as const, kind: 'propose_rule' };
    if (input.tool !== expected.tool) throw new IndustryError('操作不属于这个工作台', 400, 'INDUSTRY_RECEIPT_INVALID');
    if (proposal && !runs.some(run => run.id === proposal[1])) return wrongTarget();
    const operation = operations.find(row => row.requestKey === key);
    if (!operation) return absent();
    if (operation.tool !== expected.tool || operation.kind !== expected.kind) return unknown();
    // Historical rule suggestions retain a payload hash, not their runId. A
    // terminal failure cannot be attributed to this supplied run with certainty.
    if (proposal && !['completed', 'running'].includes(operation.status)) return unknown();
    return receipt(operation.status, operation.status === 'completed' ? '已找到原操作结果。再次点击原操作可取回缓存，不会重新生成。' : operation.status === 'running' ? '原操作仍在处理，请保留原编号等待结果。' : '原操作未完整确认，请先核对已保存记录，再决定是否明确另开。');
  }
  if (path === '/api/commerce/jobs' || path === '/api/commerce/edits') {
    const tool = path.endsWith('/edits') ? 'image_edit' : 'product_creative';
    if (input.tool !== tool) throw new IndustryError('操作不属于这个工作台', 400, 'INDUSTRY_RECEIPT_INVALID');
    const job = jobs.find(row => row.requestKey === key && (tool === 'image_edit' ? row.kind === 'image_edit' : row.kind !== 'image_edit' && !row.sourceJobId));
    return job ? commerceStatus(job) : absent();
  }
  const action = /^\/api\/commerce\/jobs\/([\w-]{1,160})\/(generate|retry|derive)$/.exec(path);
  if (action) {
    const parent = jobs.find(row => row.id === action[1]); if (!parent) return wrongTarget();
    if (input.tool !== (parent.kind === 'image_edit' ? 'image_edit' : 'product_creative')) throw new IndustryError('操作不属于这个工作台', 400, 'INDUSTRY_RECEIPT_INVALID');
    if (action[2] === 'derive') {
      const derived = jobs.find(row => row.sourceJobId === parent.id && row.requestKey === key);
      return derived ? commerceStatus(derived) : absent();
    }
    const mutation = parent.mutations?.find(row => row.requestKey === key);
    if (!mutation) return absent();
    if (action[2] === 'retry' && parent.lastPlanningRetryRequestKey === key) return parent.variants.length ? receipt('completed', '原方案重试已形成备选，请查看原任务。', { jobId: parent.id }) : commerceStatus(parent);
    const variant = action[2] === 'retry' ? parent.variants.find(row => row.lastRetryRequestKey === key) : undefined;
    if (variant) {
      const status = variant.status === 'completed' ? 'completed' : variant.status === 'failed' ? 'failed' : 'running';
      return receipt(status, status === 'completed' ? '原图片重试已有结果，请查看原任务。' : status === 'running' ? '原图片重试仍在处理，请等待原任务。' : '原图片重试未完成，已有版本保留在原任务。', { jobId: parent.id, variantId: variant.id });
    }
    // Older mutations store only a hash, not their immutable variant/action.
    // Their existence proves acceptance; current job state cannot prove which
    // later result belongs to this particular request, so never unlock a retry.
    if (['planning', 'queued', 'generating'].includes(parent.status)) return receipt('running', '找到已接收的图片操作，原任务仍在处理，请不要另开。', { jobId: parent.id });
    return { ...unknown(), jobId: parent.id };
  }
  if (path === '/api/review-replies/runs') {
    if (input.tool !== 'review_reply') throw new IndustryError('操作不属于这个工作台', 400, 'INDUSTRY_RECEIPT_INVALID');
    const run = runs.find(row => row.requestKey === key); if (!run) return absent();
    return receipt(run.status === 'generating' ? 'running' : run.status, run.status === 'completed' ? '原评价任务已有回复，请从历史查看；不会重新生成。' : run.status === 'generating' ? '原评价任务仍在处理，请保留原编号等待。' : '原评价任务未完整完成，已有回复与未处理原文保留在历史。', { runId: run.id });
  }
  const refine = /^\/api\/review-replies\/runs\/([\w-]{1,160})\/refine$/.exec(path);
  if (refine) {
    if (input.tool !== 'review_reply') throw new IndustryError('操作不属于这个工作台', 400, 'INDUSTRY_RECEIPT_INVALID');
    const run = runs.find(row => row.id === refine[1]); if (!run) return wrongTarget();
    const mutation = run.mutations.find(row => row.requestKey === key); if (!mutation) return absent();
    return receipt(mutation.status === 'generating' ? 'running' : mutation.status, mutation.status === 'completed' ? '原回复优化已有结果，请查看原回复的版本记录。' : mutation.status === 'generating' ? '原回复优化仍在处理中，请不要另开。' : '原回复优化未完整确认，已有版本保留在任务历史。', { runId: run.id });
  }
  throw new IndustryError('不支持核对此操作回执', 400, 'INDUSTRY_RECEIPT_INVALID');
}
export async function recoverIndustryOperations(store: IndustryStore) {
  await store.base.mutate(db => {
    for (const user of db.users) for (const item of user.industry?.operations ?? []) {
      if (item.status === 'running' && !runningOperations.has(item.id)) {
        item.status = 'uncertain'; item.error = '服务中断后结果尚未确认，原请求已保留；未自动重新执行。'; item.updatedAt = new Date().toISOString();
      }
    }
  });
}
/** Every auxiliary paid action has a durable original receipt and result. */
export async function runIndustryOperation<T>(store: IndustryStore, actor: IndustryActor, input: OperationInput, execute: (operation: IndustryOperation) => Promise<T>): Promise<T> {
  if (!validIndustryKey(input.requestKey)) throw new IndustryError('请重新确认本次工作台操作');
  const hash = operationHash(input);
  const begun = await store.base.mutate(db => {
    const state = privateIndustryState(db, actor, true)!;
    const old = ownedOperation(db, actor, input.requestKey);
    if (old) {
      if (old.payloadHash !== hash) throw new IndustryError('这次操作内容已变化，请重新确认', 409, 'INDUSTRY_OPERATION_CONFLICT');
      return { operation: structuredClone(old), created: false };
    }
    const budget = assertIndustryBudget(db, industryScope(actor), input.usageSessionId, 0);
    if (budget.tool !== input.tool) throw new IndustryError('用量授权不属于这个工具', 409, 'INDUSTRY_BUDGET_MISMATCH');
    if (state.operations.length >= 10000 || state.operations.filter(item => item.workspaceId === actor.workspaceId && item.status === 'running').length >= 4) throw new IndustryError('工作台正在处理其他操作，请稍后继续', 429);
    const operation: IndustryOperation = { id: uid('iop'), ...industryScope(actor), requestKey: input.requestKey,
      tool: input.tool, kind: input.kind, usageSessionId: input.usageSessionId, payloadHash: hash,
      status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.operations.push(operation);
    return { operation: structuredClone(operation), created: true };
  });
  const op = begun.operation;
  if (!begun.created) {
    if (op.status === 'completed') return structuredClone(op.result) as T;
    if (op.status === 'running' && runningOperations.has(op.id)) return runningOperations.get(op.id) as Promise<T>;
    throw new IndustryError(op.error || '原操作结果仍待核对，请查看工作台记录；未重新执行。', 409, op.status === 'failed' ? 'INDUSTRY_OPERATION_FAILED' : 'INDUSTRY_OPERATION_UNCERTAIN');
  }
  const promise = (async () => {
    try {
      const result = await execute(op);
      await store.base.mutate(db => {
        const saved = ownedOperation(db, actor, op.id);
        if (!saved || saved.status !== 'running') throw new IndustryError('原操作状态已变化，请查看保存的记录', 409);
        saved.result = structuredClone(result); saved.status = 'completed'; saved.updatedAt = new Date().toISOString();
      });
      return result;
    } catch (error) {
      await store.base.mutate(db => {
        const user = db.users.find(item => item.id === actor.id);
        const saved = user?.industry?.operations.find(item => item.id === op.id && item.workspaceId === actor.workspaceId && item.userId === actor.id);
        if (saved?.status === 'running') { saved.status = error instanceof IndustryError ? 'failed' : 'uncertain'; saved.error = error instanceof IndustryError ? error.message : '本次结果尚未确认，请核对原记录；未自动重新执行。'; saved.updatedAt = new Date().toISOString(); }
      });
      throw error;
    } finally { runningOperations.delete(op.id); }
  })();
  runningOperations.set(op.id, promise);
  return promise;
}

export function industryAttachmentReferenced(db: Database, scope: IndustryScope, id: string) {
  const state = db.users.find(user => user.id === scope.userId)?.industry;
  if (!state) return false;
  const contains = (value: unknown): boolean => Array.isArray(value) ? value.some(contains)
    : value && typeof value === 'object' ? Object.values(value).some(contains) : value === id;
  return collections.some(name => (state[name] as OwnedRow[]).some(row => row.workspaceId === scope.workspaceId && rowOwner(row) === scope.userId && contains(row)))
    || state.operations.some(row => row.workspaceId === scope.workspaceId && row.userId === scope.userId && contains(row.result));
}
