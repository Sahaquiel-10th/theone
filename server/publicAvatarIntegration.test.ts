import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import type { Store } from './db.js';
import type { Database, ModelConfig, User } from './types.js';
import type { PublicRun } from './publicSharingTypes.js';
import { AttachmentService } from './attachmentService.js';
import { installPublicSharingRoutes, type PublicAvatarDependencies } from './publicSharingRoutes.js';
import { installPublicApiRoutes } from './publicApiRoutes.js';
import { createWorkbook } from './officeWorkbook.js';

const usage = { inputTokens: 40, outputTokens: 20, totalTokens: 60, source: 'provider' as const };
const quote = { operation: 'quote', dataJson: JSON.stringify({ items: [{ name: '咨询', unit: '次', quantity: 2, unitPrice: 100 }], shipping: 0, taxRate: 0, pricesIncludeTax: true }) };
const scene = { id: 'goal', title: '确认目标', situation: '需要把当前资料整理成方案', feature: '先核对已给数据', advantage: '不用自己重新排版', benefit: '拿到一份可检查的方案', evidence: '核对报价和步骤', steps: ['说明本次目标', '核对方案中的数据'], prompt: '整理当前输入', capabilityIds: [] };
const visual = { version: 1, title: '合成咨询方案', intro: '核对输入，再拿到方案', scenes: [scene, { ...scene, id: 'delivery', title: '拿到成果' }] };
const ownerHeaders = { 'x-key': 'present', 'Content-Type': 'application/json' };

async function harness(t: TestContext, modelToolCall: NonNullable<PublicAvatarDependencies['modelToolCall']>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-avatar-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const user = (id: string, ws: string, name: string): User => ({ id, username: `${id}_account`, role: 'user', passwordHash: 'synthetic-unusable-hash', enabled: true, defaultWorkspaceId: ws, createdAt: at, profile: { workspaceId: ws, displayName: name, updatedAt: at, onboarding: { knowledgeChoice: 'skipped' } } });
  const model: ModelConfig = { id: 'model', name: 'Synthetic model', provider: 'synthetic', kind: 'chat', enabled: true, isDefault: true, apiKey: 'MODEL_SECRET_NOT_PUBLIC', protocol: 'openai', model: 'synthetic', baseUrl: 'https://invalid.example', systemPrompt: 'MODEL_INTERNAL_PROMPT', inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: .2, costOutputPowerPerMillion: .2, createdAt: at };
  const feature = (id: string, toolId: string) => {
    const values = { name: id === 'finance' ? '收益测算' : id === 'workbook' ? '模板填表' : '交互网页', description: '处理本次明确输入并交付', author: 'ONE', instructions: '只处理当前授权输入。', limitations: '不读取其他资料', integration: 'question_answer' as const, modelId: model.id, knowledgeMode: 'none' as const, tools: [{ id: toolId, description: '使用当前输入，交付真实结果' }] };
    const snapshot = { version: 1, values, evidence: 'Synthetic verified release', approvedBy: 'admin', approvedAt: at };
    return { id, revision: 1, status: 'approved' as const, draft: values, current: snapshot, history: [snapshot], release: { id: `${id}-release`, version: 1, userIds: ['owner', 'other'], publishedAt: at, publishedBy: 'admin' } };
  };
  let db = { users: [user('owner', 'owner-space', '林老师'), user('other', 'other-space', '其他老师')], workspaces: [{ id: 'owner-space', name: '老师工作区', slug: 'owner-space', status: 'active', createdAt: at, updatedAt: at }, { id: 'other-space', name: '其他工作区', slug: 'other-space', status: 'active', createdAt: at, updatedAt: at }], workspaceMembers: [{ id: 'owner-member', workspaceId: 'owner-space', userId: 'owner', role: 'owner', createdAt: at }, { id: 'other-member', workspaceId: 'other-space', userId: 'other', role: 'owner', createdAt: at }], models: [model], settings: { safetyRules: 'safe', rechargeCnyPerPower: 7, officialFeatures: [feature('finance', 'oneFinance'), feature('html', 'oneHtml'), feature('workbook', 'oneWorkbook')] }, agents: [], auditLogs: [], publications: [], publicSessions: [], publicRuns: [], attachments: [], conversations: [], messages: [{ content: 'OWNER_PRIVATE_CONVERSATION' }], contextTraces: [], knowledgeConnections: [], modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: 'owner-power', workspaceId: 'owner-space', userId: 'owner', balanceMicros: 100e6, paidBalanceMicros: 100e6, reservedMicros: 0, createdAt: at, updatedAt: at }, { id: 'other-power', workspaceId: 'other-space', userId: 'other', balanceMicros: 100e6, paidBalanceMicros: 100e6, reservedMicros: 0, createdAt: at, updatedAt: at }] } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: fn => { const pending = queue.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } }); queue = pending.catch(() => undefined); return pending; } };
  const app = express(); app.use(express.json());
  const keyAuth: express.RequestHandler = (req, res, next) => {
    if (req.headers['x-key'] !== 'present') { res.sendStatus(428); return; }
    const other = req.headers['x-user'] === 'other'; req.user = db.users.find(u => u.id === (other ? 'other' : 'owner'))!; req.workspaceId = other ? 'other-space' : 'owner-space'; next();
  };
  const knowledge = { recallWithDiagnostics: async (workspaceId: string, _q: string, _k: number, sourceIds: string[]) => { assert.ok(['owner-space', 'other-space'].includes(workspaceId)); assert.deepEqual(sourceIds, []); return { chunks: [], failures: [], status: 'not_connected' }; } };
  installPublicSharingRoutes(app, [keyAuth], store, knowledge as any, new AttachmentService(store, directory), '', { directory, modelToolCall });
  installPublicApiRoutes(app, [keyAuth], store, knowledge as any, undefined, { directory, modelToolCall });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/sharing`;
  const publish = async (other = false, workbook = false) => {
    const response = await fetch(`${base}/manage`, { method: 'POST', headers: { ...ownerHeaders, ...(other ? { 'x-user': 'other' } : {}) }, body: JSON.stringify({ name: '可改名的咨询分身', description: '合成咨询与交付服务', prompt: 'PRIVATE_PUBLICATION_PROMPT', modelId: 'model', sourceIds: [], attachments: workbook, budget: 10, perRun: 1, days: 7, confirmed: true, workspaceId: 'forged-space', authorName: '伪造名人', service: { mode: 'consultation', welcome: '先说说你要解决的事。', starterQuestions: ['帮我准备一份咨询方案'], method: 'PRIVATE_METHOD_MATERIAL：先确认需求，再核对成本和交付。', features: workbook ? [{ featureId: 'workbook', releaseId: 'workbook-release', when: '访客需要填写所选模板', workflow: '核对本次附件编号，填写指定单元格，再交付副本' }] : [{ featureId: 'finance', releaseId: 'finance-release', when: '需要核对报价', workflow: '确认数量和价格，再导出报价' }, { featureId: 'html', releaseId: 'html-release', when: '需要可阅读方案', workflow: '按已有内容生成网页' }] } }) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { id: string; slug: string };
  };
  const session = async (slug: string) => {
    const response = await fetch(`${base}/${slug}/sessions`, { method: 'POST' }); assert.equal(response.status, 200);
    const { token } = await response.json(); return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  const submit = async (slug: string, headers: Record<string, string>, operationId: string) => {
    const body = { content: '请按已确认的合成内容，导出2次100元的咨询报价，再制作说明网页。', operationId, attachmentIds: [] };
    const response = await fetch(`${base}/${slug}/questions`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 202, await response.clone().text()); return { receipt: (await response.json()).run as PublicRun, body };
  };
  const wait = async (slug: string, headers: Record<string, string>, runId: string): Promise<PublicRun> => {
    for (let i = 0; i < 200; i++) {
      const response = await fetch(`${base}/${slug}/questions/${runId}`, { headers }); assert.equal(response.status, 200);
      const { run } = await response.json(); if (run.status !== 'running') return run;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Synthetic public task did not settle');
  };
  return { get db() { return db; }, store, base, directory, publish, session, submit, wait };
}

function callsForBoth() {
  return [{ id: 'finance-call', type: 'function' as const, function: { name: 'public_feature_0', arguments: JSON.stringify({ request: '导出两次咨询报价', tool: 'oneFinance', input: quote }) } }, { id: 'html-call', type: 'function' as const, function: { name: 'public_feature_1', arguments: JSON.stringify({ request: '用已给资料制作方案网页', tool: 'oneHtml', input: visual }) } }];
}

test('real HTTP avatar combines two reviewed features, bills exactly its parent run and isolates actual artifact downloads', async t => {
  let calls = 0;
  const f = await harness(t, async (model, messages, definitions) => {
    calls++; assert.equal(model.id, 'model'); assert.doesNotMatch(JSON.stringify(messages), /OWNER_PRIVATE_CONVERSATION|MODEL_SECRET_NOT_PUBLIC|storagePath/);
    assert.deepEqual(definitions.map(d => d.function.name), ['public_feature_0', 'public_feature_1']);
    if (calls === 1) return { content: '', toolCalls: callsForBoth(), finishReason: 'tool_calls', usage };
    assert.equal(calls, 2); assert.equal(messages.filter(m => m.role === 'tool').length, 2);
    assert.doesNotMatch(JSON.stringify(messages.filter(m => m.role === 'tool')), /api\/attachments|api\/welcome-pages|openUrl|downloadUrl|owner-space/);
    return { content: '报价200元，报价单和说明网页都做好了。', toolCalls: [], finishReason: 'stop', usage };
  });
  assert.equal((await fetch(`${f.base}/manage`)).status, 428);
  const publication = await f.publish(), url = `${f.base}/${publication.slug}`;
  const meta = await (await fetch(url)).json();
  assert.equal(meta.authorName, '林老师'); assert.equal(meta.name, '可改名的咨询分身'); assert.equal(meta.service.starterQuestions.length, 1);
  assert.doesNotMatch(JSON.stringify(meta), /伪造名人|PRIVATE_METHOD|PRIVATE_PUBLICATION|MODEL_SECRET|featureId|releaseId|workflow|owner-space/);
  assert.equal(f.db.publications![0].workspaceId, 'owner-space'); assert.equal(f.db.publications![0].userId, 'owner');
  const guest = await f.session(publication.slug), stranger = await f.session(publication.slug);
  const { receipt, body } = await f.submit(publication.slug, guest, 'http_composite_avatar_1234');
  assert.equal(receipt.status, 'running'); assert.ok(receipt.id);
  const completed = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.artifacts?.length, 2); assert.equal(calls, 2);
  assert.equal(f.db.modelUsageRecords.length, 2); assert.equal(f.db.powerLedger.length, 2);
  assert.ok(f.db.modelUsageRecords.every(row => row.workspaceId === 'owner-space' && row.userId === 'owner' && row.conversationId === receipt.id && row.status === 'success' && row.chargedMicros === 60));
  assert.equal(f.db.powerAccounts[0].balanceMicros, 100e6 - 120); assert.equal(f.db.powerAccounts[1].balanceMicros, 100e6);
  assert.equal(f.db.conversations.length, 0); assert.equal(f.db.messages.length, 1, 'Guest delivery must not create an owner private conversation');
  for (const artifact of completed.artifacts!) {
    const download = `${url}/questions/${receipt.id}/artifacts/${artifact.id}`;
    assert.equal((await fetch(download)).status, 401); assert.equal((await fetch(download, { headers: stranger })).status, 404);
    assert.equal((await fetch(download, { headers: ownerHeaders })).status, 401);
    const response = await fetch(download, { headers: guest }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 100);
    if (artifact.name.endsWith('.xlsx')) { const zip = await JSZip.loadAsync(bytes); assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /200/); }
    else assert.match(bytes.toString(), /合成咨询方案/);
    const row = f.db.attachments.find(file => file.id === artifact.id)!;
    assert.equal(row.workspaceId, 'owner-space'); assert.equal(row.userId, f.db.publicRuns![0].sessionId); assert.equal(row.conversationId, f.db.publicRuns![0].sessionId);
  }
  const repeated = await fetch(`${url}/questions`, { method: 'POST', headers: guest, body: JSON.stringify(body) }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).run.id, receipt.id);
  assert.equal(calls, 2); assert.equal(f.db.publicRuns!.length, 1); assert.equal(f.db.attachments.length, 2); assert.equal(f.db.powerLedger.length, 2);
  assert.equal((await fetch(`${url}/questions/${receipt.id}`, { headers: stranger })).status, 404);
  const another = await f.publish(true), anotherGuest = await f.session(another.slug);
  const target = completed.artifacts![0];
  assert.equal((await fetch(`${f.base}/${another.slug}/questions/${receipt.id}/artifacts/${target.id}`, { headers: anotherGuest })).status, 404);
  assert.equal((await fetch(`${url}/questions/${receipt.id}/artifacts/${target.id}`, { headers: anotherGuest })).status, 401);
  assert.equal((await fetch(`${f.base}/manage/${publication.id}/usage`, { headers: { ...ownerHeaders, 'x-user': 'other' } })).status, 404);
  assert.equal((await fetch(`${f.base}/manage/${publication.id}/close`, { method: 'POST', headers: ownerHeaders })).status, 200);
  assert.equal((await fetch(`${url}/questions/${receipt.id}/artifacts/${target.id}`, { headers: guest })).status, 410);
  assert.equal((await fetch(`${url}/sessions`, { method: 'POST' })).status, 410);
  assert.equal(calls, 2);
});

test('HTTP public failure after file creation preserves the deliverable and never retries or leaks raw model errors', async t => {
  let calls = 0;
  const f = await harness(t, async () => {
    if (++calls === 1) return { content: '', toolCalls: callsForBoth().slice(0, 1), finishReason: 'tool_calls', usage };
    throw new Error('PROVIDER_SECRET_MUST_NOT_LEAK');
  });
  const publication = await f.publish(), guest = await f.session(publication.slug), url = `${f.base}/${publication.slug}`;
  const { receipt, body } = await f.submit(publication.slug, guest, 'http_avatar_partial_12345');
  const failed = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.artifacts?.length, 1); assert.equal(calls, 2); assert.match(failed.error ?? '', /已生成的文件仍可/);
  assert.doesNotMatch(JSON.stringify(failed), /PROVIDER_SECRET|storagePath|MODEL_SECRET/);
  assert.equal(f.db.modelUsageRecords.length, 2); assert.deepEqual(f.db.modelUsageRecords.map(row => row.status), ['success', 'failed']); assert.equal(f.db.powerLedger.length, 1);
  const file = failed.artifacts![0], response = await fetch(`${url}/questions/${receipt.id}/artifacts/${file.id}`, { headers: guest }); assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer()); assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /200/);
  const repeated = await fetch(`${url}/questions`, { method: 'POST', headers: guest, body: JSON.stringify(body) }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).run.id, receipt.id);
  assert.equal(calls, 2); assert.equal(f.db.attachments.length, 1);
});

test('HTTP model and feature revocation prevent new paid execution without granting other tools', async t => {
  let calls = 0;
  const f = await harness(t, async () => { calls++; return { content: '', toolCalls: callsForBoth().slice(0, 1), finishReason: 'tool_calls', usage }; });
  const publication = await f.publish(), guest = await f.session(publication.slug), url = `${f.base}/${publication.slug}`;
  f.db.settings.officialFeatures![0].status = 'paused'; delete f.db.settings.officialFeatures![0].release;
  const { receipt } = await f.submit(publication.slug, guest, 'http_avatar_revoked_12345');
  const failed = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(failed.status, 'failed'); assert.equal(f.db.attachments.length, 0); assert.equal(calls, 0); assert.equal(f.db.modelUsageRecords.length, 0); assert.equal(f.db.powerLedger.length, 0);
  assert.match(failed.error ?? '', /工具还没就位/);
  f.db.models[0].enabled = false;
  const denied = await fetch(`${url}/questions`, { method: 'POST', headers: guest, body: JSON.stringify({ content: '继续', operationId: 'http_avatar_model_off_123', attachmentIds: [] }) });
  assert.equal(denied.status, 503); assert.equal(f.db.publicRuns!.length, 1); assert.equal(calls, 0);
});

test('API avatar reuses the same reviewed features, returns real files and revocation denies receipt and download access', async t => {
  let calls = 0;
  const f = await harness(t, async (_model, messages, definitions) => {
    calls++; assert.deepEqual(definitions.map(d => d.function.name), ['public_feature_0', 'public_feature_1']);
    assert.doesNotMatch(JSON.stringify(messages), /OWNER_PRIVATE_CONVERSATION|MODEL_SECRET_NOT_PUBLIC/);
    return calls === 1 ? { content: '', toolCalls: callsForBoth(), finishReason: 'tool_calls', usage } : { content: 'API 的报价单和网页已生成。', toolCalls: [], finishReason: 'stop', usage };
  });
  const publication = await f.publish(), origin = f.base.replace(/\/api\/sharing$/, ''), api = `${origin}/api/v1`;
  const issue = async () => {
    const response = await fetch(`${origin}/api/sharing-api/manage/${publication.id}/keys`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name: '合成 API 验收', version: 1, budget: 1, perRun: 1, days: 1, confirmed: true }) });
    assert.equal(response.status, 200, await response.clone().text()); return await response.json() as { token: string; grant: { id: string } };
  };
  const first = await issue(), second = await issue(), headers = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' }, foreign = { ...headers, Authorization: `Bearer ${second.token}` };
  const body = { question: '按合成数据给出报价单和网页。', operationId: 'http_avatar_api_combo_1234' };
  const submission = await fetch(`${api}/tasks`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(submission.status, 202);
  const receipt = (await submission.json()).task; assert.ok(receipt.id);
  let completed: PublicRun | undefined;
  for (let i = 0; i < 200; i++) { const response = await fetch(`${api}/tasks/${receipt.id}`, { headers }); assert.equal(response.status, 200); completed = (await response.json()).task; if (completed?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(completed?.status, 'completed'); assert.equal(completed.artifacts?.length, 2); assert.equal(calls, 2);
  assert.ok(f.db.modelUsageRecords.every(row => row.conversationId === receipt.id && row.userId === 'owner')); assert.equal(f.db.powerLedger.length, 2);
  const file = completed.artifacts![0], download = `${api}/tasks/${receipt.id}/artifacts/${file.id}`;
  assert.equal((await fetch(download)).status, 401); assert.equal((await fetch(download, { headers: foreign })).status, 404);
  const response = await fetch(download, { headers }); assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer()); assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /200/);
  const repeated = await fetch(`${api}/tasks`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).task.id, receipt.id); assert.equal(calls, 2); assert.equal(f.db.publicRuns!.length, 1);
  assert.equal((await fetch(`${api}/tasks/${receipt.id}`, { headers: foreign })).status, 404);
  const revoked = await fetch(`${origin}/api/sharing-api/manage/${publication.id}/keys/${first.grant.id}/revoke`, { method: 'POST', headers: ownerHeaders }); assert.equal(revoked.status, 200);
  assert.equal((await fetch(download, { headers })).status, 401); assert.equal((await fetch(`${api}/tasks/${receipt.id}`, { headers })).status, 401);
  const retry = await fetch(`${api}/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...body, operationId: 'http_avatar_revoked_api_1234' }) }); assert.equal(retry.status, 401); assert.equal(calls, 2);
});

test('HTTP delegated feature uses its own published model pricing and bills every child call to the same guest task exactly once', async t => {
  let parentCalls = 0, featureCalls = 0;
  const f = await harness(t, async (model, _messages, definitions) => {
    if (definitions[0]?.function.name === 'public_oneFinance') {
      assert.equal(model.id, 'feature-model'); featureCalls++;
      return featureCalls === 1 ? { content: '', toolCalls: [{ id: 'inner-quote', type: 'function', function: { name: 'public_oneFinance', arguments: JSON.stringify(quote) } }], finishReason: 'tool_calls', usage } : { content: '真实报价总计200元，已生成报价单。', toolCalls: [], finishReason: 'stop', usage };
    }
    assert.equal(model.id, 'model'); parentCalls++;
    return parentCalls === 1 ? { content: '', toolCalls: [{ id: 'feature-quote', type: 'function', function: { name: 'public_feature_0', arguments: JSON.stringify({ request: '咨询2次，每次100元，无运费，无税额，单价含税。请计算并导出报价单。' }) } }], finishReason: 'tool_calls', usage } : { content: '报价单已经做好，总计200元。', toolCalls: [], finishReason: 'stop', usage };
  });
  f.db.models.push({ ...f.db.models[0], id: 'feature-model', name: '独立功能模型', inputPowerPerMillion: 2, outputPowerPerMillion: 2 });
  f.db.settings.officialFeatures![0].history[0].values.modelId = 'feature-model';
  const publication = await f.publish(), guest = await f.session(publication.slug);
  const { receipt, body } = await f.submit(publication.slug, guest, 'http_avatar_inner_bill_1234');
  const completed = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.artifacts?.length, 1);
  assert.equal(parentCalls, 2); assert.equal(featureCalls, 2); assert.equal(f.db.modelUsageRecords.length, 4); assert.equal(f.db.powerLedger.length, 4);
  assert.ok(f.db.modelUsageRecords.every(row => row.conversationId === receipt.id && row.workspaceId === 'owner-space' && row.userId === 'owner' && row.status === 'success'));
  const inner = f.db.modelUsageRecords.filter(row => row.activity === 'public_feature');
  assert.equal(inner.length, 2); assert.ok(inner.every(row => row.modelId === 'feature-model' && row.featurePriceSnapshot?.id === 'finance' && row.featurePriceSnapshot.releaseId === 'finance-release' && row.featurePriceSnapshot.multiplier === .6 && row.chargedMicros === 72));
  assert.equal(f.db.powerAccounts[0].balanceMicros, 100e6 - 264);
  const repeated = await fetch(`${f.base}/${publication.slug}/questions`, { method: 'POST', headers: guest, body: JSON.stringify(body) }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).run.id, receipt.id);
  assert.equal(parentCalls + featureCalls, 4); assert.equal(f.db.powerLedger.length, 4); assert.equal(f.db.attachments.length, 1);
});

test('HTTP tool rejection cannot become a completed task even when the next model falsely claims success', async t => {
  let calls = 0;
  const f = await harness(t, async () => ++calls === 1 ? { content: '', toolCalls: [{ id: 'bad-quote', type: 'function', function: { name: 'public_feature_0', arguments: JSON.stringify({ request: '导出报价', tool: 'oneFinance', input: { operation: 'quote', dataJson: '{}' } }) } }], finishReason: 'tool_calls', usage } : { content: 'FALSE_SUCCESS：所有文件都完成了。', toolCalls: [], finishReason: 'stop', usage });
  const publication = await f.publish(), guest = await f.session(publication.slug);
  const { receipt, body } = await f.submit(publication.slug, guest, 'http_avatar_false_done_1234');
  const result = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(calls, 2); assert.equal(result.status, 'failed'); assert.equal(result.artifacts?.length, 0); assert.equal(result.response, undefined);
  assert.match(result.error ?? '', /有一步没能做完/); assert.doesNotMatch(JSON.stringify(result), /FALSE_SUCCESS/);
  const repeated = await fetch(`${f.base}/${publication.slug}/questions`, { method: 'POST', headers: guest, body: JSON.stringify(body) }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).run.id, receipt.id); assert.equal(calls, 2);
});

test('HTTP mixed success and rejected feature retains its first real download without reporting the entire task complete', async t => {
  let calls = 0;
  const bad = callsForBoth(); bad[1].function.arguments = JSON.stringify({ request: '制作网页', tool: 'oneHtml', input: { ...visual, scenes: [] } });
  const f = await harness(t, async () => ++calls === 1 ? { content: '', toolCalls: bad, finishReason: 'tool_calls', usage } : { content: 'FALSE_SUCCESS：报价单和网页全都完成。', toolCalls: [], finishReason: 'stop', usage });
  const publication = await f.publish(), guest = await f.session(publication.slug);
  const { receipt } = await f.submit(publication.slug, guest, 'http_avatar_partial_done_1234');
  const result = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(calls, 2); assert.equal(result.status, 'failed'); assert.equal(result.response, undefined); assert.equal(result.artifacts?.length, 1);
  assert.match(result.error ?? '', /已生成的文件仍可查看/); assert.doesNotMatch(JSON.stringify(result), /FALSE_SUCCESS/);
  const file = result.artifacts![0], response = await fetch(`${f.base}/${publication.slug}/questions/${receipt.id}/artifacts/${file.id}`, { headers: guest }); assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer()); assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /200/);
  assert.equal(f.db.attachments.length, 1); assert.equal(f.db.powerLedger.length, 2);
});

test('HTTP corrected schema succeeds after an earlier rejection when that same feature actually delivers its file', async t => {
  let calls = 0;
  const f = await harness(t, async () => {
    calls++;
    if (calls === 1) return { content: '', toolCalls: [{ id: 'invalid-wrapper', type: 'function', function: { name: 'public_feature_0', arguments: JSON.stringify({ tool: 'oneFinance', input: quote }) } }], finishReason: 'tool_calls', usage };
    if (calls === 2) return { content: '', toolCalls: callsForBoth().slice(0, 1), finishReason: 'tool_calls', usage };
    return { content: '已核对真实报价200元，报价单已经做好。', toolCalls: [], finishReason: 'stop', usage };
  });
  const publication = await f.publish(), guest = await f.session(publication.slug);
  const { receipt, body } = await f.submit(publication.slug, guest, 'http_avatar_schema_repair_1234');
  const result = await f.wait(publication.slug, guest, receipt.id);
  assert.equal(calls, 3); assert.equal(result.status, 'completed', result.error); assert.equal(result.error, undefined); assert.equal(result.artifacts?.length, 1); assert.match(result.response ?? '', /200元/);
  const file = result.artifacts![0], response = await fetch(`${f.base}/${publication.slug}/questions/${receipt.id}/artifacts/${file.id}`, { headers: guest }); assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer()); assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /200/);
  assert.equal(f.db.powerLedger.length, 3); assert.equal(f.db.attachments.length, 1);
  const repeated = await fetch(`${f.base}/${publication.slug}/questions`, { method: 'POST', headers: guest, body: JSON.stringify(body) }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).run.id, receipt.id); assert.equal(calls, 3);
});

test('HTTP uploaded guest workbook is really filled through scoped readers and another guest cannot reuse its attachment ID', async t => {
  let calls = 0, inputId = '';
  const f = await harness(t, async (_model, messages, definitions) => {
    calls++; assert.deepEqual(definitions.map(d => d.function.name), ['public_feature_0']); assert.match(JSON.stringify(messages), new RegExp(inputId)); assert.match(JSON.stringify(messages), /来访预算模板.xlsx/); assert.doesNotMatch(JSON.stringify(messages), /storagePath|OWNER_PRIVATE_CONVERSATION/);
    return calls === 1 ? { content: '', toolCalls: [{ id: 'fill-uploaded-template', type: 'function', function: { name: 'public_feature_0', arguments: JSON.stringify({ request: '保持模板，填写登记表B2预算2400元', tool: 'oneWorkbook', input: { operation: 'fill', dataJson: JSON.stringify({ attachmentId: inputId, title: '来访预算已填', updates: [{ sheet: '登记', cell: 'B2', value: 2400 }] }) } }) } }], finishReason: 'tool_calls', usage } : { content: '已按模板填写预算2400元，副本已经做好。', toolCalls: [], finishReason: 'stop', usage };
  });
  const publication = await f.publish(false, true), guest = await f.session(publication.slug), stranger = await f.session(publication.slug), url = `${f.base}/${publication.slug}`;
  const template = await createWorkbook({ title: '来访预算模板', sheets: [{ name: '登记', headers: ['客户', '预算'], rows: [['合成客户', 0]] }] });
  const allocated = await fetch(`${url}/uploads`, { method: 'POST', headers: guest, body: JSON.stringify({ name: template.name, size: template.bytes.length, mimeType: template.mime }) }); assert.equal(allocated.status, 200, await allocated.clone().text()); inputId = (await allocated.json()).attachment.id;
  const chunk = await fetch(`${url}/uploads/${inputId}/chunks?offset=0`, { method: 'PUT', headers: { ...guest, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(template.bytes).buffer }); assert.equal(chunk.status, 200);
  assert.equal((await fetch(`${url}/uploads/${inputId}/complete`, { method: 'POST', headers: guest })).status, 200);
  let ready = false;
  for (let i = 0; i < 200; i++) { const state = await (await fetch(`${url}/uploads/${inputId}`, { headers: guest })).json(); if (state.attachment.status === 'ready') { ready = true; break; } assert.notEqual(state.attachment.status, 'failed', state.attachment.parseError); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(ready, true, 'Uploaded XLSX must finish the actual attachment parser');
  const original = f.db.attachments.find(file => file.id === inputId)!;
  const payload = { content: '按所选模板，把登记表B2预算填为2400元并交付副本。', operationId: 'http_avatar_uploaded_fill_1234', attachmentIds: [inputId] };
  const denied = await fetch(`${url}/questions`, { method: 'POST', headers: stranger, body: JSON.stringify(payload) }); assert.equal(denied.status, 400); assert.equal(calls, 0); assert.equal(f.db.publicRuns!.length, 0);
  const submission = await fetch(`${url}/questions`, { method: 'POST', headers: guest, body: JSON.stringify(payload) }); assert.equal(submission.status, 202); const receipt = (await submission.json()).run;
  const completed = await f.wait(publication.slug, guest, receipt.id); assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.artifacts?.length, 1); assert.equal(calls, 2);
  const file = completed.artifacts![0], response = await fetch(`${url}/questions/${receipt.id}/artifacts/${file.id}`, { headers: guest }); assert.equal(response.status, 200);
  const actual = XLSX.read(await response.arrayBuffer(), { type: 'array' }); assert.equal(actual.Sheets['登记'].B2.v, 2400); assert.equal(actual.Sheets['登记'].A2.v, '合成客户');
  assert.deepEqual(await fs.readFile(original.storagePath), template.bytes); assert.equal(original.userId, f.db.publicRuns![0].sessionId); assert.equal(f.db.conversations.length, 0);
  assert.equal(f.db.modelUsageRecords.length, 2); assert.equal(f.db.powerLedger.length, 2); assert.ok(f.db.modelUsageRecords.every(row => row.conversationId === receipt.id));
  assert.equal((await fetch(`${url}/questions/${receipt.id}/artifacts/${file.id}`, { headers: stranger })).status, 404);
});
