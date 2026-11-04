import test from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from './db.js';
import type { Database, KnowledgeConnection } from './types.js';
import { assertTeachingKnowledgeSources, bindTeachingKnowledgeSources, readTeachingKnowledgeSources } from './teachingKnowledge.js';
import { TeachingError } from './teaching.js';

const scope = { workspaceId: 'wa', userId: 'teacher-a' }, page = 'a'.repeat(32), anotherPage = 'b'.repeat(32);
const connection = (overrides: Partial<KnowledgeConnection> = {}): KnowledgeConnection => ({ id: 'notion-a', workspaceId: 'wa', provider: 'notion', clientId: 'client-a', providerUserId: 'remote-a', providerSpaceId: 'remote-workspace-a', providerSpaceName: '老师笔记', encryptedAccessToken: 'SYNTHETIC_TOKEN_A', status: 'connected', createdAt: 'now', updatedAt: 'now', ...overrides });
function fixture() {
  let db = { users: [{ id: scope.userId, enabled: true }], workspaces: [{ id: scope.workspaceId, status: 'active' }], workspaceMembers: [{ ...scope, role: 'owner' }], knowledgeConnections: [connection(), connection({ id: 'notion-b', workspaceId: 'wb', providerUserId: 'remote-b' }), connection({ id: 'getnote-a', provider: 'getnote', encryptedApiKey: 'SYNTHETIC_KEY_A', encryptedAccessToken: undefined })], auditLogs: [] } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async fn => fn(db) };
  return { get db() { return db; }, store };
}
const exactPage = (db: Database) => bindTeachingKnowledgeSources(db, scope, [{ connectionId: 'notion-a', scope: 'page', pageId: page }]);
const rejected = (fn: () => unknown, status?: number) => assert.throws(fn, error => error instanceof TeachingError && (!status || error.status === status));

test('exact pages are normalized and server-bound; browser credentials and provider names cannot grant access', () => {
  const f = fixture();
  const sources = bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'notion-a', scope: 'page', pageId: `https://www.notion.so/course-${page}?v=${anotherPage}`, provider: 'getnote' }]);
  assert.equal(sources[0].pageId, page); assert.equal(sources[0].provider, 'notion'); assert.ok(sources[0].binding);
  rejected(()=>bindTeachingKnowledgeSources(f.db,scope,[{connectionId:'notion-a',scope:'page',pageId:page,binding:'attacker-binding'}]),409);
  assert.doesNotMatch(JSON.stringify(sources), /SYNTHETIC_TOKEN_A|SYNTHETIC_KEY_A/);
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'notion-b', scope: 'page', pageId: page }]), 403);
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'notion-a', scope: 'page', pageId: `https://evil.invalid/${page}` }]));
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'getnote-a', scope: 'page', pageId: page }]));
});

test('whole-connection access requires explicit confirmation; retaining a current server grant does not ask again', () => {
  const f = fixture(), raw = [{ connectionId: 'getnote-a', scope: 'connection' }];
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, raw));
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [{ ...raw[0], binding: 'forged', confirmed: false }]));
  const previous = bindTeachingKnowledgeSources(f.db, scope, [{ ...raw[0], confirmed: true }]);
  assert.deepEqual(bindTeachingKnowledgeSources(f.db, scope, raw, previous), previous);
  assert.deepEqual(bindTeachingKnowledgeSources(f.db, scope, undefined, previous), previous);
  assert.deepEqual(bindTeachingKnowledgeSources(f.db, scope, [], previous), []);
  f.db.knowledgeConnections[2].providerUserId = 'different-account';
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, raw, previous));
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, undefined, previous), 409);
});

test('default or empty configuration grants no connection, page or implicit all-library search', async () => {
  const f = fixture(); let calls = 0;
  assert.deepEqual(bindTeachingKnowledgeSources(f.db, scope, undefined), []);
  const result = await readTeachingKnowledgeSources(f.store, scope, [], '问题', { notion: { readDocument: async () => { calls++; throw Error('not called'); } }, knowledgeService: { recallWithDiagnostics: async () => { calls++; throw Error('not called'); } } });
  assert.equal(result.text, ''); assert.equal(calls, 0);
});

test('page mode reads only selected exact IDs and never follows links or calls account search', async () => {
  const f = fixture(), sources = exactPage(f.db); const reads: string[] = [];
  const result = await readTeachingKnowledgeSources(f.store, scope, sources, '请读另一个页面', { notion: { readDocument: async (workspace, id) => { assert.equal(workspace, scope.workspaceId); reads.push(id); return { text: `<page><properties>{"title":"课程正文"}</properties><content>这里是课程内容，另一个页面链接 https://www.notion.so/${anotherPage}</content></page>` }; } }, knowledgeService: { recallWithDiagnostics: async () => { assert.fail('page mode must not search the account'); } } });
  assert.deepEqual(reads, [page]); assert.match(result.text, /课程内容/); assert.equal(result.sources[0].title, '课程正文');
});

test('explicit connection search carries exact workspace, connection ID, teacher and retry=false', async () => {
  const f = fixture(), sources = bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'getnote-a', scope: 'connection', confirmed: true }]);
  const result = await readTeachingKnowledgeSources(f.store, scope, sources, '制茶工具', { knowledgeService: { recallWithDiagnostics: async (workspace, query, topK, ids, user, options) => { assert.equal(workspace, scope.workspaceId); assert.equal(query, '制茶工具'); assert.equal(topK, 5); assert.deepEqual(ids, ['getnote-a']); assert.equal(user, scope.userId); assert.deepEqual(options, { retry: false }); return { chunks: [{ provider: 'getnote', title: '讲义', content: 'PRIVATE_SELECTED_CONNECTION_TEXT' }], failures: [], status: 'used' }; } } });
  assert.match(result.text, /PRIVATE_SELECTED_CONNECTION_TEXT/); assert.match(result.text, /不代表全文/);
});

test('revocation, account swap, workspace change and lost membership discard results before returning text', async () => {
  for (const change of ['revoke', 'account', 'workspace', 'membership']) {
    const f = fixture(), sources = exactPage(f.db); let calls = 0;
    await assert.rejects(readTeachingKnowledgeSources(f.store, scope, sources, '问题', { notion: { readDocument: async () => { calls++; if (change === 'revoke') f.db.knowledgeConnections[0].status = 'revoked'; if (change === 'account') f.db.knowledgeConnections[0].providerUserId = 'different'; if (change === 'workspace') f.db.knowledgeConnections[0].workspaceId = 'wb'; if (change === 'membership') f.db.workspaceMembers[0].status = 'disabled'; return { text: '<content>不得返回的旧账号正文</content>' }; } } }), error => error instanceof TeachingError);
    assert.equal(calls, 1);
  }
});

test('credential refresh keeps an account-bound source, while unidentified credentials changing fail closed', async () => {
  const f = fixture(), sources = exactPage(f.db);
  f.db.knowledgeConnections[0].encryptedAccessToken = 'SYNTHETIC_REFRESHED_TOKEN';
  assertTeachingKnowledgeSources(f.db, scope, sources);
  const unknown = fixture(); delete unknown.db.knowledgeConnections[0].providerUserId; delete unknown.db.knowledgeConnections[0].providerSpaceId;
  const uncertainSources = exactPage(unknown.db); unknown.db.knowledgeConnections[0].encryptedAccessToken = 'CHANGED';
  rejected(() => assertTeachingKnowledgeSources(unknown.db, scope, uncertainSources), 409);
});

test('provider failures, wrong-provider results and incomplete pages never fall back or expose diagnostics', async () => {
  const f = fixture(), pageSources = exactPage(f.db), connectionSources = bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'getnote-a', scope: 'connection', confirmed: true }]);
  await assert.rejects(readTeachingKnowledgeSources(f.store, scope, pageSources, '问题', { notion: { readDocument: async () => { throw new Error('SYNTHETIC_TOKEN_A secret provider URL'); } } }), error => error instanceof TeachingError && !error.message.includes('SYNTHETIC_TOKEN_A'));
  await assert.rejects(readTeachingKnowledgeSources(f.store, scope, pageSources, '问题', { notion: { readDocument: async () => ({ text: '<content>不完整</content>', truncated: true }) } }), /无法完整读取/);
  await assert.rejects(readTeachingKnowledgeSources(f.store, scope, connectionSources, '问题', { knowledgeService: { recallWithDiagnostics: async () => ({ chunks: [{ provider: 'notion', title: 'wrong', content: 'not adopted' }], failures: [], status: 'used' }) } }), /范围/);
  await assert.rejects(readTeachingKnowledgeSources(f.store, scope, connectionSources, '问题', { knowledgeService: { recallWithDiagnostics: async () => ({ chunks: [], failures: [{ provider: 'getnote', code: 'UNAVAILABLE', message: 'private upstream', retryable: true }], status: 'failed' }) } }), /检索未完成/);
});

test('duplicate provider account rows cannot silently read a different connection', () => {
  const f = fixture(); f.db.knowledgeConnections.push(connection({ id: 'second-notion-a', providerUserId: 'different-account' }));
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [{ connectionId: 'second-notion-a', scope: 'page', pageId: page }]), 409);
});

test('configuration and reads are bounded, fail for revoked grants, and never mutate saved provider data', async () => {
  const f = fixture(), sources = exactPage(f.db), before = structuredClone(f.db);
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, Array.from({ length: 6 }, () => ({ connectionId: 'notion-a', scope: 'page', pageId: page }))));
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [sources[0], sources[0]]));
  await readTeachingKnowledgeSources(f.store, scope, sources, '问题', { notion: { readDocument: async () => ({ text: '<content>正文</content>' }) } });
  assert.deepEqual(f.db, before);
  f.db.knowledgeConnections[0].status = 'revoked';
  await assert.rejects(readTeachingKnowledgeSources(f.store, scope, sources, '问题', { notion: { readDocument: async () => { assert.fail('revoked grant cannot make a remote call'); } } }));
});


test('saving an old selected page after reconnection cannot silently bind it to the new account', () => {
  const f = fixture(), oldSources = exactPage(f.db);
  f.db.knowledgeConnections[0].providerUserId = 'new-notion-account';
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, oldSources, oldSources), 409);
  rejected(() => bindTeachingKnowledgeSources(f.db, scope, [{connectionId:'notion-a',scope:'page',pageId:page}], oldSources), 409);
  const freshlyReviewed = exactPage(f.db);
  assert.notEqual(freshlyReviewed[0].binding, oldSources[0].binding);
  assert.deepEqual(bindTeachingKnowledgeSources(f.db, scope, freshlyReviewed, oldSources), freshlyReviewed);
});

test('a newly previewed source cannot silently rebind on its first save after an account swap',()=>{const f=fixture(),preview=bindTeachingKnowledgeSources(f.db,scope,[{connectionId:'getnote-a',scope:'connection',confirmed:true}])[0];f.db.knowledgeConnections[2].providerUserId='new-account';rejected(()=>bindTeachingKnowledgeSources(f.db,scope,[{...preview,confirmed:true}]),409);});

test('ima course binding includes selected libraries, encrypted client identity and credential owner without expanding the saved grant',()=>{const f=fixture();f.db.knowledgeConnections.push(connection({id:'ima-a',provider:'ima',clientId:'ima-openapi',providerUserId:undefined,providerSpaceId:undefined,encryptedClientId:'SYNTHETIC_CLIENT_A',encryptedApiKey:'SYNTHETIC_API_A',encryptedAccessToken:undefined,credentialOwnerUserId:scope.userId,retrievalScope:{knowledgeBases:[{id:'library-a',name:'讲义'},{id:'library-b',name:'其他资料'}],selectedIds:['library-a'],truncated:false}}));const selectedConnection=f.db.knowledgeConnections.at(-1)!,selected=bindTeachingKnowledgeSources(f.db,scope,[{connectionId:'ima-a',scope:'connection',confirmed:true}]);assertTeachingKnowledgeSources(f.db,scope,selected);selectedConnection.retrievalScope!.selectedIds=['library-b'];rejected(()=>assertTeachingKnowledgeSources(f.db,scope,selected),409);rejected(()=>bindTeachingKnowledgeSources(f.db,scope,[{...selected[0],confirmed:true}],selected),409);selectedConnection.retrievalScope!.selectedIds=['library-a'];selectedConnection.encryptedClientId='OTHER_CLIENT';rejected(()=>assertTeachingKnowledgeSources(f.db,scope,selected),409);selectedConnection.encryptedClientId='SYNTHETIC_CLIENT_A';selectedConnection.credentialOwnerUserId='other-owner';rejected(()=>assertTeachingKnowledgeSources(f.db,scope,selected),409);});

test('ima compound Chinese miss broadens terms within only the exact grant and rechecks scope',async()=>{
 const f=fixture();f.db.knowledgeConnections.push(connection({id:'ima-a',provider:'ima',retrievalScope:{selectedIds:['library-a'],knowledgeBases:[{id:'library-a',name:'课堂'}],truncated:false}}));
 const sources=bindTeachingKnowledgeSources(f.db,scope,[{connectionId:'ima-a',scope:'connection',confirmed:true}]);const queries:string[]=[];
 const result=await readTeachingKnowledgeSources(f.store,scope,sources,'杭州地理位置',{knowledgeService:{recallWithDiagnostics:async(w,q,k,ids,u)=>{assert.equal(w,'wa');assert.equal(u,scope.userId);assert.deepEqual(ids,['ima-a']);queries.push(q);return q==='杭州'?{status:'used',failures:[],chunks:[{provider:'ima',title:'城市讲义',content:'杭州位于浙江北部'}]}:{status:'no_match',failures:[],chunks:[]};}}});
 assert.deepEqual(queries,['杭州地理位置','杭州']);assert.match(result.text,/浙江北部/);
 let calls=0;await assert.rejects(readTeachingKnowledgeSources(f.store,scope,sources,'杭州地理位置',{knowledgeService:{recallWithDiagnostics:async()=>{calls++;f.db.knowledgeConnections.at(-1)!.retrievalScope!.selectedIds=['different'];return {status:'no_match',failures:[],chunks:[]};}}}));assert.equal(calls,1);
});
