import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { OneKeyPresence } from "./oneKeyPresence.js";
const installationId = "a".repeat(32);

function sign(privateKey: crypto.KeyObject, nonce: string) {
  return crypto.sign(null, Buffer.from(nonce, "base64url"), privateKey).toString("base64url");
}

test("requires a fresh ONE Key signature for a protected request", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const device = {
    id: "device-a", serialNumber: "ONE-A", workspaceId: "workspace-a", userId: "user-a", status: "active",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: new Date().toISOString()
  };
  const store = { read: async () => ({ oneKeyDevices: [device] }) } as any;
  const presence = new OneKeyPresence(store);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a&installationId=${installationId}`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce) }));
  const [readyRaw] = await once(socket, "message");
  assert.equal(JSON.parse(readyRaw.toString()).type, "ready");

  const proof = presence.requireProof({ deviceId: device.id, installationId, userId: device.userId, workspaceId: device.workspaceId, method: "POST", path: "/api/chat" });
  const [proofRaw] = await once(socket, "message");
  const challenge = JSON.parse(proofRaw.toString());
  socket.send(JSON.stringify({ type: "proof_response", challengeId: challenge.challengeId, signature: sign(pair.privateKey, challenge.nonce) }));
  await proof;

  await assert.rejects(
    () => presence.requireProof({ deviceId: device.id, installationId, userId: device.userId, workspaceId: "workspace-b", method: "POST", path: "/api/chat" }),
    /不属于当前账号/
  );

  socket.close();
  await once(socket, "close");
  await presence.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("accepts execution events only for the authenticated device workspace", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const timestamp = new Date().toISOString();
  const device = {
    id: "device-a", serialNumber: "ONE-A", workspaceId: "workspace-a", userId: "user-a", status: "active",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: timestamp
  };
  const database = {
    oneKeyDevices: [device], auditLogs: [], executionEvents: [],
    executionTasks: [
      { id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", sourceMessageId: "message-a", provider: "codex", status: "queued", instruction: "safe", deviceId: "device-a", installationId, createdAt: timestamp, updatedAt: timestamp },
      { id: "task-b", workspaceId: "workspace-b", userId: "user-b", conversationId: "conversation-b", sourceMessageId: "message-b", provider: "codex", status: "queued", instruction: "foreign", deviceId: "device-a", installationId, createdAt: timestamp, updatedAt: timestamp }
    ]
  } as any;
  let resolveMutation: (() => void) | undefined;
  const nextMutation = () => new Promise<void>((resolve) => { resolveMutation = resolve; });
  const store = {
    read: async () => database,
    mutate: async (change: (value: typeof database) => unknown) => {
      const result = change(database);
      resolveMutation?.(); resolveMutation = undefined;
      return result;
    }
  } as any;
  const presence = new OneKeyPresence(store);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a&installationId=${installationId}`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce) }));
  await once(socket, "message");

  const startMessage = once(socket, "message");
  await presence.startExecution("device-a", "task-a", "safe", installationId);
  assert.deepEqual(JSON.parse((await startMessage)[0].toString()), { type: "execution_start", taskId: "task-a", instruction: "safe" });

  let mutated = nextMutation();
  socket.send(JSON.stringify({ type: "execution_event", taskId: "task-a", kind: "message", text: "done", status: "completed", providerThreadId: "thread-a" }));
  await mutated;
  assert.equal(database.executionTasks[0].status, "completed");
  assert.equal(database.executionTasks[0].providerThreadId, "thread-a");
  assert.equal(database.executionEvents.length, 1);

  mutated = nextMutation();
  socket.send(JSON.stringify({ type: "execution_event", taskId: "task-b", kind: "message", text: "leak", status: "completed" }));
  await mutated;
  assert.equal(database.executionTasks[1].status, "queued");
  assert.equal(database.executionEvents.length, 1);

  socket.close();
  await once(socket, "close");
  await presence.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("negotiates local tools and isolates request responses to the authenticated task", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const timestamp = new Date().toISOString();
  const device = { id: "device-a", serialNumber: "ONE-A", workspaceId: "workspace-a", userId: "user-a", status: "active", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: timestamp };
  const store = { read: async () => ({ oneKeyDevices: [device], executionTasks: [{ id: "task-a", deviceId: "device-a", installationId, workspaceId: "workspace-a", userId: "user-a" }] }) } as any;
  const presence = new OneKeyPresence(store);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a&installationId=${installationId}`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce), capabilities: ["local_tools_v1"] }));
  await once(socket, "message");
  assert.equal(presence.supportsLocalAgent("device-a", installationId), true);

  const preparing = presence.prepareLocalExecution("device-a", "task-a", installationId);
  const [prepareRaw] = await once(socket, "message");
  const prepare = JSON.parse(prepareRaw.toString());
  assert.equal(prepare.type, "local_prepare");
  socket.send(JSON.stringify({ type: "local_ready", taskId: "task-a", requestId: prepare.requestId, targetName: "project-a" }));
  assert.deepEqual(await preparing, { targetName: "project-a", output: "" });

  const running = presence.executeLocalTool("device-a", "task-a", "read_file", { path: "README.md" }, installationId);
  const [toolRaw] = await once(socket, "message");
  const tool = JSON.parse(toolRaw.toString());
  assert.equal(tool.tool, "read_file");
  socket.send(JSON.stringify({ type: "tool_result", taskId: "task-a", requestId: tool.requestId, ok: true, output: "hello" }));
  assert.deepEqual(await running, { targetName: undefined, output: "hello" });

  socket.close();
  await once(socket, "close");
  await presence.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("binds runtime update status and dispatch to the authenticated workspace and computer", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const timestamp = new Date().toISOString();
  const device = { id: "device-a", serialNumber: "ONE-A", workspaceId: "workspace-a", userId: "user-a", status: "active", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: timestamp };
  const database = { oneKeyDevices: [device], auditLogs: [] } as any;
  const store = { read: async () => database, mutate: async (change: (value: typeof database) => unknown) => change(database) } as any;
  const presence = new OneKeyPresence(store);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a&installationId=${installationId}`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({
    type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce),
    capabilities: ["runtime_update_v1"], platform: "windows", architecture: "amd64", launcherVersion: "0.2.4", updateProtocol: 1
  }));
  await once(socket, "message");

  const status = await presence.runtimeStatus({ deviceId: "device-a", installationId, userId: "user-a", workspaceId: "workspace-a" });
  assert.deepEqual(status.runtime, { platform: "windows", architecture: "amd64", version: "0.2.4", updateProtocol: 1 });
  await assert.rejects(() => presence.runtimeStatus({ deviceId: "device-a", installationId, userId: "user-b", workspaceId: "workspace-b" }), /不属于当前账号/);
  await assert.rejects(() => presence.runtimeStatus({ deviceId: "device-a", installationId: "b".repeat(32), userId: "user-a", workspaceId: "workspace-a" }), /当前这台电脑/);

  const updateMessage = once(socket, "message");
  const progress = await presence.requestRuntimeUpdate({
    deviceId: "device-a", installationId, userId: "user-a", workspaceId: "workspace-a", version: "0.3.0",
    envelope: { payload: "payload", signature: "signature" }
  });
  const command = JSON.parse((await updateMessage)[0].toString());
  assert.equal(command.type, "update_install");
  assert.equal(command.requestId, progress.requestId);
  assert.deepEqual(command.envelope, { payload: "payload", signature: "signature" });

  socket.send(JSON.stringify({ type: "update_event", requestId: progress.requestId, status: "verifying" }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await presence.runtimeStatus({ deviceId: "device-a", installationId, userId: "user-a", workspaceId: "workspace-a" })).update?.status, "verifying");

  socket.close();
  await once(socket, "close");
  await presence.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test("keeps one resident per Key and computer while allowing a newer runtime to take over", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const device = {
    id: "device-a", serialNumber: "ONE-A", workspaceId: "workspace-a", userId: "user-a", status: "active",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: new Date().toISOString()
  };
  const store = { read: async () => ({ oneKeyDevices: [device] }), mutate: async () => undefined } as any;
  const presence = new OneKeyPresence(store);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");

  const authenticate = async (version: string, expectReady: boolean) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a&installationId=${installationId}`);
    const [authRaw] = await once(socket, "message");
    const auth = JSON.parse(authRaw.toString());
    const outcome = expectReady ? once(socket, "message") : once(socket, "close");
    socket.send(JSON.stringify({
      type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce),
      capabilities: ["runtime_update_v1"], platform: "macos", architecture: "arm64", launcherVersion: version, updateProtocol: 1
    }));
    const result = await outcome;
    if (expectReady) assert.equal(JSON.parse(result[0].toString()).type, "ready");
    else assert.equal(result[0], 4009);
    return socket;
  };

  const original = await authenticate("0.3.1", true);
  const duplicate = await authenticate("0.3.1", false);
  assert.equal(duplicate.readyState, WebSocket.CLOSED);
  assert.equal((await presence.runtimeStatus({ deviceId: "device-a", installationId, userId: "user-a", workspaceId: "workspace-a" })).runtime?.version, "0.3.1");

  const originalClosed = once(original, "close");
  const upgraded = await authenticate("0.3.2", true);
  assert.equal((await originalClosed)[0], 4009);
  assert.equal((await presence.runtimeStatus({ deviceId: "device-a", installationId, userId: "user-a", workspaceId: "workspace-a" })).runtime?.version, "0.3.2");

  upgraded.close();
  await once(upgraded, "close");
  await presence.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
