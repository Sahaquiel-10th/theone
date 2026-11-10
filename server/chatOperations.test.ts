import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "./db.js";
import type { Conversation, Database, Message } from "./types.js";
import { beginChatOperation, bindChatOperationConversation, ChatOperationError, completeChatOperation, failChatOperation, failChatOperationInMutation, getChatOperationResult, reconcileInterruptedChatOperations } from "./chatOperations.js";
import type { ChatOperation } from "./chatOperations.js";
import {createWorkflowRun} from './taskWorkflow.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {notionHash,legacyNotionNormalized,canonicalNotionDigest} from './notionCanonical.js';

test('startup requeues only a proven workflow result gap; unknown attempts, local holds and human stops remain protected',()=>{
 for(const mode of ['proven','unknown','local_hold','user_stop'] as const){
  const f=fixture(),task=conversation();f.db().conversations.push(task);
  const binding={workspaceId:task.workspaceId,userId:task.userId,operationId:'workflow-op'},run=createWorkflowRun({version:1,steps:[{id:'draft',title:'整理正文',kind:'model',instruction:'整理指定材料',inputs:[]}]},binding);
  run.steps[0].state='running';run.phase='running';
  const namespace=`workflow:${run.id}`,tool=`workflow:${run.id}:draft`,key=taskStepKey(namespace,tool,JSON.stringify({revision:1,instruction:run.spec.steps[0].instruction,inputs:[]}));
  const op={...binding,id:binding.operationId,operationId:'workflow_operation_startup',conversationId:task.id,status:'pending',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',workRun:{state:'running',workflow:run,steps:[{key,namespace,tool,label:'整理正文',scopeId:binding.operationId,effect:'model',state:mode==='unknown'?'started':'completed',updatedAt:'2026-10-25T00:00:00Z',output:{workflow:{version:1,runId:run.id,revision:1,stepId:'draft'},outcome:mode==='unknown'?'waiting':'completed',result:{content:'已核对的合成正文'}}}]}} as unknown as ChatOperation;
  f.db().chatOperations.push(op);
  if(mode==='user_stop'){task.workPaused=true;task.workPauseReason='user_stopped';}
  if(mode==='local_hold')f.db().executionTasks=[{workspaceId:task.workspaceId,userId:task.userId,conversationId:task.id,executionSafetyHold:true} as unknown as NonNullable<Database['executionTasks']>[number]];
  reconcileInterruptedChatOperations(f.db());
  assert.equal(op.workRun!.state,mode==='proven'?'queued':'interrupted',mode);assert.equal(op.status,mode==='proven'?'pending':'interrupted',mode);
  assert.equal(f.db().chatOperations.length,1,'no new operation is made on restart');
 }
});

type TestDatabase = Database & { chatOperations: ChatOperation[] };
const scope = { workspaceId: "wa", userId: "a", operationId: "client-operation-0001" };
const payload = { content: "personal question", modelId: "model", attachmentIds: ["attachment-a"], webSearch: false };
const start = { ...scope, requestId: "server-request-1", payload };

function fixture(snapshot?: TestDatabase) {
  let db = snapshot ? structuredClone(snapshot) : {
    users: [{ id: "a", enabled: true }, { id: "b", enabled: true }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }],
    workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }],
    conversations: [], chatOperations: []
  } as unknown as TestDatabase;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(fn: (db: Database) => T) => {
    const next = queue.then(() => { const before = structuredClone(db); try { return fn(db); } catch (error) { db = before; throw error; } });
    queue = next.catch(() => undefined); return next;
  } };
  return { store, db: () => db };
}

function conversation(id = "conversation-a", workspaceId = "wa", userId = "a"): Conversation {
  return { id, workspaceId, userId, modelId: "model", title: "personal question", archived: false, messages: [], createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" };
}
const userMessage: Message = { id: "user-message", role: "user", content: "personal question", createdAt: "2026-09-13T00:00:01.000Z" };
const assistantMessage: Message = { id: "assistant-message", role: "assistant", content: "private answer", sources: [{ title: "private source", url: "https://example.com/note", snippet: "private snippet" }], createdAt: "2026-09-13T00:00:02.000Z" };

async function finish(f: ReturnType<typeof fixture>) {
  await f.store.mutate(db => {
    const target = conversation(); target.messages.push(structuredClone(userMessage));
    db.conversations.push(target);
    bindChatOperationConversation(db, scope, target.id);
  });
  await f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  });
}

const code = (expected: ChatOperationError["code"]) => (error: unknown) => error instanceof ChatOperationError && error.code === expected;

test("response-loss retry and process restart reuse the saved answer without retrieval, model or charge", async () => {
  let f = fixture(); let retrievals = 0; let calls = 0; let charges = 0;
  async function request() {
    const begun = await beginChatOperation(f.store, start);
    if (begun.kind === "started") { retrievals++; calls++; charges++; await finish(f); }
    return getChatOperationResult(f.db(), scope);
  }
  const original = await request();
  // The first HTTP response was lost. The browser must reuse the original operation id.
  f = fixture(f.db()); reconcileInterruptedChatOperations(f.db());
  const repeated = await request();
  assert.deepEqual(repeated, original);
  assert.deepEqual([retrievals, calls, charges], [1, 1, 1]);
  assert.equal(f.db().chatOperations.length, 1);
  assert.equal(f.db().chatOperations[0].requestId, "server-request-1");
  assert.ok(!JSON.stringify(f.db().chatOperations).includes("private answer"));
  assert.ok(!JSON.stringify(f.db().chatOperations).includes("personal question"));
});

test("parallel identical requests are rejected safely while only one operation is reserved", async () => {
  const f = fixture();
  const results = await Promise.allSettled([beginChatOperation(f.store, start), beginChatOperation(f.store, { ...start, requestId: "server-request-2" })]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  const rejected = results.find(item => item.status === "rejected") as PromiseRejectedResult;
  assert.ok(code("CHAT_OPERATION_PENDING")(rejected.reason));
  assert.equal(rejected.reason.details.requestId, "server-request-1");
  assert.equal(f.db().chatOperations.length, 1);
});

test("same operation id with changed content, model, attachment or options never executes", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  for (const changed of [{ ...payload, content: "another question" }, { ...payload, modelId: "other" }, { ...payload, attachmentIds: ["other"] }, { ...payload, webSearch: true }]) {
    await assert.rejects(beginChatOperation(f.store, { ...start, payload: changed }), code("CHAT_OPERATION_CONFLICT"));
  }
  assert.equal(f.db().chatOperations.length, 1);
});

test("equivalent JSON object key order hashes identically", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  const repeated = await beginChatOperation(f.store, { ...start, payload: { webSearch: false, attachmentIds: ["attachment-a"], modelId: "model", content: "personal question", omitted: undefined } });
  assert.equal(repeated.kind, "completed");
});

test("same-conversation concurrent different operations are blocked until the first completes", async () => {
  const f = fixture(); f.db().conversations.push(conversation());
  await beginChatOperation(f.store, { ...start, conversationId: "conversation-a" });
  const second = { ...start, operationId: "client-operation-0002", conversationId: "conversation-a" };
  await assert.rejects(beginChatOperation(f.store, second), code("CHAT_CONVERSATION_BUSY"));
  await f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  });
  assert.equal((await beginChatOperation(f.store, second)).kind, "started");
});

test("new conversations gain the same serialization guard as existing conversations", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push(conversation());
  bindChatOperationConversation(f.db(), scope, "conversation-a");
  await assert.rejects(beginChatOperation(f.store, { ...start, operationId: "client-operation-0002", conversationId: "conversation-a" }), code("CHAT_CONVERSATION_BUSY"));
  f.db().conversations.push(conversation("other"));
  assert.throws(() => bindChatOperationConversation(f.db(), scope, "other"), code("CHAT_OPERATION_CONFLICT"));
});

test("workspace and user scopes prevent both replay access and foreign-conversation binding", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  const other = { ...scope, workspaceId: "wb", userId: "b" };
  assert.throws(() => getChatOperationResult(f.db(), other), code("CHAT_OPERATION_NOT_FOUND"));
  await assert.rejects(beginChatOperation(f.store, { ...start, ...other, conversationId: "conversation-a" }), code("CHAT_OPERATION_NOT_FOUND"));
  await assert.rejects(beginChatOperation(f.store, { ...start, workspaceId: "wb" }), code("CHAT_OPERATION_FORBIDDEN"));
  assert.equal((await beginChatOperation(f.store, { ...start, ...other })).kind, "started");
  assert.notEqual(f.db().chatOperations[0].id, f.db().chatOperations[1].id);
  assert.throws(() => bindChatOperationConversation(f.db(), other, "conversation-a"), code("CHAT_OPERATION_NOT_FOUND"));
  // Shared workspace membership does not allow one user to read another user's result.
  f.db().workspaceMembers.push({ id: "membership", workspaceId: "wa", userId: "b", role: "member", createdAt: "now" });
  assert.throws(() => getChatOperationResult(f.db(), { ...scope, userId: "b" }), code("CHAT_OPERATION_NOT_FOUND"));
});

test("disabled users and suspended workspaces cannot replay previously saved private results", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  f.db().users[0].enabled = false;
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_FORBIDDEN"));
  f.db().users[0].enabled = true; f.db().workspaces[0].status = "suspended";
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_FORBIDDEN"));
});

test("replay is detached and ends at the original assistant reply, not later messages", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  f.db().conversations[0].messages.push({ ...userMessage, id: "later", content: "later text" });
  const replay = getChatOperationResult(f.db(), scope);
  assert.equal(replay.conversation.messages.length, 2);
  assert.equal(replay.message.id, assistantMessage.id);
  replay.message.content = "mutated response";
  replay.message.sources![0].snippet = "mutated snippet";
  assert.equal(f.db().conversations[0].messages[1].content, "private answer");
  assert.equal(f.db().conversations[0].messages[1].sources![0].snippet, "private snippet");
});

test("deleted conversation leaves a tombstone so an old request cannot cause another charge", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  f.db().conversations = [];
  assert.equal((await beginChatOperation(f.store, start)).kind, "completed");
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_RESULT_UNAVAILABLE"));
  assert.equal(f.db().chatOperations.length, 1);
});

test("restart changes unfinished requests to uncertain without ever re-executing them", async () => {
  let f = fixture(); await beginChatOperation(f.store, start);
  f = fixture(f.db()); reconcileInterruptedChatOperations(f.db()); reconcileInterruptedChatOperations(f.db());
  assert.equal(f.db().chatOperations[0].status, "interrupted");
  await assert.rejects(beginChatOperation(f.store, start), code("CHAT_OPERATION_INTERRUPTED"));
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_INTERRUPTED"));
  assert.equal(f.db().chatOperations[0].retryable, false);
});

for(const state of ['scheduled','checking'] as const)test(`restart retains ${state} Notion verification without replaying the model or write`,async()=>{
 const f=fixture();await beginChatOperation(f.store,start);
 f.db().conversations.push(conversation());bindChatOperationConversation(f.db(),scope,'conversation-a');
 const op=f.db().chatOperations[0];
 op.workRun={state:'running',notionReceipt:{state:'uncertain',pageId:'a'.repeat(32),expectedDigest:'b'.repeat(64),verification:{state,version:23,attempt:1,nextCheckAt:'2026-10-25T00:00:00Z',deadlineAt:'2026-10-25T00:05:00Z',...(state==='checking'?{leaseId:'persisted-lease',leaseUntil:'2026-10-25T00:00:01Z'}:{})}}} as NonNullable<ChatOperation['workRun']>;
 reconcileInterruptedChatOperations(f.db());reconcileInterruptedChatOperations(f.db());
 assert.equal(op.status,'pending');assert.equal(op.workRun.state,'failed');assert.equal(op.workRun.failureCode,'notion_verification_pending');assert.equal(op.workRun.notionReceipt!.verification!.version,23);assert.equal(op.workRun.notionReceipt!.verification!.state,state);assert.equal(op.workRun.unread,false);
 assert.equal(f.db().conversations[0].workPaused,true);assert.equal(f.db().conversations[0].messages.length,0);
 await assert.rejects(beginChatOperation(f.store,start),code('CHAT_OPERATION_PENDING'));
});

test('restart between readback proof and deterministic finalization retains only the pending finalization, never model execution',async()=>{
 const f=fixture();await beginChatOperation(f.store,start);
 const op=f.db().chatOperations[0];op.workRun={state:'failed',failureCode:'notion_verification_pending',notionReceipt:{state:'verified',pageId:'a'.repeat(32),expectedDigest:'b'.repeat(64),digest:'c'.repeat(64)}} as NonNullable<ChatOperation['workRun']>;
 reconcileInterruptedChatOperations(f.db());assert.equal(op.status,'pending');assert.equal(op.workRun.state,'failed');assert.equal(op.workRun.failureCode,'notion_verification_pending');assert.equal(op.workRun.notionReceipt!.state,'verified');
 await assert.rejects(beginChatOperation(f.store,start),code('CHAT_OPERATION_PENDING'));
});

test("failed attempts stay failed for the same operation id; known safe failures permit an explicit new operation", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  await failChatOperation(f.store, scope, { retryable: true });
  await assert.rejects(beginChatOperation(f.store, start), (error: unknown) => code("CHAT_OPERATION_FAILED")(error) && (error as ChatOperationError).details.retryable === true);
  assert.equal((await beginChatOperation(f.store, { ...start, operationId: "client-operation-0002" })).kind, "started");
});

test("an after-completion HTTP failure never overwrites the durable successful result", async () => {
  const f = fixture(); await beginChatOperation(f.store, start); await finish(f);
  await failChatOperation(f.store, scope);
  completeChatOperation(f.db(), scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  assert.equal((await beginChatOperation(f.store, start)).kind, "completed");
  assert.equal(f.db().chatOperations[0].status, "completed");
});
test('structured failures survive restart and project only reviewed fields for the exact owner',async()=>{
 const f=fixture();await beginChatOperation(f.store,start);
 const failure={code:'model_timeout' as const,stage:'model' as const,outcome:'not_started' as const};
 await failChatOperation(f.store,scope,{failure});
 const restarted=fixture(JSON.parse(JSON.stringify(f.db())));
 assert.deepEqual(restarted.db().chatOperations[0].failure,failure);
 await assert.rejects(()=>beginChatOperation(restarted.store,start),code('CHAT_OPERATION_FAILED'));
 const done=fixture();await beginChatOperation(done.store,start);await finish(done);
 done.db().chatOperations[0].failure={...failure,privateMessage:'DO_NOT_RETURN_PRIVATE_FAILURE'} as typeof failure;
 assert.deepEqual(getChatOperationResult(done.db(),scope).failure,failure);
 assert.doesNotMatch(JSON.stringify(getChatOperationResult(done.db(),scope)),/DO_NOT_RETURN_PRIVATE_FAILURE/);
 assert.throws(()=>getChatOperationResult(done.db(),{...scope,userId:'b',workspaceId:'wb'}),code('CHAT_OPERATION_NOT_FOUND'));
});

test("failed result transaction rolls back both response and completion; retry remains safely blocked", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push(conversation()); bindChatOperationConversation(f.db(), scope, "conversation-a");
  await assert.rejects(f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
    throw Error("simulated persistence failure");
  }), /simulated/);
  assert.equal(f.db().conversations[0].messages.length, 0);
  assert.equal(f.db().chatOperations[0].status, "pending");
  await assert.rejects(beginChatOperation(f.store, start), code("CHAT_OPERATION_PENDING"));
});

test("invalid operation ids and non-JSON payloads cannot reserve rows", async () => {
  const f = fixture();
  for (const operationId of ["", "short", "x".repeat(129), "has/slash/invalid"])
    await assert.rejects(beginChatOperation(f.store, { ...start, operationId }), code("CHAT_OPERATION_INVALID"));
  await assert.rejects(beginChatOperation(f.store, { ...start, payload: { invalid: Infinity } }), code("CHAT_OPERATION_INVALID"));
  assert.equal(f.db().chatOperations.length, 0);
});

test("failed-message cleanup and conversation unlock commit atomically, including storage failure", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push({ ...conversation(), messages: [structuredClone(userMessage)] });
  bindChatOperationConversation(f.db(), scope, "conversation-a");
  f.db().attachments = [{ id: "attachment-a", workspaceId: scope.workspaceId, userId: scope.userId, conversationId: "conversation-a", messageId: userMessage.id }] as Database["attachments"];
  const clean = (db: Database) => {
    db.conversations[0].messages = [];
    delete db.attachments[0].messageId; delete db.attachments[0].conversationId;
    failChatOperationInMutation(db, scope, { retryable: true });
  };
  await assert.rejects(f.store.mutate(db => { clean(db); throw Error("storage unavailable"); }), /storage unavailable/);
  assert.equal(f.db().conversations[0].messages.length, 1);
  assert.equal(f.db().attachments[0].messageId, userMessage.id);
  assert.equal(f.db().chatOperations[0].status, "pending");
  await assert.rejects(beginChatOperation(f.store, { ...start, conversationId: "conversation-a", operationId: "client-operation-0002" }), code("CHAT_CONVERSATION_BUSY"));
  await f.store.mutate(clean);
  assert.equal(f.db().conversations[0].messages.length, 0);
  assert.equal(f.db().attachments[0].messageId, undefined);
  assert.equal(f.db().chatOperations[0].status, "failed");
  assert.equal((await beginChatOperation(f.store, { ...start, conversationId: "conversation-a", operationId: "client-operation-0002" })).kind, "started");
});

test("mid-call account disable permits durable finalization, never public replay access", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().conversations.push(conversation()); bindChatOperationConversation(f.db(), scope, "conversation-a");
  f.db().users[0].enabled = false;
  await f.store.mutate(db => {
    db.conversations[0].messages.push(structuredClone(assistantMessage));
    completeChatOperation(db, scope, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! });
  });
  assert.equal(f.db().chatOperations[0].status, "completed");
  assert.throws(() => getChatOperationResult(f.db(), scope), code("CHAT_OPERATION_FORBIDDEN"));
  f.db().users[0].enabled = true;
  assert.equal(getChatOperationResult(f.db(), scope).message.content, "private answer");
});

test("mid-call account disable still permits failure cleanup with strict operation ownership", async () => {
  const f = fixture(); await beginChatOperation(f.store, start);
  f.db().users[0].enabled = false;
  assert.throws(() => failChatOperationInMutation(f.db(), { ...scope, workspaceId: "wb", userId: "b" }), code("CHAT_OPERATION_NOT_FOUND"));
  assert.throws(() => completeChatOperation(f.db(), { ...scope, workspaceId: "wb", userId: "b" }, { conversationId: "conversation-a", assistantMessageId: assistantMessage.id! }), code("CHAT_OPERATION_NOT_FOUND"));
  await failChatOperation(f.store, scope, { retryable: true });
  assert.equal(f.db().chatOperations[0].status, "failed");
});

test('startup requeues persisted safe-read recovery without resetting retries or calling any provider',()=>{
 for(const mode of ['safe_read','paid_web','paid_sibling','local_hold','stopped','revoked','foreign','duplicate'] as const){
  const f=fixture(),task=conversation();f.db().conversations.push(task);
  const binding={workspaceId:task.workspaceId,userId:task.userId,operationId:'read-recovery-op'},run=createWorkflowRun({version:1,steps:[{id:'read',title:'读取指定资料',kind:'tool',tool:mode==='paid_web'?'web_search':'knowledge_search',instruction:'用户授权的资料线索',inputs:[]}]},binding);
  run.steps[0]={id:'read',state:'waiting',waitingFor:'result'};run.phase='waiting';
  const namespace=`workflow:${run.id}`,tool=`workflow:${run.id}:read`,key=taskStepKey(namespace,tool,JSON.stringify({revision:1,instruction:run.spec.steps[0].instruction,inputs:[]}));
  const recovery={strategy:'retry_read' as const,state:'scheduled' as const,attempt:2,maxAttempts:3 as const,firstAttemptAt:'2026-11-03T00:00:00.000Z',nextRetryAt:'2026-11-03T00:00:10.000Z',deadlineAt:'2026-11-03T00:02:00.000Z',reason:'timeout' as const};
  const cp={key,namespace,tool,label:'读取指定资料',scopeId:binding.operationId,effect:'read' as const,state:'started' as const,updatedAt:'2026-11-03T00:00:00.000Z',operation:{version:1 as const,execution:'failed' as const,verification:'not_required' as const,recovery},output:{workflow:{version:1,runId:run.id,revision:1,stepId:'read'},outcome:'waiting'}};
  const op={...binding,id:binding.operationId,operationId:'read_recovery_startup_0001',conversationId:task.id,status:'pending',createdAt:'2026-11-03T00:00:00.000Z',updatedAt:'2026-11-03T00:00:00.000Z',workRun:{state:'running',workflow:run,steps:[cp]}} as unknown as ChatOperation;
  if(mode==='paid_sibling')op.workRun!.steps!.push({key:'unknown_paid',namespace:'nested',tool:'model',label:'原付费调用',scopeId:op.id,effect:'model',state:'started',updatedAt:cp.updatedAt});
  if(mode==='local_hold')f.db().executionTasks=[{workspaceId:task.workspaceId,userId:task.userId,conversationId:task.id,executionSafetyHold:true} as unknown as NonNullable<Database['executionTasks']>[number]];
  if(mode==='stopped')task.workPauseReason='user_stopped';
  if(mode==='revoked')op.workRun!.failureCode='task_key_required';
  if(mode==='foreign')cp.scopeId='foreign_operation';
  if(mode==='duplicate')op.workRun!.steps!.push(structuredClone(cp));
  f.db().chatOperations.push(op);reconcileInterruptedChatOperations(f.db());
  assert.equal(op.workRun!.state,mode==='safe_read'?'queued':'interrupted',mode);assert.equal(op.status,mode==='safe_read'?'pending':'interrupted',mode);
  assert.equal(op.workRun!.steps![0].operation?.recovery?.attempt,2);assert.equal(op.workRun!.steps![0].operation?.recovery?.nextRetryAt,'2026-11-03T00:00:10.000Z');assert.equal(f.db().chatOperations.length,1);
 }
});

function notionRestartFixture(){
 const f=fixture(),task=conversation();f.db().conversations.push(task);
 const binding={workspaceId:task.workspaceId,userId:task.userId,operationId:'acknowledged-startup-op'};
 const run=createWorkflowRun({version:1,steps:[{id:'save',title:'保存正文',kind:'notion',instruction:'保存本轮完整正文',inputs:[]},{id:'read',title:'读取已交付文章',kind:'tool',tool:'read_notion_document',instruction:'读取同一篇文章',inputs:['save']}]},binding);
 const namespace=`workflow:${run.id}`,tool=`workflow:${run.id}:save`,key=taskStepKey(namespace,tool,JSON.stringify({revision:1,instruction:run.spec.steps[0].instruction,inputs:[]})),workerKey='a'.repeat(64),expectedDigest='b'.repeat(64),expectedRawDigest='c'.repeat(64),pageId='d'.repeat(32);
 const outer:TaskStep={key,namespace,tool,scopeId:binding.operationId,label:'保存正文',effect:'external_write',state:'started',updatedAt:'2026-11-10T01:00:00Z',output:{workflow:{version:1,runId:run.id,revision:1,stepId:'save'},outcome:'waiting',expectedBodyDigest:expectedDigest,notionCheckpointKey:workerKey}};
 const worker:TaskStep={key:workerKey,namespace:'worker',tool:'save_notion_draft',scopeId:binding.operationId,label:'实际保存',effect:'external_write',state:'started',updatedAt:'2026-11-10T01:00:01Z'};
 run.steps[0]={id:'save',state:'waiting',waitingFor:'result'};run.phase='waiting';
 const op={...binding,id:binding.operationId,operationId:'acknowledged_startup_submission',conversationId:task.id,status:'pending',createdAt:task.createdAt,updatedAt:task.updatedAt,workRun:{state:'running',workflow:run,steps:[outer,worker],notionReceipt:{state:'delivered',delivery:'unknown',checkpointKey:workerKey,expectedDigest,expectedRawDigest,pageId,final:true,writeAcknowledgement:{version:1,operationId:binding.operationId,checkpointKey:workerKey,expectedDigest,expectedRawDigest,pageId,acknowledgedAt:'2026-11-10T01:00:02Z'},verification:{state:'scheduled',version:17,attempt:1,nextCheckAt:'2026-11-10T01:00:04Z',deadlineAt:'2026-11-10T01:05:02Z'}}}} as unknown as ChatOperation;
 f.db().chatOperations.push(op);return {...f,task,op,run,outer,worker};
}

test('startup resolves the exact ACK-to-worker gap into queued metadata while background checks retain their budget',()=>{
 for(const state of ['scheduled','checking','exhausted'] as const){
  const f=notionRestartFixture(),receipt=f.op.workRun!.notionReceipt!;receipt.verification!.state=state;
  const before=structuredClone(receipt);reconcileInterruptedChatOperations(f.db());reconcileInterruptedChatOperations(f.db());
  assert.equal(f.op.status,'pending');assert.equal(f.op.workRun!.state,'queued');assert.equal(f.op.workRun!.failureCode,undefined);assert.equal(f.task.workPaused,false);
  const worker=f.op.workRun!.steps!.find(cp=>cp.key===f.worker.key)!;assert.equal(worker.state,'completed');assert.equal((worker.output as any).state,'delivered');
  assert.deepEqual(f.op.workRun!.notionReceipt,before);assert.equal(f.op.workRun!.workflow!.steps[1].state,'queued');assert.equal(f.db().chatOperations.length,1);assert.equal(f.task.messages.length,0);
 }
 const f=notionRestartFixture();f.op.workRun!.state='failed';f.op.workRun!.failureCode='notion_verification_exhausted';f.outer.state='failed';(f.outer.output as any).outcome='failed';f.run.steps[0]={id:'save',state:'failed'};f.run.phase='failed';
 reconcileInterruptedChatOperations(f.db());assert.equal(f.op.workRun!.state,'queued');assert.equal(f.op.workRun!.workflow!.steps[0].state,'completed');assert.equal(f.op.workRun!.workflow!.steps[1].state,'queued');
});

function notionRestartWithSourceFixture(){
 const f=notionRestartFixture(),receipt=f.op.workRun!.notionReceipt!,content='# 已完成文章\n\n这篇完整原稿在发送前已经持久保存。\n\n`literal code` 与[原始链接](https://example.com/article)也保留。';
 receipt.expectedRawDigest=notionHash(content);receipt.expectedDigest=notionHash(legacyNotionNormalized(content));receipt.expectedLength=content.length;receipt.canonicalVersion=11;receipt.expectedCanonicalDigest=canonicalNotionDigest(content,11);
 Object.assign(receipt.writeAcknowledgement!,{expectedRawDigest:receipt.expectedRawDigest,expectedDigest:receipt.expectedDigest});(f.outer.output as any).expectedBodyDigest=receipt.expectedDigest;
 f.worker.output={content,untrustedMetadata:'must not be copied'};return {...f,content};
}

test('startup preserves only the complete receipt-bound source when finishing the acknowledged worker metadata gap',()=>{
 const f=notionRestartWithSourceFixture(),before=structuredClone(f.op.workRun!.notionReceipt);reconcileInterruptedChatOperations(f.db());
 assert.equal(f.op.workRun!.state,'queued');const worker=f.op.workRun!.steps!.find(cp=>cp.key===f.worker.key)!;
 assert.equal((worker.output as any).content,f.content);assert.equal((worker.output as any).untrustedMetadata,undefined);assert.equal(worker.state,'completed');
 assert.deepEqual(f.op.workRun!.notionReceipt,before);assert.equal(f.op.workRun!.workflow!.steps[1].state,'queued');assert.equal(f.task.messages.length,0);
});

test('startup cannot retain a partial, corrupt or differently canonicalized before-send source',()=>{
 const mutations=[
  (f:ReturnType<typeof notionRestartWithSourceFixture>)=>{(f.worker.output as any).content=f.content.slice(0,-1);},
  f=>{(f.worker.output as any).content={text:f.content};},
  f=>{f.op.workRun!.notionReceipt!.expectedLength!--;},
  f=>{f.op.workRun!.notionReceipt!.expectedCanonicalDigest='f'.repeat(64);},
  f=>{f.op.workRun!.notionReceipt!.canonicalVersion=12 as any;},
  f=>{const receipt=f.op.workRun!.notionReceipt!;receipt.expectedDigest='f'.repeat(64);receipt.writeAcknowledgement!.expectedDigest=receipt.expectedDigest;(f.outer.output as any).expectedBodyDigest=receipt.expectedDigest;},
 ] satisfies ((f:ReturnType<typeof notionRestartWithSourceFixture>)=>void)[];
 for(const [index,mutate] of mutations.entries()){
  const f=notionRestartWithSourceFixture();mutate(f);const original=structuredClone(f.worker);reconcileInterruptedChatOperations(f.db());
  assert.notEqual(f.op.workRun!.state,'queued',String(index));assert.deepEqual(f.worker,original,String(index));
 }
});

test('startup ACK recovery cannot release wrong proofs, protected failures or unrelated effects',()=>{
 for(const kind of ['wrong_ack','wrong_source','wrong_artifact','wrong_worker','prior_write','duplicate','unknown_model','unknown_artifact','other_failed','stop','cancel','archive','local_hold','key','authorization','budget'] as const){
  const f=notionRestartFixture(),job=f.op.workRun!;
  if(kind==='wrong_ack')job.notionReceipt!.writeAcknowledgement!.operationId='another_operation';
  if(kind==='wrong_source')(f.outer.output as any).expectedBodyDigest='f'.repeat(64);
  if(kind==='wrong_artifact')(f.outer.output as any).sourceArtifact={id:'existing_article',ref:'another_message',originOperationId:'another_operation',bodyDigest:'f'.repeat(64)};
  if(kind==='wrong_worker')f.worker.scopeId='foreign';
  if(kind==='prior_write')(f.outer.output as any).priorNotionCheckpointKey=f.worker.key;
  if(kind==='duplicate')job.steps!.push(structuredClone(f.worker));
  if(kind==='unknown_model'||kind==='unknown_artifact')job.steps!.push({key:'another-effect',namespace:'nested',tool:'another_call',scopeId:f.op.id,label:'其他未决效果',effect:kind==='unknown_model'?'model':'artifact',state:'started',updatedAt:f.worker.updatedAt});
  if(kind==='other_failed'){f.run.steps[1]={id:'read',state:'failed'};f.run.phase='failed';job.steps!.push({...f.outer,key:taskStepKey(`workflow:${f.run.id}`,`workflow:${f.run.id}:read`,JSON.stringify({revision:1,instruction:f.run.spec.steps[1].instruction,inputs:['save']})),tool:`workflow:${f.run.id}:read`,effect:'read',state:'failed',output:{workflow:{version:1,runId:f.run.id,revision:1,stepId:'read'},outcome:'failed'}});}
  if(kind==='stop')f.task.workPauseReason='user_stopped';if(kind==='cancel')f.op.executionCancelled=true;if(kind==='archive')f.task.archived=true;
  if(kind==='local_hold')f.db().executionTasks=[{workspaceId:f.task.workspaceId,userId:f.task.userId,conversationId:f.task.id,executionSafetyHold:true} as any];
  if(['key','authorization','budget'].includes(kind))job.failureCode=`task_${kind}_required`;
  reconcileInterruptedChatOperations(f.db());assert.notEqual(job.state,'queued',kind);assert.equal(f.db().chatOperations.length,1,kind);assert.equal(f.worker.state,'started',kind);
 }
});
