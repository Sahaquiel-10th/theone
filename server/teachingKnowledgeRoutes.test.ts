import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { Store } from './db.js';
import type { Database, KnowledgeConnection, ModelConfig } from './types.js';
import { installTeachingKnowledgeRoutes, type TeachingKnowledgeRouteDependencies } from './teachingKnowledgeRoutes.js';
import { bindTeachingKnowledgeSources } from './teachingKnowledge.js';
import { installTeachingAiRoutes, type TeachingAiRouteDependencies } from './teachingAiRoutes.js';
import { addTeachingSubmission, authTeachingSession, createTeachingActivity, createTeachingCourse, createTeachingSession, publishTeachingCourse, teachingState, TeachingError } from './teaching.js';

const teacher = { workspaceId: 'wa', userId: 'teacher-a' }, other = { workspaceId: 'wb', userId: 'teacher-b' };
const page = 'a'.repeat(32), privatePage = 'b'.repeat(32), unselectedPage = 'c'.repeat(32);
const headers = { 'Content-Type': 'application/json', 'x-teacher': teacher.userId, 'x-key': 'present' };
function database() {
  const model = { id: 'model', name: 'Synthetic', provider: 'synthetic', kind: 'chat', protocol: 'openai', enabled: true, isDefault: true, apiKey: 'SYNTHETIC_MODEL_SECRET', baseUrl: 'https://never-used.invalid', systemPrompt: '', inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: 'now' } as ModelConfig;
  const c = { id: 'notion-a', workspaceId: 'wa', provider: 'notion', clientId: 'client-a', status: 'connected', providerUserId: 'remote-a', providerSpaceId: 'space-a', providerSpaceName: '老师笔记', encryptedAccessToken: 'PRIVATE_NOTION_CREDENTIAL', createdAt: 'now', updatedAt: 'now' } as KnowledgeConnection;
  return { users: [teacher, other].map(scope => ({ id: scope.userId, username: scope.userId, enabled: true, defaultWorkspaceId: scope.workspaceId })), workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: [teacher, other].map(scope => ({ ...scope, role: 'owner' })), knowledgeConnections: [c, { ...c, id: 'notion-b', workspaceId: 'wb', providerUserId: 'remote-b' }, { ...c, id: 'getnote-a', provider: 'getnote', providerSpaceName: '得到资料' }, { ...c, id: 'revoked', provider: 'flomo', status: 'revoked' }], attachments: [], auditLogs: [], modelUsageRecords: [], powerAccounts: [teacher, other].map(scope => ({ ...scope, id: `power-${scope.userId}`, balanceMicros: 10_000_000, reservedMicros: 0 })), powerLedger: [], rechargeOrders: [], models: [model], settings: { safetyRules: 'safe', rechargeCnyPerPower: 7 } } as unknown as Database;
}
async function fixture(t: TestContext, knowledge: Omit<TeachingKnowledgeRouteDependencies, 'verifyKey'>, modelCall?: TeachingAiRouteDependencies['modelCall']) {
  let db = database(), tail: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(fn: (db: Database) => T) => { const next = tail.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } }); tail = next.catch(() => undefined); return next; } };
  const auth: express.RequestHandler = (req, res, next) => { const user = db.users.find(user => user.id === req.headers['x-teacher']); if (!user) { res.sendStatus(401); return; } req.user = user; req.workspaceId = user.defaultWorkspaceId; next(); };
  let keyActive = true;
  const verifyKey = async (req: express.Request) => { if (!keyActive || req.headers['x-key'] !== 'present') throw new TeachingError('请插入 ONE Key。', 428); };
  const app = express(); app.use(express.json());
  installTeachingKnowledgeRoutes(app, [auth], store, { ...knowledge, verifyKey });
  installTeachingAiRoutes(app, [auth], store, { verifyKey, knowledge, modelCall });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/teaching`;
  const post = (url: string, body: unknown, h: Record<string, string> = headers) => fetch(base + url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const poll = async (url: string, h: Record<string, string> = headers) => { for (let attempt = 0; attempt < 100; attempt++) { const response = await fetch(base + url, { headers: h }); assert.equal(response.status, 200); const operation = (await response.json() as any).operation; if (operation.status !== 'running') return operation; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('synthetic operation timed out'); };
  return { get db() { return db; }, store, base, post, poll, revokeKey: () => { keyActive = false; } };
}
function courseFixture(db: Database, kind: 'inquiry' | 'assignment' = 'inquiry') {
  const course = createTeachingCourse(db, teacher, { title: '课程', budgetMicros: 1_000_000 });
  course.knowledgeSources = bindTeachingKnowledgeSources(db, teacher, [{ connectionId: 'notion-a', scope: 'page', pageId: page }]);
  const { activity } = createTeachingActivity(db, teacher, course.id, { revision: course.revision, title: '活动', stage: kind === 'inquiry' ? 'before' : 'after', kind, instructions: '请观察', status: 'published', rubric: kind === 'assignment' ? [{ id: 'observation', label: '观察', description: '有实际观察', maxScore: 10 }] : [] });
  activity.knowledgeSources = bindTeachingKnowledgeSources(db, teacher, [{ connectionId: 'notion-a', scope: 'page', pageId: privatePage }]);
  publishTeachingCourse(db, teacher, course.id, { revision: course.revision, confirmed: true });
  const session = createTeachingSession(db, course.slug!, { participantName: '学生甲', participantRef: '1', consent: true });
  return { course, activity, session };
}
const answer = () => ({ content: JSON.stringify({ answer: '课程已有相关学习资料。', materialInsufficient: false, needsLocationClarification: false, locationCandidates: [], citations: [{ source: 'material', quote: 'PUBLIC_LEARNING_PAGE' }] }), finishReason: 'stop' as const, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: 'provider' as const } });

test('teacher connection picker is workspace-authorized and never returns credentials or other owners sources', async t => {
  const f = await fixture(t, {});
  assert.equal((await fetch(f.base + '/knowledge/connections')).status, 401);
  const response = await fetch(f.base + '/knowledge/connections', { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json() as any;
  assert.deepEqual(result.connections.map((source: any) => source.id), ['notion-a', 'getnote-a']);
  assert.equal(result.connections[0].pageSupported, true); assert.equal(result.connections[1].pageSupported, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOTION_CREDENTIAL|notion-b|remote-b|binding|clientId|workspaceId/);
  const otherResult = await (await fetch(f.base + '/knowledge/connections', { headers: { ...headers, 'x-teacher': other.userId } })).json() as any;
  assert.deepEqual(otherResult.connections.map((source: any) => source.id), ['notion-b']);
});

test('exact-page preview checks Key, normalizes IDs, bounds its output and does not synchronize page contents', async t => {
  const reads: string[] = [];
  const f = await fixture(t, { notion: { readDocument: async (workspace, id) => { assert.equal(workspace, 'wa'); reads.push(id); return { text: `<properties>{"title":"具体课程页面"}</properties><content>${'只读课程文字'.repeat(4000)}</content>` }; } } });
  const source = { connectionId: 'notion-a', scope: 'page', pageId: `https://www.notion.so/${page}` };
  assert.equal((await f.post('/knowledge/preview', { source }, { 'Content-Type': 'application/json', 'x-teacher': teacher.userId })).status, 428);
  assert.equal(reads.length, 0);
  const before = structuredClone(f.db), response = await f.post('/knowledge/preview', { source }); assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.deepEqual(reads, [page]); assert.equal(result.source.pageId, page); assert.equal(result.preview.title, '具体课程页面'); assert.ok(result.preview.text.length < 12_100); assert.match(result.preview.text, /预览仅显示/);
  assert.deepEqual(f.db, before);
  assert.equal((await f.post('/knowledge/preview', { source: { ...source, connectionId: 'notion-b' } })).status, 403);
  assert.equal((await f.post('/knowledge/preview', { source: { ...source, pageId: `https://evil.invalid/${page}` } })).status, 400);
  assert.equal(reads.length, 1);
});

test('whole-connection preview makes no search until explicitly confirmed and searches only that teacher source', async t => {
  let searches = 0;
  const f = await fixture(t, { knowledgeService: { recallWithDiagnostics: async (workspace, query, _count, ids, user, options) => { searches++; assert.deepEqual([workspace, query, user], ['wa', '制茶工具', teacher.userId]); assert.deepEqual(ids, ['getnote-a']); assert.deepEqual(options, { retry: false }); return { chunks: [{ provider: 'getnote', title: '讲义', content: 'SELECTED_GETNOTE_CONTENT' }], failures: [], status: 'used' }; } } });
  const source = { connectionId: 'getnote-a', scope: 'connection' };
  assert.equal((await f.post('/knowledge/preview', { source, query: '制茶工具' })).status, 400); assert.equal(searches, 0);
  const response = await f.post('/knowledge/preview', { source: { ...source, confirmed: true }, query: '制茶工具' }); assert.equal(response.status, 200); assert.match(await response.text(), /SELECTED_GETNOTE_CONTENT/); assert.equal(searches, 1);
});

test('revocation or Key removal during a preview prevents old page text from reaching the teacher response', async t => {
  for (const mode of ['source', 'key']) {
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(t, { notion: { readDocument: async () => { if (mode === 'source') f.db.knowledgeConnections[0].status = 'revoked'; else f.revokeKey(); return { text: '<content>PRIVATE_REVOKED_TEXT</content>' }; } } });
    const response = await f.post('/knowledge/preview', { source: { connectionId: 'notion-a', scope: 'page', pageId: page } });
    assert.equal(response.status, mode === 'source' ? 403 : 428); assert.doesNotMatch(await response.text(), /PRIVATE_REVOKED_TEXT/);
  }
});

test('student answers read only course sources and ignore forged student connection or page parameters', async t => {
  const reads: string[] = []; let modelCalls = 0;
  const f = await fixture(t, { notion: { readDocument: async (workspace, id) => { assert.equal(workspace, teacher.workspaceId); reads.push(id); assert.equal(id, page); return { text: '<content>PUBLIC_LEARNING_PAGE</content>' }; } }, knowledgeService: { recallWithDiagnostics: async () => { assert.fail('exact-page course cannot issue account search'); } } }, async (_model, messages) => { modelCalls++; assert.match(JSON.stringify(messages), /PUBLIC_LEARNING_PAGE/); assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_RUBRIC_PAGE|PRIVATE_NOTION_CREDENTIAL|notion-b/); return answer(); });
  const { course, activity, session } = courseFixture(f.db), studentHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const response = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: 'knowledge-public-ask01', content: '请介绍课程', sourceIds: ['notion-b'], pageId: unselectedPage, knowledgeSources: [{ connectionId: 'notion-b', scope: 'connection', confirmed: true }] }, studentHeaders); assert.equal(response.status, 202);
  const operation = (await response.json() as any).operation;
  assert.equal((await f.poll(`/public/${course.slug}/operations/${operation.id}`, studentHeaders)).status, 'completed');
  assert.deepEqual(reads, [page]); assert.equal(modelCalls, 1);
});

test('grading reads snapshot private references as reference material and never mixes them into student evidence', async t => {
  const reads: string[] = [];
  const f = await fixture(t, { notion: { readDocument: async (_workspace, id) => { reads.push(id); return { text: `<content>${id === page ? 'PUBLIC_LEARNING_PAGE' : 'PRIVATE_RUBRIC_PAGE'}</content>` }; } } }, async (_model, messages) => {
    const data = JSON.parse(messages.find(message => message.role === 'user')!.content!).untrustedTeachingData;
    assert.match(data.materialText, /PUBLIC_LEARNING_PAGE/); assert.match(data.materialText, /PRIVATE_RUBRIC_PAGE/);
    assert.equal(data.work.text, '学生实际观察'); assert.equal(data.work.attachmentText, '');
    return { ...answer(), content: JSON.stringify({ criteria: [{ criterionId: 'observation', score: 7, comment: '有观察', evidence: '学生实际观察' }], feedback: '请老师复核。' }) };
  });
  const { course, activity, session } = courseFixture(f.db, 'assignment');
  const submission = addTeachingSubmission(f.db, teacher, course, { activityId: activity.id, operationId: 'knowledge-grade-submit1', text: '学生实际观察' }, authTeachingSession(f.db, course.slug!, session.token).session).submission;
  const response = await f.post(`/courses/${course.id}/ai`, { kind: 'grade', activityId: activity.id, submissionId: submission.id, operationId: 'knowledge-grade-00001', budgetConfirmed: true }); assert.equal(response.status, 202);
  const operation = (await response.json() as any).operation;
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`); assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.deepEqual(reads, [page, privatePage]); assert.equal(teachingState(f.db, teacher).submissions[0].grade?.total, 7);
});

test('source revocation before billing prevents a model call; revocation after a model call prevents result publication', async t => {
  for (const phase of ['read', 'model']) {
    let f!: Awaited<ReturnType<typeof fixture>>, modelCalls = 0;
    f = await fixture(t, { notion: { readDocument: async () => { if (phase === 'read') f.db.knowledgeConnections[0].status = 'revoked'; return { text: '<content>PUBLIC_LEARNING_PAGE</content>' }; } } }, async () => { modelCalls++; f.db.knowledgeConnections[0].status = 'revoked'; return answer(); });
    const { course, activity, session } = courseFixture(f.db), h = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
    const response = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: `knowledge-revoke-${phase}1`, content: '请介绍课程' }, h); assert.equal(response.status, 202);
    const op = (await response.json() as any).operation, done = await f.poll(`/public/${course.slug}/operations/${op.id}`, h);
    assert.equal(done.status, 'failed'); assert.equal(done.result, undefined); assert.equal(modelCalls, phase === 'read' ? 0 : 1); assert.equal(f.db.modelUsageRecords.length, phase === 'read' ? 0 : 1);
  }
});
