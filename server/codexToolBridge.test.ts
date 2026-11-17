import test from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from './db.js';
import type { Database, ExecutionTask } from './types.js';
import type { WorkRun } from './coordinatorTypes.js';
import { CodexToolBridge, codexBridgeInstruction, codexBridgeSkillsSupported, resumeCodexBridgeTask, type CodexBridgeCall } from './codexToolBridge.js';
import { NotionDocuments, writingTarget } from './notionDocuments.js';
import type { NotionMcpService } from './knowledge/notionMcpService.js';
import { sourceBinding } from './publicSharing.js';
import { publicExecutionTask } from './executionService.js';

const owner = { workspaceId: 'wa', userId: 'a', deviceId: 'da', installationId: 'a'.repeat(32) };
const parentId = 'a'.repeat(32), pageId = 'b'.repeat(32);
function fixture(options: { notion?: boolean; sources?: boolean; web?: boolean } = {}) {
  let db = { users: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }],
    workspaceMembers: [{ workspaceId: 'wa', userId: 'a', role: 'owner' }, { workspaceId: 'wb', userId: 'b', role: 'owner' }],
    oneKeyDevices: [{ ...owner, id: 'da', status: 'active' }],
    knowledgeConnections: [{ id: 'source-a', workspaceId: 'wa', provider: 'getnote', status: 'connected', encryptedApiKey: 'SYNTHETIC_ONLY_A' },
      { id: 'source-b', workspaceId: 'wb', provider: 'getnote', status: 'connected', encryptedApiKey: 'SYNTHETIC_ONLY_B' },
      { id: 'notion-a', workspaceId: 'wa', provider: 'notion', status: 'connected', notionWriting: { grantId: 'grant-a', userId: 'a', parentId, authorizedAt: 'now' } }],
    conversations: [{ ...owner, id: 'conversation', title: '独立合成任务', messages: [{ id: 'input', role: 'user', content: '依据授权资料写一篇完整短文，并保存到 Notion。', createdAt: '2026-11-17T01:00:00Z' }], createdAt: '2026-11-17T01:00:00Z', updatedAt: '2026-11-17T01:00:00Z' }],
    messages: [], executionTasks: [], executionEvents: [], chatOperations: [], settings: {}, attachments: [], auditLogs: [] } as unknown as Database;
  let chain = Promise.resolve();
  const store = { read: async () => structuredClone(db), mutate: <T>(fn: (db: Database) => T) => {
    const next = chain.then(() => { const copy = structuredClone(db); const value = fn(copy); db = copy; return value; });
    chain = next.then(() => {}, () => {}); return next;
  } } as Store;
  const job = { state: 'prepared', executionMode: 'local', localExecution: { deviceId: 'da', installationId: owner.installationId, toolBridge: true },
    instruction: '依据授权资料完成文章并保存到 Notion。', inputMessageId: 'input', executorId: 'general', executorVersion: 1,
    modelId: 'model', modelPrompt: '', values: {}, budget: 1, webSearch: Boolean(options.web), skills: [], credentials: [], steps: [],
    sources: options.sources ? [{ id: 'source-a', binding: sourceBinding(db.knowledgeConnections[0]) }] : [],
    notionTarget: options.notion ? writingTarget(db, owner) : undefined } as unknown as WorkRun;
  db.chatOperations!.push({ ...owner, id: 'operation', operationId: 'operation_synthetic_0001', conversationId: 'conversation', workRun: job,
    status: 'completed', createdAt: '2026-11-17T01:00:00Z', updatedAt: '2026-11-17T01:00:00Z', requestId: 'test', payloadHash: 'test' });
  if (job.notionTarget) db.conversations[0].notionDocument = structuredClone(job.notionTarget);
  const task = { ...owner, id: 'execution', conversationId: 'conversation', sourceMessageId: 'input', provider: 'codex', status: 'running',
    dispatchOperationId: 'local_synthetic_0001', providerThreadId: 'thread-a', reportRound: 0, deliveryAttempt: { id: 'attempt-a', round: 0, issuedAt: 'now' },
    createdAt: '2026-11-17T01:00:01Z', updatedAt: '2026-11-17T01:00:01Z', instruction: '完成本次独立任务' } as ExecutionTask;
  db.executionTasks.push(task);
  let body = '', reads = 0, writes = 0, loseResponse = false, beforeSearch: (() => Promise<void>) | undefined;
  const recalls: unknown[][] = [];
  const knowledge = { recallWithDiagnostics: async (...args: unknown[]) => { recalls.push(args); await beforeSearch?.(); return { chunks: [{ content: '合成资料：从观察问题开始。', sourceId: 'source-a' }], status: 'used', failures: [] }; } };
  const mcp = { readDocument: async (workspaceId: string, id: string) => { assert.equal(workspaceId, 'wa'); reads++; return { text: `<page url="https://www.notion.so/${id}"><content>${body}</content></page>` }; },
    callDocumentTool: async (workspaceId: string, connectionId: string, grantId: string, userId: string, name: string, args: any) => {
      assert.deepEqual([workspaceId, connectionId, grantId, userId], ['wa', 'notion-a', 'grant-a', 'a']);
      if (name === 'notion-create-pages') { writes++; body = args.pages[0].content; }
      else if (name === 'notion-update-page') { writes++; body = body.replace(args.content_updates[0].old_str, args.content_updates[0].new_str); }
      else throw new Error('unexpected synthetic tool');
      if (loseResponse) throw new Error('synthetic response lost');
      return { pages: [{ id: pageId }] };
    } } as unknown as NotionMcpService;
  const documents = new NotionDocuments(store, mcp);
  const verify = async () => {};
  const searches: string[] = [];
  const createBridge = () => new CodexToolBridge(store, knowledge as any, documents, verify, options.web ? { webSearch: async (query, context) => {
    assert.equal(context.workspaceId, 'wa'); assert.equal(context.userId, 'a'); assert.equal(context.conversationId, 'conversation'); await context.verify(); searches.push(query);
    return [{ title: '合成公开资料', url: 'https://example.invalid/synthetic', snippet: '只使用合成资料。' }];
  } } : {});
  const bridge = createBridge();
  const call = (tool: string, args: unknown, id = tool): CodexBridgeCall => ({ taskId: task.id, round: 0, attemptId: 'attempt-a', threadId: 'thread-a', turnId: 'turn-a', callId: id, tool, arguments: args });
  const prepare = async () => bridge.prepare((await store.read()).executionTasks[0]);
  return { store, bridge, documents, mcp, createBridge, call, prepare, recalls, searches, db: () => db, writes: () => writes, reads: () => reads,
    loseResponse: () => { loseResponse = true; }, setSearch: (effect: () => Promise<void>) => { beforeSearch = effect; },
    setBody: (value: string) => { body = value; } };
}
const value = (response: { contentItems: { text: string }[] }) => JSON.parse(response.contentItems[0].text);
async function original(f: ReturnType<typeof fixture>, content = '完整原稿第一段。\n\n第二段有可直接使用的结尾。') {
  return value(await f.bridge.call(owner, f.call('one_save_artifact', { title: '合成文章', content }))).artifactId as string;
}

test('Codex bridge exposes a stable schema, persists original artifacts and reuses exact calls', async () => {
  const f = fixture();
  assert.deepEqual((await f.prepare())!.tools.map(tool => tool.name), ['one_knowledge_search', 'one_save_artifact', 'one_get_delivery', 'one_save_notion']);
  const request = f.call('one_save_artifact', { title: '合成文章', content: 'ONE_SYNTHETIC_ORIGINAL完整正文' });
  const responses = await Promise.all([f.bridge.call(owner, request), f.bridge.call(owner, request)]);
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(f.db().conversations[0].messages.filter(message => message.content === 'ONE_SYNTHETIC_ORIGINAL完整正文').length, 1);
  assert.equal(f.db().chatOperations![0].workRun!.steps!.length, 1);
  assert.equal(f.db().executionTasks[0].toolBridge!.calls.length, 1);
  await assert.rejects(() => f.bridge.call(owner, { ...request, arguments: { title: '改过', content: '不同的输入' } }), /输入已经变化/);
  assert.doesNotMatch(JSON.stringify(publicExecutionTask(f.db().executionTasks[0])), /toolBridge|ONE_SYNTHETIC_ORIGINAL/);
  const longer = '长'.repeat(50_001);
  const saved = await f.bridge.call(owner, f.call('one_save_artifact', { title: '独立长文', content: longer }, 'long-original'));
  assert.equal(saved.success, true, 'portable ONE originals are not limited by the Notion connector limit');
});

test('search uses only the exact authorized workspace sources and revocation also applies to cached results', async () => {
  const f = fixture({ sources: true }); await f.prepare();
  const request = f.call('one_knowledge_search', { query: '观察问题', topK: 2 });
  assert.equal((await f.bridge.call(owner, request)).success, true);
  assert.deepEqual(f.recalls[0].slice(0, 5), ['wa', '观察问题', 2, ['source-a'], 'a']);
  await f.store.mutate(db => { db.knowledgeConnections[0].status = 'revoked'; });
  await assert.rejects(() => f.bridge.call(owner, request), /知识授权已变化/);
  assert.equal(f.recalls.length, 1);
});

test('public searches use the owned existing adapter and reject private originals or absent web permission', async () => {
  const f = fixture({ web: true }); await f.prepare();
  assert.equal((await f.bridge.call(owner, f.call('one_web_search', { query: '合成公开关键词' }))).success, true);
  const privateBody = 'ONE 合成的私人客户文档：完整行程和客户约谈内容，不能将原文发送到公开搜索。';
  await original(f, privateBody);
  const rejected = await f.bridge.call(owner, f.call('one_web_search', { query: privateBody }, 'private-search'));
  assert.equal(rejected.success, false); assert.deepEqual(f.searches, ['合成公开关键词']);
  await f.store.mutate(db => { db.chatOperations![0].workRun!.webSearch = false; });
  assert.equal((await f.bridge.call(owner, f.call('one_web_search', { query: '另一个合成关键词' }, 'not-authorized'))).success, false);
  assert.equal(f.searches.length, 1);
});

test('delivery reads expand only the latest original unless an exact artifact is requested', async () => {
  const f = fixture(); await f.prepare(); const first = await original(f, '合成第一稿');
  await f.bridge.call(owner, f.call('one_save_artifact', { title: '合成第二稿', content: '合成第二稿完整正文' }, 'second-original'));
  const recent = value(await f.bridge.call(owner, f.call('one_get_delivery', {})));
  assert.equal(recent.artifacts[0].content, undefined); assert.equal(recent.artifacts[1].content, '合成第二稿完整正文');
  const selected = value(await f.bridge.call(owner, f.call('one_get_delivery', { artifactId: first }, 'read-exact')));
  assert.equal(selected.artifacts.length, 1); assert.equal(selected.artifacts[0].content, '合成第一稿');
});

test('revoked connectors do not lock away owned ONE originals or past delivery facts', async () => {
  const f = fixture({ sources: true, notion: true }); await f.prepare();
  const artifactId = await original(f);
  await f.bridge.call(owner, f.call('one_save_notion', { artifactId }));
  await f.store.mutate(db => { db.knowledgeConnections[0].status = 'revoked'; db.knowledgeConnections[2].notionWriting = undefined; });
  assert.ok(await f.prepare());
  const result = value(await f.bridge.call(owner, f.call('one_get_delivery', {})));
  assert.equal(result.artifacts[0].artifactId, artifactId); assert.equal(result.notion.saved, true);
  const denied = await f.bridge.call(owner, f.call('one_save_notion', { artifactId }, 'revoked-save'));
  assert.equal(denied.success, false); assert.equal(f.writes(), 1);
});

test('same artifact with a new callId reuses a successful Notion write despite background quality differences', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f);
  const first = await f.bridge.call(owner, f.call('one_save_notion', { artifactId }));
  assert.equal(first.success, true); assert.equal(value(first).saved, true); assert.equal(f.writes(), 1);
  await f.store.mutate(db => { db.chatOperations![0].workRun!.notionReceipt!.integrity = { state: 'missing', missingBlockCount: 1 }; });
  const duplicate = await f.createBridge().call(owner, f.call('one_save_notion', { artifactId }, 'different-call-id'));
  assert.equal(duplicate.success, true); assert.equal(value(duplicate).saved, true); assert.equal(f.writes(), 1);
});

test('parallel different callIds save one Notion page and finalizing the same draft does not write again', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f);
  const [first, second] = await Promise.all([
    f.bridge.call(owner, f.call('one_save_notion', { artifactId, final: false }, 'parallel-draft')),
    f.bridge.call(owner, f.call('one_save_notion', { artifactId, final: true }, 'parallel-final'))
  ]);
  assert.equal(first.success, true); assert.equal(second.success, true); assert.equal(f.writes(), 1);
  assert.equal(f.db().chatOperations![0].workRun!.notionReceipt!.final, true);
});

test('a second bridge instance with a stale create snapshot cannot duplicate a page after the first ACK', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f);
  const context = f.documents.context.bind(f.documents);
  const releases: (() => void)[] = []; let entered!: () => void;
  const bothEntered = new Promise<void>(resolve => { entered = resolve; });
  f.documents.context = async (...args) => { const snapshot = await context(...args); await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) entered(); }); return snapshot; };
  const first = f.bridge.call(owner, f.call('one_save_notion', { artifactId }, 'instance-a'));
  const second = f.createBridge().call(owner, f.call('one_save_notion', { artifactId }, 'instance-b'));
  await bothEntered; releases[0](); assert.equal((await first).success, true); releases[1](); assert.equal((await second).success, false);
  assert.equal(f.writes(), 1);
  assert.equal((await f.bridge.call(owner, f.call('one_save_notion', { artifactId }, 'query-actual'))).success, true);
  assert.equal(f.writes(), 1);
});

test('unknown Notion results query the original page without repeating writes, even with another callId', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f); f.loseResponse();
  assert.equal((await f.bridge.call(owner, f.call('one_save_notion', { artifactId }))).success, false);
  assert.equal(f.writes(), 1);
  await f.store.mutate(db => { const receipt = db.chatOperations![0].workRun!.notionReceipt!; receipt.pageId = pageId; receipt.url = `https://www.notion.so/${pageId}`; });
  const resumed = await f.createBridge().call(owner, f.call('one_save_notion', { artifactId }, 'recovered-call-id'));
  assert.equal(resumed.success, true); assert.equal(value(resumed).saved, true); assert.equal(f.writes(), 1); assert.ok(f.reads() > 0);
});

test('unknown create with no page or receipt identity stays uncertain and is never sent again', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f); f.loseResponse();
  await f.bridge.call(owner, f.call('one_save_notion', { artifactId }));
  const retried = await f.createBridge().call(owner, f.call('one_save_notion', { artifactId }, 'new-call'));
  assert.equal(retried.success, false); assert.equal(f.writes(), 1);
});

test('an unknown delivery keeps its original operation across a new handoff and is recovered without copying its ACK', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f); f.loseResponse();
  await f.bridge.call(owner, f.call('one_save_notion', { artifactId }, 'original-unknown'));
  await f.store.mutate(db => {
    const task = db.executionTasks[0], old = db.chatOperations![0]; old.workRun!.state = 'failed'; old.workRun!.notionReceipt!.pageId = pageId;
    task.status = 'failed'; task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'failed', receivedAt: 'now', disposition: 'accepted' };
    const next = structuredClone(old); next.id = 'next'; next.workRun!.inputMessageId = 'new-input'; next.workRun!.state = 'prepared'; next.workRun!.notionReceipt = undefined; next.workRun!.steps = []; next.workRun!.expectedOutput = 'text';
    db.chatOperations!.push(next);
    const resumed = resumeCodexBridgeTask(db, { ...owner, conversationId: 'conversation', sourceMessageId: 'new-input' }, 'new_delivery_handoff', '核对原保存，不重写文章。', 'now')!;
    resumed.deliveryAttempt = { id: 'attempt-b', round: 1, issuedAt: 'now' };
  });
  await f.prepare();
  const nextCall = (tool: string, args: unknown) => ({ ...f.call(tool, args, `next-${tool}`), round: 1, attemptId: 'attempt-b', turnId: 'turn-b' });
  const before = value(await f.bridge.call(owner, nextCall('one_get_delivery', {})));
  assert.equal(before.notion.pageId, pageId); assert.equal(before.notion.saved, false);
  const confirmed = await f.bridge.call(owner, nextCall('one_save_notion', { artifactId }));
  assert.equal(confirmed.success, true); assert.equal(value(confirmed).saved, true); assert.equal(f.writes(), 1);
  assert.equal(f.db().chatOperations![1].workRun!.notionReceipt, undefined, 'an old write ACK is not forged into the new operation');
  assert.equal(f.db().executionTasks[0].toolBridge!.deliveryProof!.operationId, 'operation');
  await f.store.mutate(db => { const task = db.executionTasks[0]; task.status = 'completed'; task.terminalReceipt = { id: 'terminal-b', hash: 'hash', attemptId: 'attempt-b', round: 1, outcome: 'completed', receivedAt: 'now', disposition: 'accepted' }; f.bridge.settle(db, task.id); });
  assert.equal(f.db().executionTasks[0].businessOutcome, 'completed');
});

test('bridge rejects other owners, wrong execution identity, unexpected arguments, cancellation and post-terminal calls', async () => {
  const f = fixture({ sources: true }); await f.prepare();
  const request = f.call('one_get_delivery', {});
  for (const changed of [{ workspaceId: 'wb' }, { userId: 'b' }, { deviceId: 'db' }, { installationId: 'b'.repeat(32) }]) await assert.rejects(() => f.bridge.call({ ...owner, ...changed }, request));
  for (const changed of [{ taskId: 'other' }, { round: 1 }, { attemptId: 'other' }, { threadId: 'other' }]) await assert.rejects(() => f.bridge.call(owner, { ...request, ...changed }));
  await f.bridge.call(owner, request);
  await assert.rejects(() => f.bridge.call(owner, { ...request, callId: 'new-call', turnId: 'wrong-turn' }), /处理轮次已经变化/);
  const invalid = await f.bridge.call(owner, f.call('one_knowledge_search', { query: '正常关键词', workspaceId: 'wb' }, 'foreign-argument'));
  assert.equal(invalid.success, false); assert.equal(f.recalls.length, 0);
  await f.store.mutate(db => { db.executionTasks[0].status = 'cancelled'; });
  await assert.rejects(() => f.bridge.call(owner, request));
});

test('cancelling during a source read cannot expose a late body or reactivate the task', async () => {
  const f = fixture({ sources: true }); await f.prepare();
  f.setSearch(async () => { await f.store.mutate(db => { db.executionTasks[0].status = 'cancelled'; }); });
  const returned = await f.bridge.call(owner, f.call('one_knowledge_search', { query: '观察问题' }));
  assert.equal(returned.success, false); assert.doesNotMatch(JSON.stringify(returned), /合成资料/);
  assert.equal(f.db().executionTasks[0].status, 'cancelled');
});

test('main-chat supplements retain the original Codex thread, round history, artifacts and newly authorized sources', async () => {
  const f = fixture(); await f.prepare(); const artifactId = await original(f);
  await f.store.mutate(db => {
    const task = db.executionTasks[0], previous = db.chatOperations![0];
    task.status = 'completed'; task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'completed', receivedAt: 'now', disposition: 'accepted' };
    const next = structuredClone(previous); next.id = 'next-operation'; next.operationId = 'next_submission_0001'; next.workRun!.inputMessageId = 'next-input';
    next.workRun!.notionTarget = writingTarget(db, owner); next.workRun!.sources = [{ id: 'source-a', binding: sourceBinding(db.knowledgeConnections[0]) }]; next.workRun!.steps = [];
    db.chatOperations!.push(next);
    const continued = resumeCodexBridgeTask(db, { ...owner, conversationId: 'conversation', sourceMessageId: 'next-input' }, 'next_local_submission_0001', '继续同一篇文章并保存到 Notion。', '2026-11-17T01:10:00Z');
    assert.equal(continued?.id, 'execution'); assert.equal(continued?.providerThreadId, 'thread-a'); assert.equal(continued?.reportRound, 1);
    assert.equal(continued?.toolBridge?.operationId, next.id); assert.equal(continued?.toolBridge?.admissions?.length, 2);
    continued!.deliveryAttempt = { id: 'attempt-b', round: 1, issuedAt: 'now' };
  });
  await f.prepare();
  const nextCall = (tool: string, args: unknown) => ({ ...f.call(tool, args, `next-${tool}`), round: 1, attemptId: 'attempt-b', turnId: 'turn-b' });
  const delivery = value(await f.bridge.call(owner, nextCall('one_get_delivery', {})));
  assert.equal(delivery.artifacts[0].artifactId, artifactId);
  assert.equal((await f.bridge.call(owner, nextCall('one_knowledge_search', { query: '新增知识来源' }))).success, true);
  assert.equal((await f.bridge.call(owner, nextCall('one_save_notion', { artifactId }))).success, true); assert.equal(f.writes(), 1);
  await assert.rejects(() => f.bridge.call(owner, f.call('one_get_delivery', {}, 'old-round')));
});

test('settlement separates successful business delivery from background integrity and keeps failed deliveries partial', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f);
  await f.bridge.call(owner, f.call('one_save_notion', { artifactId }));
  await f.store.mutate(db => {
    const task = db.executionTasks[0]; task.status = 'completed'; task.finalResponse = '完整文章已保存。';
    task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'completed', receivedAt: 'now', disposition: 'accepted' };
    db.chatOperations![0].workRun!.notionReceipt!.integrity = { state: 'inconclusive', reason: 'read_failed' };
    f.bridge.settle(db, task.id);
  });
  assert.equal(f.db().chatOperations![0].workRun!.resultOutcome, 'completed');
  const g = fixture({ notion: true }); await g.prepare(); await original(g);
  await g.store.mutate(db => { const task = db.executionTasks[0]; task.status = 'completed'; task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'completed', receivedAt: 'now', disposition: 'accepted' }; g.bridge.settle(db, task.id); });
  assert.equal(g.db().chatOperations![0].workRun!.resultOutcome, 'partial');
});

test('complete content delivery survives a failed executor closing reply, but cannot hide an unfinished local-file goal', async () => {
  for (const expectedOutput of ['text', 'local_file'] as const) {
    const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f);
    await f.bridge.call(owner, f.call('one_save_notion', { artifactId }));
    await f.store.mutate(db => {
      const task = db.executionTasks[0]; task.status = 'failed'; task.lastError = '收尾模型回复中断';
      task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'failed', receivedAt: 'now', disposition: 'accepted' };
      db.chatOperations![0].workRun!.expectedOutput = expectedOutput;
      f.bridge.settle(db, task.id);
    });
    assert.equal(f.db().executionTasks[0].status, 'failed', 'the actual terminal evidence remains unchanged');
    assert.equal(f.db().executionTasks[0].businessOutcome, expectedOutput === 'text' ? 'completed' : 'partial');
  }
});

test('an independent conversation never inherits a Codex thread, and unresolved old termination cannot resume', async () => {
  for (const independent of [true, false]) {
    const f = fixture(); await f.prepare();
    await f.store.mutate(db => {
      const task = db.executionTasks[0], next = structuredClone(db.chatOperations![0]);
      task.status = 'cancelled'; next.id = 'next'; next.workRun!.inputMessageId = 'new-input';
      if (independent) next.conversationId = 'new-independent-conversation';
      else task.transportInterruption = { attemptId: 'attempt-a', round: 0, reason: 'cancellation_pending', at: 'now' };
      db.chatOperations!.push(next);
      assert.equal(resumeCodexBridgeTask(db, { ...owner, conversationId: next.conversationId!, sourceMessageId: 'new-input' }, 'new_local_dispatch', '新要求', 'now'), undefined);
      assert.equal(task.providerThreadId, 'thread-a'); assert.equal(task.reportRound, 0);
    });
  }
});

test('a confirmed cancellation may resume only after the user supplies a new exact owned handoff', async () => {
  const f = fixture(); await f.prepare();
  await f.store.mutate(db => {
    const task = db.executionTasks[0], next = structuredClone(db.chatOperations![0]);
    task.status = 'cancelled'; task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'cancelled', receivedAt: 'now', disposition: 'accepted' };
    next.id = 'next'; next.workRun!.inputMessageId = 'new-input'; next.workRun!.instruction = '用户明确要求继续原任务'; db.chatOperations!.push(next);
    const resumed = resumeCodexBridgeTask(db, { ...owner, conversationId: 'conversation', sourceMessageId: 'new-input' }, 'user_requested_resume', '继续原任务', 'now');
    assert.equal(resumed?.providerThreadId, 'thread-a'); assert.equal(resumed?.reportRound, 1); assert.equal(resumed?.status, 'queued');
  });
});

test('a late successful side effect stays with its original operation after a new exact round begins', async () => {
  const f = fixture({ notion: true }); await f.prepare(); const artifactId = await original(f);
  const write = f.mcp.callDocumentTool.bind(f.mcp); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), inWrite = new Promise<void>(resolve => { entered = resolve; });
  f.mcp.callDocumentTool = async (...args) => { const reply = await write(...args); entered(); await gate; return reply; };
  const oldCall = f.bridge.call(owner, f.call('one_save_notion', { artifactId }, 'late-write'));
  await inWrite;
  await f.store.mutate(db => {
    const task = db.executionTasks[0]; task.status = 'failed'; task.terminalReceipt = { id: 'terminal', hash: 'hash', attemptId: 'attempt-a', round: 0, outcome: 'failed', receivedAt: 'now', disposition: 'accepted' };
    const next = structuredClone(db.chatOperations![0]); next.id = 'next'; next.workRun!.inputMessageId = 'new-input'; next.workRun!.notionReceipt = undefined; next.workRun!.steps = [];
    db.chatOperations!.push(next);
    resumeCodexBridgeTask(db, { ...owner, conversationId: 'conversation', sourceMessageId: 'new-input' }, 'new_round_after_terminal', '只查看原结果', 'now');
  });
  release(); assert.equal((await oldCall).success, false);
  assert.equal(f.db().chatOperations![0].workRun!.notionReceipt!.pageId, pageId);
  assert.equal(f.db().chatOperations![1].workRun!.notionReceipt, undefined);
  assert.equal(f.db().executionTasks[0].reportRound, 1); assert.equal(f.db().executionTasks[0].status, 'queued'); assert.equal(f.writes(), 1);
});

test('prompt-only workbench requirements join the bridge handoff, specialist and combined tools remain on existing routes', () => {
  const prompt = { values: { name: '现有合成工作台', instructions: '先找出事实，再给客户写建议。', limitations: '不虚构经历。', integration: 'question_answer', tools: [] } };
  assert.equal(codexBridgeSkillsSupported([prompt]), true);
  assert.equal(codexBridgeSkillsSupported([{ values: { ...prompt.values, modelId: 'fixed-feature-model' } }]), false);
  assert.equal(codexBridgeSkillsSupported([{ values: { ...prompt.values, tools: [{ id: 'oneWorkbook' }] } }]), false);
  assert.equal(codexBridgeSkillsSupported([prompt, prompt]), false);
  const instruction = codexBridgeInstruction({ instruction: '完成本轮建议', skills: [prompt] } as unknown as WorkRun, '原始材料');
  assert.match(instruction, /现有合成工作台/); assert.match(instruction, /不虚构经历/); assert.match(instruction, /one_save_artifact/);
});
