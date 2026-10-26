import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {Database} from './types.js';
import {auth, requireOneKeySession} from './middleware.js';
import {signToken} from './security.js';
import {installExecutionReconciliationRoutes, manualExecutionStopConfirmation} from './executionReconciliationRoutes.js';

const scope = {workspaceId:'wa',userId:'ua',deviceId:'da',installationId:'a'.repeat(32)};
const updatedAt = '2026-10-20T07:43:14.398Z';
const body = {expectedRound:0,expectedUpdatedAt:updatedAt,reason:'已检查原进程退出，仅结束旧隔离测试。',
  confirmation:manualExecutionStopConfirmation};
async function setup(t: test.TestContext) {
  let database = {users:[{id:scope.userId,role:'admin',enabled:true,defaultWorkspaceId:scope.workspaceId}],
    workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[{workspaceId:scope.workspaceId,userId:scope.userId,status:'active',role:'owner'}],
    oneKeyDevices:[{id:scope.deviceId,...scope,status:'active'}],
    executionTasks:[{id:'old-task',...scope,conversationId:'old-conversation',provider:'codex',status:'cancelled',reportRound:0,
      instruction:'private original task',updatedAt,createdAt:updatedAt,completedAt:updatedAt,
      deliveryAttempt:{id:'private-old-attempt',round:0,issuedAt:updatedAt},
      transportInterruption:{attemptId:'private-old-attempt',round:0,reason:'cancellation_pending',at:updatedAt}}],
    messages:[],conversations:[],executionEvents:[],auditLogs:[]} as unknown as Database;
  const store = {read:async()=>structuredClone(database),mutate:async(change:(db:Database)=>unknown)=>{
    const copy = structuredClone(database), result = change(copy); database = copy; return result;
  }} as any;
  let proofCalls = 0, rejectProof = false, proofHook: (()=>void) | undefined;
  const presence = {requireProof:async(binding:typeof scope)=>{
    proofCalls++; assert.equal(binding.workspaceId,scope.workspaceId); assert.equal(binding.userId,scope.userId);
    if (rejectProof) throw new Error('ONE Key 未连接'); proofHook?.();
  }} as any;
  const secret = 'test-only-execution-reconciliation-secret', app = express(); app.use(express.json());
  installExecutionReconciliationRoutes(app,[auth(secret,{store,oneKeyPresence:presence}),requireOneKeySession],store);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/executions/`;
  const token = (patch:Record<string,unknown>={}) => signToken({sub:scope.userId,...scope,...patch},secret);
  const post = (payload:unknown=body,id='old-task',authorization:string|undefined=token()) => fetch(`${base}${id}/reconcile-stop`,{
    method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:`Bearer ${authorization}`}:{})},body:JSON.stringify(payload)});
  return {get db(){return database;},get proofCalls(){return proofCalls;},token,post,
    rejectProof(){rejectProof=true;},onProof(hook:()=>void){proofHook=hook;}};
}

test('fresh-key same-owner admin reconciliation uses the durable store and returns no attempt or private instruction',async t=>{
  const f = await setup(t), first = await f.post(); assert.equal(first.status,200);
  const result = await first.json();
  assert.equal(result.task.status,'cancelled'); assert.equal(result.task.blocksCurrentDevice,false);
  assert.equal(result.task.resultDeliveryPending,false); assert.equal(result.manual,true); assert.equal(result.duplicate,false);
  assert.ok(result.auditId); assert.equal(f.db.auditLogs.length,1); assert.equal(f.proofCalls,1);
  assert.doesNotMatch(JSON.stringify(result),/private-old-attempt|private original task|deliveryAttempt|terminalReceipt|"deviceId"/);
  const second = await f.post(); assert.equal(second.status,200); assert.equal((await second.json()).duplicate,true);
  assert.equal(f.db.auditLogs.length,1); assert.equal(f.proofCalls,2,'a duplicate still requires fresh Key proof');
});

test('anonymous, ordinary, unproved or Key-less requests cannot reconcile an execution',async t=>{
  // An explicit empty authorization avoids the test helper's valid-token default.
  const g = await setup(t), before = JSON.stringify(g.db);
  assert.equal((await g.post(body,'old-task','')).status,401);
  g.db.users[0].role='user'; assert.equal((await g.post()).status,403); g.db.users[0].role='admin';
  assert.equal((await g.post(body,'old-task',g.token({deviceId:undefined,installationId:undefined}))).status,428);
  g.rejectProof(); assert.equal((await g.post()).status,428);
  assert.equal(JSON.stringify(g.db),before);
});

test('stale rounds, timestamps, other computers and client identity or attempt fields cannot release an old wait',async t=>{
  const f = await setup(t), before = JSON.stringify(f.db);
  for (const patch of [{expectedRound:1},{expectedUpdatedAt:'2026-10-20T07:43:15.398Z'}])
    assert.equal((await f.post({...body,...patch})).status,409);
  for (const patch of [{expectedRound:-1},{expectedRound:0.5},{expectedRound:'0'},{confirmation:'yes'},
    {reason:''},{attemptId:'browser-must-not-bind-attempt'},{workspaceId:'foreign'}])
    assert.equal((await f.post({...body,...patch})).status,400);
  assert.equal((await f.post(body,'foreign-task')).status,409);
  assert.equal((await f.post(body,'old-task',f.token({installationId:'b'.repeat(32)}))).status,409);
  assert.equal((await f.post(body,'old-task',f.token({deviceId:'foreign-device'}))).status,409);
  assert.equal(JSON.stringify(f.db),before);
});

test('role revocation between fresh proof and mutation is rechecked before any state changes',async t=>{
  const f = await setup(t); f.onProof(()=>{f.db.users[0].role='user';});
  const response = await f.post(); assert.equal(response.status,409);
  assert.equal(f.db.executionTasks[0].transportInterruption?.reason,'cancellation_pending');
  assert.equal(f.db.auditLogs.length,0);
});
