import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import type { Store } from './db.js';
import type { Database } from './types.js';
import { OneKeyPresence } from './oneKeyPresence.js';
import { CodexToolBridge } from './codexToolBridge.js';
import { NotionDocuments } from './notionDocuments.js';

test('authenticated launcher forwards task-scoped Codex tools and replays a durable result after reconnect', async () => {
  const pair = crypto.generateKeyPairSync('ed25519'), installationId = 'a'.repeat(32), owner = { workspaceId: 'wa', userId: 'a', deviceId: 'key-a', installationId };
  let db = { users: [{ id: 'a', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }], workspaceMembers: [{ workspaceId: 'wa', userId: 'a', role: 'owner' }],
    oneKeyDevices: [{ ...owner, id: 'key-a', serialNumber: 'SYNTHETIC-BRIDGE', status: 'active', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), createdAt: 'now' }],
    executionTasks: [{ ...owner, id: 'task-a', conversationId: 'conversation-a', sourceMessageId: 'input-a', instruction: '写合成正文', provider: 'codex', status: 'queued', createdAt: 'now', updatedAt: 'now' }],
    executionEvents: [], knowledgeConnections: [], messages: [], auditLogs: [], conversations: [{ workspaceId: 'wa', userId: 'a', id: 'conversation-a', messages: [], title: '合成桥梁任务' }],
    chatOperations: [{ workspaceId: 'wa', userId: 'a', id: 'operation-a', operationId: 'operation_synthetic_0001', conversationId: 'conversation-a', status: 'completed', requestId: 'test', workRun: {
      state: 'prepared', executionMode: 'local', localExecution: { deviceId: 'key-a', installationId, toolBridge: true }, inputMessageId: 'input-a', instruction: '写合成正文', sources: [], skills: [], steps: []
    } }], settings: {} } as unknown as Database;
  let chain = Promise.resolve();
  const store = { read: async () => structuredClone(db), mutate: <T>(fn: (value: Database) => T) => { const next = chain.then(() => { const copy = structuredClone(db), value = fn(copy); db = copy; return value; }); chain = next.then(() => {}, () => {}); return next; } } as Store;
  const presence = new OneKeyPresence(store);
  const bridge = new CodexToolBridge(store, { recallWithDiagnostics: async () => { throw Error('no synthetic source'); } }, new NotionDocuments(store, {} as any),
    scope => presence.requireProof({ ...scope, method: 'POST', path: '/internal/codex/tool-call' }));
  presence.configureCodexToolBridge(bridge);
  const server = createServer(); presence.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/one-key/launcher?deviceId=key-a&installationId=${installationId}`); sockets.push(socket);
    const [raw] = await once(socket, 'message'), challenge = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ type: 'auth_response', challengeId: challenge.challengeId, signature: crypto.sign(null, Buffer.from(challenge.nonce, 'base64url'), pair.privateKey).toString('base64url'),
      capabilities: ['codex_exec_v1', 'execution_round_v1', 'execution_terminal_receipt_v1', 'codex_tool_bridge_v1'] }));
    const [ready] = await once(socket, 'message'); assert.equal(JSON.parse(ready.toString()).type, 'ready');
    socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'request_challenge') socket.send(JSON.stringify({ type: 'proof_response', challengeId: message.challengeId,
      signature: crypto.sign(null, Buffer.from(message.nonce, 'base64url'), pair.privateKey).toString('base64url') })); });
    return socket;
  }
  function receive(socket: WebSocket, type: string) {
    return new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { socket.off('message', listener); reject(Error(`missing ${type}`)); }, 3000);
      const listener = (data: Buffer) => { const message = JSON.parse(data.toString()); if (message.type === type) { clearTimeout(timer); socket.off('message', listener); resolve(message); } }; socket.on('message', listener); });
  }
  try {
    const socket = await connect(), started = receive(socket, 'execution_start'); await presence.startExecution('key-a', 'task-a', '写合成正文', installationId); const launch = await started;
    assert.ok(launch.toolBridge.tools.some((tool: { name: string }) => tool.name === 'one_save_artifact')); assert.ok(launch.attemptId);
    socket.send(JSON.stringify({ type: 'execution_event', taskId: 'task-a', round: 0, attemptId: launch.attemptId, kind: 'status', status: 'running', providerThreadId: 'thread-a', text: '正在写作' }));
    const call = { type: 'executor_tool_call', taskId: 'task-a', round: 0, attemptId: launch.attemptId, requestId: 'request-a', threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a', tool: 'one_save_artifact', arguments: { title: '合成文章', content: 'ONE_SYNTHETIC_SOCKET_ORIGINAL完整正文。' } };
    const firstResponse = receive(socket, 'executor_tool_result'); socket.send(JSON.stringify(call)); const first = await firstResponse;
    assert.equal(first.success, true); assert.equal(first.requestId, 'request-a'); assert.equal(first.turnId, 'turn-a');
    const artifactId = JSON.parse(first.contentItems[0].text).artifactId;
    const closed = once(socket, 'close'); socket.close(); await closed;
    const restored = await connect(), replay = receive(restored, 'executor_tool_result'); restored.send(JSON.stringify({ ...call, requestId: 'reconnect-a' })); const second = await replay;
    assert.equal(second.success, true); assert.equal(JSON.parse(second.contentItems[0].text).artifactId, artifactId);
    assert.equal(db.messages.filter(message => message.id === artifactId).length, 1); assert.equal(db.executionTasks[0].toolBridge!.calls.length, 1);
    const rejected = receive(restored, 'executor_tool_result'); restored.send(JSON.stringify({ ...call, callId: 'wrong-turn', requestId: 'wrong-turn-request', turnId: 'turn-b' }));
    assert.equal((await rejected).success, false); assert.equal(db.executionTasks[0].toolBridge!.calls.length, 1);
  } finally {
    for (const socket of sockets) socket.terminate(); await presence.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
