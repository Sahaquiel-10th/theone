import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from './db.js';
import type { Database, ModelUsageRecord } from './types.js';
import { publicUser } from './serializers.js';
import { IndustryStore, assertIndustryBudget, createIndustryUsageSession, emptyIndustryState, industryDatabase, industryUsage, readIndustryOperation, recoverIndustryOperations, runIndustryOperation } from './industryState.js';
import { defaultReviewDraft } from './reviewReplyTemplates.js';
import type { ReviewProfile } from './reviewReplyTypes.js';

const exec = promisify(execFile);
function fixture() {
  let db = { users: [{ id: 'a', username: 'owner', enabled: true, industry: emptyIndustryState() }, { id: 'b', username: 'peer', enabled: true, industry: emptyIndustryState() }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: [{ userId: 'a', workspaceId: 'wa' }, { userId: 'a', workspaceId: 'wb' }, { userId: 'b', workspaceId: 'wa' }], oneKeyDevices: [{ id: 'key-a', userId: 'a', workspaceId: 'wa', status: 'active' }], modelUsageRecords: [], powerAccounts: [], powerLedger: [], attachments: [], settings: { safetyRules: '' }, models: [], conversations: [] } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const base: Store = { read: async () => db, mutate: <T>(fn: (data: Database) => T) => { const next = queue.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } }); queue = next.catch(() => undefined); return next; } };
  const actor = { id: 'a', workspaceId: 'wa' }, scope = { userId: 'a', workspaceId: 'wa' };
  const session = createIndustryUsageSession(db, actor, { confirmed: true, tool: 'review_reply', requestKey: 'budget-create-00001', budgetMicros: 500_000 }, { keyDeviceId: 'key-a' });
  return { db: () => db, base, store: new IndustryStore(base), actor, scope, session };
}
function row(id: string, workspaceId = 'wa', ownerId = 'a'): ReviewProfile { return { ...defaultReviewDraft(), id, workspaceId, ownerId, agentId: 'review_reply', revision: 1, versions: [], createdAt: '', updatedAt: '' }; }

test('industry private JSON survives two real ONE JSON Store processes and publicUser omits it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-industry-restart-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DB_PROVIDER: 'json', ONE_DATA_DIR: directory, ADMIN_INITIAL_PASSWORD: 'isolated-industry-fixture-password', YYLX_API_KEY: '', PROVIDER_CREDENTIALS_KEY: 'industry-fixture-encryption-key-only' };
  const run = async (script: string) => (await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env, timeout: 120_000 })).stdout;
  await run(`const {store}=await import('./server/db.ts');const {IndustryStore}=await import('./server/industryState.ts');const {ReviewReplyService,defaultReviewDraft}=await import('./server/reviewReplies.ts');const db=await store.read();const actor={id:db.users[0].id,workspaceId:db.users[0].defaultWorkspaceId};await new ReviewReplyService(new IndustryStore(store)).saveProfile(actor,{...defaultReviewDraft(),shopName:'PRIVATE_RESTART_SHOP'});`);
  const result = JSON.parse(await run(`const {store}=await import('./server/db.ts');const {IndustryStore}=await import('./server/industryState.ts');const {publicUser}=await import('./server/serializers.ts');const db=await store.read();console.log(JSON.stringify({rows:(await new IndustryStore(store).read()).reviewReplyProfiles,public:publicUser(db.users[0]),userId:db.users[0].id,workspaceId:db.users[0].defaultWorkspaceId}));`));
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].shopName, 'PRIVATE_RESTART_SHOP'); assert.equal(result.rows[0].ownerId, result.userId); assert.equal(result.rows[0].workspaceId, result.workspaceId);
  assert.equal(Object.hasOwn(result.public, 'industry'), false); assert.doesNotMatch(JSON.stringify(result.public), /PRIVATE_RESTART_SHOP|reviewReplyProfiles/);
});

test('flatten/scatter keeps one user\'s workspaces and another user separate; read-only projections create no state', async () => {
  const f = fixture(); delete f.db().users[1].industry;
  await f.store.read(); assert.equal(f.db().users[1].industry, undefined);
  await f.store.mutate(db => { db.reviewReplyProfiles.push(row('one'), row('two', 'wb'), row('peer', 'wa', 'b')); });
  assert.deepEqual(f.db().users[0].industry!.reviewReplyProfiles.map(p => [p.id, p.workspaceId]), [['one', 'wa'], ['two', 'wb']]);
  assert.deepEqual(f.db().users[1].industry!.reviewReplyProfiles.map(p => p.id), ['peer']);
  assert.equal((await f.store.read()).reviewReplyProfiles.length, 3);
  for (const user of f.db().users) assert.equal(Object.hasOwn(publicUser(user), 'industry'), false);
});

test('changing a saved row owner or workspace fails and rolls back every mutation in the transaction', async () => {
  const f = fixture(); await f.store.mutate(db => { db.reviewReplyProfiles.push(row('bound-row')); });
  for (const field of ['ownerId', 'workspaceId'] as const) {
    const before = structuredClone(f.db());
    await assert.rejects(f.store.mutate(db => { db.users[0].username = 'must roll back'; db.reviewReplyProfiles[0][field] = field === 'ownerId' ? 'b' : 'wb'; }), { code: 'INDUSTRY_BINDING_CONFLICT' });
    assert.deepEqual(f.db(), before);
  }
  assert.equal(industryDatabase(f.db()).reviewReplyProfiles[0].ownerId, 'a');
});

test('one authorized session counts every stage and job, includes pending holds, ignores legacy and foreign usage', () => {
  const f = fixture(), prefix = `industry_${f.session.id}_`;
  f.db().modelUsageRecords.push(...[
    { workspaceId: 'wa', userId: 'a', requestId: `${prefix}job1_plan`, chargedMicros: 100_000, reservedMicros: 0 },
    { workspaceId: 'wa', userId: 'a', requestId: `${prefix}job1_image`, chargedMicros: 0, reservedMicros: 200_000 },
    { workspaceId: 'wa', userId: 'a', requestId: `${prefix}job2_ocr`, chargedMicros: 50_000 },
    { workspaceId: 'wa', userId: 'a', chargedMicros: 9_000_000 },
    { workspaceId: 'wb', userId: 'a', requestId: `${prefix}other_workspace`, chargedMicros: 9_000_000 },
    { workspaceId: 'wa', userId: 'b', requestId: `${prefix}other_owner`, chargedMicros: 9_000_000 },
  ] as ModelUsageRecord[]);
  assert.equal(industryUsage(f.db(), f.scope, f.session), 350_000);
  assert.equal(assertIndustryBudget(f.db(), f.scope, f.session.id, 150_000, `${prefix}next`).id, f.session.id);
  assert.throws(() => assertIndustryBudget(f.db(), f.scope, f.session.id, 150_001, `${prefix}next`), { code: 'INDUSTRY_BUDGET_EXCEEDED' });
  assert.throws(() => assertIndustryBudget(f.db(), { ...f.scope, workspaceId: 'wb' }, f.session.id, 0));
  assert.throws(() => assertIndustryBudget(f.db(), { ...f.scope, userId: 'b' }, f.session.id, 0));
  assert.throws(() => assertIndustryBudget(f.db(), f.scope, f.session.id, 0, 'other_session_request'), { code: 'INDUSTRY_BUDGET_MISMATCH' });
});

test('the session is bound to the exact active ONE Key and expires; no other key can replace it', () => {
  const f = fixture(); f.db().oneKeyDevices.push({ ...f.db().oneKeyDevices[0], id: 'another-key' });
  f.db().oneKeyDevices[0].status = 'revoked';
  assert.throws(() => assertIndustryBudget(f.db(), f.scope, f.session.id, 0), { code: 'INDUSTRY_KEY_REVOKED' });
  f.db().oneKeyDevices[0].status = 'active'; f.session.expiresAt = '2000-01-01';
  assert.throws(() => assertIndustryBudget(f.db(), f.scope, f.session.id, 0), { code: 'INDUSTRY_BUDGET_REQUIRED' });
});

test('auxiliary operations cache their exact result, reject changed payload and isolate owner/workspace', async () => {
  const f = fixture(); let calls = 0;
  const input = { requestKey: 'aux-request-0000001', tool: 'review_reply' as const, kind: 'analyze', usageSessionId: f.session.id, payload: { text: 'private source' } };
  const execute = async () => { calls++; return { text: 'PRIVATE_RESULT', attachmentIds: ['private-image'] }; };
  const first = await runIndustryOperation(f.store, f.actor, input, execute);
  assert.deepEqual(await runIndustryOperation(f.store, f.actor, input, execute), first); assert.equal(calls, 1);
  await assert.rejects(runIndustryOperation(f.store, f.actor, { ...input, payload: { text: 'changed' } }, execute), { code: 'INDUSTRY_OPERATION_CONFLICT' });
  const saved = readIndustryOperation(f.db(), f.actor, input.requestKey); assert.equal(saved.status, 'completed');
  for (const actor of [{ id: 'a', workspaceId: 'wb' }, { id: 'b', workspaceId: 'wa' }]) assert.throws(() => readIndustryOperation(f.db(), actor, saved.id), { code: 'INDUSTRY_OPERATION_NOT_FOUND' });
});

test('in-flight duplicate auxiliary requests share a promise; unknown and recovered calls never replay', async () => {
  const f = fixture(); let calls = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  const input = { requestKey: 'aux-running-000001', tool: 'review_reply' as const, kind: 'ocr', usageSessionId: f.session.id, payload: { image: 'private' } };
  const execute = async () => { calls++; started(); await gate; return { text: 'done' }; };
  const one = runIndustryOperation(f.store, f.actor, input, execute); await began;
  const two = runIndustryOperation(f.store, f.actor, input, execute); release(); assert.deepEqual(await one, await two); assert.equal(calls, 1);
  const failed = { ...input, requestKey: 'aux-unknown-000001' };
  await assert.rejects(runIndustryOperation(f.store, f.actor, failed, async () => { calls++; throw Error('provider may have accepted'); }));
  await assert.rejects(runIndustryOperation(f.store, f.actor, failed, execute), { code: 'INDUSTRY_OPERATION_UNCERTAIN' }); assert.equal(calls, 2);
  await f.base.mutate(db => { const operation = db.users[0].industry!.operations[0]; operation.status = 'running'; });
  await recoverIndustryOperations(f.store);
  await assert.rejects(runIndustryOperation(f.store, f.actor, input, execute), { code: 'INDUSTRY_OPERATION_UNCERTAIN' }); assert.equal(calls, 2);
});
