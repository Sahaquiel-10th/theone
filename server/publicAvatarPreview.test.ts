import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Database } from './types.js';
import type { Store } from './db.js';
import { callModelWithTools } from './modelGateway.js';
import { installPublicSharingRoutes } from './publicSharingRoutes.js';
import { getChatOperationResult, reconcileInterruptedChatOperations } from './chatOperations.js';
import { adminUserUsageDetail, adminUsageSummaries } from './adminUsage.js';
import { capabilityHealth } from './capabilityHealth.js';
import { publish } from './publicSharing.js';

function fixture() {
  let db = {users: [{id: 'owner', username: 'teacher', enabled: true}, {id: 'other', username: 'other', enabled: true}], workspaces: [{id: 'ws', status: 'active'}, {id: 'other-ws', status: 'active'}], workspaceMembers: [{workspaceId: 'ws', userId: 'owner', role: 'owner'}, {workspaceId: 'other-ws', userId: 'other', role: 'owner'}], models: [{id: 'model', name: 'Fixture', enabled: true, kind: 'chat', protocol: 'openai', apiKey: 'MODEL_SECRET', systemPrompt: 'BASE_METHOD', inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1}], settings: {safetyRules: 'GLOBAL_SAFETY', rechargeCnyPerPower: 7}, publications: [], publicSessions: [], publicRuns: [], chatOperations: [], conversations: [], messages: [{content: 'OWNER_PRIVATE_CHAT'}], attachments: [], auditLogs: [], modelUsageRecords: [], powerLedger: [], powerAccounts: [{id: 'power', workspaceId: 'ws', userId: 'owner', balanceMicros: 10e6, reservedMicros: 0}, {id: 'other-power', workspaceId: 'other-ws', userId: 'other', balanceMicros: 10e6, reservedMicros: 0}], knowledgeConnections: [{id: 'selected', workspaceId: 'ws', provider: 'notion', status: 'connected', clientId: 'client', encryptedApiKey: 'SOURCE_SECRET'}, {id: 'not-selected', workspaceId: 'ws', provider: 'getnote', status: 'connected', encryptedApiKey: 'UNSELECTED_SECRET'}, {id: 'foreign-source', workspaceId: 'other-ws', provider: 'notion', status: 'connected', encryptedApiKey: 'FOREIGN_SECRET'}]} as unknown as Database;
  const store: Store = {read: async () => db, mutate: async action => {const before = structuredClone(db); try {return action(db);} catch (error) {db = before; throw error;}}};
  const input = {operationId: 'avatar_preview_operation_1', content: '请按方法介绍服务', confirmed: true, config: {name: '', prompt: 'CUSTOM_ANSWER', modelId: 'model', sourceIds: ['selected'], service: {mode: 'consultation', welcome: '你好', starterQuestions: [], method: 'TEACHER_METHOD', features: []}}};
  return {store, input, restore: (value: Database) => {db = value;}, get db() {return db;}};
}

async function http(t: TestContext, f: ReturnType<typeof fixture>, call: typeof callModelWithTools, recall: (...args: any[]) => Promise<any> = async () => ({chunks: [], failures: [], status: 'no_match'})) {
  const app = express(); app.use(express.json());
  installPublicSharingRoutes(app, [(req, res, next) => {if (req.headers['x-key'] !== 'present') {res.sendStatus(428); return;} req.user = {id: String(req.headers['x-user'] ?? 'owner')} as any; req.workspaceId = String(req.headers['x-workspace'] ?? 'ws'); next();}], f.store, {recallWithDiagnostics: recall} as any, {} as any, '', {previewModelCall: call});
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/sharing/manage/preview`;
  return {url, post: (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-key': 'present', ...headers}, body: JSON.stringify(body), signal})};
}
const answer: Awaited<ReturnType<typeof callModelWithTools>> = {content: '真实合成回答', toolCalls: [], finishReason: 'stop', usage: {inputTokens: 30, outputTokens: 10, totalTokens: 40, source: 'provider'}};

test('private avatar test uses selected knowledge and shared method, charges only the owner, and never publishes or delivers tools', async t => {
  const f = fixture(); let calls = 0, recalls = 0;
  const api = await http(t, f, async (model, messages, tools, _requestId, options) => {
    calls++; assert.equal(model.id, 'model'); assert.deepEqual(tools, []); assert.equal(options?.maxOutputTokens, 1200); assert.equal(options?.timeoutMs, 60000);
    const text = JSON.stringify(messages); for (const expected of ['GLOBAL_SAFETY', 'BASE_METHOD', 'CUSTOM_ANSWER', 'TEACHER_METHOD', 'SELECTED_FACT', '先了解需求', '私有回答测试']) assert.match(text, new RegExp(expected));
    assert.doesNotMatch(text, /OWNER_PRIVATE_CHAT|SOURCE_SECRET|MODEL_SECRET|FOREIGN_SECRET|UNSELECTED_SECRET|storagePath|oneHtml/);
    return answer;
  }, async (workspaceId, query, topK, ids, userId, options) => {recalls++; assert.equal(workspaceId, 'ws'); assert.equal(userId, 'owner'); assert.equal(query, f.input.content); assert.equal(topK, 4); assert.deepEqual(ids, ['selected']); assert.equal(options.retry, false); return {chunks: [{title: '本次资料', content: 'SELECTED_FACT'}], failures: [], status: 'used'};});
  const before = structuredClone({publications: f.db.publications, sessions: f.db.publicSessions, runs: f.db.publicRuns, conversations: f.db.conversations, attachments: f.db.attachments});
  const response = await api.post({...f.input, workspaceId: 'other-ws', config: {...f.input.config, intent: 'activate', confirmed: true, visitorPercent: 200, attachments: true, serviceBusiness: {access: 'entitlement'}}});
  assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.response, answer.content); assert.equal(data.chargedMicros, 40); assert.equal(data.heldMicros, 0); assert.match(data.limitations, /不执行功能.*不创建文件或公开分享/);
  assert.equal(calls, 1); assert.equal(recalls, 1); assert.equal(f.db.modelUsageRecords.length, 1); assert.equal(f.db.modelUsageRecords[0].userId, 'owner'); assert.equal(f.db.modelUsageRecords[0].workspaceId, 'ws'); assert.equal(f.db.modelUsageRecords[0].commercial, undefined);
  assert.equal(f.db.chatOperations![0].status, 'completed'); assert.equal(f.db.chatOperations![0].conversationId, undefined);
  assert.deepEqual({publications: f.db.publications, sessions: f.db.publicSessions, runs: f.db.publicRuns, conversations: f.db.conversations, attachments: f.db.attachments}, before);
  const replay = await api.post(f.input); assert.equal(replay.status, 409, 'all draft fields participate in the fingerprint, including ignored commerce configuration');
  const originalInput = {...f.input, workspaceId: 'other-ws', config: {...f.input.config, intent: 'activate', confirmed: true, visitorPercent: 200, attachments: true, serviceBusiness: {access: 'entitlement'}}};
  const same = await api.post(originalInput); assert.equal(same.status, 200); assert.deepEqual(await same.json(), data);
  assert.equal((await api.post({...originalInput, config: {...originalInput.config, prompt: 'CHANGED_CONFIG'}})).status, 409);
  assert.equal(calls, 1); assert.equal(recalls, 1);
});

test('private test enforces Key, owner/workspace, source grants, consent, role and bounded history before retrieval or charging', async t => {
  const f = fixture(); const api = await http(t, f, async () => {assert.fail('invalid request must never call a model');}, async () => {assert.fail('invalid request must never retrieve');});
  assert.equal((await api.post(f.input, {'x-key': ''})).status, 428);
  const foreignHeaders: Record<string, string>[] = [{'x-user': 'other'}, {'x-workspace': 'other-ws'}, {'x-user': 'other', 'x-workspace': 'other-ws'}];
  for (const headers of foreignHeaders) assert.notEqual((await api.post(f.input, headers)).status, 200);
  assert.equal((await api.post({...f.input, config: {...f.input.config, sourceIds: ['foreign-source']}})).status, 400);
  assert.equal((await api.post({...f.input, confirmed: false})).status, 400);
  assert.equal((await api.post({...f.input, history: [{role: 'system', content: 'expand authority'}]})).status, 400);
  assert.equal((await api.post({...f.input, history: Array.from({length: 7}, () => ({role: 'user', content: 'x'}))})).status, 400);
  assert.equal((await api.post({...f.input, content: 'x'.repeat(2001)})).status, 400);
  assert.equal(f.db.chatOperations?.length, 0); assert.equal(f.db.modelUsageRecords.length, 0);
});

test('pending, completed, conflicting, failed and restarted test identifiers never cause a second paid call', async t => {
  const f = fixture(); let calls = 0; let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}); const wait = new Promise<void>(resolve => {release = resolve;});
  const api = await http(t, f, async () => {calls++; entered(); await wait; return answer;});
  const first = api.post(f.input); await started;
  assert.equal((await api.post(f.input)).status, 409);
  assert.equal((await api.post({...f.input, content: '不能修改同一标识的问题'})).status, 409);
  release(); const response = await first; assert.equal(response.status, 200); const result = await response.json(); const replay = await api.post(f.input); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), result); assert.equal(calls, 1);
  f.db.chatOperations![0].status = 'pending'; reconcileInterruptedChatOperations(f.db);
  assert.equal((await api.post(f.input)).status, 409); assert.equal(calls, 1);
});

test('source revocation after lookup blocks the paid call and failure tombstone prevents replay', async t => {
  const f = fixture(); let recalls = 0;
  const api = await http(t, f, async () => {assert.fail('revoked binding must stop before billing');}, async () => {recalls++; f.db.knowledgeConnections[0].encryptedApiKey = 'CHANGED_SECRET'; return {chunks: [{title: '资料', content: 'DO_NOT_SEND'}], failures: [], status: 'used'};});
  assert.equal((await api.post(f.input)).status, 409); assert.equal(f.db.modelUsageRecords.length, 0); assert.equal(f.db.chatOperations![0].status, 'failed');
  f.db.knowledgeConnections[0].encryptedApiKey = 'SOURCE_SECRET'; assert.equal((await api.post(f.input)).status, 409); assert.equal(recalls, 1);
});

test('no knowledge selection skips retrieval, bounds output, and suppresses raw provider failures without replay', async t => {
  const f = fixture(); let calls = 0;
  const api = await http(t, f, async () => {calls++; throw new Error('PROVIDER_PRIVATE_BODY MODEL_SECRET');}, async () => {assert.fail('empty selection must not scan all knowledge');});
  const input = {...f.input, config: {...f.input.config, sourceIds: []}};
  const failed = await api.post(input); assert.equal(failed.status, 400); assert.doesNotMatch(await failed.text(), /PROVIDER_PRIVATE_BODY|MODEL_SECRET/);
  assert.equal(f.db.chatOperations![0].status, 'failed'); assert.equal(f.db.modelUsageRecords.length, 1); assert.equal(f.db.modelUsageRecords[0].status, 'failed'); assert.equal(f.db.powerAccounts[0].reservedMicros, 0);
  assert.equal((await api.post(input)).status, 409); assert.equal(calls, 1);
});

test('the same operation identifier remains independent for two legitimate owners and cannot reuse the other source', async t => {
  const f = fixture(); let calls = 0;
  const api = await http(t, f, async (_model, messages) => {calls++; const text = JSON.stringify(messages); assert.notEqual(text.includes('FACT_ws'), text.includes('FACT_other-ws')); return answer;}, async (workspaceId, _query, _topK, ids, userId) => {
    assert.equal(userId, workspaceId === 'ws' ? 'owner' : 'other'); assert.deepEqual(ids, workspaceId === 'ws' ? ['selected'] : ['foreign-source']); return {chunks: [{title: '私有资料', content: `FACT_${workspaceId}`}], failures: [], status: 'used'};
  });
  assert.equal((await api.post(f.input)).status, 200);
  const other = {...f.input, config: {...f.input.config, sourceIds: ['foreign-source']}};
  assert.equal((await api.post(other, {'x-user': 'other', 'x-workspace': 'other-ws'})).status, 200);
  assert.equal(calls, 2); assert.equal(f.db.chatOperations!.length, 2); assert.notEqual(f.db.chatOperations![0].id, f.db.chatOperations![1].id);
  assert.deepEqual(f.db.modelUsageRecords.map(u => [u.workspaceId, u.userId]), [['ws', 'owner'], ['other-ws', 'other']]);
  assert.equal((await api.post({...other, operationId: 'other_source_grant_attack', config: {...other.config, sourceIds: ['selected']}}, {'x-user': 'other', 'x-workspace': 'other-ws'})).status, 400);
  assert.equal(calls, 2);
});

test('a private test never executes model tool calls and leaves the charged answer attempt as a non-replayable failure', async t => {
  const f = fixture(); let calls = 0;
  const api = await http(t, f, async (_model, _messages, tools) => {calls++; assert.deepEqual(tools, []); return {...answer, content: '模型要求创建文件', toolCalls: [{id: 'call_1', type: 'function', function: {name: 'oneHtml', arguments: '{}'}}]};});
  const response = await api.post({...f.input, config: {...f.input.config, sourceIds: []}}); assert.equal(response.status, 409); assert.match(await response.text(), /不执行工具/);
  assert.equal(f.db.attachments.length, 0); assert.equal(f.db.chatOperations![0].status, 'failed'); assert.equal(f.db.modelUsageRecords[0].chargedMicros, 40);
  assert.equal((await api.post({...f.input, config: {...f.input.config, sourceIds: []}})).status, 409); assert.equal(calls, 1);
});

test('answer-only preview ignores unfinished or stale delivery grants, while original config still fingerprints and publish rejects them', async t => {
  const f = fixture(); let calls = 0;
  const service = {...f.input.config.service, features: [{featureId: 'deleted-feature', releaseId: 'retired-release', when: '', workflow: 'unfinished-tool-workflow'}]};
  const input = {...f.input, config: {...f.input.config, sourceIds: [], service}};
  const api = await http(t, f, async (_model, messages, tools) => {calls++; assert.deepEqual(tools, []); const system = JSON.stringify(messages); assert.match(system, /TEACHER_METHOD/); assert.doesNotMatch(system, /deleted-feature|retired-release|unfinished-tool-workflow/); return answer;});
  const response = await api.post(input); assert.equal(response.status, 200); assert.match((await response.json()).limitations, /不执行功能/);
  const same = await api.post(input); assert.equal(same.status, 200); assert.equal(calls, 1);
  assert.equal((await api.post({...input, config: {...input.config, service: {...service, features: []}}})).status, 409, 'ignored tool settings remain in the original immutable fingerprint');
  assert.throws(() => publish(f.db, {workspaceId: 'ws', userId: 'owner'}, {intent: 'draft', name: '正式保存', description: '', prompt: '', modelId: 'model', sourceIds: [], attachments: false, budget: 1, perRun: .1, days: 7, confirmed: true, service}), /功能未开放|使用条件/);
  assert.equal(f.db.publications!.length, 0); assert.equal(f.db.publicRuns!.length, 0); assert.equal(f.db.publicSessions!.length, 0);
});

test('knowledge-mode test reports no-match, unavailable and partial source evidence without claiming a complete lookup', async t => {
  for (const [index, recall, expected] of [
    [0, {chunks: [], failures: [], status: 'no_match'}, /未检索到相关.*仅依据方法资料/],
    [1, {chunks: [], failures: [{provider: 'notion', code: 'UNAVAILABLE'}], status: 'failed'}, /未能返回可用资料.*仅依据方法资料/],
    [2, {chunks: [{title: '部分资料', content: '已取得的事实'}], failures: [{provider: 'notion', code: 'UNAVAILABLE'}], status: 'partial'}, /部分.*不完整/]
  ] as const) {
    const f = fixture(); const api = await http(t, f, async (_model, messages) => {assert.match(JSON.stringify(messages), /依据方法与已授权资料提供知识服务和真实交付/); assert.doesNotMatch(JSON.stringify(messages), /先了解需求，帮助访客判断适合什么服务/); return answer;}, async () => recall);
    const result = await api.post({...f.input, operationId: `knowledge_evidence_case_${index}`, config: {...f.input.config, service: {...f.input.config.service, mode: 'knowledge'}}});
    assert.equal(result.status, 200); const body = await result.json(); assert.match(body.warning, expected); assert.match(body.limitations, /不执行功能.*不创建文件或公开分享/);
  }
});

test('a lost HTTP receipt recovers the real gateway result and original charge from persisted owner-only state after route restart', async t => {
  const f = fixture(); const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-avatar-preview-receipt-')); t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const receiptFile = path.join(directory, 'synthetic-database.json');
  const originalStore = f.store;
  f.store = {read: () => originalStore.read(), mutate: async action => {const value = await originalStore.mutate(action); await fs.writeFile(receiptFile, JSON.stringify(await originalStore.read())); return value;}};
  let calls = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}); const gate = new Promise<void>(resolve => {release = resolve;});
  const gateway = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const request = JSON.parse(raw); calls++;
    assert.equal(request.max_tokens, 1200); assert.equal(request.tools, undefined); assert.match(JSON.stringify(request.messages), /TEACHER_METHOD/);
    entered(); await gate; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({choices: [{message: {content: 'PRIVATE_PERSISTED_PREVIEW_RESULT'}, finish_reason: 'stop'}], usage: {prompt_tokens: 30, completion_tokens: 10, total_tokens: 40}}));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); t.after(() => {gateway.closeAllConnections(); gateway.close();});
  f.db.models[0].baseUrl = `http://127.0.0.1:${(gateway.address() as any).port}`; f.db.models[0].model = 'fixture';
  const input = {...f.input, config: {...f.input.config, sourceIds: []}};
  const api = await http(t, f, callModelWithTools, async () => {assert.fail('empty selected sources cannot retrieve');});
  const controller = new AbortController(); const lost = api.post(input, {}, controller.signal).then(() => 'received', () => 'lost');
  await started; controller.abort(); assert.equal(await lost, 'lost'); release();
  for (let i = 0; i < 100 && f.db.chatOperations?.[0]?.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.db.chatOperations![0].status, 'completed');
  // Read after the durable write completes, not merely after in-memory mutation.
  let restored: Database | undefined;
  for (let i = 0; i < 100; i++) {try {restored = JSON.parse(await fs.readFile(receiptFile, 'utf8')); if (restored?.chatOperations?.[0]?.avatarPreviewResult) break;} catch {} await new Promise(resolve => setTimeout(resolve, 10));}
  assert.equal(restored!.chatOperations![0].avatarPreviewResult!.response, 'PRIVATE_PERSISTED_PREVIEW_RESULT');
  assert.equal(restored!.chatOperations![0].avatarPreviewResult!.chargedMicros, 40); f.restore(restored!);
  f.db.models[0].enabled = false; // Recovering an existing receipt never starts a new model call.
  const restarted = await http(t, f, async () => {assert.fail('receipt recovery must not call the gateway');}, async () => {assert.fail('receipt recovery must not retrieve knowledge');});
  const replay = await restarted.post(input); assert.equal(replay.status, 200); const result = await replay.json(); assert.equal(result.response, 'PRIVATE_PERSISTED_PREVIEW_RESULT'); assert.equal(result.chargedMicros, 40); assert.equal(calls, 1); assert.equal(f.db.modelUsageRecords.length, 1);
  assert.equal((await restarted.post({...input, config: {...input.config, prompt: 'CHANGED_PROMPT'}})).status, 409);
  assert.equal((await restarted.post({...input, config: {...input.config, sourceIds: ['selected']}})).status, 409);
  assert.notEqual((await restarted.post(input, {'x-user': 'other', 'x-workspace': 'other-ws'})).status, 200);
  f.db.users[0].enabled = false; assert.notEqual((await restarted.post(input)).status, 200); f.db.users[0].enabled = true;
  assert.throws(() => getChatOperationResult(f.db, {workspaceId: 'ws', userId: 'owner', operationId: input.operationId}), /不可用/);
  f.db.users[0].defaultWorkspaceId = 'ws'; f.db.users[1].defaultWorkspaceId = 'other-ws';
  f.db.oneKeyDevices = []; f.db.retrievalLogs = []; f.db.executionTasks = [];
  const adminProjections = JSON.stringify({usage: adminUserUsageDetail(f.db, 'owner'), summary: adminUsageSummaries(f.db), health: capabilityHealth(f.db, [])});
  assert.doesNotMatch(adminProjections, /PRIVATE_PERSISTED_PREVIEW_RESULT|TEACHER_METHOD|CUSTOM_ANSWER|avatarPreviewResult/);
  assert.doesNotMatch(await (await fetch(restarted.url.replace(/\/preview$/, ''), {headers: {'x-key': 'present'}})).text(), /PRIVATE_PERSISTED_PREVIEW_RESULT|avatarPreviewResult/);
});
