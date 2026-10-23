import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import { createWorkbook } from './officeWorkbook.js';
import type { Database } from './types.js';
import type { Store } from './db.js';
import { availablePublicAvatarFeatures, validateAvatarFeatureGrants, createPublicAvatarFeatureTools, type PublicAvatarFeatureDependencies } from './publicAvatarFeatures.js';
import { OrchestrationToolError } from './taskOrchestrator.js';

const scope = { workspaceId: 'owner-space', userId: 'owner' };
function fixture(toolIds = ['oneFinance']) {
  const values = { name: '老师测算', description: '按用户数据测算', author: 'ONE', instructions: '使用实际工具，缺数据先问，不猜数字。', limitations: '只处理当前输入', integration: 'question_answer', modelId: 'model', usageMultiplier: .6, tools: toolIds.map(id => ({ id, description: '处理当前用户输入' })) };
  const version = { version: 1, values, evidence: '合成验收', approvedBy: 'admin', approvedAt: 't' };
  const db = { users: [{ id: 'owner', enabled: true }, { id: 'other', enabled: true }], workspaces: [{ id: 'owner-space', status: 'active' }, { id: 'other-space', status: 'active' }], workspaceMembers: [{ workspaceId: 'owner-space', userId: 'owner' }, { workspaceId: 'other-space', userId: 'other' }], models: [{ id: 'model', kind: 'chat', enabled: true, apiKey: 'synthetic-secret', systemPrompt: '合成模型' }], settings: { officialFeatures: [{ id: 'finance', status: 'approved', revision: 1, draft: values, current: version, history: [version], release: { id: 'release-1', version: 1, userIds: ['owner'], publishedAt: 't', publishedBy: 'admin' } }] } } as unknown as Database;
  const store = { read: async () => db, mutate: async <T>(fn: (d: Database) => T) => fn(db) } as Store;
  const grant = { featureId: 'finance', releaseId: 'release-1', when: '需要测算收益或整理文件', workflow: '先确认输入，再真实测算并交付' };
  const p = { id: 'pub', ...scope, service: { features: [grant] } }, run = { id: 'run', workspaceId: scope.workspaceId, userId: 'guest-session', sessionId: 'guest-session', publicationId: 'pub' };
  db.publicRuns = [{ ...run, operationId: 'synthetic-operation', payloadHash: 'synthetic', content: '合成问题', attachmentIds: [], status: 'running', createdAt: new Date().toISOString() }];
  db.publicSessions = [{ id: run.sessionId, workspaceId: scope.workspaceId, userId: run.userId, publicationId: 'pub', tokenHash: 'synthetic', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), uploadCount: 0, uploadBytes: 0 }];
  const saved: { name: string; bytes: Buffer; mimeType: string; kind: string }[] = [];
  let calls = 0, checks = 0;
  const deps: PublicAvatarFeatureDependencies = { directory: '/synthetic-private', verify: async () => { checks++; }, bill: async () => { calls++; throw new Error('unexpected model call'); }, saveArtifact: async file => { saved.push(file); return { id: `artifact-${saved.length}`, name: file.name }; } };
  return { db, store, grant, p, run, saved, deps, calls: () => calls, checks: () => checks, values: db.settings.officialFeatures![0].history[0].values };
}
function invoke(f: ReturnType<typeof fixture>, input: unknown) {
  const tool = createPublicAvatarFeatureTools(f.store, f.p, f.run, f.deps)[0];
  return tool.structured!.run(tool.structured!.validate(input)) as Promise<any>;
}
const profit = { operation: 'profit', dataJson: JSON.stringify({ revenue: 1000, variableCost: 300, fixedCost: 200, quantity: 10 }) };
const quote = { operation: 'quote', dataJson: JSON.stringify({ items: [{ name: '咨询', unit: '次', quantity: 2, unitPrice: 100 }], shipping: 0, taxRate: 0, pricesIncludeTax: true }) };

test('safe public feature catalog respects membership, approved exact release and actual model availability', () => {
  const f = fixture();
  assert.deepEqual(availablePublicAvatarFeatures(f.db, scope), [{ id: 'finance', releaseId: 'release-1', name: '老师测算', description: '按用户数据测算', usageMultiplier: .6 }]);
  assert.deepEqual(availablePublicAvatarFeatures(f.db, { workspaceId: 'other-space', userId: 'other' }), []);
  assert.throws(() => availablePublicAvatarFeatures(f.db, { workspaceId: 'owner-space', userId: 'other' }), /账号或空间/);
  f.db.models[0].enabled = false;
  assert.deepEqual(availablePublicAvatarFeatures(f.db, scope), []);
  f.db.models[0].enabled = true; f.db.settings.officialFeatures![0].status = 'paused';
  assert.deepEqual(availablePublicAvatarFeatures(f.db, scope), []);
});

test('catalog refuses external dependencies, credentials, images, laptop access and mandatory private knowledge', () => {
  for (const tool of ['sandboxLookup', 'oneSlides', 'knowledge_search', 'web_search', 'run_command']) assert.deepEqual(availablePublicAvatarFeatures(fixture([tool]).db, scope), []);
  for (const extra of [{ auth: 'bearer' }, { operationId: 'hidden' }, { document: {} }, { mcp: { endpoint: 'https://example.com', tool: {} } }]) {
    const f = fixture(); Object.assign(f.values.tools![0], extra); assert.deepEqual(availablePublicAvatarFeatures(f.db, scope), []);
  }
  const f = fixture(); f.values.knowledgeMode = 'required'; assert.deepEqual(availablePublicAvatarFeatures(f.db, scope), []);
  delete f.values.knowledgeMode; f.values.usageMultiplier = 3; assert.deepEqual(availablePublicAvatarFeatures(f.db, scope), []);
});

test('selection binds exact release, rejects duplicates and unreviewed properties without changing old grants', () => {
  const f = fixture(); assert.deepEqual(validateAvatarFeatureGrants(f.db, scope, [f.grant]), [f.grant]);
  assert.deepEqual(validateAvatarFeatureGrants(f.db, scope, undefined), []);
  for (const input of [[{ ...f.grant, releaseId: 'old' }], [f.grant, f.grant], Array(5).fill(f.grant), [{ ...f.grant, when: '' }], [{ ...f.grant, secret: 'no' }]]) assert.throws(() => validateAvatarFeatureGrants(f.db, scope, input));
  assert.throws(() => validateAvatarFeatureGrants(f.db, { workspaceId: 'other-space', userId: 'other' }, [f.grant]), /未开放/);
});

test('direct finance reuses actual ONE calculation with zero extra model calls and no persistence requirement', async () => {
  const f = fixture(); f.deps.directory = undefined;
  const result = await invoke(f, { request: '核对收益', tool: 'oneFinance', input: profit });
  assert.equal(result.status, 'completed'); assert.equal(result.result.operatingProfit, 500); assert.equal(result.result.breakEvenQuantity, 3);
  assert.deepEqual(result.files, []); assert.equal(f.calls(), 0); assert.equal(f.saved.length, 0); assert.ok(f.checks() >= 3);
});

test('real quotation exports actual XLSX in guest-owned callback, not owner attachment endpoints', async () => {
  const f = fixture(); const result = await invoke(f, { request: '导出报价单', tool: 'oneFinance', input: quote });
  assert.equal(result.result.total, 200); assert.equal(f.saved.length, 1); assert.equal(f.saved[0].mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const zip = await JSZip.loadAsync(f.saved[0].bytes); assert.match(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /200/);
  assert.deepEqual(result.files, [{ id: 'artifact-1', name: '报价单.xlsx' }]); assert.equal(f.calls(), 0);
  assert.doesNotMatch(JSON.stringify(result), /api\/attachments|storagePath|synthetic-secret|owner-space/);
});

const scene = { id: 'first', title: '先确认目标', situation: '想要说明使用方法', feature: '整理目标', advantage: '不用反复翻找', benefit: '拿到可用的步骤', evidence: '按实际结果核对', steps: ['确认输入', '检查结果'], prompt: '请整理当前输入', capabilityIds: [] };
const doc = { version: 1, title: '服务说明', intro: '先整理，再行动', scenes: [scene, { ...scene, id: 'second', title: '检查成果' }] };
test('two reviewed features can produce private HTML and SVG using shared renderer without another model', async () => {
  for (const id of ['oneHtml', 'oneFlowchart']) {
    const f = fixture([id]); const result = await invoke(f, { request: '制作服务说明', tool: id, input: doc });
    assert.equal(result.status, 'completed'); assert.equal(f.saved.length, 1); assert.equal(f.calls(), 0);
    assert.match(f.saved[0].bytes.toString(), id === 'oneHtml' ? /<!doctype html>/i : /<svg/);
    assert.doesNotMatch(JSON.stringify(result), /api\/attachments|api\/welcome-pages|openUrl|downloadUrl/);
  }
});

test('nested feature model receives exact configuration and every model call passes feature-price billing', async () => {
  const f = fixture(); let calls = 0;
  f.deps.bill = async input => {
    calls++; assert.equal(input.featurePrice.id, 'finance'); assert.equal(input.featurePrice.releaseId, 'release-1'); assert.equal(input.featurePrice.multiplier, .6); assert.equal(input.model.id, 'model');
    assert.match(String(input.messages[0].content), /先确认输入/); assert.deepEqual(input.tools.map(t => t.function.name), ['public_oneFinance']);
    if (calls === 1) return { content: '', toolCalls: [{ id: 'call1', type: 'function', function: { name: 'public_oneFinance', arguments: JSON.stringify(profit) } }], finishReason: 'tool_calls' };
    assert.match(String(input.messages.at(-1)?.content), /operatingProfit/); return { content: '经营利润是500元。', toolCalls: [], finishReason: 'stop' };
  };
  const result = await invoke(f, { request: '收入1000成本300固定200共10次，帮我测算' });
  assert.equal(calls, 2); assert.equal(result.status, 'completed'); assert.equal(result.content, '经营利润是500元。');
});

test('scope mismatch, release drift and disabled feature stop before any model or file call', async () => {
  const f = fixture();
  assert.throws(() => createPublicAvatarFeatureTools(f.store, f.p, { ...f.run, workspaceId: 'other-space' }, f.deps), /不属于/);
  assert.throws(() => createPublicAvatarFeatureTools(f.store, f.p, { ...f.run, userId: 'other' }, f.deps), /不属于/);
  const tool = createPublicAvatarFeatureTools(f.store, f.p, f.run, f.deps)[0];
  f.db.settings.officialFeatures![0].release!.id = 'release-2';
  await assert.rejects(tool.structured!.run({ request: '测算', tool: 'oneFinance', input: profit }), error => error instanceof OrchestrationToolError);
  assert.equal(f.calls(), 0); assert.equal(f.saved.length, 0);
});

test('fresh release check occurs again before export and file callback cannot leak an owner URL', async () => {
  const f = fixture(); let checks = 0;
  f.deps.verify = async () => { if (++checks === 3) f.db.settings.officialFeatures![0].release!.id = 'new-release'; };
  await assert.rejects(invoke(f, { request: '导出报价', tool: 'oneFinance', input: quote }), error => error instanceof OrchestrationToolError);
  assert.equal(f.saved.length, 0);
});

test('direct input cannot invoke an unselected tool or read owner attachments', async () => {
  const f = fixture(); await assert.rejects(invoke(f, { request: '制作网页', tool: 'oneHtml', input: doc }), /没有开放/);
  for (const id of ['oneTable', 'oneWorkbook']) {
    const g = fixture([id]); await assert.rejects(invoke(g, { request: '读文件', tool: id, input: { operation: id === 'oneTable' ? 'clean' : 'inspect', dataJson: JSON.stringify({ attachmentId: 'owner-private-file' }) } }), /附件不可用|选中的模板/);
    assert.equal(g.saved.length, 0); assert.equal(g.calls(), 0);
  }
});

test('fabricated tool calls never execute and repeated failures are bounded, not silently retried forever', async () => {
  const f = fixture(); let calls = 0;
  f.deps.bill = async () => { calls++; return { content: '', toolCalls: [{ id: `call-${calls}`, type: 'function', function: { name: 'web_search', arguments: '{"query":"secret"}' } }], finishReason: 'tool_calls' }; };
  await assert.rejects(invoke(f, { request: '联网搜索' }), /还没能正确接上/);
  assert.equal(calls, 2); assert.equal(f.saved.length, 0);
});

test('plain prose cannot masquerade as feature completion, and unavailable storage preserves no fake receipt', async () => {
  const f = fixture(); f.deps.bill = async () => ({ content: '我已经完成计算了', toolCalls: [], finishReason: 'stop' });
  const result = await invoke(f, { request: '测算' }); assert.equal(result.status, 'failed'); assert.match(result.message, /还没有取得所需结果/);
  const g = fixture(['oneHtml']); g.deps.directory = undefined;
  await assert.rejects(invoke(g, { request: '生成网页', tool: 'oneHtml', input: doc }), /暂时无法保存/); assert.equal(g.saved.length, 0);
});

test('fresh guest-run and session binding prevents another guest or workspace from borrowing feature grants', async () => {
  for (const change of ['foreign-user', 'foreign-session', 'foreign-workspace', 'stopped', 'expired'] as const) {
    const f = fixture();
    if (change === 'foreign-user') f.db.publicRuns![0].userId = 'different-guest';
    if (change === 'foreign-session') f.db.publicSessions![0].publicationId = 'different-publication';
    if (change === 'foreign-workspace') f.db.publicRuns![0].workspaceId = 'different-space';
    if (change === 'stopped') f.db.publicRuns![0].status = 'interrupted';
    if (change === 'expired') f.db.publicSessions![0].expiresAt = '2000-01-01T00:00:00Z';
    await assert.rejects(invoke(f, { request: '核对收益', tool: 'oneFinance', input: profit }), /会话或任务已失效/);
    assert.equal(f.calls(), 0); assert.equal(f.saved.length, 0);
  }
});

test('a calculation cannot pretend to satisfy a feature that also requires a file deliverable', async () => {
  const f = fixture(['oneFinance', 'oneHtml']); let calls = 0;
  f.deps.bill = async () => ++calls === 1 ? { content: '', toolCalls: [{ id: 'finance', type: 'function', function: { name: 'public_oneFinance', arguments: JSON.stringify(profit) } }], finishReason: 'tool_calls' } : { content: '计算和网页都做好了。', toolCalls: [], finishReason: 'stop' };
  const result = await invoke(f, { request: '测算并制作网页' });
  assert.equal(result.status, 'failed'); assert.equal(f.saved.length, 0);
});

test('a provider failure after an artifact does not erase the already saved guest deliverable', async () => {
  const f = fixture(['oneHtml']); let calls = 0;
  f.deps.bill = async () => {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'html', type: 'function', function: { name: 'public_oneHtml', arguments: JSON.stringify(doc) } }], finishReason: 'tool_calls' };
    throw new Error('synthetic model outage');
  };
  await assert.rejects(invoke(f, { request: '制作网页' }), /synthetic model outage/);
  assert.equal(calls, 2); assert.equal(f.saved.length, 1); assert.match(f.saved[0].bytes.toString(), /服务说明/);
});

function addGuestInput(f: ReturnType<typeof fixture>, id: string, name: string, size: number) {
  (f.db.attachments ??= []).push({ id, workspaceId: f.run.workspaceId, userId: f.run.userId, conversationId: f.run.sessionId, originalName: name, kind: 'spreadsheet', mimeType: name.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size, status: 'ready', extractedText: '', storagePath: '/synthetic-private/' + id, createdAt: new Date().toISOString() });
  (f.deps.inputFiles ??= []).push({ id, name, kind: 'spreadsheet' });
}

test('selected guest XLSX template is really filled without modifying the original or adding a model call', async () => {
  const f = fixture(['oneWorkbook']);
  const template = await createWorkbook({ title: '预算模板', sheets: [{ name: '登记', headers: ['客户', '预算'], rows: [['原始客户', 0]] }] });
  addGuestInput(f, 'guest-template', '预算模板.xlsx', template.bytes.length); let reads = 0;
  f.deps.readOffice = async id => { assert.equal(id, 'guest-template'); reads++; return template.bytes; };
  const result = await invoke(f, { request: '填写模板', tool: 'oneWorkbook', input: { operation: 'fill', dataJson: JSON.stringify({ attachmentId: 'guest-template', title: '已填预算', updates: [{ sheet: '登记', cell: 'A2', value: '客户甲' }, { sheet: '登记', cell: 'B2', value: 1200 }] }) } });
  assert.equal(result.status, 'completed'); assert.equal(reads, 1); assert.equal(f.saved.length, 1); assert.equal(f.calls(), 0);
  const actual = XLSX.read(f.saved[0].bytes, { type: 'buffer' }); assert.equal(actual.Sheets['登记'].A2.v, '客户甲'); assert.equal(actual.Sheets['登记'].B2.v, 1200);
  assert.equal(XLSX.read(template.bytes, { type: 'buffer' }).Sheets['登记'].A2.v, '原始客户');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|storagePath|api\/attachments/);
});

test('guest attachment allowlist and canonical ownership reject unknown and other-guest IDs before any reader runs', async () => {
  for (const mode of ['unknown', 'other-guest', 'other-workspace', 'not-ready'] as const) {
    const f = fixture(['oneWorkbook']); addGuestInput(f, 'template', '模板.xlsx', 100);
    if (mode === 'unknown') f.deps.inputFiles = [];
    if (mode === 'other-guest') f.db.attachments[0].userId = 'other-guest';
    if (mode === 'other-workspace') f.db.attachments[0].workspaceId = 'other-space';
    if (mode === 'not-ready') f.db.attachments[0].status = 'uploading';
    let reads = 0; f.deps.readOffice = async () => { reads++; throw Error('must not read'); };
    await assert.rejects(invoke(f, { request: '查看模板', tool: 'oneWorkbook', input: { operation: 'inspect', dataJson: JSON.stringify({ attachmentId: 'template' }) } }), /未选择此附件|不属于当前访客/);
    assert.equal(reads, 0); assert.equal(f.saved.length, 0); assert.equal(f.calls(), 0);
  }
});

test('selected guest tables merge through the existing table implementation and deliver a real workbook', async () => {
  const f = fixture(['oneTable']), csvs = new Map([['left', '姓名,金额\n甲,10'], ['right', '姓名,金额\n乙,20']]);
  for (const [id, csv] of csvs) addGuestInput(f, id, `${id}.csv`, Buffer.byteLength(csv));
  const reads: string[] = []; f.deps.readTable = async id => { reads.push(id); return csvs.get(id)!; };
  const result = await invoke(f, { request: '合并这两份表', tool: 'oneTable', input: { operation: 'merge', dataJson: JSON.stringify({ attachmentIds: ['left', 'right'] }) } });
  assert.equal(result.status, 'completed'); assert.deepEqual(reads, ['left', 'right']); assert.equal(f.saved.length, 1);
  const actual = XLSX.read(f.saved[0].bytes, { type: 'buffer' }); assert.deepEqual(XLSX.utils.sheet_to_json(actual.Sheets[actual.SheetNames[0]], { header: 1 }), [['姓名', '金额'], ['甲', '10'], ['乙', '20']]);
});

test('nested feature model receives only the guest-selected bounded attachment index and can fill the actual template', async () => {
  const f = fixture(['oneWorkbook']); const template = await createWorkbook({ title: '模板', sheets: [{ name: '登记', headers: ['客户'], rows: [['原始']] }] });
  addGuestInput(f, 'selected-guest-template', '来访者登记.xlsx', template.bytes.length); f.deps.readOffice = async () => template.bytes; let calls = 0;
  f.deps.bill = async input => {
    calls++; const prompt = String(input.messages[0].content); assert.match(prompt, /selected-guest-template/); assert.match(prompt, /来访者登记.xlsx/); assert.doesNotMatch(prompt, /synthetic-private|storagePath/);
    return calls === 1 ? { content: '', toolCalls: [{ id: 'fill-template', type: 'function', function: { name: 'public_oneWorkbook', arguments: JSON.stringify({ operation: 'fill', dataJson: JSON.stringify({ attachmentId: 'selected-guest-template', title: '已填登记', updates: [{ sheet: '登记', cell: 'A2', value: '来访者甲' }] }) }) } }], finishReason: 'tool_calls' } : { content: '登记表已填好。', toolCalls: [], finishReason: 'stop' };
  };
  const result = await invoke(f, { request: '使用已选登记模板填写来访者甲' });
  assert.equal(result.status, 'completed'); assert.equal(calls, 2); assert.equal(f.saved.length, 1); assert.equal(XLSX.read(f.saved[0].bytes, { type: 'buffer' }).Sheets['登记'].A2.v, '来访者甲');
});

test('revocation during a guest input read and oversized reader output stop before any artifact save', async () => {
  const f = fixture(['oneWorkbook']); addGuestInput(f, 'template', '模板.xlsx', 100);
  f.deps.readOffice = async () => { f.db.attachments[0].userId = 'different-guest'; return Buffer.from('synthetic'); };
  await assert.rejects(invoke(f, { request: '查看模板', tool: 'oneWorkbook', input: { operation: 'inspect', dataJson: '{"attachmentId":"template"}' } }), /不属于当前访客/);
  assert.equal(f.saved.length, 0);
  const g = fixture(['oneTable']); addGuestInput(g, 'large', '大表.csv', 1); g.deps.readTable = async () => 'x'.repeat(120001);
  await assert.rejects(invoke(g, { request: '整理表格', tool: 'oneTable', input: { operation: 'clean', dataJson: '{"attachmentId":"large"}' } }), /超过 120000 字/);
  assert.equal(g.saved.length, 0);
});
