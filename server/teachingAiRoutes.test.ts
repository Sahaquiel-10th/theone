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
import { addTeachingSubmission, authTeachingSession, bindTeachingGradingBasis, closeTeachingCourse, createTeachingActivity, createTeachingCourse, createTeachingSession, publishTeachingCourse, reviewTeachingSubmission, teachingState, updateTeachingActivity, updateTeachingCourse, type TeachingError } from './teaching.js';
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
  const course = createTeachingCourse(db, scope, { title: '隔离课程', budgetMicros });
  // Historical uploaded course sources remain readable until explicitly switched.
  delete course.sourceMode; delete course.teacherBudgetMode; course.materialText='本课程介绍茶叶文化。';
  const { activity } = createTeachingActivity(db, scope, course.id, { revision: course.revision, title: '学习活动', stage: kind === 'inquiry' ? 'before' : 'after', kind, status: 'published', instructions: '请观察并记录。', referenceText: 'PRIVATE_EXAM_REFERENCE_ANSWER', rubric: kind === 'assignment' ? [{ id: 'observation', label: '观察', description: '明确描述观察', maxScore: 10 }] : [], questions: kind === 'quiz' ? [{ id: 'q1', type: 'single', prompt: '选择', options: ['甲', '乙'], answer: '甲', points: 10 }] : [] });
  if (publish) publishTeachingCourse(db, scope, course.id, { revision: course.revision, confirmed: true });
  return { course, activity };
}
async function fixture(t: TestContext, modelCall: NonNullable<TeachingAiRouteDependencies['modelCall']>, knowledge?:TeachingAiRouteDependencies['knowledge']) {
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
    installTeachingAiRoutes(app, [auth], store, { verifyKey, modelCall, knowledge });
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

test('a balance-backed teacher may run at zero course cap, but wallet limits and all public cumulative caps remain enforced',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;return reply({answer:'虚构游戏回合。',choices:['观察','提问']});});
  const course=createTeachingCourse(f.db,teacher,{title:'按账户余额使用'}),activity=createTeachingActivity(f.db,teacher,course.id,{revision:course.revision,title:'试玩',kind:'game',stage:'during',status:'published',avatarPrompt:'引导课堂游戏'}).activity;
  assert.equal(course.teacherBudgetMode,'balance');assert.equal(course.budgetMicros,0);
  const body={kind:'answer',preview:true,activityId:activity.id,conversationId:'balance-manual-trial',operationId:'balance-manual-request001',content:'开始',budgetConfirmed:true};
  const first=await f.post(`/courses/${course.id}/ai`,body);assert.equal(first.status,202);const firstOperation=(await first.json() as any).operation;assert.equal('teacherBudgetModeSnapshot' in firstOperation,false);
  assert.equal((await f.poll(`/courses/${course.id}/operations/${firstOperation.id}`)).status,'completed');assert.equal(calls,1);
  assert.equal(teachingState(f.db,teacher).operations.find(row=>row.id===firstOperation.id)?.teacherBudgetModeSnapshot,'balance');
  const rawBefore=f.db.modelUsageRecords.length;updateTeachingCourse(f.db,teacher,course.id,{revision:course.revision,budgetMicros:1});publishTeachingCourse(f.db,teacher,course.id,{revision:course.revision,confirmed:true});
  const student=createTeachingSession(f.db,course.slug!,{participantName:'学生',consent:true}),headers={'Content-Type':'application/json',Authorization:`Bearer ${student.token}`};
  const submitted=await f.post(`/public/${course.slug}/questions`,{activityId:activity.id,operationId:'public-cannot-bypass-cap01',content:'开始游戏',gameRevision:0,teacherBudgetMode:'balance',teacherBudgetModeSnapshot:'balance'},headers);assert.equal(submitted.status,202,await submitted.clone().text());
  const failed=await f.poll(`/public/${course.slug}/operations/${(await submitted.json() as any).operation.id}`,headers);assert.equal(failed.status,'failed');assert.equal(calls,1);assert.equal(f.db.modelUsageRecords.length,rawBefore);assert.doesNotMatch(JSON.stringify(failed),/teacherBudgetModeSnapshot/);
  const other=createTeachingCourse(f.db,teacher,{title:'钱包仍保护'}),second=createTeachingActivity(f.db,teacher,other.id,{revision:other.revision,title:'试玩',kind:'game',stage:'during',avatarPrompt:'游戏'}).activity;
  const account=f.db.powerAccounts.find(row=>row.userId===teacher.userId&&row.workspaceId===teacher.workspaceId)!;account.balanceMicros=0;account.reservedMicros=0;
  const noFunds=await f.post(`/courses/${other.id}/ai`,{...body,activityId:second.id,conversationId:'no-wallet-trial',operationId:'balance-still-needs-wallet'});assert.equal(noFunds.status,202);assert.equal((await f.poll(`/courses/${other.id}/operations/${(await noFunds.json() as any).operation.id}`)).status,'failed');assert.equal(calls,1);assert.equal(account.balanceMicros,0);assert.equal(account.reservedMicros,0);
});

test('manual budget authorization snapshots cannot be widened while knowledge retrieval waits, and live course mode can tighten balance requests',async t=>{
  for(const transition of ['course-to-balance','balance-to-course'] as const){
    let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});t.after(()=>release());
    const f=await fixture(t,async()=>{calls++;return reply(guidedAnswer());},{knowledgeService:{recallWithDiagnostics:async()=>{entered();await gate;return {status:'used',failures:[],chunks:[{provider:'getnote',title:'课程资料',content:'本课程介绍茶叶文化。'}]};}}});
    f.db.knowledgeConnections.push({id:'mode-gate-library',workspaceId:teacher.workspaceId,provider:'getnote',status:'connected',clientId:'fixture',providerUserId:'account',encryptedApiKey:'SYNTHETIC',createdAt:'now',updatedAt:'now'});
    const initial=transition==='course-to-balance'?'course':'balance',next=initial==='course'?'balance':'course';
    const course=createTeachingCourse(f.db,teacher,{title:'在途授权',teacherBudgetMode:initial,budgetMicros:1,knowledgeSources:[{connectionId:'mode-gate-library',scope:'connection',confirmed:true}]}),activity=createTeachingActivity(f.db,teacher,course.id,{revision:course.revision,title:'试问',kind:'inquiry',stage:'before'}).activity;
    const started=await f.post(`/courses/${course.id}/ai`,{kind:'answer',preview:true,activityId:activity.id,conversationId:'mode-gate-conversation',operationId:`mode-gate-${transition}-001`,content:'课程是什么',budgetConfirmed:true});assert.equal(started.status,202);const op=(await started.json() as any).operation;
    await waiting;assert.equal(teachingState(f.db,teacher).operations.find(row=>row.id===op.id)!.teacherBudgetModeSnapshot,initial);updateTeachingCourse(f.db,teacher,course.id,{revision:course.revision,teacherBudgetMode:next});release();
    const done=await f.poll(`/courses/${course.id}/operations/${op.id}`);assert.equal(done.status,'failed',JSON.stringify(done));assert.equal(calls,0,`${transition} must not turn an old narrow authorization into a paid request`);assert.equal(f.db.modelUsageRecords.length,0);
  }
});

test('knowledge-only AI reads the exact authorized library and never reuses historical course text or attachment originals',async t=>{
  let calls=0,reads=0;const f=await fixture(t,async(_model,messages)=>{calls++;const input=String(messages.find(row=>row.role==='user')?.content);assert.match(input,/KNOWLEDGE_ALLOWED_TEXT/);assert.doesNotMatch(input,/LEGACY_PRIVATE_TEXT|legacy-unreadable-file/);return reply(guidedAnswer());},{knowledgeService:{recallWithDiagnostics:async(workspace,_query,_topK,ids,user)=>{reads++;assert.equal(workspace,teacher.workspaceId);assert.equal(user,teacher.userId);assert.deepEqual(ids,['course-library']);return {status:'used',failures:[],chunks:[{provider:'getnote',title:'授权的课程资料',content:'本课程介绍茶叶文化。KNOWLEDGE_ALLOWED_TEXT'}]};}}});
  f.db.knowledgeConnections.push({id:'course-library',workspaceId:teacher.workspaceId,provider:'getnote',status:'connected',clientId:'fixture-client',providerUserId:'fixture-account',providerSpaceId:'fixture-space',encryptedApiKey:'SYNTHETIC_LIBRARY_KEY',createdAt:'now',updatedAt:'now'});
  const course=createTeachingCourse(f.db,teacher,{title:'课程',budgetMicros:1_000_000,knowledgeSources:[{connectionId:'course-library',scope:'connection',confirmed:true}]});
  delete course.sourceMode;course.materialText='LEGACY_PRIVATE_TEXT';course.materialAttachmentIds=['legacy-unreadable-file'];
  updateTeachingCourse(f.db,teacher,course.id,{revision:course.revision,sourceMode:'knowledge'});
  const {activity}=createTeachingActivity(f.db,teacher,course.id,{revision:course.revision,title:'试问',kind:'inquiry',stage:'before',avatarPrompt:'依据本课程资料引导'});
  const started=await f.post(`/courses/${course.id}/ai`,{kind:'answer',preview:true,conversationId:'knowledge-only-trial',activityId:activity.id,operationId:'knowledge-source-trial-0001',content:'课程介绍什么',budgetConfirmed:true});assert.equal(started.status,202,await started.clone().text());
  const result=await f.poll(`/courses/${course.id}/operations/${(await started.json() as any).operation.id}`);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(calls,1);assert.equal(reads,1);assert.equal(course.materialText,'LEGACY_PRIVATE_TEXT');assert.deepEqual(course.materialAttachmentIds,['legacy-unreadable-file']);
});

test('knowledge-only courses still use private exam references and student work attachments for explicit teacher grading',async t=>{
  let calls=0;const f=await fixture(t,async(_model,messages)=>{calls++;const input=String(messages.find(row=>row.role==='user')?.content);assert.match(input,/TEACHER_REFERENCE_TEXT|EXAM_PRIVATE_FILE_TEXT/);assert.match(input,/STUDENT_WORK_ORIGINAL/);return reply({criteria:[{criterionId:'score',score:80,comment:'依据原作品',evidence:'STUDENT_WORK_ORIGINAL'}],feedback:'请老师复核'});});
  const course=createTeachingCourse(f.db,teacher,{title:'仅知识库学习资料',budgetMicros:0});
  const reference={id:'private-exam-file',...teacher,conversationId:`teaching:${course.id}`,storagePath:'/not-read-when-inline-text',originalName:'试卷.txt',mimeType:'text/plain',kind:'text',size:22,status:'ready',extractedText:'EXAM_PRIVATE_FILE_TEXT',createdAt:'now'} as Attachment;
  const work={...reference,id:'student-original-file',originalName:'作业.txt',extractedText:'STUDENT_WORK_ORIGINAL'};f.db.attachments.push(reference,work);
  const {activity}=createTeachingActivity(f.db,teacher,course.id,{revision:course.revision,title:'批改作业',kind:'assignment',stage:'after',referenceText:'TEACHER_REFERENCE_TEXT',sourceAttachmentIds:[reference.id],rubric:[{id:'score',label:'完成情况',description:'依据原作业',maxScore:100}]});
  const submission=addTeachingSubmission(f.db,teacher,course,{activityId:activity.id,participantName:'老师代传',operationId:'knowledge-work-intake-01',attachmentIds:[work.id]}).submission;
  const response=await f.post(`/courses/${course.id}/ai`,{kind:'grade',activityId:activity.id,submissionId:submission.id,operationId:'knowledge-private-grade-001',budgetConfirmed:true});assert.equal(response.status,202);const result=await f.poll(`/courses/${course.id}/operations/${(await response.json() as any).operation.id}`);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(calls,1);assert.equal(submission.grade?.status,'suggested');assert.equal(submission.grade?.total,80);assert.equal(course.materialText,'');assert.equal(course.sourceMode,'knowledge');assert.equal(course.teacherBudgetMode,'balance');assert.equal(course.budgetMicros,0);
});

test('teacher preview receipts and alias recovery expose only that teacher trial question, never student private questions', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return reply(guidedAnswer()); });
  const { course, activity } = addCourse(f.db);
  const body = { kind: 'answer', preview: true, activityId: activity.id, conversationId: 'teacher-trial-original', operationId: 'teacher-trial-receipt-001', content: 'TEACHER_OWN_PREVIEW_QUESTION', budgetConfirmed: true };
  const first = await f.post(`/courses/${course.id}/ai`, body); assert.equal(first.status, 202, await first.clone().text());
  const initial = (await first.json() as any).operation; assert.equal(initial.question, body.content);
  await f.poll(`/courses/${course.id}/operations/${initial.id}`);
  const recovered = await fetch(`${f.base}/courses/${course.id}/operations/${body.operationId}`, { headers: ownerHeaders });
  assert.equal(recovered.status, 200); assert.equal((await recovered.json() as any).operation.question, body.content);
  const list = await fetch(`${f.base}/courses/${course.id}/operations?activityId=${activity.id}&conversationId=${body.conversationId}`, { headers: ownerHeaders });
  assert.equal((await list.json() as any).operations[0].question, body.content);
  for (const scope of [sameWorkspace, otherWorkspace]) assert.equal((await fetch(`${f.base}/courses/${course.id}/operations/${body.operationId}`, { headers: { ...ownerHeaders, 'x-teacher': scope.userId } })).status, 404);
  const student = createTeachingSession(f.db, course.slug!, { participantName: '学生', consent: true }), headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${student.token}` };
  const submitted = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, operationId: 'student-private-question-001', preview: true, conversationId: body.conversationId, content: 'STUDENT_PRIVATE_QUESTION' }, headers);
  assert.equal(submitted.status, 202); const studentInitial = (await submitted.json() as any).operation; assert.equal(Object.hasOwn(studentInitial, 'question'), false);
  const studentDone = await f.poll(`/public/${course.slug}/operations/${studentInitial.id}`, headers); assert.equal(Object.hasOwn(studentDone, 'question'), false);
  const ownStudentHistory = await fetch(`${f.base}/public/${course.slug}/operations`, { headers }); assert.doesNotMatch(await ownStudentHistory.text(), /STUDENT_PRIVATE_QUESTION|TEACHER_OWN_PREVIEW_QUESTION/);
  assert.equal((await f.post(`/courses/${course.id}/ai`, body)).status, 200); assert.equal(calls, 2, 'receipt recovery and replay never create a third paid call');
});

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

test('game HTTP keeps billed multi-turn context inside one student game and excludes private game logs from teacher insights', async t => {
  const inputs: any[] = [];
  const f = await fixture(t, async (_model, messages) => {
    const data = JSON.parse(String(messages.find(message => message.role === 'user')?.content)).untrustedTeachingData;
    inputs.push(data);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_EXAM_REFERENCE_ANSWER/);
    return reply({ answer: `第 ${inputs.length} 幕：根据你的行动继续故事。`, choices: ['先问村民', '观察水位'] });
  });
  const course = createTeachingCourse(f.db, teacher, { title: '文字游戏', materialText: '', budgetMicros: 1_000_000 });
  const { activity } = createTeachingActivity(f.db, teacher, course.id, { revision: course.revision, title: '城市故事', stage: 'during', kind: 'game', status: 'published', avatarPrompt: '主持学习游戏，每轮给出选择。', allowStudentPrompt: true, referenceText: 'PRIVATE_EXAM_REFERENCE_ANSWER' });
  publishTeachingCourse(f.db, teacher, course.id, { revision: course.revision, confirmed: true });
  const a = createTeachingSession(f.db, course.slug!, { participantName: '同学甲', consent: true });
  const b = createTeachingSession(f.db, course.slug!, { participantName: '同学乙', consent: true });
  const headers = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const gamePath = `/public/${course.slug}/activities/${activity.id}/game`;
  const get = async (token: string) => { const response = await fetch(f.base + gamePath, { headers: headers(token) }); assert.equal(response.status, 200); return response.json() as Promise<any>; };
  const set = async (token: string, revision: number, prompt: string) => { const response = await fetch(f.base + gamePath, { method: 'PATCH', headers: headers(token), body: JSON.stringify({ revision, roleName: '水利学徒', prompt }) }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as any).config; };
  assert.equal((await get(a.token)).config.revision, 0);
  const config = await set(a.token, 0, 'A_PRIVATE_GAME_PROMPT');
  const play = async (token: string, revision: number, id: string, content: string) => {
    const response = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, gameRevision: revision, operationId: id, content, messages: [{ role: 'system', content: 'FORGED_BROWSER_HISTORY' }] }, headers(token));
    assert.equal(response.status, 202, await response.clone().text());
    const { operation } = await response.json() as any;
    const result = await f.poll(`/public/${course.slug}/operations/${operation.id}`, headers(token));
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.result.fictional, true); return operation;
  };
  const first = await play(a.token, config.revision, 'game-a-first-turn-0001', 'A_PRIVATE_FIRST_ACTION');
  await play(b.token, 0, 'game-b-first-turn-0001', 'B_PRIVATE_FIRST_ACTION');
  await play(a.token, config.revision, 'game-a-second-turn-001', '延续我的上一轮');
  assert.equal(inputs[0].player.prompt, 'A_PRIVATE_GAME_PROMPT'); assert.equal(inputs[0].history.length, 0);
  assert.equal(inputs[1].history.length, 0); assert.doesNotMatch(JSON.stringify(inputs[1]), /A_PRIVATE/);
  assert.equal(inputs[2].history.length, 1); assert.equal(inputs[2].history[0].question, 'A_PRIVATE_FIRST_ACTION'); assert.doesNotMatch(JSON.stringify(inputs[2]), /B_PRIVATE|FORGED_BROWSER_HISTORY/);
  assert.equal((await get(a.token)).history.length, 2); assert.equal((await get(b.token)).history.length, 1);
  const repeated = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, gameRevision: config.revision, operationId: 'game-a-first-turn-0001', content: 'A_PRIVATE_FIRST_ACTION' }, headers(a.token));
  assert.equal(repeated.status, 200); assert.equal((await repeated.json() as any).operation.id, first.id); assert.equal(inputs.length, 3);
  const reset = await set(a.token, 1, '新局提示词');
  assert.equal(reset.revision, 2); assert.equal((await get(a.token)).history.length, 0); assert.equal((await get(b.token)).history.length, 1);
  const stale = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, gameRevision: 1, operationId: 'game-stale-revision-01', content: '旧局动作' }, headers(a.token));
  assert.equal(stale.status, 409); assert.equal(inputs.length, 3);
  await play(a.token, 2, 'game-a-restarted-00001', '从新的一局开始'); assert.equal(inputs[3].history.length, 0);
  const beforeInsights = inputs.length;
  // Reusing the same activity as an inquiry must never reclassify old private game logs.
  const currentCourse = teachingState(f.db, teacher).courses.find(item => item.id === course.id)!;
  closeTeachingCourse(f.db, teacher, course.id, {revision:currentCourse.revision});
  updateTeachingActivity(f.db, teacher, course.id, activity.id, {revision:currentCourse.revision,kind:'inquiry',stage:'before'});
  publishTeachingCourse(f.db, teacher, course.id, {revision:currentCourse.revision,confirmed:true});
  const summary = await f.post(`/courses/${course.id}/ai`, { kind: 'insights', activityId: activity.id, operationId: 'teacher-game-insight-1', budgetConfirmed: true });
  const operation = (await summary.json() as any).operation;
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`);
  assert.equal(done.status, 'completed'); assert.equal(inputs.length, beforeInsights, 'unsubmitted personal game logs are not insight input');
  assert.doesNotMatch(JSON.stringify(done.result), /A_PRIVATE|B_PRIVATE|新局提示词/);
  assert.equal(f.db.modelUsageRecords.length, 4); assert.ok(f.db.modelUsageRecords.every(row => row.workspaceId === teacher.workspaceId && row.userId === teacher.userId));
});

test('game configuration cannot change while a billed turn is in flight and unknown restart receipts do not reissue it', async t => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, async () => { calls++; await gate; return reply({ answer: '这一幕结束。', choices: [] }); });
  const course = createTeachingCourse(f.db, teacher, { title: '游戏并发测试', budgetMicros: 1_000_000 });
  const { activity } = createTeachingActivity(f.db, teacher, course.id, { revision: course.revision, title: '游戏', stage: 'during', kind: 'game', allowStudentPrompt: true, status: 'published' });
  publishTeachingCourse(f.db, teacher, course.id, { revision: course.revision, confirmed: true });
  const student = createTeachingSession(f.db, course.slug!, { participantName: '参与者', consent: true });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${student.token}` };
  const response = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, gameRevision: 0, operationId: 'game-pending-restart-1', content: '开始' }, headers);
  const { operation } = await response.json() as any;
  const change = await fetch(`${f.base}/public/${course.slug}/activities/${activity.id}/game`, { method: 'PATCH', headers, body: JSON.stringify({ revision: 0, roleName: '新角色', prompt: '新玩法' }) });
  assert.equal(change.status, 409);
  // A distinct process has no local lease for the durable request.
  const restarted = await f.start();
  const recovered = await fetch(`${restarted}/public/${course.slug}/operations/${operation.id}`, { headers });
  assert.equal((await recovered.json() as any).operation.status, 'uncertain');
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  const same = await f.post(`/public/${course.slug}/questions`, { activityId: activity.id, gameRevision: 0, operationId: 'game-pending-restart-1', content: '开始' }, headers);
  assert.equal((await same.json() as any).operation.status, 'uncertain'); assert.equal(calls, 1);
});

test('adopting a new grading basis during a model call cannot attach or publish the stale suggestion', async t => {
  let release!: () => void, calls = 0; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const f = await fixture(t, async () => { calls++; await gate; return reply({ criteria: [{ criterionId: 'observation', score: 5, comment: '旧版本建议', evidence: '我观察了茶具' }], feedback: 'STALE_GRADING_SUGGESTION' }); });
  const { course, activity } = addCourse(f.db, teacher, 'assignment', false);
  const submission = addTeachingSubmission(f.db, teacher, course, { activityId: activity.id, operationId: 'basis-inflight-submit1', participantName: '一', text: '我观察了茶具。' }).submission;
  const started = await f.post(`/courses/${course.id}/ai`, { kind: 'grade', submissionId: submission.id, activityId: activity.id, operationId: 'basis-inflight-grade1', budgetConfirmed: true, gradingRevision: 0 }); assert.equal(started.status, 202);
  const operation = (await started.json() as any).operation;
  for (let attempt = 0; attempt < 100 && !calls; attempt++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 1);
  // Adopting the saved current rubric is a real teacher action which changes
  // only this submission's basis revision, not the general course revision.
  const adopted = await f.post(`/courses/${course.id}/submissions/${submission.id}/grading-basis`, { confirmed: true, submissionActivityRevision: submission.activityRevision, activityRevision: activity.revision, expectedGradingRevision: 0 }); assert.equal(adopted.status, 200); assert.equal((await adopted.json() as any).submission.gradingRevision, 1);
  release(); const finished = await f.poll(`/courses/${course.id}/operations/${operation.id}`); assert.equal(finished.status, 'failed'); assert.match(finished.error, /评分依据.*变化|评分.*版本/);
  assert.equal(teachingState(f.db, teacher).submissions.find(row => row.id === submission.id)!.grade, undefined); assert.equal(f.db.modelUsageRecords.length, 1);
  assert.equal((await f.post(`/courses/${course.id}/ai`, { kind: 'grade', submissionId: submission.id, activityId: activity.id, operationId: 'basis-stale-new-grade1', budgetConfirmed: true, gradingRevision: 0 })).status, 409);
  assert.equal((await f.post(`/courses/${course.id}/submissions/${submission.id}/grading-basis`, { confirmed: true, submissionActivityRevision: submission.activityRevision, activityRevision: activity.revision, expectedGradingRevision: 1 }, { ...ownerHeaders, 'x-teacher': sameWorkspace.userId })).status, 404);
});

test('course create HTTP receipt replays and rejects conflicting payload without accepting a foreign owner', async t => {
  const f = await fixture(t, async () => { assert.fail('course create has no model call'); });
  const body = { clientRequestId: 'create-course-http-001', title: '一次课程' };
  const first = await f.post('/courses', body); assert.equal(first.status, 201); const course = (await first.json() as any).course;
  const replay = await f.post('/courses', body); assert.equal(replay.status, 200); assert.equal((await replay.json() as any).course.id, course.id);
  assert.equal((await f.post('/courses', { ...body, title: 'changed' })).status, 409);
  const foreign = await f.post('/courses', body, { ...ownerHeaders, 'x-teacher': otherWorkspace.userId }); assert.equal(foreign.status, 201); assert.notEqual((await foreign.json() as any).course.id, course.id);
  assert.equal(f.db.modelUsageRecords.length, 0);
});

test('teacher grades a student attachment-only photograph through the billed vision route and students wait for publication', async t => {
  let calls = 0;
  const f = await fixture(t, async (_model, messages) => { calls++; assert.ok(messages.some(message => message.inputImageDataUrls?.length === 1)); const data = JSON.parse(String(messages.find(message => message.role === 'user')!.content)).untrustedTeachingData; assert.equal(data.work.text, ''); assert.equal(data.imageCount, 1); assert.doesNotMatch(JSON.stringify(data), /private-photo-owner|学生图名|private-ref/); return reply({ criteria: [{ criterionId: 'observation', score: 8, comment: '需老师核对原图', evidence: '可见观察记录和标注', evidenceImageIndex: 1 }], feedback: '视觉评分建议，待老师复核。' }); });
  const { course, activity } = addCourse(f.db, teacher, 'assignment'), joined = createTeachingSession(f.db, course.slug!, { participantName: '学生图名', participantRef: 'private-ref', participantClass: '测试一班', consent: true }), studentHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${joined.token}` };
  const storagePath = path.join(f.directory, 'student-original.png'); await fs.writeFile(storagePath, Buffer.from('synthetic-private-image'));
  const photo = { id: 'private-photo-owner', workspaceId: teacher.workspaceId, userId: joined.sessionId, conversationId: `teaching:${course.id}`, status: 'ready', kind: 'image', mimeType: 'image/png', originalName: 'photo.png', size: 23, storagePath, extractedText: '', createdAt: new Date().toISOString() } as Attachment; f.db.attachments.push(photo);
  const submitted = await f.post(`/public/${course.slug}/submissions`, { activityId: activity.id, operationId: 'photo-assignment-only1', attachmentIds: [photo.id] }, studentHeaders); assert.equal(submitted.status, 201); const submission = (await submitted.json() as any).submission;
  const response = await f.post(`/courses/${course.id}/ai`, { kind: 'grade', activityId: activity.id, submissionId: submission.id, operationId: 'photo-vision-grade001', budgetConfirmed: true }); assert.equal(response.status, 202); const op = (await response.json() as any).operation;
  const done = await f.poll(`/courses/${course.id}/operations/${op.id}`); assert.equal(done.status, 'completed', JSON.stringify(done)); assert.match(done.result.grade.criteria[0].evidence, /^图片1：.*视觉建议/); assert.equal(calls, 1); assert.equal(f.db.modelUsageRecords.length, 1);
  const mine = await (await fetch(`${f.base}/public/${course.slug}/submissions`, { headers: studentHeaders })).json() as any; assert.equal(Object.hasOwn(mine.submissions[0], 'grade'), false);
});

test('collect, set private assignment grading, explicitly adopt and publish feedback through the original student link and token', async t => {
  let calls = 0;
  const f = await fixture(t, async (_model, messages) => { calls++; const data = JSON.parse(String(messages.find(message => message.role === 'user')!.content)).untrustedTeachingData; assert.equal(data.criteria[0].id, 'late-rubric'); assert.match(data.materialText, /PRIVATE_NEW_REFERENCE/); return reply({ criteria: [{ criterionId: 'late-rubric', score: 9, comment: '有具体观察', evidence: '我观察了茶具' }], feedback: '新标准下的建议，待老师复核' }); });
  const course = createTeachingCourse(f.db, teacher, { title: '先收作业再评分', budgetMicros: 1_000_000 });
  const { activity } = createTeachingActivity(f.db, teacher, course.id, { revision: course.revision, kind: 'assignment', stage: 'after', title: '交观察作业', instructions: '请上传观察记录', status: 'published', rubric: [] });
  publishTeachingCourse(f.db, teacher, course.id, { revision: course.revision, confirmed: true });
  const slug = course.slug!, sharedAt = course.updatedAt;
  const joined = await f.post(`/public/${slug}/sessions`, { participantName: '原学生', participantClass: '一班', consent: true }); assert.equal(joined.status, 201); const session = await joined.json() as any;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const submitted = await f.post(`/public/${slug}/submissions`, { activityId: activity.id, operationId: 'late-rubric-student-01', text: '我观察了茶具。' }, headers); assert.equal(submitted.status, 201); const submission = (await submitted.json() as any).submission;
  const original = structuredClone(teachingState(f.db, teacher).submissions.find(row => row.id === submission.id)!.activitySnapshot);
  const patch = (body: unknown, access: Record<string,string> = ownerHeaders, id = course.id) => fetch(`${f.base}/courses/${id}/activities/${activity.id}/grading`, { method: 'PATCH', headers: access, body: JSON.stringify(body) });
  const grading = { revision: course.revision, activityRevision: activity.revision, rubric: [{ id: 'late-rubric', label: '观察', description: '具体、真实的观察', maxScore: 10 }], referenceText: 'PRIVATE_NEW_REFERENCE', sourceAttachmentIds: [], knowledgeSources: [], avatarPrompt: 'PRIVATE_GRADING_GUIDANCE_WITH_ANSWER' };
  assert.equal((await patch(grading, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await patch(grading, headers)).status, 401, 'a student token never grants teacher grading access');
  for (const scope of [sameWorkspace, otherWorkspace]) assert.equal((await patch(grading, { ...ownerHeaders, 'x-teacher': scope.userId })).status, 404);
  const other = addCourse(f.db, teacher, 'assignment'); assert.equal((await patch({ ...grading, revision: other.course.revision }, ownerHeaders, other.course.id)).status, 404);
  const saved = await patch(grading); assert.equal(saved.status, 200, await saved.clone().text()); const updated = await saved.json() as any;
  assert.equal(updated.course.slug, slug); assert.equal(updated.course.status, 'published'); assert.equal(updated.course.updatedAt, sharedAt);
  const studentCourse = await (await fetch(`${f.base}/public/${slug}`)).json() as any; assert.equal(studentCourse.course.activities[0].avatarPrompt, ''); assert.doesNotMatch(JSON.stringify(studentCourse), /PRIVATE_GRADING_GUIDANCE_WITH_ANSWER|PRIVATE_NEW_REFERENCE|sourceAttachmentIds|knowledgeSources/);
  assert.equal((await patch(grading)).status, 409, 'a stale edit cannot overwrite the current grading setup');
  const unchanged = teachingState(f.db, teacher).submissions.find(row => row.id === submission.id)!; assert.deepEqual(unchanged.activitySnapshot, original); assert.equal(unchanged.gradingSnapshot, undefined);
  const before = await fetch(`${f.base}/public/${slug}/session`, { headers }); assert.equal(before.status, 200); assert.equal((await before.json() as any).session.id, session.sessionId);
  const adopted = await f.post(`/courses/${course.id}/submissions/${submission.id}/grading-basis`, { confirmed: true, submissionActivityRevision: submission.activityRevision, activityRevision: updated.activity.revision, expectedGradingRevision: 0 }); assert.equal(adopted.status, 200); assert.equal((await adopted.json() as any).submission.gradingRevision, 1);
  const started = await f.post(`/courses/${course.id}/ai`, { kind: 'grade', activityId: activity.id, submissionId: submission.id, operationId: 'late-rubric-ai-grade1', budgetConfirmed: true, gradingRevision: 1 }); assert.equal(started.status, 202); const operation = (await started.json() as any).operation;
  const done = await f.poll(`/courses/${course.id}/operations/${operation.id}`); assert.equal(done.status, 'completed', JSON.stringify(done)); assert.equal(calls, 1);
  const suggested = await (await fetch(`${f.base}/public/${slug}/submissions`, { headers })).json() as any; assert.equal(Object.hasOwn(suggested.submissions[0], 'grade'), false);
  const grade = { ...done.result.grade, gradingRevision: 1, feedback: '老师复核后发布的原学生反馈' };
  const reviewed = await fetch(`${f.base}/courses/${course.id}/submissions/${submission.id}/review`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ grade }) }); assert.equal(reviewed.status, 200);
  const publicResult = await fetch(`${f.base}/public/${slug}/submissions`, { headers }); assert.equal(publicResult.status, 200); const mine = await publicResult.json() as any;
  assert.equal(mine.submissions.length, 1); assert.equal(mine.submissions[0].id, submission.id); assert.equal(mine.submissions[0].grade.total, 9); assert.equal(mine.submissions[0].grade.feedback, grade.feedback);
  assert.doesNotMatch(JSON.stringify(mine), /PRIVATE_NEW_REFERENCE|gradingSnapshot|sourceAttachmentIds|knowledgeSources/);
  const secondGrading = await patch({ ...grading, revision: updated.course.revision, activityRevision: updated.activity.revision, rubric: [{ id: 'future', label: '以后的标准', description: '', maxScore: 100 }] }); assert.equal(secondGrading.status, 200);
  assert.equal((await fetch(`${f.base}/public/${slug}/submissions`, { headers })).status, 200);
  assert.equal(unchanged.grade?.total, 9); assert.equal((await f.post(`/courses/${course.id}/submissions/${submission.id}/grading-basis`, { confirmed: true, activityRevision: activity.revision, submissionActivityRevision: submission.activityRevision, expectedGradingRevision: 1 })).status, 409);
  // The established close/republish revocation behavior remains unchanged.
  const liveCourse = teachingState(f.db, teacher).courses.find(row => row.id === course.id)!;
  closeTeachingCourse(f.db, teacher, course.id, { revision: liveCourse.revision }); assert.equal((await fetch(`${f.base}/public/${slug}/submissions`, { headers })).status, 410);
  publishTeachingCourse(f.db, teacher, course.id, { revision: liveCourse.revision, confirmed: true }); assert.notEqual(liveCourse.slug, slug);
  assert.equal((await fetch(`${f.base}/public/${slug}/submissions`, { headers })).status, 404);
  assert.equal((await fetch(`${f.base}/public/${liveCourse.slug}/submissions`, { headers })).status, 401);
});

test('the private grading endpoint rechecks ONE Key before mutating a published assignment', async t => {
  const f = await fixture(t, async () => { assert.fail('grading setup has no model call'); }), { course, activity } = addCourse(f.db, teacher, 'assignment'); const revision = course.revision, activityRevision = activity.revision;
  f.removeKey();
  const response = await fetch(`${f.base}/courses/${course.id}/activities/${activity.id}/grading`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ revision, activityRevision, referenceText: 'must not save' }) }); assert.equal(response.status, 428);
  assert.equal(course.revision, revision); assert.equal(activity.revision, activityRevision); assert.notEqual(activity.referenceText, 'must not save');
});
