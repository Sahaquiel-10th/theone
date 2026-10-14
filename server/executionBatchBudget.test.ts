import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database, ModelConfig, ModelUsageRecord } from './types.js';
import type { Store } from './db.js';
import type { ChatOperation } from './chatOperations.js';
import { workBatchBudget, reserveExecutionBatchBudget, type ExecutionBatchBudget } from './executionBatchBudget.js';
import { MODEL_MAX_OUTPUT_TOKENS } from './modelGateway.js';
import { runBilledModel } from './modelBilling.js';

const a = { workspaceId: 'wa', userId: 'a' }, b = { workspaceId: 'wb', userId: 'b' };
const startedAt = new Date(Date.now() - 60_000).toISOString();
function operation(id: string, scope = a, child = false, budget = .01): ChatOperation {
  return { ...scope, id: `${scope.userId}-${id}`, operationId: id, requestId: child ? `cloud-${id}` : `coord-${id}`, payloadHash: '',
    status: child ? 'pending' : 'completed', createdAt: startedAt, updatedAt: startedAt,
    ...(child ? { workRun: { parentOperationId: 'parent', budget, state: 'prepared' } as NonNullable<ChatOperation['workRun']> } : {}) };
}
function fixture(cap = .01) {
  const model = { id: 'model', enabled: true, kind: 'chat', name: 'model', systemPrompt: '', inputPowerPerMillion: 0, outputPowerPerMillion: 2,
    costInputPowerPerMillion: 0, costOutputPowerPerMillion: 1 } as ModelConfig;
  let db = { users: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }],
    workspaceMembers: [{ ...a }, { ...b }], models: [model], chatOperations: [operation('parent'), operation('cloud-child', a, true, cap), operation('parent', b), operation('foreign-child', b, true, cap)],
    powerAccounts: [{ ...a, id: 'a', balanceMicros: 100e6 }, { ...b, id: 'b', balanceMicros: 100e6 }], powerLedger: [], modelUsageRecords: [] } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => structuredClone(db), mutate: fn => {
    const next = queue.then(() => { const copy = structuredClone(db), result = fn(copy); db = copy; return result; });
    queue = next.catch(() => undefined); return next;
  } };
  return { store, model, db: () => db, snapshot: { parentOperationId: 'parent', budget: cap, startedAt } as ExecutionBatchBudget };
}
const usage = { inputTokens: 0, outputTokens: 1000, totalTokens: 1000, source: 'provider' };
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('test reservation did not settle');
}

test('batch ownership comes from the saved parent and never from the shared conversation or foreign operation', () => {
  const f = fixture(), db = f.db(), child = db.chatOperations![1];
  assert.deepEqual(workBatchBudget(db, a, child), f.snapshot);
  assert.throws(() => workBatchBudget(db, a, db.chatOperations![3]), /归属不可用/);
  assert.equal(workBatchBudget(db, a, undefined), undefined);
  assert.equal(workBatchBudget(db, a, operation('standalone')), undefined);
  assert.throws(() => reserveExecutionBatchBudget(db, a, 'compile', 1, { ...f.snapshot, budget: .02 }), /预算记录已变化/);
  assert.throws(() => reserveExecutionBatchBudget(db, a, 'compile', 1, { ...f.snapshot, startedAt: '2026-10-13T01:00:00.000Z' }), /归属已变化/);
});

test('one usage row associated by snapshot and cloud request counts once; unrelated old history and other workspaces stay outside the budget', () => {
  const f = fixture(), db = f.db();
  const row = { ...a, id: 'cloud-usage', requestId: 'cloud-cloud-child', createdAt: new Date(Date.parse(startedAt) + 1000).toISOString(), chargedMicros: 1000, reservedMicros: 2000, batchBudget: f.snapshot } as ModelUsageRecord;
  db.modelUsageRecords.push(row,
    { ...row, id: 'historic-same-project', createdAt: new Date(Date.parse(startedAt) - 1000).toISOString(), chargedMicros: 999999, batchBudget: { ...f.snapshot, startedAt: new Date(Date.parse(startedAt) - 1000).toISOString() } },
    { ...row, ...b, id: 'foreign-usage', chargedMicros: 999999 },
    { ...row, id: 'other-batch-same-conversation', requestId: 'another', conversationId: 'same-project', chargedMicros: 999999, batchBudget: { ...f.snapshot, parentOperationId: 'other' } });
  assert.deepEqual(reserveExecutionBatchBudget(db, a, 'compile', 7000, f.snapshot), f.snapshot);
  assert.throws(() => reserveExecutionBatchBudget(db, a, 'compile', 7001, f.snapshot), /达到已授权预算/);
  const restored = JSON.parse(JSON.stringify(db)) as Database;
  assert.throws(() => reserveExecutionBatchBudget(restored, a, 'gateway', 7001, f.snapshot), /达到已授权预算/);
});

test('cloud and two local stages compete for one atomic budget and rejected reservations never invoke or charge the provider', async () => {
  const hold = MODEL_MAX_OUTPUT_TOKENS * 2, f = fixture(hold * 1.5 / 1e6);
  let release!: (value: { usage: typeof usage }) => void, calls = 0;
  const blocked = new Promise<{ usage: typeof usage }>(resolve => { release = resolve; });
  const outcomes: string[] = [];
  const cloud = runBilledModel(f.store, { ...a, model: f.model, input: {}, activity: 'task_worker', requestId: 'cloud-cloud-child' }, async () => { calls++; return blocked; });
  const compile = runBilledModel(f.store, { ...a, model: f.model, input: {}, activity: 'execution_compile', requestId: 'compile-one', batchBudget: f.snapshot }, async () => { calls++; return blocked; });
  const gateway = runBilledModel(f.store, { ...a, model: f.model, input: {}, activity: 'codex_execution', requestId: 'gateway-two', batchBudget: f.snapshot }, async () => { calls++; return blocked; });
  const attempts = [cloud, compile, gateway].map(promise => promise.then(() => { outcomes.push('success'); }, error => {
    assert.match(error.message, /达到已授权预算/); outcomes.push('rejected');
  }));
  try {
    await waitFor(() => outcomes.filter(outcome => outcome === 'rejected').length === 2);
    assert.equal(calls, 1); assert.equal(f.db().modelUsageRecords.length, 1);
    assert.equal(f.db().modelUsageRecords[0].reservedMicros, hold);
    assert.deepEqual(f.db().modelUsageRecords[0].batchBudget, f.snapshot);
    await runBilledModel(f.store, { ...b, model: f.model, input: {}, activity: 'codex_execution', requestId: 'foreign-gateway', batchBudget: f.snapshot }, async () => ({ usage }));
    assert.equal(f.db().modelUsageRecords.length, 2, 'same group identifier in a different owned workspace has a separate cap');
  } finally { release({ usage }); }
  await Promise.all(attempts);
  assert.equal(outcomes.filter(outcome => outcome === 'success').length, 1);
  assert.equal(f.db().powerLedger.filter(row => row.workspaceId === 'wa').length, 1);
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  await runBilledModel(f.store, { ...a, model: f.model, input: {}, activity: 'local_agent', requestId: 'explicit-next-stage', batchBudget: f.snapshot }, async () => ({ usage }));
  assert.ok(f.db().modelUsageRecords.filter(row => row.workspaceId === 'wa').reduce((n, row) => n + (row.chargedMicros ?? 0) + (row.reservedMicros ?? 0), 0) <= Math.floor(f.snapshot.budget * 1e6));
});
