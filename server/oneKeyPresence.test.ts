import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { OneKeyPresence } from "./oneKeyPresence.js";

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

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce) }));
  const [readyRaw] = await once(socket, "message");
  assert.equal(JSON.parse(readyRaw.toString()).type, "ready");

  const proof = presence.requireProof({ deviceId: device.id, userId: device.userId, workspaceId: device.workspaceId, method: "POST", path: "/api/chat" });
  const [proofRaw] = await once(socket, "message");
  const challenge = JSON.parse(proofRaw.toString());
  socket.send(JSON.stringify({ type: "proof_response", challengeId: challenge.challengeId, signature: sign(pair.privateKey, challenge.nonce) }));
  await proof;

  await assert.rejects(
    () => presence.requireProof({ deviceId: device.id, userId: device.userId, workspaceId: "workspace-b", method: "POST", path: "/api/chat" }),
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
      { id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", sourceMessageId: "message-a", provider: "codex", status: "queued", instruction: "safe", deviceId: "device-a", createdAt: timestamp, updatedAt: timestamp },
      { id: "task-b", workspaceId: "workspace-b", userId: "user-b", conversationId: "conversation-b", sourceMessageId: "message-b", provider: "codex", status: "queued", instruction: "foreign", deviceId: "device-a", createdAt: timestamp, updatedAt: timestamp }
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

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce) }));
  await once(socket, "message");

  const startMessage = once(socket, "message");
  await presence.startExecution("device-a", "task-a", "safe");
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
  const store = { read: async () => ({ oneKeyDevices: [device] }) } as any;
  const presence = new OneKeyPresence(store);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=device-a`);
  const [authRaw] = await once(socket, "message");
  const auth = JSON.parse(authRaw.toString());
  socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: sign(pair.privateKey, auth.nonce), capabilities: ["local_tools_v1"] }));
  await once(socket, "message");
  assert.equal(presence.supportsLocalAgent("device-a"), true);

  const preparing = presence.prepareLocalExecution("device-a", "task-a");
  const [prepareRaw] = await once(socket, "message");
  const prepare = JSON.parse(prepareRaw.toString());
  assert.equal(prepare.type, "local_prepare");
  socket.send(JSON.stringify({ type: "local_ready", taskId: "task-a", requestId: prepare.requestId, targetName: "project-a" }));
  assert.deepEqual(await preparing, { targetName: "project-a", output: "" });

  const running = presence.executeLocalTool("device-a", "task-a", "read_file", { path: "README.md" });
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
