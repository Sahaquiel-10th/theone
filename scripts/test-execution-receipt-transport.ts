import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { acceptTerminalReceipt, parseTerminalReceipt, recordExecutionAttempt } from '../server/executionTerminalReceipt.js';
import type { TerminalReceipt, TerminalOwner } from '../server/executionTerminalReceipt.js';
import type { Database } from '../server/types.js';

// Real Swift production journal + real WebSocket frames + production receipt
// parser / acceptance / JSON store. NOT the signed Key gateway, Codex or MySQL.
const binary = process.argv[2];
assert.ok(binary, 'Usage: node --import tsx scripts/test-execution-receipt-transport.ts <fixture-binary>');
const evidence = await mkdtemp(path.join(tmpdir(), 'one-receipt-transport-'));
process.env.ONE_DATA_DIR = path.join(evidence, 'server');
process.env.DB_PROVIDER = 'json';
process.env.ADMIN_INITIAL_PASSWORD = randomBytes(32).toString('hex');
delete process.env.YYLX_API_KEY;
const { store } = await import('../server/db.js');
const run = promisify(execFile);
const owner: TerminalOwner = { workspaceId: 'ws_transport', userId: 'usr_transport',
  deviceId: 'dev_transport', installationId: 'a'.repeat(32) };
const now = '2026-10-22T10:00:00.000Z';

async function native(root: string, mode: string, url?: string) {
  const { stdout } = await run(binary, [root, mode, ...(url ? [url] : [])], { timeout: 8000 });
  return JSON.parse(stdout.trim());
}
async function fixture(name: string, cancelled = false) {
  const root = path.join(evidence, name); await mkdir(root);
  await store.mutate(db => {
    db.users = [{ id: owner.userId, enabled: true }] as any;
    db.workspaces = [{ id: owner.workspaceId, status: 'active' }] as any;
    db.workspaceMembers = [{ ...owner, status: 'active' }] as any;
    db.oneKeyDevices = [{ id: owner.deviceId, ...owner, status: 'active' }] as any;
    db.executionTasks = [{ id: 'task_transport', ...owner, provider: 'codex',
      conversationId: 'conversation_transport', sourceMessageId: 'message_transport', instruction: 'synthetic only',
      status: cancelled ? 'cancelled' : 'running', reportRound: 0, createdAt: now, updatedAt: now }] as any;
    db.conversations = [{ id: 'conversation_transport', ...owner, messages: [], updatedAt: now }] as any;
    db.messages = []; db.executionEvents = []; db.auditLogs = [];
    recordExecutionAttempt(db, db.executionTasks[0], 'attempt_transport', now);
  });
  const produced = await native(root, 'produce');
  assert.equal(produced.executed, true); assert.equal(produced.pending, 1);
  const receipt: TerminalReceipt = (await native(root, 'snapshot')).receipts[0];
  assert.ok(parseTerminalReceipt(receipt), 'native UTF8 receipt must validate on server');
  assert.equal(receipt.outcome, 'completed');
  assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), 'ONE_TRANSPORT_OK 中文🙂\n');
  return { root, receipt };
}
type Mode = 'drop-before-commit' | 'drop-ack' | 'wrong-ack' | 'foreign-owner' | 'deliver';
let mode: Mode = 'drop-before-commit';
let handlerFailure: unknown;
const server = createServer();
const sockets = new WebSocketServer({ server, path: '/receipt' });
sockets.on('connection', socket => {
  if (mode === 'drop-before-commit') { socket.terminate(); return; }
  socket.once('message', async bytes => {
    try {
      const receipt = parseTerminalReceipt(JSON.parse(bytes.toString())); assert.ok(receipt);
      const bound = mode === 'foreign-owner' ? { ...owner, workspaceId: 'ws_foreign' } : owner;
      // Same mutation-before-ACK ordering as the production socket route.
      const ack = await store.mutate(db => acceptTerminalReceipt(db, bound, receipt, now));
      if (mode === 'drop-ack' || !ack) { socket.terminate(); return; }
      socket.send(JSON.stringify(mode === 'wrong-ack' ? { ...ack, workspaceId: 'ws_foreign' } : ack));
    } catch (error) { handlerFailure = error; socket.terminate(); }
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const url = `ws://127.0.0.1:${address.port}/receipt`;
async function send(root: string, next: Mode) {
  mode = next; const result = await native(root, 'send', url);
  if (handlerFailure) throw handlerFailure;
  return result;
}
async function onceOnly(root: string) {
  assert.equal((await native(root, 'produce')).executed, false, 'a repeated start must not execute again');
  assert.equal(await readFile(path.join(root, 'operation-count.txt'), 'utf8'), 'executed\n');
}
async function persisted() {
  return JSON.parse(await readFile(path.join(evidence, 'server', 'db.json'), 'utf8')) as Database;
}
try {
  const { root, receipt } = await fixture('loss');
  assert.equal((await send(root, 'drop-before-commit')).pending, 1);
  assert.equal((await persisted()).executionTasks[0].status, 'running');
  assert.equal((await persisted()).messages.length, 0);
  assert.equal((await native(root, 'snapshot')).receipts[0].receiptHash, receipt.receiptHash);
  await onceOnly(root);
  console.log('PASS 1: real socket loss before commit preserves completed native receipt and prevents re-execution');

  assert.equal((await send(root, 'drop-ack')).pending, 1);
  const committed = await persisted();
  assert.equal(committed.executionTasks[0].status, 'completed');
  assert.equal(committed.executionTasks[0].finalResponse, receipt.finalResponse);
  assert.equal(committed.messages.length, 1); assert.equal(committed.executionEvents.length, 1);
  assert.equal((await native(root, 'snapshot')).receipts[0].receiptHash, receipt.receiptHash);
  console.log('PASS 2: committed result survives a lost ACK; native process restart reloads identical pending bytes');

  assert.equal((await send(root, 'wrong-ack')).accepted, false);
  assert.equal((await native(root, 'snapshot')).receipts.length, 1);
  console.log('PASS 3: a foreign-workspace ACK cannot erase the native receipt');

  assert.equal((await send(root, 'deliver')).accepted, true);
  assert.deepEqual((await native(root, 'snapshot')).receipts, []);
  assert.equal((await native(root, 'snapshot')).acknowledged, true);
  const duplicate = await persisted();
  assert.equal(duplicate.messages.length, 1); assert.equal(duplicate.executionEvents.length, 1);
  await onceOnly(root);
  const files = await import('node:fs/promises');
  for (const file of await files.readdir(path.join(root, 'outbox'))) {
    const target = path.join(root, 'outbox', file), journal = JSON.parse(await readFile(target, 'utf8'));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(journal.acknowledged, true); assert.equal(journal.receipt, undefined);
  }
  console.log('PASS 4: reconnect duplicate gets ACK, clears payload only, preserves tombstone and one server result');

  const isolated = await fixture('foreign-owner');
  const before = await readFile(path.join(evidence, 'server', 'db.json'), 'utf8');
  assert.equal((await send(isolated.root, 'foreign-owner')).pending, 1);
  assert.equal(await readFile(path.join(evidence, 'server', 'db.json'), 'utf8'), before);
  await onceOnly(isolated.root);
  console.log('PASS 5: foreign workspace binding cannot mutate or acknowledge a valid native receipt');

  const stopped = await fixture('cancelled', true);
  assert.equal((await send(stopped.root, 'deliver')).accepted, true);
  const cancelled = await persisted();
  assert.equal(cancelled.executionTasks[0].status, 'cancelled');
  assert.equal(cancelled.executionTasks[0].finalResponse, undefined);
  assert.equal(cancelled.executionTasks[0].terminalReceipt?.disposition, 'supplemental');
  assert.equal((await native(stopped.root, 'snapshot')).receipts.length, 0);
  await onceOnly(stopped.root);
  console.log('PASS 6: late completion settles delivery without overwriting explicit cancellation or rerunning');
  console.log('Receipt transport integration: 6 groups passed. NOT real Key/Codex/Windows/MySQL acceptance.');
} finally {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())));
  console.log(`Synthetic evidence retained: ${evidence}`);
}
