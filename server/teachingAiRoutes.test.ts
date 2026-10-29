import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Store } from './db.js';
import type { Attachment, Database, ModelConfig } from './types.js';
import { installTeachingAiRoutes, type TeachingAiRouteDependencies } from './teachingAiRoutes.js';
import { installTeachingRoutes } from './teachingRoutes.js';
import { addTeachingSubmission, authTeachingSession, closeTeachingCourse, createTeachingActivity, createTeachingCourse, createTeachingSession, publishTeachingCourse, reviewTeachingSubmission, teachingState, type TeachingError } from './teaching.js';
import type { TeachingActivity, TeachingCourse, TeachingScope } from './teachingTypes.js';

const teacher = { workspaceId: 'teaching-wa', userId: 'teacher-a' };
const sameWorkspace = { workspaceId: teacher.workspaceId, userId: 'teacher-b' };
const otherWorkspace = { workspaceId: 'teaching-wb', userId: 'teacher-c' };
const ownerHeaders = { 'Content-Type': 'application/json', 'x-teacher': teacher.userId };
const reply = (content: unknown) => ({ content: JSON.stringify(content), finishReason: 'stop' as const, toolCalls: [], usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, source: 'provider' as const } });
const guidedAnswer = () => ({ answer: '本课介绍茶叶文化。', materialInsufficient: false, needsLocationClarification: false, locationCandidates: [], citations: [{ source: 'material', quote: '本课程介绍茶叶文化。' }] });
function makeDb() {
  const scopes = [teacher, sameWorkspace, otherWorkspace];
  const model = { id: 'teaching-fixture-model', name: 'Fixture', provider: 'synthetic', enabled: true, isDefault: true, kind: 'chat', protocol: 'openai', apiKey: 'SYNTHETIC_NEVER_SENT', baseUrl: 'https://never-used.invalid', model: 'fixture', systemPrompt: '', inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString() } as ModelConfig;
  return { users: scopes.map(scope => ({ id: scope.userId, username: scope.userId, enabled: true, defaultWorkspaceId: scope.workspaceId })), workspaces: [...new Set(scopes.map(scope => scope.workspaceId))].map(id => ({ id, status: 'active', kind: 'personal' })), workspaceMembers: scopes.map(scope => ({ ...scope, role: 'owner' })), models: [model], settings: { safetyRules: 'Do not disclose private information.', rechargeCnyPerPower: 7 }, attachments: [], modelUsageRecords: [], powerAccounts: scopes.map(scope => ({ ...scope, id: `power-${scope.userId}`, balanceMicros: 20_000_000, reservedMicros: 0, updatedAt: new Date().toISOString() })), powerLedger: [], auditLogs: [], knowledgeConnections: [], conversations: [], messages: [], rechargeOrders: [] } as unknown as Database;
}
function addCourse(db: Database, scope: TeachingScope = teacher, kind: TeachingActivity['kind'] = 'inquiry', publish = true, budgetMicros = 1_000_000) {
  const course = createTeachingCourse(db, scope, { title: '隔离课程', materialText: '本课程介绍茶叶文化。', budgetMicros });
  const { activity } = createTeachingActivity(db, scope, course.id, { revision: course.revision, title: '学习活动', stage: kind === 'inquiry' ? 'before' : 'after', kind, status: 'published', instructions: '请观察并记录。', referenceText: 'PRIVATE_EXAM_REFERENCE_ANSWER', rubric: kind === 'assignment' ? [{ id: 'observation', label: '观察', description: '明确描述观察', maxScore: 10 }] : [], questions: kind === 'quiz' ? [{ id: 'q1', type: 'single', prompt: '选择', options: ['甲', '乙'], answer: '甲', points: 10 }] : [] });
  if (publish) publishTeachingCourse(db, scope, course.id, { revision: course.revision, confirmed: true });
  return { course, activity };
}
async function fixture(t: TestContext, modelCall: NonNullable<TeachingAiRouteDependencies['modelCall']>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-teaching-ai-http-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let db = makeDb(), tail: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(fn: (current: Database) => T) => { const next = tail.then(() => { const previous = structuredClone(db); try { return fn(db); } catch (error) { db = previous; throw error; } }); tail = next.catch(() => undefined); return next; } };
  let keyPresent = true;
  const auth: express.RequestHandler = (req, res, next) => { const user = db.users.find(value => value.id === req.headers['x-teacher']); if (!user) { res.sendStatus(401); return; } req.user = user; req.workspaceId = user.defaultWorkspaceId; next(); };
  const verifyKey = async () => { if (!keyPresent) throw Object.assign(new Error('Key removed'), { status: 428 }); };
  const start = async () => {
    const app = express(); app.use(express.json());
    installTeachingRoutes(app, [auth], store, { verifyKey });
    installTeachingAiRoutes(app, [auth], store, { verifyKey, modelCall });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status((error as TeachingError).status ?? 500).json({ error: 'request rejected' }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/teaching`;
  };
  const base = await start();
  const post = (url: string, body: unknown, headers: Record<string, string> = ownerHeaders) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  const poll = async (url: string, headers: Record<string, string> = ownerHeaders) => {
    for (let attempt = 0; attempt < 100; attempt++) { const response = await fetch(base + url, { headers }); assert.equal(response.status, 200, await response.clone().text()); const result = await response.json() as any; if (result.operation.status !== 'running') return result.operation; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('synthetic teaching operation did not finish');
  };
  return { get db() { return db; }, store, base, post, poll, start, directory, removeKey: () => { keyPresent = false; } };
}

test('HTTP AI requests are idempotent, payload conflicts reject, and restart polling never reissues unknown attempts', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return reply({ instructions: '请探索茶叶文化并提出自己的问题。' }); });
  const { course, activity } = addCourse(f.db, teacher, 'inquiry', false);
  const body = { kind: 'prepare', activityId: activity.id, operationId: 'teacher-prepare-000001', budgetConfirmed: true };
  const first = await f.post(`/courses/${course.id}/ai`, body); assert.equal(first.status, 202, await first.clone().text());
  const operation = (await first.json() as any).operation;
  assert.equal(operation.courseRevision, course.revision);
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`); assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(calls, 1); assert.equal(f.db.modelUsageRecords.length, 1);
  const duplicate = await f.post(`/courses/${course.id}/ai`, body); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json() as any).operation.id, operation.id);
  assert.equal((await f.post(`/courses/${course.id}/ai`, { ...body, content: 'changed' })).status, 409); assert.equal(calls, 1);
  await f.store.mutate(db => { const saved = teachingState(db, teacher).operations.find(value => value.id === operation.id)!; saved.status = 'running'; delete saved.result; });
  const restartedBase = await f.start();
  const recovered = await fetch(`${restartedBase}/courses/${course.id}/operations/${operation.id}`, { headers: ownerHeaders });
  assert.equal(recovered.status, 200); assert.equal((await recovered.json() as any).operation.status, 'uncertain');
  await f.post(`/courses/${course.id}/ai`, body);
  assert.equal(calls, 1, 'an unknown durable attempt must never automatically call the model again');
});

test('provider uncertainty is retained without duplicate calls or leaked provider diagnostics', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('PRIVATE_PROVIDER_ERROR_AND_SECRET'); });
  const { course, activity } = addCourse(f.db, teacher, 'inquiry', false);
  const body = { kind: 'prepare', activityId: activity.id, operationId: 'unknown-prepare-00001', budgetConfirmed: true };
  const response = await f.post(`/courses/${course.id}/ai`, body); assert.equal(response.status, 202);
  const operation = (await response.json() as any).operation;
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`);
  assert.equal(done.status, 'uncertain'); assert.doesNotMatch(JSON.stringify(done), /PRIVATE_PROVIDER_ERROR_AND_SECRET/);
  const duplicate = await f.post(`/courses/${course.id}/ai`, body); assert.equal(duplicate.status, 200);
  assert.equal(calls, 1); assert.equal(f.db.modelUsageRecords.length, 1);
});

test('course budget is checked before a billing reservation and concurrent reservations count toward it', async t => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, async () => { calls++; await gate; return reply(guidedAnswer()); });
  const tiny = addCourse(f.db, teacher, 'inquiry', true, 1);
  const tinySession = createTeachingSession(f.db, tiny.course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const publicHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${tinySession.token}` };
  const beforeBalance = f.db.powerAccounts[0].balanceMicros;
  const refused = await f.post(`/public/${tiny.course.slug}/questions`, { activityId: tiny.activity.id, operationId: 'budget-too-small-0001', content: '介绍课程' }, publicHeaders);
  const refusedOp = (await refused.json() as any).operation;
  assert.equal((await f.poll(`/public/${tiny.course.slug}/operations/${refusedOp.id}`, publicHeaders)).status, 'failed');
  assert.equal(calls, 0); assert.equal(f.db.modelUsageRecords.length, 0); assert.equal(f.db.powerAccounts[0].balanceMicros, beforeBalance); assert.equal(f.db.powerAccounts[0].reservedMicros, 0);
  const { course, activity } = addCourse(f.db);
  const one = createTeachingSession(f.db, course.slug!, { participantName: '二', participantRef: '2', consent: true });
  const two = createTeachingSession(f.db, course.slug!, { participantName: '三', participantRef: '3', consent: true });
  const headers = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const first = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: 'budget-reserved-00001', content: '介绍课程' }, headers(one.token));
  const firstOp = (await first.json() as any).operation;
  for (let attempt = 0; attempt < 100 && !calls; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1); const reserved = f.db.modelUsageRecords[0].reservedMicros!; assert.ok(reserved > 0);
  await f.store.mutate(db => { teachingState(db, teacher).courses.find(value => value.id === course.id)!.budgetMicros = reserved; });
  const second = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: 'budget-reserved-00002', content: '介绍课程' }, headers(two.token));
  const secondOp = (await second.json() as any).operation;
  assert.equal((await f.poll(`/public/${course.slug}/operations/${secondOp.id}`, headers(two.token))).status, 'failed');
  assert.equal(calls, 1); assert.equal(f.db.modelUsageRecords.length, 1);
  release(); assert.equal((await f.poll(`/public/${course.slug}/operations/${firstOp.id}`, headers(one.token))).status, 'completed');
});

test('late AI grade cannot overwrite a published teacher grade; students see only their own published results', async t => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, async () => { calls++; await gate; return reply({ criteria: [{ criterionId: 'observation', score: 4, comment: '可补充观察', evidence: '我观察了茶具' }], feedback: 'AI_PRIVATE_SUGGESTION' }); });
  const { course, activity } = addCourse(f.db, teacher, 'assignment');
  const one = createTeachingSession(f.db, course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const two = createTeachingSession(f.db, course.slug!, { participantName: '二', participantRef: '2', consent: true });
  const first = addTeachingSubmission(f.db, teacher, course, { activityId: activity.id, operationId: 'grade-submission-0001', text: '我观察了茶具。' }, authTeachingSession(f.db, course.slug!, one.token).session).submission;
  const second = addTeachingSubmission(f.db, teacher, course, { activityId: activity.id, operationId: 'grade-submission-0002', text: '另一个学生的私密作业。' }, authTeachingSession(f.db, course.slug!, two.token).session).submission;
  const started = await f.post(`/courses/${course.id}/ai`, { kind: 'grade', activityId: activity.id, submissionId: first.id, operationId: 'grade-after-review-001', budgetConfirmed: true });
  const operation = (await started.json() as any).operation;
  for (let attempt = 0; attempt < 100 && !calls; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  const unpublished = await fetch(`${f.base}/public/${course.slug}/submissions`, { headers: { Authorization: `Bearer ${one.token}` } });
  const unpublishedBody = await unpublished.json() as any;
  assert.equal(Object.hasOwn(unpublishedBody.submissions[0], 'grade'), false);
  assert.doesNotMatch(JSON.stringify(unpublishedBody), /AI_PRIVATE_SUGGESTION|另一个学生|activitySnapshot|referenceText/);
  await f.store.mutate(db => reviewTeachingSubmission(db, teacher, course.id, first.id, { criteria: [{ criterionId: 'observation', score: 9, comment: '老师复核', evidence: '我观察了茶具' }], total: 9, feedback: '老师确认反馈' }));
  release();
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`); assert.equal(done.status, 'failed');
  const saved = teachingState(f.db, teacher).submissions.find(value => value.id === first.id)!;
  assert.equal(saved.grade?.total, 9); assert.equal(saved.grade?.source, 'teacher'); assert.equal(saved.grade?.status, 'published');
  const mine = await (await fetch(`${f.base}/public/${course.slug}/submissions`, { headers: { Authorization: `Bearer ${one.token}` } })).json() as any;
  assert.equal(mine.submissions.length, 1); assert.equal(mine.submissions[0].grade.total, 9);
  assert.doesNotMatch(JSON.stringify(mine), new RegExp(`${second.id}|AI_PRIVATE_SUGGESTION|PRIVATE_EXAM_REFERENCE_ANSWER`));
  assert.equal((await f.post(`/courses/${course.id}/ai`, { kind: 'grade', activityId: activity.id, submissionId: first.id, operationId: 'grade-published-00001', budgetConfirmed: true })).status, 409);
});

test('different operation IDs cannot start parallel AI grading for the same submission', async t => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, async () => { calls++; await gate; return reply({ criteria: [{ criterionId: 'observation', score: 4, comment: '观察明确', evidence: '我观察了茶具' }], feedback: '请老师复核。' }); });
  const { course, activity } = addCourse(f.db, teacher, 'assignment');
  const submission = addTeachingSubmission(f.db, teacher, course, { activityId: activity.id, operationId: 'parallel-grade-submit1', participantName: '一', participantRef: '1', text: '我观察了茶具。' }).submission;
  const body = { kind: 'grade', activityId: activity.id, submissionId: submission.id, operationId: 'parallel-grade-first1', budgetConfirmed: true };
  const first = await f.post(`/courses/${course.id}/ai`, body); assert.equal(first.status, 202);
  const op = (await first.json() as any).operation;
  for (let attempt = 0; attempt < 100 && !calls; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  const sameId = await f.post(`/courses/${course.id}/ai`, body); assert.equal(sameId.status, 202); assert.equal((await sameId.json() as any).operation.id, op.id);
  const differentId = await f.post(`/courses/${course.id}/ai`, { ...body, operationId: 'parallel-grade-second2' }); assert.equal(differentId.status, 409, await differentId.clone().text());
  assert.equal(teachingState(f.db, teacher).operations.filter(value => value.submissionId === submission.id).length, 1); assert.equal(f.db.modelUsageRecords.length, 1); assert.equal(calls, 1);
  release(); assert.equal((await f.poll(`/courses/${course.id}/operations/${op.id}`)).status, 'completed');
});

test('public AI is session-bound and teacher-only exam references never reach a public answer call', async t => {
  let calls = 0;
  const f = await fixture(t, async (_model, messages, tools) => { calls++; assert.deepEqual(tools, []); assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_EXAM_REFERENCE_ANSWER|PRIVATE_EXAM_FILE_TEXT|OTHER_COURSE_SECRET/); return reply(guidedAnswer()); });
  const { course, activity } = addCourse(f.db);
  f.db.attachments.push({ id: 'private-exam-source', ...teacher, conversationId: `teaching:${course.id}`, status: 'ready', extractedText: 'PRIVATE_EXAM_FILE_TEXT', textChars: 22, segmentCount: 0, storagePath: path.join(f.directory, 'private-paper.txt'), size: 22, kind: 'text', mimeType: 'text/plain', originalName: 'private-paper.txt', createdAt: new Date().toISOString() });
  activity.sourceAttachmentIds = ['private-exam-source'];
  course.activities.push({ ...structuredClone(activity), id: 'private-quiz-activity', kind: 'quiz', stage: 'after', questions: [{ id: 'private-q', type: 'text', prompt: '老师题目', options: [], answer: 'PRIVATE_EXAM_REFERENCE_ANSWER', points: 10 }] });
  const another = addCourse(f.db); another.course.materialText = 'OTHER_COURSE_SECRET';
  const foreign = addCourse(f.db, otherWorkspace);
  const one = createTeachingSession(f.db, course.slug!, { participantName: '学生一', participantRef: '1', consent: true });
  const two = createTeachingSession(f.db, course.slug!, { participantName: '学生二', participantRef: '2', consent: true });
  const h = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const body = { activityId: activity.id, operationId: 'public-answer-000001', content: '课程介绍什么？' };
  assert.equal((await f.post(`/public/${course.slug}/questions`, body, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await f.post(`/public/${another.course.slug}/questions`, { ...body, activityId: another.activity.id }, h(one.token))).status, 401);
  assert.equal((await f.post(`/public/${foreign.course.slug}/questions`, { ...body, activityId: foreign.activity.id }, h(one.token))).status, 401);
  assert.equal((await f.post(`/public/${course.slug}/questions`, { ...body, activityId: 'private-quiz-activity', operationId: 'quiz-answer-block-0001' }, h(one.token))).status, 403);
  assert.equal((await f.post(`/courses/${course.id}/ai`, { kind: 'insights', operationId: 'other-owner-ai-00001', budgetConfirmed: true }, { ...ownerHeaders, 'x-teacher': sameWorkspace.userId })).status, 404);
  assert.equal((await f.post(`/courses/${course.id}/ai`, { kind: 'insights', operationId: 'other-space-ai-00001', budgetConfirmed: true }, { ...ownerHeaders, 'x-teacher': otherWorkspace.userId })).status, 404);
  const response = await f.post(`/public/${course.slug}/questions`, body, h(one.token)); assert.equal(response.status, 202);
  const op = (await response.json() as any).operation;
  const complete = await f.poll(`/public/${course.slug}/operations/${op.id}`, h(one.token)); assert.equal(complete.status, 'completed');
  assert.equal((await fetch(`${f.base}/public/${course.slug}/operations/${op.id}`, { headers: h(two.token) })).status, 404);
  assert.equal(calls, 1);
});

test('completed suggested grades stay private until the teacher explicitly publishes a review', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('objective grading must not call a model'); });
  const { course, activity } = addCourse(f.db, teacher, 'quiz');
  const session = createTeachingSession(f.db, course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const studentHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const submitted = await f.post(`/public/${course.slug}/submissions`, { activityId: activity.id, operationId: 'objective-http-submit1', answers: { q1: '甲' } }, studentHeaders); assert.equal(submitted.status, 201);
  const submission = (await submitted.json() as any).submission;
  const started = await f.post(`/courses/${course.id}/ai`, { kind: 'grade', activityId: activity.id, submissionId: submission.id, operationId: 'objective-http-grade01', budgetConfirmed: true }); assert.equal(started.status, 202);
  const operation = (await started.json() as any).operation;
  assert.equal((await f.poll(`/courses/${course.id}/operations/${operation.id}`)).status, 'completed');
  assert.equal(calls, 0); assert.equal(f.db.modelUsageRecords.length, 0);
  const before = await (await fetch(`${f.base}/public/${course.slug}/submissions`, { headers: studentHeaders })).json() as any;
  assert.equal(before.submissions[0].grade, undefined);
  const teacherView = await (await fetch(`${f.base}/courses/${course.id}/submissions`, { headers: ownerHeaders })).json() as any;
  assert.equal(teacherView.submissions[0].grade.status, 'suggested'); assert.equal(teacherView.submissions[0].grade.total, 10);
  const reviewed = await fetch(`${f.base}/courses/${course.id}/submissions/${submission.id}/review`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ grade: { criteria: [{ criterionId: 'q1', score: 10, comment: '确认', evidence: '甲' }], total: 10, feedback: '老师确认' } }) }); assert.equal(reviewed.status, 200);
  const after = await (await fetch(`${f.base}/public/${course.slug}/submissions`, { headers: studentHeaders })).json() as any;
  assert.equal(after.submissions[0].grade.status, 'published'); assert.equal(after.submissions[0].grade.source, 'teacher'); assert.equal(after.submissions[0].grade.total, 10);
});

test('organizing a private teacher exam cannot publish the quoted answer key inside its question text', async t => {
  const secretAnswer = 'PRIVATE_STANDARD_ANSWER_321', paper = `题目：观察记录的编号是什么？参考答案：${secretAnswer}`;
  const f = await fixture(t, async () => reply({ instructions: '回答老师提供的问题。', questions: [{ id: 'prepared-question', prompt: '观察记录的编号是什么？', type: 'text', options: [], answer: secretAnswer, points: 10, citation: { source: 'attachment', quote: paper } }] }));
  const { course, activity } = addCourse(f.db, teacher, 'quiz', false);
  activity.questions = []; activity.referenceText = paper;
  const started = await f.post(`/courses/${course.id}/ai`, { kind: 'prepare', activityId: activity.id, operationId: 'prepare-private-exam1', budgetConfirmed: true }); assert.equal(started.status, 202);
  const operation = (await started.json() as any).operation;
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`); assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.result.draft.questions[0].answer, secretAnswer);
  const saved = await fetch(`${f.base}/courses/${course.id}/activities/${activity.id}`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ ...done.result.draft, revision: course.revision, activityRevision: activity.revision, status: 'published' }) }); assert.equal(saved.status, 200);
  const updated = (await saved.json() as any).course;
  const published = await f.post(`/courses/${course.id}/publish`, { revision: updated.revision, confirmed: true }); assert.equal(published.status, 200);
  const slug = (await published.json() as any).course.slug;
  const studentCourse = await (await fetch(`${f.base}/public/${slug}`)).text();
  assert.doesNotMatch(studentCourse, /PRIVATE_STANDARD_ANSWER_321|参考答案|referenceText/);
  assert.match(studentCourse, /观察记录的编号是什么/);
});

test('insights redact identities from disclosed course questions even before a student submits an assignment', async t => {
  let insightPrompt = '';
  const f = await fixture(t, async (_model, messages) => {
    if (JSON.stringify(messages).includes('recordCount')) { insightPrompt = JSON.stringify(messages); return reply({ summary: '关注课程内容。', topics: [{ label: '茶叶文化', count: 1 }], suggestions: ['补充背景介绍。'] }); }
    return reply(guidedAnswer());
  });
  const { course, activity } = addCourse(f.db);
  const session = createTeachingSession(f.db, course.slug!, { participantName: 'PRIVATE_PARTICIPANT_NAME_123', participantRef: 'PRIVATE_PARTICIPANT_REF_456', consent: true });
  const studentHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const question = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: 'identified-question-01', content: '我叫 PRIVATE_PARTICIPANT_NAME_123，我的学号 PRIVATE_PARTICIPANT_REF_456，请介绍茶叶文化。' }, studentHeaders);
  const questionOp = (await question.json() as any).operation;
  assert.equal((await f.poll(`/public/${course.slug}/operations/${questionOp.id}`, studentHeaders)).status, 'completed');
  assert.equal(teachingState(f.db, teacher).submissions.length, 0, 'questions alone must be sufficient for the teacher to request insights');
  const started = await f.post(`/courses/${course.id}/ai`, { kind: 'insights', operationId: 'identified-insights-01', budgetConfirmed: true });
  const insightOp = (await started.json() as any).operation;
  assert.equal((await f.poll(`/courses/${course.id}/operations/${insightOp.id}`)).status, 'completed');
  assert.ok(insightPrompt);
  assert.doesNotMatch(insightPrompt, /PRIVATE_PARTICIPANT_NAME_123|PRIVATE_PARTICIPANT_REF_456/);
});

test('operation lists and client-ID aliases remain scoped to exact owner, course and participant session after republication', async t => {
  const f = await fixture(t, async (_model, messages) => JSON.stringify(messages).includes('recordCount') ? reply({ summary: '关注课程背景。', topics: [{ label: '背景', count: 2 }], suggestions: ['补充相关材料。'] }) : reply(guidedAnswer()));
  const first = addCourse(f.db), second = addCourse(f.db);
  const one = createTeachingSession(f.db, first.course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const two = createTeachingSession(f.db, first.course.slug!, { participantName: '二', participantRef: '2', consent: true });
  const three = createTeachingSession(f.db, second.course.slug!, { participantName: '三', participantRef: '3', consent: true });
  const h = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const alias = 'shared-operation-alias-0001';
  const createQuestion = async (course: TeachingCourse, activity: TeachingActivity, token: string) => {
    const response = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: alias, content: '请介绍课程背景。' }, h(token)); assert.equal(response.status, 202);
    const op = (await response.json() as any).operation;
    assert.equal((await f.poll(`/public/${course.slug}/operations/${alias}`, h(token))).status, 'completed');
    return op;
  };
  const firstOp = await createQuestion(first.course, first.activity, one.token);
  const secondOp = await createQuestion(first.course, first.activity, two.token);
  const thirdOp = await createQuestion(second.course, second.activity, three.token);
  const teacherResult = await f.post(`/courses/${first.course.id}/ai`, { kind: 'insights', activityId: first.activity.id, operationId: alias, budgetConfirmed: true }); assert.equal(teacherResult.status, 202);
  const teacherOp = (await teacherResult.json() as any).operation;
  assert.equal((await f.poll(`/courses/${first.course.id}/operations/${alias}`)).status, 'completed');
  const list = async (url: string, access: Record<string, string>) => { const response = await fetch(f.base + url, { headers: access }); assert.equal(response.status, 200); return (await response.json() as any).operations; };
  assert.deepEqual((await list(`/courses/${first.course.id}/operations`, ownerHeaders)).map((item: any) => item.id), [teacherOp.id]);
  assert.deepEqual((await list(`/public/${first.course.slug}/operations`, h(one.token))).map((item: any) => item.id), [firstOp.id]);
  assert.deepEqual((await list(`/public/${first.course.slug}/operations`, h(two.token))).map((item: any) => item.id), [secondOp.id]);
  assert.deepEqual((await list(`/public/${second.course.slug}/operations`, h(three.token))).map((item: any) => item.id), [thirdOp.id]);
  for (const id of [secondOp.id, thirdOp.id, teacherOp.id]) assert.equal((await fetch(`${f.base}/public/${first.course.slug}/operations/${id}`, { headers: h(one.token) })).status, 404);
  assert.equal((await fetch(`${f.base}/courses/${first.course.id}/operations/${firstOp.id}`, { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(`${f.base}/courses/${second.course.id}/operations/${teacherOp.id}`, { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(`${f.base}/courses/${first.course.id}/operations`, { headers: { ...ownerHeaders, 'x-teacher': sameWorkspace.userId } })).status, 404);
  assert.equal((await fetch(`${f.base}/public/${first.course.slug}/operations`, { headers: h(three.token) })).status, 401);
  const oldSlug = first.course.slug!;
  await f.store.mutate(db => { const current = teachingState(db, teacher).courses.find(value => value.id === first.course.id)!; closeTeachingCourse(db, teacher, current.id, { revision: current.revision }); publishTeachingCourse(db, teacher, current.id, { revision: current.revision, confirmed: true }); });
  const freshCourse = teachingState(f.db, teacher).courses.find(value => value.id === first.course.id)!;
  assert.notEqual(freshCourse.slug, oldSlug);
  assert.equal((await fetch(`${f.base}/public/${oldSlug}/operations/${alias}`, { headers: h(one.token) })).status, 404);
  assert.equal((await fetch(`${f.base}/public/${freshCourse.slug}/operations/${alias}`, { headers: h(one.token) })).status, 401);
  const fresh = createTeachingSession(f.db, freshCourse.slug!, { participantName: '一', participantRef: '1', consent: true });
  assert.deepEqual(await list(`/public/${freshCourse.slug}/operations`, h(fresh.token)), []);
  assert.equal((await fetch(`${f.base}/public/${freshCourse.slug}/operations/${firstOp.id}`, { headers: h(fresh.token) })).status, 404);
});

test('student image inputs require exact attachment owner, workspace, course and ready status', async t => {
  let calls = 0;
  const f = await fixture(t, async (_model, messages) => { calls++; assert.ok(messages.some(message => message.inputImageDataUrls?.[0]?.startsWith('data:image/png;base64,'))); return reply(guidedAnswer()); });
  const { course, activity } = addCourse(f.db), other = addCourse(f.db);
  const one = createTeachingSession(f.db, course.slug!, { participantName: '学生一', participantRef: '1', consent: true });
  const two = createTeachingSession(f.db, course.slug!, { participantName: '学生二', participantRef: '2', consent: true });
  const storagePath = path.join(f.directory, 'photo.png'); await fs.writeFile(storagePath, Buffer.from('synthetic-image'));
  const photo = { id: 'own-photo', workspaceId: teacher.workspaceId, userId: one.sessionId, conversationId: `teaching:${course.id}`, status: 'ready', kind: 'image', mimeType: 'image/png', originalName: 'photo.png', size: 15, storagePath, extractedText: '', createdAt: new Date().toISOString() } as Attachment;
  f.db.attachments.push(photo, { ...photo, id: 'other-student-photo', userId: two.sessionId }, { ...photo, id: 'teacher-photo', userId: teacher.userId }, { ...photo, id: 'other-course-photo', conversationId: `teaching:${other.course.id}` }, { ...photo, id: 'other-workspace-photo', workspaceId: otherWorkspace.workspaceId }, { ...photo, id: 'unready-photo', status: 'parsing' });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${one.token}` };
  for (const id of ['other-student-photo', 'teacher-photo', 'other-course-photo', 'other-workspace-photo', 'unready-photo']) assert.equal((await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: `photo-attempt-${id}`, content: '请识别地点', attachmentIds: [id] }, headers)).status, 400);
  assert.equal(calls, 0);
  const response = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: 'photo-own-attempt-0001', content: '请识别地点', attachmentIds: [photo.id] }, headers);
  const op = (await response.json() as any).operation;
  assert.equal((await f.poll(`/public/${course.slug}/operations/${op.id}`, headers)).status, 'completed'); assert.equal(calls, 1);
});
