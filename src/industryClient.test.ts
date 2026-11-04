import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndustryClient, industryFilePath, industryPaidPath, readIndustryPending, type IndustryRequest } from './industryClient';

function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
const session = (id: string) => ({ id, tool: 'image_edit' as const, budgetMicros: 10e6, createdAt: '', expiresAt: '2099-01-01T00:00:00Z' });
test('preparing profiles is free; every model action requires explicit use authorization before HTTP', async () => {
  let calls = 0, asked = 0;
  const request: IndustryRequest = async <T,>() => { calls++; return { profile: {} } as T; };
  const client = createIndustryClient(request, { tool: 'review_reply', storage: storage(), storageKey: 'owner:a:review', session: () => undefined, onBudgetRequired: () => { asked++; }, onPending: () => {} });
  await client.request('/api/review-replies/profiles', { method: 'POST', body: '{"draft":{}}' });
  await assert.rejects(client.request('/api/review-replies/runs', { method: 'POST', body: '{}' }), /确认本轮/);
  assert.equal(calls, 1); assert.equal(asked, 1); assert.equal(client.pending().length, 0);
  assert.equal(industryPaidPath('/api/commerce/materials/recognize', 'POST'), true);
  assert.equal(industryPaidPath('/api/commerce/jobs/one/download'), false);
  assert.equal(industryFilePath('/api/attachments/owned/content?download=1'), '/api/industry/files/owned/content?download=1');
});
test('lost responses persist the exact original key and budget across reload and a newly confirmed session', async () => {
  const disk = storage(), bodies: Record<string, unknown>[] = [];
  const first: IndustryRequest = async <T,>(_path: string, options?: RequestInit) => { bodies.push(JSON.parse(String(options?.body))); throw new Error('lost receipt'); };
  const options = { tool: 'image_edit' as const, storage: disk, storageKey: 'workspace-a:owner:edit', session: () => session('old-grant'), onBudgetRequired: () => {}, onPending: () => {} };
  const a = createIndustryClient(first, options);
  const call = { method: 'POST', body: '{"instruction":"price 69","items":[{"imageId":"owned"}]}' };
  await assert.rejects(a.request('/api/commerce/edits', call), /lost receipt/);
  assert.equal(bodies.length, 1); assert.equal(readIndustryPending(disk, options.storageKey).length, 1);
  const second: IndustryRequest = async <T,>(_path: string, options?: RequestInit) => { bodies.push(JSON.parse(String(options?.body))); return { job: { id: 'already-accepted' } } as T; };
  const b = createIndustryClient(second, { ...options, session: () => session('new-grant') });
  await b.request('/api/commerce/edits', call);
  assert.equal(bodies[0].requestKey, bodies[1].requestKey); assert.equal(bodies[1].usageSessionId, 'old-grant');
  assert.equal(b.pending().length, 0);
});
test('only an explicit new attempt can replace the original key and authorization, even when the form retains its key', async () => {
  const bodies: Record<string, unknown>[] = []; let grant = session('first-grant');
  const request: IndustryRequest = async <T,>(_path: string, options?: RequestInit) => { bodies.push(JSON.parse(String(options?.body))); throw new Error('unknown'); };
  const client = createIndustryClient(request, { tool: 'image_edit', storage: storage(), storageKey: 'a:b:edit', session: () => grant, onBudgetRequired: () => {}, onPending: () => {} });
  const input = { method: 'POST', body: '{"requestKey":"form-original-request-001","instruction":"69"}' };
  await assert.rejects(client.request('/api/commerce/edits', input));
  grant = session('second-grant'); client.prepareExplicitRetry(client.pending()[0].requestKey);
  await assert.rejects(client.request('/api/commerce/edits', input));
  assert.notEqual(bodies[0].requestKey, bodies[1].requestKey); assert.equal(bodies[1].usageSessionId, 'second-grant');
  await assert.rejects(client.request('/api/commerce/edits', input));
  assert.equal(bodies[1].requestKey, bodies[2].requestKey); assert.equal(bodies.length, 3);
});
test('a remounted creative form cannot replace a lost plan receipt with its new form key', async () => {
  const disk = storage(), bodies: Record<string, unknown>[] = [];
  const request: IndustryRequest = async <T,>(_path: string, options?: RequestInit) => { bodies.push(JSON.parse(String(options?.body))); throw new Error('lost planning response'); };
  const options = { tool: 'product_creative' as const, storage: disk, storageKey: 'owner:creative', session: () => session('original-grant'), onBudgetRequired: () => {}, onPending: () => {} };
  const first = createIndustryClient(request, options);
  await assert.rejects(first.request('/api/commerce/jobs', { method: 'POST', body: JSON.stringify({ requestKey: 'old-form-request-001', brief: { productName: 'same product' } }) }));
  const reloaded = createIndustryClient(request, { ...options, session: () => session('new-grant') });
  await assert.rejects(reloaded.request('/api/commerce/jobs', { method: 'POST', body: JSON.stringify({ requestKey: 'new-form-request-002', brief: { productName: 'same product' } }) }));
  assert.equal(bodies[1].requestKey, 'old-form-request-001');
  assert.equal(bodies[1].usageSessionId, 'original-grant');
  assert.equal(reloaded.pending().length, 1);
});
test('pending records are isolated by workspace/tool and invalid old drafts are harmless', () => {
  const disk = storage(); disk.setItem('workspace-one', 'null'); assert.deepEqual(readIndustryPending(disk, 'workspace-one'), []);
  disk.setItem('workspace-one', JSON.stringify([{ fingerprint: 'x', requestKey: 'bad', path: '/api/admin', usageSessionId: 'secret', createdAt: 0 }]));
  assert.deepEqual(readIndustryPending(disk, 'workspace-one'), []); assert.deepEqual(readIndustryPending(disk, 'workspace-two'), []);
});
test('multipart source workflows use ONE chunk/parse routes and snapshot files before asynchronous work', async () => {
  const disk = storage(), form = new FormData(); form.append('files', new File(['abc'], 'a.txt')); form.append('files', new File(['def'], 'b.txt'));
  let next = 0; const calls: { path: string; method?: string }[] = [];
  const request: IndustryRequest = async <T,>(path: string, options?: RequestInit) => {
    calls.push({ path, method: options?.method });
    if (path === '/api/industry/files/uploads') { form.delete('files'); return { attachment: { id: `file-${++next}` }, chunkBytes: 2 } as T; }
    if (options?.method === 'GET' || !options?.method) return { attachment: { id: path.split('/').at(-1), status: 'ready' } } as T;
    return { ok: true } as T;
  };
  const client = createIndustryClient(request, { tool: 'image_edit', storage: disk, storageKey: 'upload', session: () => undefined, onBudgetRequired: () => { throw Error('upload must be free'); }, onPending: () => {} });
  const result = await client.request<{ attachments: { id: string }[] }>('/api/attachments', { method: 'POST', body: form });
  assert.equal(result.attachments.length, 2); assert.equal(calls.filter(call => call.path.includes('/chunks?')).length, 4);
  assert.ok(calls.every(call => call.path.startsWith('/api/industry/files/'))); assert.equal(client.pending().length, 0);
});
