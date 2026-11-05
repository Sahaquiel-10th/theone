import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database, ModelConfig } from './types.js';
import type { Store } from './db.js';
import { IndustryStore, createIndustryUsageSession, emptyIndustryState, type IndustryTool } from './industryState.js';
import { createIndustryModelRunner, industryRequestId, industryRetailPricing, type IndustryModelInput } from './industryModel.js';
import { defaultTaskValues } from './aiTaskConfig.js';
import { callImageTask, resolveImageTask } from './imageTaskConfiguration.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'provider' as const };
function fixture(tool: IndustryTool = 'review_reply', budgetMicros = 1_000_000) {
  const model: ModelConfig = { id: 'chat', name: '合成模型', model: 'synthetic', provider: 'SYNTHETIC_PROVIDER', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'SYNTHETIC_SECRET', enabled: true, isDefault: true, kind: 'chat', protocol: 'openai', systemPrompt: '', inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 2, createdAt: '' };
  let db = { models: [model], users: [{ id: 'a', enabled: true, industry: emptyIndustryState() }, { id: 'b', enabled: true, industry: emptyIndustryState() }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: [{ userId: 'a', workspaceId: 'wa' }, { userId: 'b', workspaceId: 'wb' }], powerAccounts: [{ id: 'pa', userId: 'a', workspaceId: 'wa', balanceMicros: 2_000_000 }, { id: 'pb', userId: 'b', workspaceId: 'wb', balanceMicros: 2_000_000 }], modelUsageRecords: [], powerLedger: [], conversations: [], attachments: [], settings: { safetyRules: '平台安全规则', aiTasks: { image_generation: { published: { ...defaultTaskValues('image_generation'), version: 1, modelId: model.id, imageRoute: 'images', imageServiceModel: 'configured-image', imagePowerPerCall: .4, costImagePowerPerCall: .04 } } } } } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const base: Store = { read: async () => db, mutate: <T>(change: (state: Database) => T) => {
    const next = queue.then(() => { const before = structuredClone(db); try { return change(db); } catch (error) { db = before; throw error; } });
    queue = next.catch(() => undefined); return next;
  } };
  const actor = { id: 'a', workspaceId: 'wa' }, scope = { userId: 'a', workspaceId: 'wa' };
  const session = createIndustryUsageSession(db, actor, { requestKey: 'fixture-session-00001', confirmed: true, tool, budgetMicros });
  const input: IndustryModelInput = { tool, usageSessionId: session.id, operationId: 'operation-one', stepId: 'step-one', kind: tool === 'review_reply' ? 'chat' : 'image', messages: [{ role: 'user', content: '合成请求', createdAt: '' }], maxOutputTokens: 3000, verify: () => {} };
  return { store: new IndustryStore(base), db: () => db, input, scope, actor, session };
}

test('workbench text uses the real ONE wallet, retail snapshot and platform safety rules', async () => {
  const f = fixture(); let calls = 0;
  const run = createIndustryModelRunner(f.store, { chatCall: async (model, messages, tools, requestId, options) => {
    calls++; assert.equal(model.id, 'chat'); assert.deepEqual(tools, []); assert.equal(options?.maxOutputTokens, 3000);
    assert.ok(requestId?.startsWith(`industry_${f.session.id}_`)); assert.equal(messages[0].content, '平台安全规则');
    assert.equal(f.db().modelUsageRecords[0].status, 'pending');
    return { content: '结果', toolCalls: [], usage, finishReason: 'stop' };
  } });
  assert.equal((await run(f.scope, f.input)).content, '结果');
  assert.equal(calls, 1); assert.equal(f.db().modelUsageRecords[0].chargedMicros, 40); assert.equal(f.db().powerLedger.length, 1);
  assert.equal(f.db().powerAccounts[0].balanceMicros, 2_000_000 - 40); assert.equal(f.db().powerAccounts[1].balanceMicros, 2_000_000);
});

test('published image configuration charges the existing per-picture price and passes server-owned auto edit control', async () => {
  const f = fixture('image_edit'); const original = structuredClone(f.db().models); let calls = 0;
  const run = createIndustryModelRunner(f.store, { imageStorageAvailable: true, imageCall: async (model, _messages, _safety, _requestId, options) => {
    calls++; assert.equal(model.kind, 'image'); assert.equal(model.model, 'configured-image'); assert.equal(options?.imageSize, 'auto'); assert.equal(_safety, '平台安全规则');
    return { content: '图片', imageUrl: 'data:image/png;base64,fixture', raw: { secret: 'not a domain DTO' }, usage };
  } });
  const result = await run(f.scope, { ...f.input, imageSize: 'auto', modelId: 'untrusted-selection-is-ignored' });
  assert.equal(calls, 1); assert.equal(result.raw, undefined);
  assert.equal(f.db().modelUsageRecords[0].chargedMicros, 400_000); assert.equal(f.db().modelUsageRecords[0].costMicros, 40_000);
  assert.deepEqual(f.db().models, original);
});

test('atomic step receipt prevents concurrent duplicate paid calls and subsequent replay', async () => {
  const f = fixture(); let calls = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  const run = createIndustryModelRunner(f.store, { chatCall: async () => { calls++; started(); await gate; return { content: 'once', toolCalls: [], usage }; } });
  const first = run(f.scope, f.input); await began;
  await assert.rejects(run(f.scope, f.input), { code: 'INDUSTRY_STEP_ALREADY_RESERVED' });
  release(); await first;
  await assert.rejects(run(f.scope, f.input), { code: 'INDUSTRY_STEP_ALREADY_RESERVED' });
  assert.equal(calls, 1); assert.equal(f.db().modelUsageRecords.length, 1);
});

test('concurrent jobs share the authorized session ceiling including pending reservations', async () => {
  const f = fixture('image_edit', 1); f.db().powerAccounts[0].balanceMicros=400_000; let calls = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; });
  const run = createIndustryModelRunner(f.store, { imageStorageAvailable: true, imageCall: async () => { calls++; started(); await gate; return { content: 'image', imageUrl: 'fixture' }; } });
  const first = run(f.scope, f.input); await began;
  await assert.rejects(run(f.scope, { ...f.input, operationId: 'second-job' }), /余额|电力不足/);
  release(); await first;
  assert.equal(calls, 1); assert.equal(f.db().modelUsageRecords.length, 1);
});

test('uncertain text usage keeps its hold and can never silently reissue the same paid step', async () => {
  const f = fixture(); let calls = 0;
  const run = createIndustryModelRunner(f.store, { chatCall: async () => { calls++; return { content: 'result without usage', toolCalls: [] }; } });
  await run(f.scope, f.input);
  assert.equal(f.db().modelUsageRecords[0].status, 'needs_review'); assert.ok(f.db().modelUsageRecords[0].reservedMicros! > 0);
  await assert.rejects(run(f.scope, f.input), { code: 'INDUSTRY_STEP_ALREADY_RESERVED' }); assert.equal(calls, 1);
});

test('cross-workspace, expired, wrong-tool and revoked membership sessions fail before provider calls', async () => {
  for (const mode of ['workspace', 'expired', 'tool', 'membership'] as const) {
    const f = fixture(); let calls = 0;
    const run = createIndustryModelRunner(f.store, { chatCall: async () => { calls++; return { content: '', toolCalls: [], usage }; } });
    if (mode === 'expired') f.session.expiresAt = '2000-01-01';
    if (mode === 'membership') f.db().workspaceMembers[0].status = 'disabled';
    const scope = mode === 'workspace' ? { userId: 'b', workspaceId: 'wb' } : f.scope;
    await assert.rejects(run(scope, { ...f.input, tool: mode === 'tool' ? 'image_edit' : 'review_reply' }));
    assert.equal(calls, 0); assert.equal(f.db().modelUsageRecords.length, 0);
  }
});

test('authorization is rechecked atomically before charging and after the provider returns', async () => {
  const f = fixture(); let checks = 0, calls = 0;
  const run = createIndustryModelRunner(f.store, { chatCall: async () => { calls++; return { content: 'private result', toolCalls: [], usage }; } });
  await assert.rejects(run(f.scope, { ...f.input, verify: () => { if (++checks === 2) throw Error('revoked before reserve'); } }), /revoked/);
  assert.equal(calls, 0); assert.equal(f.db().modelUsageRecords.length, 0);
  checks = 0;
  await assert.rejects(run(f.scope, { ...f.input, verify: () => { if (++checks === 3) throw Error('revoked before exposure'); } }), /revoked/);
  assert.equal(calls, 1); assert.equal(f.db().modelUsageRecords[0].chargedMicros, 40);
});

test('provider errors do not expose credentials and failed receipts still forbid automatic retry', async () => {
  const f = fixture(); let calls = 0;
  const run = createIndustryModelRunner(f.store, { chatCall: async () => { calls++; throw Error('SYNTHETIC_SECRET raw provider body'); } });
  await assert.rejects(run(f.scope, f.input), (error: any) => error.code === 'INDUSTRY_MODEL_CALL_FAILED' && !/SECRET|provider body/.test(error.message));
  await assert.rejects(run(f.scope, f.input), { code: 'INDUSTRY_STEP_ALREADY_RESERVED' }); assert.equal(calls, 1);
});

test('retail readiness contains no credentials or procurement fields; identifiers are bounded', () => {
  const f = fixture(); const result = industryRetailPricing(f.db(), f.scope, true);
  assert.equal(result.chatReady, true); assert.equal(result.image?.powerPerImage, .4);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PROVIDER|synthetic.invalid|cost|apiKey|baseUrl/);
  for (const id of ['', 'wrong:scope', 'x'.repeat(161)]) assert.throws(() => industryRequestId(f.session.id, id, 'step'));
});

test('a completed paid image is retained when the session expires during the call; no subsequent step is charged', async () => {
  const f = fixture('image_edit'); let calls = 0;
  const run = createIndustryModelRunner(f.store, { imageStorageAvailable: true, imageCall: async () => {
    calls++; f.session.expiresAt = '2000-01-01'; return { content: '已付费图片', imageUrl: 'data:image/png;base64,paid-result' };
  } });
  assert.equal((await run(f.scope, f.input)).imageUrl, 'data:image/png;base64,paid-result');
  assert.equal(f.db().modelUsageRecords[0].chargedMicros, 400_000);
  await assert.rejects(run(f.scope, { ...f.input, stepId: 'explicit-next-step' }), { code: 'INDUSTRY_BUDGET_REQUIRED' }); assert.equal(calls, 1);
});

test('both existing image routes preserve default square output and accept explicit auto edits without Message fields', async () => {
  const previous = globalThis.fetch;
  const f = fixture('image_edit');
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64');
  try {
    for (const route of ['images', 'responses'] as const) {
      f.db().settings.aiTasks!.image_generation!.published!.imageRoute = route;
      const config = resolveImageTask(f.db(), true); let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        const expected = calls === 1 ? '1024x1024' : 'auto';
        if (route === 'images') { assert.ok(init?.body instanceof FormData); assert.equal(init.body.get('size'), expected); assert.equal(init.body.get('n'), '1'); }
        else { const body = JSON.parse(String(init?.body)); assert.equal(body.tools[0].size, expected); }
        return Response.json(route === 'images' ? { data: [{ b64_json: image }] } : { status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', output_format: 'png', result: image }] });
      };
      const messages = [{ role: 'user' as const, content: 'edit', createdAt: '', inputImageDataUrls: [`data:image/png;base64,${image}`] }];
      await callImageTask(config, config.billingModel, messages);
      await callImageTask(config, config.billingModel, messages, '', 'explicit-edit', undefined, undefined, { imageSize: 'auto' });
      assert.equal(calls, 2);
    }
  } finally { globalThis.fetch = previous; }
});
