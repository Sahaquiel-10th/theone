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
