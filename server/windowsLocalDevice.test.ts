import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { OneKeyPresence } from './oneKeyPresence.js';

const installationId = 'a'.repeat(32);
const capabilities = ['local_tools_v1', 'local_configuration_v1', 'runtime_update_v1'];

async function windowsDevice(options: { capabilities?: string[]; runtime?: boolean } = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const db: any = {
    oneKeyDevices: [{ id: 'windows-key', workspaceId: 'wa', userId: 'a', status: 'active',
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    executionTasks: [], auditLogs: []
  };
  let readInterruption: { skip: number; run: () => Promise<void> } | undefined;
  const store: any = {
    read: async () => {
      if (readInterruption) {
        if (readInterruption.skip > 0) readInterruption.skip--;
        else {
          const interruption = readInterruption;
          readInterruption = undefined;
          await interruption.run();
        }
      }
      return structuredClone(db);
    },
    mutate: async (change: (database: any) => unknown) => change(db)
  };
  const presence = new OneKeyPresence(store), server = createServer();
  presence.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=windows-key&installationId=${installationId}`);
  const challenge = JSON.parse((await once(socket, 'message'))[0].toString());
  const sign = (nonce: string) => crypto.sign(null, Buffer.from(nonce, 'base64url'), pair.privateKey).toString('base64url');
  socket.send(JSON.stringify({ type: 'auth_response', challengeId: challenge.challengeId, signature: sign(challenge.nonce),
    capabilities: options.capabilities ?? capabilities,
    ...(options.runtime === false ? {} : { platform: 'windows', architecture: 'amd64', launcherVersion: '0.4.28', updateProtocol: 1 }) }));
  assert.equal(JSON.parse((await once(socket, 'message'))[0].toString()).type, 'ready');
  const messages: any[] = [];
  let configuration: ((message: any) => void) | undefined;
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (message.type === 'request_challenge') socket.send(JSON.stringify({ type: 'proof_response', challengeId: message.challengeId, signature: sign(message.nonce) }));
    if (message.type === 'local_configuration') configuration?.(message);
  });
  const scope = { deviceId: 'windows-key', installationId, workspaceId: 'wa', userId: 'a' };
  async function disconnect() {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close');
      socket.terminate();
      await closed;
    }
    for (let attempt = 0; attempt < 100 && presence.isConnected(scope.deviceId, installationId); attempt++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(presence.isConnected(scope.deviceId, installationId), false);
  }
  return {
    presence, scope, db, socket, messages, disconnect,
    onConfiguration: (handler: (message: any) => void) => { configuration = handler; },
    reply: (message: any, response: object) => socket.send(JSON.stringify({ type: 'local_ready', taskId: 'device_settings', requestId: message.requestId, ...response })),
    disconnectDuringConfigurationRead: () => {
      const requireProof = presence.requireProof.bind(presence);
      presence.requireProof = async params => {
        await requireProof(params);
        // Complete the normal signed proof, then lose the authenticated socket
        // while configuration reads task state after its ownership check.
        readInterruption = { skip: 1, run: disconnect };
      };
    },
    close: async () => {
      socket.terminate();
      await presence.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

test('Windows built-in file tools report their confirmed launcher without downloading or invoking Codex', async () => {
  const f = await windowsDevice();
  let catalogCalls = 0;
  const catalog = () => { catalogCalls++; throw new Error('Windows built-in tools must not query the Codex catalog'); };
  try {
    for (const [install, enabled] of [[false, true], [true, true], [false, false], [true, false]]) {
      const status = await f.presence.managedExecutor(f.scope, catalog, install, enabled);
      assert.equal(status.available, true);
      assert.equal(status.preparing, false);
      assert.equal(status.installedSource, 'builtin');
      assert.equal(status.installedVersion, '0.4.28');
      assert.equal(status.version, '0.4.28');
      assert.match(status.message ?? '', /内置文件工具/);
    }
    assert.equal(catalogCalls, 0);
    assert.equal(f.messages.filter(message => ['executor_status', 'executor_prepare'].includes(message.type)).length, 0);
    assert.equal(f.messages.filter(message => message.type === 'request_challenge').length, 4);
    for (const changed of [{ workspaceId: 'wb' }, { userId: 'b' }, { installationId: 'b'.repeat(32) }]) {
      for (const install of [false, true])
        await assert.rejects(f.presence.managedExecutor({ ...f.scope, ...changed }, catalog, install), /不属于|当前这台电脑/);
    }
    assert.equal(catalogCalls, 0);
    await f.disconnect();
    for (const install of [false, true])
      await assert.rejects(f.presence.managedExecutor(f.scope, catalog, install), /插入|断开|连接/);
  } finally { await f.close(); }
});

test('Windows needs both authenticated runtime identity and local-tools capability before reporting built-in readiness', async () => {
  for (const options of [{ runtime: false }, { capabilities: ['runtime_update_v1', 'local_configuration_v1'] }]) {
    const f = await windowsDevice(options);
    let catalogCalls = 0;
    const catalog = () => { catalogCalls++; return undefined; };
    try {
      const status = await f.presence.managedExecutor(f.scope, catalog);
      assert.equal(status.available, false);
      assert.equal('installedVersion' in status && status.installedVersion, false);
      await assert.rejects(f.presence.managedExecutor(f.scope, catalog, true), /升级|不支持/);
      assert.equal(catalogCalls, 0);
      assert.equal(f.messages.filter(message => ['executor_status', 'executor_prepare'].includes(message.type)).length, 0);
    } finally { await f.close(); }
  }
});

test('Windows settings preserve the selected folder on cancellation and enforce exact account and computer scope', async () => {
  const f = await windowsDevice();
  let folder = 'C:\\ONE\\original', cancel = false;
  f.onConfiguration(message => {
    if (message.change && cancel) { f.reply(message, { type: 'local_error', error: '已取消选择，原授权目录保持不变' }); return; }
    if (message.change) folder = 'D:\\ONE\\selected';
    f.reply(message, { targetName: folder });
  });
  try {
    assert.equal((await f.presence.localConfiguration(f.scope, false)).targetName, 'C:\\ONE\\original');
    assert.equal((await f.presence.localConfiguration(f.scope, true)).targetName, 'D:\\ONE\\selected');
    cancel = true;
    await assert.rejects(f.presence.localConfiguration(f.scope, true), /已取消选择/);
    assert.equal((await f.presence.localConfiguration(f.scope, false)).targetName, 'D:\\ONE\\selected');
    const dispatched = f.messages.filter(message => message.type === 'local_configuration');
    assert.deepEqual(dispatched.map(message => message.change), [false, true, true, false]);
    assert.ok(dispatched.every(message => message.taskId === 'device_settings' && message.requestId));
    for (const changed of [{ workspaceId: 'wb' }, { userId: 'b' }, { installationId: 'b'.repeat(32) }])
      for (const change of [false, true])
        await assert.rejects(f.presence.localConfiguration({ ...f.scope, ...changed }, change), /不属于|当前这台电脑/);
    assert.equal(f.messages.filter(message => message.type === 'local_configuration').length, dispatched.length);
  } finally { await f.close(); }
});

test('a live Windows launcher lacking folder configuration reports upgrade rather than a disconnected computer', async () => {
  const f = await windowsDevice({ capabilities: ['local_tools_v1', 'runtime_update_v1'] });
  try {
    for (const change of [false, true])
      await assert.rejects(f.presence.localConfiguration(f.scope, change), /不支持目录设置.*升级/);
    assert.equal(f.presence.isConnected(f.scope.deviceId, installationId), true);
    assert.equal(f.messages.filter(message => message.type === 'local_configuration').length, 0);
    await f.disconnect();
    await assert.rejects(f.presence.localConfiguration(f.scope, false), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /插入|断开|连接/);
      assert.doesNotMatch(error.message, /不支持目录设置|升级/);
      return true;
    });
  } finally { await f.close(); }
});

test('losing the Windows socket during folder authorization cannot dispatch a stale configuration request', async () => {
  const f = await windowsDevice();
  try {
    f.disconnectDuringConfigurationRead();
    await assert.rejects(f.presence.localConfiguration(f.scope, true), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /插入|断开|连接|变更/);
      assert.doesNotMatch(error.message, /不支持目录设置|升级/);
      return true;
    });
    assert.equal(f.messages.filter(message => message.type === 'local_configuration').length, 0);
  } finally { await f.close(); }
});
