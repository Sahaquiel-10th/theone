import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { OneKeyPresence } from './oneKeyPresence.js';
import { terminalReceiptCapability, terminalReceiptHash, type TerminalReceipt } from './executionTerminalReceipt.js';
import { assertLocalExecutionAvailable, executionBlocksDevice, executionDeliveryPending } from './executionService.js';

const installationId = 'a'.repeat(32);
const owner = { workspaceId: 'workspace-a', userId: 'user-a', deviceId: 'device-a', installationId };
async function waitUntil(predicate: () => boolean, message: string, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function setup(t: test.TestContext) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const now = new Date().toISOString();
  let database = { oneKeyDevices: [{ id: owner.deviceId, ...owner, status: 'active',
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    users: [{ id: owner.userId, enabled: true }], workspaces: [{ id: owner.workspaceId, status: 'active' }],
    workspaceMembers: [{ workspaceId: owner.workspaceId, userId: owner.userId, status: 'active' }],
    executionTasks: [{ id: 'task-a', ...owner, conversationId: 'conversation-a', sourceMessageId: 'message-a',
      provider: 'codex', status: 'queued', instruction: 'only test directory', reportRound: 0, createdAt: now, updatedAt: now }],
    executionEvents: [], auditLogs: [], messages: [],
    conversations: [{ id: 'conversation-a', ...owner, messages: [], updatedAt: now }] } as any;
  let failTerminalCommit = false, failedCommits = 0;
  const store = { read: async () => database,
    mutate: async (change: (db: any) => any) => {
      const copy = structuredClone(database); const result = change(copy);
      if (failTerminalCommit && copy.auditLogs.filter((a: any) => a.action === 'execution.delivery.terminal').length
        > database.auditLogs.filter((a: any) => a.action === 'execution.delivery.terminal').length) {
        failedCommits++; throw new Error('simulated durable commit failure');
      }
      database = copy; return result;
    } } as any;
  const presence = new OneKeyPresence(store), server = createServer();
  presence.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port; const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await presence.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });
  async function connect(authenticate = true, answerProof = true) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/one-key/launcher?deviceId=${owner.deviceId}&installationId=${installationId}`);
    const frames: any[] = []; sockets.push(socket);
    socket.on('message', raw => {
      const value = JSON.parse(raw.toString()); frames.push(value);
      if (answerProof && value.type === 'request_challenge') socket.send(JSON.stringify({ type: 'proof_response',
        challengeId: value.challengeId, signature: crypto.sign(null, Buffer.from(value.nonce, 'base64url'), pair.privateKey).toString('base64url') }));
    });
    const [raw] = await once(socket, 'message'); const challenge = JSON.parse(raw.toString());
    if (authenticate) {
      const ready = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'auth_response', challengeId: challenge.challengeId,
        signature: crypto.sign(null, Buffer.from(challenge.nonce, 'base64url'), pair.privateKey).toString('base64url'),
        capabilities: [terminalReceiptCapability, 'execution_round_v1'] }));
      assert.deepEqual(JSON.parse((await ready)[0].toString()), { type: 'ready', deviceId: owner.deviceId,
        owner: { workspaceId: owner.workspaceId, userId: owner.userId } });
    }
    return { socket, frames };
  }
  async function issue(connection: Awaited<ReturnType<typeof connect>>) {
    await presence.startExecution(owner.deviceId, 'task-a', 'only test directory', installationId);
    await waitUntil(() => connection.frames.some(f => f.type === 'execution_start'), 'missing start');
    const frame = connection.frames.find(f => f.type === 'execution_start');
    assert.ok(frame.attemptId); assert.deepEqual(frame.owner, { workspaceId: owner.workspaceId, userId: owner.userId });
    const receipt: TerminalReceipt = { type: 'execution_terminal_receipt', schemaVersion: 1,
      receiptId: crypto.randomUUID(), receiptHash: '', attemptId: frame.attemptId, ...owner,
      taskId: frame.taskId, round: frame.round, outcome: 'completed', finalResponse: '已回读测试文件：ONE_LOCAL_NOTE_OK',
      targetName: '/authorized/test', occurredAt: new Date().toISOString() };
    receipt.receiptHash = terminalReceiptHash(receipt); return receipt;
  }
  return { presence, connect, issue, get db() { return database; },
    get failedCommits() { return failedCommits; }, failCommit(value: boolean) { failTerminalCommit = value; } };
}

test('real signed socket recovers a committed same-round result after connection interruption without replaying execution', async t => {
  const f = await setup(t), first = await f.connect(); const receipt = await f.issue(first);
  const closed = once(first.socket, 'close'); first.socket.close(1000); await closed;
  await waitUntil(() => f.db.executionTasks[0].status === 'failed', 'missing interrupted state');
  assert.equal(f.db.executionTasks[0].transportInterruption.reason, 'socket_close');
  const oldMessage = f.db.messages[0].content;
  const second = await f.connect(); second.socket.send(JSON.stringify(receipt));
  await waitUntil(() => second.frames.some(frame => frame.type === 'execution_terminal_ack'), 'missing durable ACK');
  const ack = second.frames.find(frame => frame.type === 'execution_terminal_ack');
  assert.equal(ack.disposition, 'accepted'); assert.equal(ack.accepted, true); assert.equal(ack.receiptHash, receipt.receiptHash);
  assert.equal(f.db.executionTasks[0].status, 'completed'); assert.equal(f.db.messages[0].content, oldMessage);
  assert.equal(f.db.messages.length, 2); assert.match(f.db.messages[1].content, /ONE_LOCAL_NOTE_OK/);
  assert.equal(second.frames.filter(frame => frame.type === 'execution_start' || frame.type === 'execution_continue').length, 0);
  second.socket.send(JSON.stringify(receipt));
  await waitUntil(() => second.frames.filter(frame => frame.type === 'execution_terminal_ack').length === 2, 'missing duplicate ACK');
  assert.equal(second.frames.at(-1).disposition, 'duplicate'); assert.equal(f.db.messages.length, 2);
});

test('terminal ACK is withheld on failed durable commit and replay after recovery stores exactly once', async t => {
  const f = await setup(t), connection = await f.connect(), receipt = await f.issue(connection);
  f.failCommit(true); connection.socket.send(JSON.stringify(receipt));
  await waitUntil(() => f.failedCommits === 1, 'commit failure not observed');
  assert.equal(connection.frames.filter(v => v.type === 'execution_terminal_ack').length, 0);
  assert.equal(f.db.executionTasks[0].status, 'queued'); assert.equal(f.db.messages.length, 0);
  f.failCommit(false); connection.socket.send(JSON.stringify(receipt));
  await waitUntil(() => connection.frames.some(v => v.type === 'execution_terminal_ack'), 'missing replay ACK');
  assert.equal(f.db.executionTasks[0].status, 'completed'); assert.equal(f.db.messages.length, 1);
});

test('new protocol rejects unauthenticated/boundary injection and ignores racing generic terminal events', async t => {
  const f = await setup(t), connection = await f.connect(), receipt = await f.issue(connection);
  connection.socket.send(JSON.stringify({ type: 'execution_event', taskId: 'task-a', round: 0, attemptId: receipt.attemptId,
    kind: 'status', status: 'completed', text: 'Codex 本轮已结束，请查看执行结果' }));
  const foreign = { ...receipt, userId: 'other-user' }; foreign.receiptHash = terminalReceiptHash(foreign);
  connection.socket.send(JSON.stringify(foreign));
  const unauthenticated = await f.connect(false); unauthenticated.socket.send(JSON.stringify(receipt));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.db.executionTasks[0].status, 'queued'); assert.equal(f.db.messages.length, 0);
  assert.equal(connection.frames.some(v => v.type === 'execution_terminal_ack'), false);
  assert.equal(unauthenticated.frames.some(v => v.type === 'execution_terminal_ack'), false);
  connection.socket.send(JSON.stringify(receipt));
  await waitUntil(() => connection.frames.some(v => v.type === 'execution_terminal_ack'), 'missing valid ACK');
  assert.equal(f.db.executionTasks[0].finalResponse, receipt.finalResponse);
});

test('cancellation while disconnected persists a tombstone, replays only stop, and does not accept late completion as success', async t => {
  const f = await setup(t), first = await f.connect(), receipt = await f.issue(first);
  const closed = once(first.socket, 'close'); first.socket.close(); await closed;
  await waitUntil(() => f.db.executionTasks[0].status === 'failed', 'missing failed state');
  await f.presence.cancelExecution(owner.deviceId, 'task-a', installationId);
  assert.equal(f.db.executionTasks[0].status, 'cancelled');
  const second = await f.connect(); await waitUntil(() => second.frames.some(v => v.type === 'execution_cancel'), 'missing cancellation tombstone');
  const cancellation = second.frames.find(v => v.type === 'execution_cancel');
  assert.equal(cancellation.attemptId, receipt.attemptId); assert.equal(cancellation.round, 0);
  assert.equal(second.frames.some(v => v.type === 'execution_start'), false);
  second.socket.send(JSON.stringify(receipt));
  await waitUntil(() => second.frames.some(v => v.type === 'execution_terminal_ack'), 'missing supplementary ACK');
  assert.equal(f.db.executionTasks[0].status, 'cancelled');
  assert.equal(second.frames.find(v => v.type === 'execution_terminal_ack').disposition, 'supplemental');
});

test('proof timeout is separately diagnosed and still fails protected requests instead of relaxing proof', async t => {
  const f = await setup(t), first = await f.connect(true, false); await f.issue(first);
  await assert.rejects(f.presence.requireProof({ ...owner, method: 'POST', path: '/api/chat' }), /未响应/);
  await waitUntil(() => f.db.executionTasks[0].status === 'failed', 'missing proof interrupted state');
  assert.equal(f.db.executionTasks[0].transportInterruption.reason, 'proof_timeout');
  assert.equal(f.db.auditLogs.find((a: any) => a.action === 'one_key.connection.disconnected').details.reason, 'proof_timeout');
  await assert.rejects(f.presence.requireProof({ ...owner, method: 'POST', path: '/api/chat' }), /插入/);
});

test('send callback failure checkpoints the exact attempt before route failure and permits result recovery', async t => {
  const f = await setup(t), first = await f.connect();
  const serverSocket = (f.presence as any).sockets.get(owner.deviceId) as WebSocket;
  const realSend = serverSocket.send.bind(serverSocket);
  (serverSocket as any).send = (raw: string, callback: (error?: Error) => void) => {
    if (JSON.parse(raw).type === 'execution_start') callback(new Error('simulated socket write failure'));
    else realSend(raw, callback);
  };
  await assert.rejects(f.presence.startExecution(owner.deviceId, 'task-a', 'only test directory', installationId), /连接已断开/);
  await waitUntil(() => f.db.executionTasks[0].status === 'failed', 'missing send-error checkpoint');
  const task = f.db.executionTasks[0];
  assert.equal(task.transportInterruption.reason, 'socket_error'); assert.equal(task.transportInterruption.attemptId, task.deliveryAttempt.id);
  const receipt: TerminalReceipt = { type: 'execution_terminal_receipt', schemaVersion: 1, receiptId: crypto.randomUUID(),
    receiptHash: '', ...owner, taskId: task.id, attemptId: task.deliveryAttempt.id, round: 0,
    outcome: 'completed', finalResponse: '写入可能已成功：实际文件已回读', occurredAt: new Date().toISOString() };
  receipt.receiptHash = terminalReceiptHash(receipt);
  const second = await f.connect(); second.socket.send(JSON.stringify(receipt));
  await waitUntil(() => second.frames.some(v => v.type === 'execution_terminal_ack'), 'missing send-error recovery ACK');
  assert.equal(f.db.executionTasks[0].status, 'completed');
  assert.equal(second.frames.some(v => v.type === 'execution_start'), false);
});

test('outbox failure distinguishes not-started from result-not-saved without issuing a fake receipt ACK', async t => {
  for (const phase of ['not_started', 'result_not_persisted'] as const) {
    const f = await setup(t), connection = await f.connect(), receipt = await f.issue(connection);
    connection.socket.send(JSON.stringify({ type: 'execution_delivery_error', ...owner,
      taskId: receipt.taskId, attemptId: receipt.attemptId, round: receipt.round,
      code: 'outbox_unavailable', phase }));
    await waitUntil(() => f.db.executionTasks[0].status === 'failed', 'missing outbox failure');
    assert.equal(connection.frames.some(v => v.type === 'execution_terminal_ack'), false);
    if (phase === 'not_started') {
      assert.equal(f.db.executionTasks[0].transportInterruption, undefined);
      assert.match(f.db.executionTasks[0].lastError, /尚未开始操作/);
    } else {
      assert.equal(f.db.executionTasks[0].transportInterruption.reason, 'local_storage');
      assert.match(f.db.executionTasks[0].lastError, /结果尚未安全保存/);
      connection.socket.send(JSON.stringify(receipt));
      await waitUntil(() => connection.frames.some(v => v.type === 'execution_terminal_ack'), 'missing durable recovery ACK');
      assert.equal(f.db.executionTasks[0].status, 'completed');
    }
  }
});

test('outbox failure cannot mutate another attempt or round and cannot overwrite cancellation', async t => {
  const f = await setup(t), connection = await f.connect(), receipt = await f.issue(connection);
  for (const patch of [{ userId: 'other-user' }, { round: 2 }, { attemptId: 'wrong-attempt' }]) {
    connection.socket.send(JSON.stringify({ type: 'execution_delivery_error', ...owner,
      taskId: receipt.taskId, attemptId: receipt.attemptId, round: receipt.round,
      code: 'outbox_unavailable', phase: 'result_not_persisted', ...patch }));
  }
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.db.executionTasks[0].status, 'queued');
  await f.presence.cancelExecution(owner.deviceId, 'task-a', installationId);
  connection.socket.send(JSON.stringify({ type: 'execution_delivery_error', ...owner,
    taskId: receipt.taskId, attemptId: receipt.attemptId, round: receipt.round,
    code: 'outbox_unavailable', phase: 'result_not_persisted' }));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.db.executionTasks[0].status, 'cancelled');
  assert.equal(f.db.executionTasks[0].transportInterruption.reason, 'cancellation_pending');
});

test('an unanswered cancellation can resend the same attempt and its real terminal unlocks a new independent task', async t => {
  const f = await setup(t), connection = await f.connect(), original = await f.issue(connection);
  await f.presence.cancelExecution(owner.deviceId, original.taskId, installationId);
  await waitUntil(() => connection.frames.filter(frame => frame.type === 'execution_cancel').length === 1, 'missing first stop');
  assert.equal(executionDeliveryPending(f.db.executionTasks[0]), true);
  assert.throws(() => assertLocalExecutionAvailable(f.db, owner), /等本机确认/);
  await f.presence.cancelExecution(owner.deviceId, original.taskId, installationId);
  await waitUntil(() => connection.frames.filter(frame => frame.type === 'execution_cancel').length === 2, 'unanswered stop was silently dropped');
  for (const stop of connection.frames.filter(frame => frame.type === 'execution_cancel')) {
    assert.equal(stop.attemptId, original.attemptId); assert.equal(stop.round, original.round);
  }
  const stopped = {...original, receiptId:crypto.randomUUID(), outcome:'cancelled' as const, finalResponse:'已确认本轮进程结束，修改保留。'};
  stopped.receiptHash = terminalReceiptHash(stopped);
  connection.socket.send(JSON.stringify(stopped));
  await waitUntil(() => connection.frames.some(frame => frame.type === 'execution_terminal_ack'), 'missing real stopped receipt');
  assert.equal(f.db.executionTasks[0].status, 'cancelled');
  assert.equal(executionBlocksDevice(f.db.executionTasks[0], owner), false);
  assert.doesNotThrow(() => assertLocalExecutionAvailable(f.db, owner));
  const next = {...f.db.executionTasks[0], id:'independent-task', conversationId:'independent-conversation', status:'queued',
    reportRound:0, deliveryAttempt:undefined, terminalReceipt:undefined, transportInterruption:undefined};
  f.db.executionTasks.push(next);
  await f.presence.startExecution(owner.deviceId, next.id, 'new independent task only', installationId);
  await waitUntil(() => connection.frames.some(frame => frame.type === 'execution_start' && frame.taskId === next.id), 'independent task did not start');
  assert.equal(connection.frames.filter(frame => frame.type === 'execution_start' && frame.taskId === original.taskId).length, 1, 'old task must not replay');
});

test('a held terminal remains stoppable but diagnostics cannot release unknown side effects or cross ownership', async t => {
  const f = await setup(t), connection = await f.connect(), original = await f.issue(connection);
  f.db.executionTasks[0].status = 'failed'; f.db.executionTasks[0].executionSafetyHold = 'command_unconfirmed';
  await f.presence.cancelExecution(owner.deviceId, original.taskId, installationId);
  await waitUntil(() => connection.frames.some(frame => frame.type === 'execution_cancel'), 'held terminal cannot be checked/stopped');
  const snapshot = JSON.stringify(f.db.executionTasks[0]);
  const diagnostic = {type:'execution_recovery_status', ...owner, taskId:original.taskId, attemptId:original.attemptId,
    round:original.round, state:'not_found'};
  for (const patch of [{workspaceId:'foreign-workspace'}, {userId:'foreign-user'}, {deviceId:'foreign-device'},
    {installationId:'b'.repeat(32)}, {attemptId:'foreign-attempt'}, {round:3}, {state:'stopped'}]) {
    connection.socket.send(JSON.stringify({...diagnostic,...patch}));
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(JSON.stringify(f.db.executionTasks[0]), snapshot);
  connection.socket.send(JSON.stringify(diagnostic));
  await waitUntil(() => /找不到这轮原操作/.test(f.db.executionTasks[0].lastError), 'missing useful scoped recovery diagnostic');
  assert.equal(f.db.executionTasks[0].status, 'cancelled');
  assert.equal(f.db.executionTasks[0].executionSafetyHold, 'command_unconfirmed');
  assert.equal(executionDeliveryPending(f.db.executionTasks[0]), true);
  assert.throws(() => assertLocalExecutionAvailable(f.db, owner), /没确认结束/);
  const events = f.db.executionEvents.length;
  connection.socket.send(JSON.stringify(diagnostic));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.db.executionEvents.length, events, 'repeated inspection must not grow history forever');
  assert.equal(connection.frames.some(frame => frame.type === 'execution_terminal_ack'), false);
});

test('an old browser stop round cannot mutate or signal a newer resumed attempt', async t => {
  const f = await setup(t), connection = await f.connect(), first = await f.issue(connection);
  connection.socket.send(JSON.stringify(first));
  await waitUntil(() => connection.frames.some(frame => frame.type === 'execution_terminal_ack'), 'missing original terminal');
  const resumed = f.db.executionTasks[0];
  Object.assign(resumed, {status:'queued',reportRound:1,deliveryAttempt:undefined,terminalReceipt:undefined,
    transportInterruption:undefined,finalResponse:undefined,lastError:undefined});
  await f.presence.continueExecution(owner.deviceId, resumed.id, 'new round only', installationId);
  await waitUntil(() => connection.frames.some(frame => frame.type === 'execution_continue'), 'missing resumed attempt');
  const before = JSON.stringify(f.db), cancellations = connection.frames.filter(frame => frame.type === 'execution_cancel').length;
  await assert.rejects(() => f.presence.cancelExecution(owner.deviceId, resumed.id, installationId, 0), /已进入新一轮/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(JSON.stringify(f.db), before, 'stale stop must fail before changing task, history or audit');
  assert.equal(connection.frames.filter(frame => frame.type === 'execution_cancel').length, cancellations);
  await f.presence.cancelExecution(owner.deviceId, resumed.id, installationId, 1);
  await waitUntil(() => connection.frames.filter(frame => frame.type === 'execution_cancel').length === cancellations + 1, 'current-round stop did not send');
  const stop = connection.frames.filter(frame => frame.type === 'execution_cancel').at(-1);
  assert.equal(stop.round, 1); assert.notEqual(stop.attemptId, first.attemptId);
});
