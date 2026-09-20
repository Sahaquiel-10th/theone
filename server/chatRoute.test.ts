import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";

test("real chat HTTP route: Key gating, durable replay, attachment followup and restart isolation", { timeout: 25000 }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "one-chat-route-"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const timestamp = new Date().toISOString();
  const computerA = "a".repeat(32), computerB = "b".repeat(32);
  let modelCalls = 0;
  const inputs: string[] = [];
  const gateway = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    inputs.push(body); modelCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: `Fixture answer ${modelCalls}` } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const gatewayPort = (gateway.address() as { port: number }).port;
  const model = { id: "model", name: "Fixture", provider: "gateway", kind: "chat", protocol: "openai", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, apiKey: "fixture-only-not-a-provider-key", model: "fixture", systemPrompt: "", enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: timestamp };
  const users = ["a", "b"].map(id => ({ id, username: `fixture-${id}`, passwordHash: "unused", role: "user", defaultWorkspaceId: `space-${id}`, enabled: true, createdAt: timestamp }));
  await fs.writeFile(path.join(directory, "db.json"), JSON.stringify({
    users, workspaces: users.map(user => ({ id: user.defaultWorkspaceId, name: user.id, slug: user.id, status: "active", createdAt: timestamp, updatedAt: timestamp })),
    workspaceMembers: users.map(user => ({ id: `member-${user.id}`, userId: user.id, workspaceId: user.defaultWorkspaceId, role: "owner", createdAt: timestamp })),
    models: [model], oneKeyDevices: ["a", "b"].map(userId => ({ id: userId === "a" ? "key" : "key-b", serialNumber: `fixture-key-${userId}`, workspaceId: `space-${userId}`, userId, status: "active", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: timestamp })),
    conversations: [], messages: [], attachments: [], settings: { safetyRules: "Fixture safety", rechargeCnyPerPower: 7 }
  }));
  let app: ChildProcess | undefined;
  const sockets: WebSocket[] = [];
  async function stop() {
    for (const socket of sockets.splice(0)) socket.terminate();
    if (app && app.exitCode === null && app.signalCode === null) { const exited = once(app, "exit"); app.kill("SIGTERM"); await exited; }
  }
  t.after(async () => { await stop(); gateway.closeAllConnections(); await new Promise<void>(r => gateway.close(() => r())); await fs.rm(directory, { recursive: true, force: true }); });
  async function start() {
    app = spawn(process.execPath, ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "server/index.ts")], {
      cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: "test", DB_PROVIDER: "json", ONE_DATA_DIR: directory,
        UPLOAD_DIR: path.join(directory, "uploads"), JWT_SECRET: "fixture-session-signing-secret-not-production", PROVIDER_CREDENTIALS_KEY: "fixture-credential-encryption-secret-not-production", PORT: "0", HOST: "127.0.0.1", MODEL_REQUEST_TIMEOUT_MS: "2000" }, stdio: ["ignore", "pipe", "pipe"]
    });
    return await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Isolated fixture server startup timed out")), 8000);
      app!.stdout!.on("data", chunk => { output += String(chunk); const match = output.match(/ONE API listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
      app!.once("exit", () => { clearTimeout(timeout); reject(new Error("Isolated fixture server exited")); });
    });
  }
  let base = await start();
  const signature = (nonce: string) => crypto.sign(null, Buffer.from(nonce, "base64url"), pair.privateKey).toString("base64url");
  async function connect(computer: string, keyId = "key") {
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/one-key/launcher?deviceId=${keyId}&installationId=${computer}`);
    sockets.push(socket);
    const [raw] = await once(socket, "message"); const auth = JSON.parse(raw.toString());
    const ready = once(socket, "message"); socket.send(JSON.stringify({ type: "auth_response", challengeId: auth.challengeId, signature: signature(auth.nonce) })); await ready;
    socket.on("message", raw => { const challenge = JSON.parse(raw.toString()); if (challenge.type === "request_challenge") socket.send(JSON.stringify({ type: "proof_response", challengeId: challenge.challengeId, signature: signature(challenge.nonce) })); });
    return socket;
  }
  const post = (endpoint: string, body: unknown, cookie = "") => fetch(`${base}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const get = (endpoint: string, cookie: string) => fetch(`${base}${endpoint}`, { headers: { Cookie: cookie } });
  async function login(computer: string, keyId = "key") {
    const challenge = await (await post("/api/one-key/challenge", { deviceId: keyId, installationId: computer })).json() as any;
    const verified = await (await post(`/api/one-key/challenge/${challenge.challengeId}/verify`, { signature: signature(challenge.nonce) })).json() as any;
    const response = await post("/api/auth/one-key/redeem", { loginCode: verified.loginCode });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  const socketA = await connect(computerA), cookie = await login(computerA);
  const fileBody = "PRIVATE_FIXTURE_DOCUMENT";
  const upload = await post("/api/attachments/uploads", { filename: "fixture.txt", size: fileBody.length, mimeType: "text/plain" }, cookie);
  assert.equal(upload.status, 200);
  const attachmentId = ((await upload.json()) as any).attachment.id;
  await connect(computerB, "key-b");
  const otherCookie = await login(computerB, "key-b");
  for (const [suffix, method] of [["", "GET"], ["/content", "GET"], ["/complete", "POST"], ["/retry", "POST"], ["", "DELETE"], ["/chunks?offset=0", "PUT"]]) {
    const response = await fetch(`${base}/api/attachments/${attachmentId}${suffix}`, { method, headers: { Cookie: otherCookie, "Content-Type": "application/octet-stream" }, ...(method === "PUT" ? { body: "bad" } : {}) });
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /fixture\.txt|storagePath|PRIVATE_FIXTURE_DOCUMENT/);
  }
  assert.equal((await fetch(`${base}/api/attachments/${attachmentId}/chunks?offset=0`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body: fileBody })).status, 200);
  assert.equal((await post(`/api/attachments/${attachmentId}/complete`, {}, cookie)).status, 200);
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await (await get(`/api/attachments/${attachmentId}`, cookie)).json() as any;
    assert.notEqual(state.attachment.status, "failed", state.attachment.parseError);
    if (state.attachment.status === "ready") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const input = { operationId: crypto.randomUUID(), content: "Summarize the attachment", modelId: "model", attachmentIds: [attachmentId], webSearch: false };
  const first = await post("/api/chat", input, cookie); assert.equal(first.status, 200);
  const answer = await first.json() as any;
  assert.equal(answer.conversation.messages.length, 2);
  assert.equal(modelCalls, 1); assert.match(inputs[0], /PRIVATE_FIXTURE_DOCUMENT/);
  const duplicate = await post("/api/chat", input, cookie); assert.equal(duplicate.status, 200); assert.equal(modelCalls, 1);
  assert.equal(((await duplicate.json()) as any).message.id, answer.message.id);
  socketA.close(); await once(socketA, "close");
  assert.equal((await post("/api/chat", input, cookie)).status, 428); assert.equal(modelCalls, 1);
  await connect(computerB);
  assert.equal((await post("/api/chat", input, cookie)).status, 428); assert.equal(modelCalls, 1);
  await connect(computerA);
  assert.equal((await post("/api/chat", input, cookie)).status, 200); assert.equal(modelCalls, 1);
  const followup = await post("/api/chat", { ...input, operationId: crypto.randomUUID(), conversationId: answer.conversation.id, content: "Explain that file again", attachmentIds: [] }, cookie);
  assert.equal(followup.status, 200); assert.equal(modelCalls, 2); assert.match(inputs[1], /PRIVATE_FIXTURE_DOCUMENT/);
  const billing = await (await get("/api/me/billing", cookie)).json() as any;
  assert.equal(billing.usage.length, 2); assert.equal(billing.ledger.filter((row: any) => row.type === "usage").length, 2);
  const stale = await fetch(`${base}/api/conversations`, { headers: { Cookie: cookie, "X-ONE-User": "b" } });
  assert.equal(stale.status, 409);
  await stop(); base = await start(); await connect(computerA);
  const restored = await (await get(`/api/conversations/${answer.conversation.id}`, cookie)).json() as any;
  assert.equal(restored.conversation.messages[0].attachments[0].id, attachmentId);
  assert.equal(restored.conversation.messages[1].knowledgeDiagnostics.status, "not_connected");
  const replay = await get(`/api/chat/operations/${input.operationId}`, cookie); assert.equal(replay.status, 200); assert.equal(modelCalls, 2);
  const missing = await get(`/api/chat/operations/${crypto.randomUUID()}`, cookie); assert.equal(missing.status, 404);
  const longText = "Long document section. ".repeat(1600) + " TAIL_OF_FULL_DOCUMENT";
  const longUpload = await post("/api/attachments/uploads", { filename: "long.txt", size: longText.length, mimeType: "text/plain" }, cookie);
  const longId = ((await longUpload.json()) as any).attachment.id;
  await fetch(`${base}/api/attachments/${longId}/chunks?offset=0`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/octet-stream" }, body: longText });
  await post(`/api/attachments/${longId}/complete`, {}, cookie);
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await (await get(`/api/attachments/${longId}`, cookie)).json() as any;
    if (state.attachment.status === "ready") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const longOperation = crypto.randomUUID();
  const longResponse = await post("/api/chat", { ...input, operationId: longOperation, content: "总结全文", attachmentIds: [longId] }, cookie);
  assert.equal(longResponse.status, 202);
  let done: Response | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    done = await get(`/api/chat/operations/${longOperation}`, cookie);
    if (done.status === 200) break;
    assert.equal(((await done.json()) as any).code, "CHAT_OPERATION_PENDING");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(done?.status, 200);
  assert.ok(inputs.slice(2).some(text => text.includes("TAIL_OF_FULL_DOCUMENT")));
  const longBilling = await (await get("/api/me/billing", cookie)).json() as any;
  assert.ok(longBilling.usage.some((row: any) => row.activity === "attachment_summary"));
  const callCount = modelCalls;
  await get(`/api/chat/operations/${longOperation}`, cookie);
  assert.equal(modelCalls, callCount);
});
