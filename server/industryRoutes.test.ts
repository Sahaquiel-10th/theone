import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Store } from './db.js';
import type { Database } from './types.js';
import type { CommerceJob } from './commerceTypes.js';
import { AttachmentService } from './attachmentService.js';
import { installIndustryRoutes } from './industryRoutes.js';
import { IndustryError, INDUSTRY_CID, emptyIndustryState, runIndustryOperation } from './industryState.js';
import { defaultReviewDraft } from './reviewReplyTemplates.js';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-industry-http-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let db = { users: [{ id: 'a', enabled: true, industry: emptyIndustryState() }, { id: 'b', enabled: true, industry: emptyIndustryState() }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: [{ workspaceId: 'wa', userId: 'a' }, { workspaceId: 'wb', userId: 'a' }, { workspaceId: 'wa', userId: 'b' }], oneKeyDevices: [{ id: 'key-a', workspaceId: 'wa', userId: 'a', status: 'active' }], attachments: [], models: [], modelUsageRecords: [], powerAccounts: [], powerLedger: [], settings: { safetyRules: '' }, conversations: [], auditLogs: [] } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve(), keyPresent = true;
  const store: Store = { read: async () => db, mutate: <T>(fn: (state: Database) => T) => { const next = queue.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } }); queue = next.catch(() => undefined); return next; } };
  const files = new AttachmentService(store, directory), app = express(); app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => {
    const user = db.users.find(u => u.id === req.get('x-test-user') && u.enabled);
    if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
    req.user = user; req.workspaceId = req.get('x-test-workspace') || 'wa';
    if (req.get('x-test-key') !== 'absent') req.oneKeyDeviceId = 'key-a';
    next();
  };
  const industry = installIndustryRoutes(app, [auth], store, files, { storageAvailable: true, verifyKey: async req => {
    if (!keyPresent || !db.oneKeyDevices.some(k => k.id === req.oneKeyDeviceId && k.workspaceId === req.workspaceId && k.userId === req.user?.id && k.status === 'active')) throw new IndustryError('请重新插入 ONE Key', 428, 'ONE_KEY_REQUIRED');
  } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/industry`;
  const request = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-test-user': 'a', 'x-test-workspace': 'wa', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const createSession = async () => { const res = await request('/usage-sessions', 'POST', { confirmed: true, tool: 'review_reply', budgetMicros: 500_000, requestKey: 'http-budget-request-00001' }); assert.equal(res.status, 201, await res.clone().text()); return (await res.json()).session; };
  return { db: () => db, directory, store, industry, files, base, request, createSession, removeKey: () => { keyPresent = false; db.oneKeyDevices[0].status = 'revoked'; } };
}

test('usage session HTTP requires Key, returns retail-only data and isolates exact owner/workspace', async t => {
  const f = await fixture(t);
  const config = await f.request('/config'); assert.equal(config.status, 200); assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await config.text(), /apiKey|baseUrl|cost|provider|storagePath/);
  const missingKey = await f.request('/usage-sessions', 'POST', { confirmed: true, requestKey: 'missing-key-request-0001', tool: 'review_reply', budgetMicros: 500_000 }, { 'x-test-key': 'absent' }); assert.equal(missingKey.status, 428);
  const session = await f.createSession();
  assert.equal(session.keyDeviceId, undefined); assert.equal(session.workspaceId, undefined); assert.equal(session.userId, undefined);
  const own = await f.request('/usage-sessions/' + session.id); assert.equal(own.status, 200); assert.equal((await own.json()).usedMicros, 0);
  for (const headers of [{ 'x-test-user': 'b' }, { 'x-test-workspace': 'wb' }] as Record<string, string>[]) assert.equal((await f.request('/usage-sessions/' + session.id, 'GET', undefined, headers)).status, 404);
  f.removeKey(); assert.equal((await f.request('/usage-sessions', 'POST', { confirmed: true, requestKey: 'revoked-key-request-0001', tool: 'review_reply', budgetMicros: 500_000 })).status, 428);
});

test('operation read-back hides binding/hash metadata, and unknown identity cannot query any industry endpoint', async t => {
  const f = await fixture(t), session = await f.createSession(); let calls = 0;
  await runIndustryOperation(f.industry, { id: 'a', workspaceId: 'wa' }, { requestKey: 'http-operation-000001', usageSessionId: session.id, tool: 'review_reply', kind: 'analyze', payload: { secret: 'PRIVATE_SOURCE' } }, async () => { calls++; return { text: 'PRIVATE_RESULT' }; });
  const response = await f.request('/operations/http-operation-000001'); assert.equal(response.status, 200); const text = await response.text();
  assert.match(text, /PRIVATE_RESULT/); assert.doesNotMatch(text, /workspaceId|userId|payloadHash|PRIVATE_SOURCE/); assert.equal(calls, 1);
  assert.equal((await f.request('/operations/http-operation-000001', 'GET', undefined, { 'x-test-user': 'b' })).status, 404);
  for (const route of ['/config', '/usage-sessions/unknown', '/operations/unknown', '/files/unknown/content']) {
    const anonymous = await fetch(f.base + route); assert.equal(anonymous.status, 401); assert.doesNotMatch(await anonymous.text(), /PRIVATE/);
  }
});

test('private file upload streams real chunks, stays unavailable until ready, and retains exact industry binding', async t => {
  const f = await fixture(t), bytes = Buffer.from('PRIVATE_INDUSTRY_TEXT_FIXTURE');
  const created = await f.request('/files/uploads', 'POST', { name: '材料.txt', size: bytes.length, mimeType: 'text/plain', workspaceId: 'wb', userId: 'b' });
  assert.equal(created.status, 201, await created.clone().text()); const result = await created.json(), id = result.attachment.id;
  assert.doesNotMatch(JSON.stringify(result), /storagePath|extractedText|workspaceId|userId/);
  const file = f.db().attachments.find(a => a.id === id)!; assert.equal(file.workspaceId, 'wa'); assert.equal(file.userId, 'a'); assert.equal(file.conversationId, INDUSTRY_CID);
  assert.equal((await fs.stat(file.storagePath)).mode & 0o777, 0o600);
  assert.equal((await f.request(`/files/${id}/content`)).status, 404);
  const foreignChunk = await fetch(`${f.base}/files/${id}/chunks?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-test-user': 'b', 'x-test-workspace': 'wa' }, body: bytes }); assert.equal(foreignChunk.status, 404); assert.equal(file.uploadedBytes, 0);
  const upload = await fetch(`${f.base}/files/${id}/chunks?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-test-user': 'a', 'x-test-workspace': 'wa' }, body: bytes }); assert.equal(upload.status, 200);
  assert.equal((await f.request(`/files/${id}/complete`, 'POST', {})).status, 200);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && f.db().attachments.find(a => a.id === id)?.status !== 'ready') await new Promise(r => setTimeout(r, 20));
  assert.equal(f.db().attachments.find(a => a.id === id)?.status, 'ready');
  const content = await f.request(`/files/${id}/content?download=1`); assert.equal(content.status, 200); assert.equal(await content.text(), bytes.toString());
  assert.match(content.headers.get('content-disposition') || '', /^attachment;/); assert.equal(content.headers.get('x-content-type-options'), 'nosniff'); assert.match(content.headers.get('content-security-policy') || '', /sandbox/);
  for (const headers of [{ 'x-test-user': 'b' }, { 'x-test-workspace': 'wb' }] as Record<string, string>[]) {
    assert.equal((await f.request(`/files/${id}/content`, 'GET', undefined, headers)).status, 404);
    assert.equal((await f.request(`/files/${id}/complete`, 'POST', {}, headers)).status, 404);
  }
});

test('file CID, ready status and exact owner are enforced, while referenced original files cannot be deleted', async t => {
  const f = await fixture(t), storagePath = path.join(f.directory, 'private-fixture.txt'); await fs.writeFile(storagePath, 'PRIVATE_BOUND_FILE', { mode: 0o600 });
  const common = { workspaceId: 'wa', userId: 'a', originalName: 'private.txt', mimeType: 'text/plain', kind: 'text' as const, status: 'ready' as const, size: 18, storagePath, extractedText: '', createdAt: '' };
  await f.store.mutate(db => { db.attachments.push({ ...common, id: 'bound', conversationId: INDUSTRY_CID }, { ...common, id: 'other-conversation', conversationId: 'chat-private' }, { ...common, id: 'other-user', userId: 'b', conversationId: INDUSTRY_CID }, { ...common, id: 'other-workspace', workspaceId: 'wb', conversationId: INDUSTRY_CID }, { ...common, id: 'not-ready', status: 'parsing', conversationId: INDUSTRY_CID }); });
  for (const id of ['other-conversation', 'other-user', 'other-workspace', 'not-ready', 'unknown']) assert.equal((await f.request(`/files/${id}/content`)).status, 404);
  await f.industry.mutate(db => { db.reviewReplyProfiles.push({ ...defaultReviewDraft(), sourceAttachmentIds: ['bound'], id: 'profile', workspaceId: 'wa', ownerId: 'a', agentId: 'review_reply', revision: 1, versions: [], createdAt: '', updatedAt: '' }); });
  const protectedFile = await f.request('/files/bound', 'DELETE'); assert.equal(protectedFile.status, 409); assert.match(await protectedFile.text(), /保留原件/); assert.equal(await fs.readFile(storagePath, 'utf8'), 'PRIVATE_BOUND_FILE');
  await f.industry.mutate(db => { db.reviewReplyProfiles = []; });
  const removed = await f.request('/files/bound', 'DELETE'); assert.equal(removed.status, 200); assert.equal(f.db().attachments.some(a => a.id === 'bound'), false); await assert.rejects(fs.stat(storagePath));
});

test('precise receipts find completed commerce and review domain records instead of treating auxiliary 404 as absence', async t => {
  const f = await fixture(t);
  const { defaultCommerceBrief } = await import('./commerceTypes.js');
  const makeJob = (id: string, requestKey: string, changes: Record<string, unknown> = {}) => ({ id, workspaceId: 'wa', userId: 'a', agentId: 'industry-commerce-main', kind: 'product_creative', taskType: 'main', requestKey, usageSessionId: 'private-session', requestHash: 'PRIVATE_HASH', brief: { ...defaultCommerceBrief(), notes: 'PRIVATE_PROMPT' }, status: 'completed', phase: 'PRIVATE_PHASE', summary: 'PRIVATE_SUMMARY', analysis: 'PRIVATE_ANALYSIS', variants: [], chatModelId: 'private-model', imageModelId: 'private-image', createdAt: '', updatedAt: '', ...changes });
  const keys = { main: 'receipt-main-key-00001', edit: 'receipt-edit-key-00001', derive: 'receipt-derive-key-0001', generate: 'receipt-generate-key-01', retry: 'receipt-retry-key-0001', review: 'receipt-review-key-001', refine: 'receipt-refine-key-001' };
  await f.industry.mutate(db => {
    db.commerceJobs.push(...[
      makeJob('main-job', keys.main, { status: 'review', mutations: [{ requestKey: keys.generate, hash: 'PRIVATE_GENERATE_HASH' }, { requestKey: keys.retry, hash: 'PRIVATE_RETRY_HASH' }], variants: [{ id: 'variant', status: 'completed', lastRetryRequestKey: keys.retry, imagePrompt: 'PRIVATE_VARIANT_PROMPT' }] }),
      makeJob('edit-job', keys.edit, { kind: 'image_edit', agentId: 'industry-image-edit' }),
      makeJob('derived-job', keys.derive, { sourceJobId: 'main-job', sourceVariantId: 'variant', taskType: 'portrait' }),
    ] as unknown as CommerceJob[]);
    db.reviewReplyRuns.push({ id: 'review-run', workspaceId: 'wa', ownerId: 'a', agentId: 'review_reply', requestKey: keys.review, payloadHash: 'PRIVATE_PAYLOAD_HASH', usageSessionId: 'private-session', profileId: '', profileRevision: 0, profileSnapshot: { ...defaultReviewDraft(), shopName: 'PRIVATE_SHOP' }, sourceImageIds: [], status: 'completed', results: [], error: '', createdAt: '', updatedAt: '', mutations: [{ requestKey: keys.refine, itemId: 'private-item', candidateId: 'private-candidate', instruction: 'PRIVATE_INSTRUCTION', status: 'completed', error: '' }] });
  });
  const check = async (key: string, route: string, tool = 'product_creative', headers: Record<string, string> = {}) => {
    const response = await f.request(`/receipts/${key}?${new URLSearchParams({ tool, path: route })}`, 'GET', undefined, headers);
    return { response, body: await response.json() };
  };
  // The old auxiliary lookup really does return 404 for a completed domain job.
  assert.equal((await f.request('/operations/' + keys.main)).status, 404);
  for (const [key, route, tool, target] of [
    [keys.main, '/api/commerce/jobs', 'product_creative', 'main-job'],
    [keys.edit, '/api/commerce/edits', 'image_edit', 'edit-job'],
    [keys.derive, '/api/commerce/jobs/main-job/derive', 'product_creative', 'derived-job'],
    [keys.retry, '/api/commerce/jobs/main-job/retry', 'product_creative', 'main-job'],
    [keys.review, '/api/review-replies/runs', 'review_reply', 'review-run'],
    [keys.refine, '/api/review-replies/runs/review-run/refine', 'review_reply', 'review-run'],
  ]) {
    const { response, body } = await check(key, route, tool);
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.receipt.status, 'completed'); assert.equal(body.receipt.retryAllowed, false);
    assert.ok(body.receipt.jobId === target || body.receipt.runId === target);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|hash|usageSessionId|workspaceId|userId|ownerId|profileSnapshot|imagePrompt/);
  }
  const ambiguous = await check(keys.generate, '/api/commerce/jobs/main-job/generate');
  assert.equal(ambiguous.response.status, 200); assert.equal(ambiguous.body.receipt.status, 'unconfirmed'); assert.equal(ambiguous.body.receipt.retryAllowed, false);
  for (const headers of [{ 'x-test-user': 'b' }, { 'x-test-workspace': 'wb' }] as Record<string, string>[]) {
    const missing = await check(keys.main, '/api/commerce/jobs', 'product_creative', headers);
    assert.equal(missing.response.status, 200); assert.equal(missing.body.receipt.status, 'not_accepted'); assert.equal(missing.body.receipt.jobId, undefined); assert.doesNotMatch(JSON.stringify(missing.body), /main-job|PRIVATE_/);
    assert.equal((await check(keys.derive, '/api/commerce/jobs/main-job/derive', 'product_creative', headers)).response.status, 404);
    assert.equal((await check(keys.refine, '/api/review-replies/runs/review-run/refine', 'review_reply', headers)).response.status, 404);
  }
  assert.equal((await check(keys.main, '/api/review-replies/runs', 'review_reply')).body.receipt.status, 'unconfirmed');
  assert.equal((await check('receipt-unknown-key-0001', '/api/admin/users')).response.status, 400);
});

test('receipt retry permission requires a precise terminal failure or exact scoped absence, never a running or ambiguous record', async t => {
  const f = await fixture(t), session = await f.createSession();
  const makeOperation = (id: string, status: 'running' | 'completed' | 'failed' | 'uncertain') => ({ id, workspaceId: 'wa', userId: 'a', requestKey: `receipt-aux-${id}-0001`, tool: 'review_reply' as const, kind: 'recognize', usageSessionId: session.id, payloadHash: 'PRIVATE_HASH', status, result: { text: 'PRIVATE_AUX_RESULT' }, createdAt: '', updatedAt: '' });
  await f.store.mutate(db => { db.users[0].industry!.operations.push(...['running', 'completed', 'failed', 'uncertain'].map(status => makeOperation(status, status as 'running' | 'completed' | 'failed' | 'uncertain'))); });
  const query = new URLSearchParams({ tool: 'review_reply', path: '/api/review-replies/recognize' });
  for (const status of ['running', 'completed', 'failed', 'uncertain']) {
    const response = await f.request(`/receipts/receipt-aux-${status}-0001?${query}`); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.receipt.status, status); assert.equal(body.receipt.retryAllowed, ['failed', 'uncertain'].includes(status));
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|payloadHash|result|workspaceId|userId/);
  }
  const absent = await f.request(`/receipts/receipt-absent-key-0001?${query}`); assert.equal(absent.status, 200); assert.equal((await absent.json()).receipt.retryAllowed, true);
  const wrongLane = await f.request(`/receipts/receipt-aux-completed-0001?${new URLSearchParams({ tool: 'review_reply', path: '/api/review-replies/analyze' })}`); assert.equal((await wrongLane.json()).receipt.retryAllowed, false);
});
