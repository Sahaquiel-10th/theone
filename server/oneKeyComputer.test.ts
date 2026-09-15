import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { OneKeyPresence } from "./oneKeyPresence.js";

test("Key on B never unlocks browser A; unplug, reinsert and reconnect preserve computer binding", async (t) => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const device = { id: "key", userId: "user", workspaceId: "space", status: "active", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const database = { oneKeyDevices: [device], auditLogs: [] };
  const presence = new OneKeyPresence({ read: async () => database, mutate: async (fn: any) => fn(database) } as any);
  const server = createServer();
  presence.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await presence.close(); await new Promise<void>(r => server.close(() => r())); });
  const port = (server.address() as { port: number }).port;
  const sign = (nonce: string) => crypto.sign(null, Buffer.from(nonce, "base64url"), pair.privateKey).toString("base64url");
  async function connect(id: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/one-key/launcher?deviceId=key&installationId=${id}`);
    sockets.push(socket);
    const [raw] = await once(socket, "message"); const challenge = JSON.parse(raw.toString());
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "auth_response", challengeId: challenge.challengeId, signature: sign(challenge.nonce) }));
    await ready;
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request_challenge") socket.send(JSON.stringify({ type: "proof_response", challengeId: message.challengeId, signature: sign(message.nonce) }));
    });
    return socket;
  }
  const a = "a".repeat(32), b = "b".repeat(32);
  const request = (installationId?: string) => presence.requireProof({ deviceId: "key", userId: "user", workspaceId: "space", installationId, method: "POST", path: "/api/chat" });
  await assert.rejects(request(), /更新/);
  const first = await connect(a);
  await request(a);
  first.close(); await once(first, "close");
  await assert.rejects(request(a), /插入/);
  await connect(b);
  await assert.rejects(request(a), /当前这台电脑/);
  await request(b);
  const resumed = await connect(a);
  await request(a);
  await assert.rejects(request(b), /当前这台电脑/);
  // Resume after sleep/network drop without issuing any new browser login.
  resumed.close(); await once(resumed, "close");
  await connect(a); await request(a);
  device.status = "revoked";
  await assert.rejects(request(a), /挂失/);
});

test("execution dispatch and pending local responses stay bound to the original computer socket", async t => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const a = "a".repeat(32), b = "b".repeat(32);
  const device = { id: "key", userId: "user", workspaceId: "space", status: "active", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const database = { oneKeyDevices: [device], auditLogs: [], executionTasks: [
    { id: "task-a", deviceId: "key", userId: "user", workspaceId: "space", installationId: a },
    { id: "task-b", deviceId: "key", userId: "user", workspaceId: "space", installationId: b },
    { id: "legacy", deviceId: "key", userId: "user", workspaceId: "space" }
  ] };
  const presence = new OneKeyPresence({ read: async () => database, mutate: async (fn: any) => fn(database) } as any);
  const server = createServer(); presence.attach(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await presence.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  async function connect(installationId: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/one-key/launcher?deviceId=key&installationId=${installationId}`);
    sockets.push(socket);
    const [raw] = await once(socket, "message"); const challenge = JSON.parse(raw.toString());
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "auth_response", challengeId: challenge.challengeId,
      signature: crypto.sign(null, Buffer.from(challenge.nonce, "base64url"), pair.privateKey).toString("base64url"), capabilities: ["local_tools_v1"] }));
    await ready; return socket;
  }
  const first = await connect(a);
  assert.equal(presence.isConnected("key", a), true);
  assert.equal(presence.isConnected("key", b), false);
  await assert.rejects(presence.startExecution("key", "legacy", "do not run"), /更新/);
  const waitingMessage = once(first, "message");
  const pending = presence.prepareLocalExecution("key", "task-a", a);
  const pendingResult = assert.rejects(pending, /连接已断开/);
  const [raw] = await waitingMessage; const original = JSON.parse(raw.toString());
  const second = await connect(b);
  await pendingResult;
  await assert.rejects(presence.startExecution("key", "task-a", "never forward to B", a), /原来的电脑/);
  await assert.rejects(presence.executeLocalTool("key", "task-a", "write_file", {}, b), /不属于/);
  const requestMessage = once(second, "message");
  const ownRequest = presence.executeLocalTool("key", "task-b", "read_file", { path: "test.txt" }, b);
  const [requestRaw] = await requestMessage; const request = JSON.parse(requestRaw.toString());
  second.send(JSON.stringify({ type: "tool_result", requestId: original.requestId, taskId: "task-a", ok: true, output: "wrong computer" }));
  second.send(JSON.stringify({ type: "tool_result", requestId: request.requestId, taskId: "task-b", ok: true, output: "B only" }));
  assert.equal((await ownRequest).output, "B only");
});
