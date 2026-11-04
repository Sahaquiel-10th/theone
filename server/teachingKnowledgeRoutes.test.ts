import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { Store } from './db.js';
import type { Database, KnowledgeConnection, ModelConfig } from './types.js';
import { installTeachingKnowledgeRoutes, type TeachingKnowledgeRouteDependencies } from './teachingKnowledgeRoutes.js';
import { bindTeachingKnowledgeSources } from './teachingKnowledge.js';
import {installTeachingRoutes} from './teachingRoutes.js';
import {ImaService} from './knowledge/imaService.js';
import {imaConnector} from './connectors/ima.js';
import {ConnectorRegistry} from './connectors/registry.js';
import {KnowledgeService} from './knowledge/knowledgeService.js';
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
async function fixture(t: TestContext, knowledgeInput: Omit<TeachingKnowledgeRouteDependencies, 'verifyKey'>|((store:Store)=>Omit<TeachingKnowledgeRouteDependencies,'verifyKey'>), modelCall?: TeachingAiRouteDependencies['modelCall']) {
  let db = database(), tail: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(fn: (db: Database) => T) => { const next = tail.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } }); tail = next.catch(() => undefined); return next; } };
  const auth: express.RequestHandler = (req, res, next) => { const user = db.users.find(user => user.id === req.headers['x-teacher']); if (!user) { res.sendStatus(401); return; } req.user = user; req.workspaceId = user.defaultWorkspaceId; next(); };
  let keyActive = true;
  const verifyKey = async (req: express.Request) => { if (!keyActive || req.headers['x-key'] !== 'present') throw new TeachingError('请插入 ONE Key。', 428); };
  const app = express(); app.use(express.json());
  const knowledge=typeof knowledgeInput==='function'?knowledgeInput(store):knowledgeInput;
  installTeachingRoutes(app,[auth],store,{verifyKey});
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

function syntheticImaTransport(){const calls:{path:string;body:Record<string,any>}[]=[],options:{mode:'read'|'no_match'|'unreadable';beforeSearch?:()=>void}={mode:'read'};const fetcher=(async(url,init)=>{const path=new URL(String(url)).pathname.split('/').at(-1)!;assert.equal(new URL(String(url)).origin,'https://ima.qq.com','fixture never makes an external network call');const body=JSON.parse(String(init?.body??'{}'));calls.push({path,body});let data:unknown;if(path==='search_knowledge_base')data={info_list:[{id:'library-selected',name:'合成杭州讲义'},{id:'library-unselected',name:'未选择的其他资料'}],is_end:true};else if(path==='list_notebook')data={note_folder_infos:[]};else if(path==='search_note')data={search_note_infos:[],is_end:true};else if(path==='search_knowledge'){assert.equal(body.knowledge_base_id,'library-selected');options.beforeSearch?.();data={info_list:options.mode==='no_match'?[]:options.mode==='unreadable'?[{media_id:'file-only',title:'合成不可读取文件.pdf',highlight_content:''}]:[{media_id:'selected-document',title:'合成杭州讲义',highlight_content:'PUBLIC_LEARNING_PAGE：杭州城市文化的合成片段。'}],is_end:true};}else if(path==='get_media_info')data={media_type:1,url_info:{url:'https://unapproved.invalid/PRIVATE_SIGNED_LINK',headers:{Authorization:'PRIVATE_OBJECT_GRANT'}}};else assert.fail(`fixture does not support ${path}`);return Response.json({code:0,data});}) as typeof fetch;return {calls,options,fetcher};}

test('HTTP preview -> new course -> refresh -> student AI preserves explicit consent and exact ima library scope through real adapters with synthetic transport',async t=>{const remote=syntheticImaTransport();let ima!:ImaService,modelCalls=0;const f=await fixture(t,store=>{ima=new ImaService(store,remote.fetcher);return {knowledgeService:new KnowledgeService(store,new ConnectorRegistry([imaConnector(ima)]))};},async(_model,messages)=>{modelCalls++;assert.match(JSON.stringify(messages),/PUBLIC_LEARNING_PAGE/);assert.doesNotMatch(JSON.stringify(messages),/未选择的其他资料|PRIVATE_NOTION_CREDENTIAL|SYNTHETIC_IMA_API_KEY|SYNTHETIC_IMA_CLIENT/);return answer();});await ima.connect(teacher,{clientId:'SYNTHETIC_IMA_CLIENT',apiKey:'SYNTHETIC_IMA_API_KEY'});await ima.updateScope(teacher,['library-selected']);const connection=f.db.knowledgeConnections.find(row=>row.provider==='ima')!;remote.calls.length=0;const existing=createTeachingCourse(f.db,teacher,{title:'合成已有课程'});const raw={connectionId:connection.id,scope:'connection',confirmed:true};assert.equal((await f.post('/knowledge/preview',{source:raw})).status,400,'no generic label or empty query search');assert.equal(remote.calls.length,0);const preview=await f.post('/knowledge/preview',{courseId:existing.id,source:raw,query:'合成杭州课程的城市文化'});assert.equal(preview.status,200,await preview.clone().text());const result=await preview.json() as any;assert.equal(result.source.confirmed,true);assert.equal(result.preview.status,'read');assert.equal(result.preview.query,'合成杭州课程的城市文化');const edited=await fetch(`${f.base}/courses/${existing.id}`,{method:'PATCH',headers,body:JSON.stringify({revision:existing.revision,knowledgeSources:[result.source]})});assert.equal(edited.status,200,await edited.clone().text());assert.equal((await edited.json() as any).course.knowledgeSources[0].confirmed,undefined,'new source also survives PATCH when previous did not contain the grant');const created=await f.post('/courses',{clientRequestId:'knowledge-new-course-0001',title:'合成杭州课程',subject:'人文',budgetMicros:1_000_000,knowledgeSources:[result.source]});assert.equal(created.status,201,await created.clone().text());let course=(await created.json() as any).course;assert.equal(course.knowledgeSources.length,1);assert.equal(Object.hasOwn(course.knowledgeSources[0],'confirmed'),false,'transient consent is normalized away after saving');const refreshed=await fetch(`${f.base}/courses/${course.id}`,{headers});assert.equal(refreshed.status,200);course=(await refreshed.json() as any).course;assert.equal(course.knowledgeSources[0].binding,result.source.binding);const noMatchSource=course.knowledgeSources[0];remote.options.mode='no_match';const none=await f.post('/knowledge/preview',{courseId:course.id,source:noMatchSource,query:'更具体但未命中的合成问题'});assert.equal(none.status,200);const noneBody=await none.json() as any;assert.equal(noneBody.preview.status,'no_match');assert.equal(noneBody.preview.text,'');assert.equal(f.db.knowledgeConnections.find(row=>row.id===connection.id)!.status,'connected');assert.equal(f.db.users[0].teaching!.courses[0].knowledgeSources!.length,1,'no_match does not remove a saved association');remote.options.mode='read';const activityResponse=await f.post(`/courses/${course.id}/activities`,{clientRequestId:'knowledge-activity-0001',revision:course.revision,title:'合成课程答疑',kind:'inquiry',stage:'before',status:'draft'});assert.equal(activityResponse.status,201);const activityBody=await activityResponse.json() as any;course=activityBody.course;const opened=await f.post(`/courses/${course.id}/activities/${activityBody.activity.id}/open`,{revision:course.revision,activityRevision:activityBody.activity.revision,confirmed:true});assert.equal(opened.status,200);const activity=(await opened.json() as any).activity;const joined=await f.post(`/public/${activity.slug}/sessions`,{participantName:'合成学生',consent:true},{'Content-Type':'application/json'});assert.equal(joined.status,201);const studentHeaders={'Content-Type':'application/json',Authorization:`Bearer ${(await joined.json() as any).token}`};const asked=await f.post(`/public/${activity.slug}/questions`,{activityId:activity.id,operationId:'knowledge-exact-ima-question1',content:'合成杭州课程的文化主题是什么',knowledgeSources:[{connectionId:'notion-b',scope:'connection',confirmed:true}]},studentHeaders);assert.equal(asked.status,202);const operation=(await asked.json() as any).operation;const done=await f.poll(`/public/${activity.slug}/operations/${operation.id}`,studentHeaders);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(modelCalls,1);assert.ok(remote.calls.filter(call=>call.path==='search_knowledge').every(call=>call.body.knowledge_base_id==='library-selected'));assert.ok(remote.calls.filter(call=>call.path==='search_knowledge').every(call=>call.body.query!=='ima'&&call.body.query!=='课程资料'));const cross=await f.post('/knowledge/preview',{source:raw,query:'不允许读别人连接'},{...headers,'x-teacher':other.userId});assert.equal(cross.status,403);const count=remote.calls.length;const crossCourse=await f.post('/knowledge/preview',{courseId:course.id,source:raw,query:'不能用别人的课程上下文'},{...headers,'x-teacher':other.userId});assert.equal(crossCourse.status,404);assert.equal(remote.calls.length,count);assert.doesNotMatch(JSON.stringify(done),/SYNTHETIC_IMA_API_KEY|SYNTHETIC_IMA_CLIENT|PRIVATE_OBJECT_GRANT/);});

test('ima preview distinguishes no selected library from unreadable matched content using real adapters and safe diagnostic codes',async t=>{const remote=syntheticImaTransport();let ima!:ImaService;const f=await fixture(t,store=>{ima=new ImaService(store,remote.fetcher);return {knowledgeService:new KnowledgeService(store,new ConnectorRegistry([imaConnector(ima)]))};});await ima.connect(teacher,{clientId:'SYNTHETIC_IMA_CLIENT',apiKey:'SYNTHETIC_IMA_API_KEY'});const connection=f.db.knowledgeConnections.find(row=>row.provider==='ima')!;await ima.updateScope(teacher,[]);const source={connectionId:connection.id,scope:'connection',confirmed:true};const empty=await f.post('/knowledge/preview',{source,query:'合成范围试搜'});assert.equal(empty.status,409);assert.equal((await empty.json() as any).code,'TEACHING_KNOWLEDGE_SCOPE_REQUIRED');assert.equal(f.db.knowledgeConnections.find(row=>row.id===connection.id)!.status,'connected');await ima.updateScope(teacher,['library-selected']);remote.options.mode='unreadable';const unreadable=await f.post('/knowledge/preview',{source,query:'合成文件正文'});assert.equal(unreadable.status,422);const details=await unreadable.json() as any;assert.equal(details.code,'TEACHING_KNOWLEDGE_CONTENT_UNAVAILABLE');assert.match(details.error,/已命中.*未取得可读正文/);assert.doesNotMatch(JSON.stringify(details),/PRIVATE_SIGNED_LINK|PRIVATE_OBJECT_GRANT|SYNTHETIC_IMA/);assert.equal(f.db.knowledgeConnections.find(row=>row.id===connection.id)!.status,'connected');});

test('a previewed ima grant cannot be saved or returned after selected libraries, client account, revocation or workspace changes',async t=>{for(const mode of ['scope','client','revoked','workspace']){const remote=syntheticImaTransport();let ima!:ImaService;const f=await fixture(t,store=>{ima=new ImaService(store,remote.fetcher);return {knowledgeService:new KnowledgeService(store,new ConnectorRegistry([imaConnector(ima)]))};});await ima.connect(teacher,{clientId:'SYNTHETIC_IMA_CLIENT',apiKey:'SYNTHETIC_IMA_API_KEY'});await ima.updateScope(teacher,['library-selected']);const connection=f.db.knowledgeConnections.find(row=>row.provider==='ima')!;const preview=await f.post('/knowledge/preview',{source:{connectionId:connection.id,scope:'connection',confirmed:true},query:'合成预览'});assert.equal(preview.status,200);const source=(await preview.json() as any).source;if(mode==='scope')connection.retrievalScope!.selectedIds=['library-unselected'];if(mode==='client')connection.encryptedClientId='CHANGED_CLIENT';if(mode==='revoked')connection.status='revoked';if(mode==='workspace')connection.workspaceId='wb';const created=await f.post('/courses',{title:'不应保存旧授权',knowledgeSources:[source]});assert.equal(created.status,mode==='scope'||mode==='client'?409:403);assert.equal(f.db.users[0].teaching?.courses.length??0,0);assert.doesNotMatch(await created.text(),/PUBLIC_LEARNING_PAGE|SYNTHETIC_IMA/);}});

test('ima range changes during preview discard the former library text before any teacher response',async t=>{const remote=syntheticImaTransport();let ima!:ImaService;const f=await fixture(t,store=>{ima=new ImaService(store,remote.fetcher);return {knowledgeService:new KnowledgeService(store,new ConnectorRegistry([imaConnector(ima)]))};});await ima.connect(teacher,{clientId:'SYNTHETIC_IMA_CLIENT',apiKey:'SYNTHETIC_IMA_API_KEY'});await ima.updateScope(teacher,['library-selected']);const connection=f.db.knowledgeConnections.find(row=>row.provider==='ima')!;remote.options.beforeSearch=()=>{f.db.knowledgeConnections.find(row=>row.id===connection.id)!.retrievalScope!.selectedIds=['library-unselected'];};const response=await f.post('/knowledge/preview',{source:{connectionId:connection.id,scope:'connection',confirmed:true},query:'合成途中变更'});assert.equal(response.status,409);const body=await response.json() as any;assert.equal(body.code,'TEACHING_KNOWLEDGE_BINDING_CHANGED');assert.doesNotMatch(JSON.stringify(body),/PUBLIC_LEARNING_PAGE|SYNTHETIC_IMA|PRIVATE_OBJECT/);assert.deepEqual(f.db.knowledgeConnections.find(row=>row.id===connection.id)!.retrievalScope!.selectedIds,['library-unselected']);assert.equal(f.db.knowledgeConnections.find(row=>row.id===connection.id)!.status,'connected','the stale former-range failure cannot overwrite the new connection state');});

test('select binds without search and preserves explicit consent, owner isolation and Key checks',async t=>{
 let searches=0;const f=await fixture(t,{knowledgeService:{recallWithDiagnostics:async()=>{searches++;throw Error('selection must not search');}}});
 const source={connectionId:'getnote-a',scope:'connection',confirmed:true};
 const r=await f.post('/knowledge/select',{source});assert.equal(r.status,200);const body=await r.json() as any;assert.equal(body.source.confirmed,true);assert.ok(body.source.binding);assert.equal(searches,0);
 assert.equal((await f.post('/knowledge/select',{source:{...source,confirmed:false}})).status,400);
 assert.equal((await f.post('/knowledge/select',{source:{...source,connectionId:'notion-b'}})).status,403);
 assert.equal((await f.post('/knowledge/select',{source},{'Content-Type':'application/json','x-teacher':teacher.userId})).status,428);
});
