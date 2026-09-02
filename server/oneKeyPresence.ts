import crypto from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Store } from "./db.js";
import { uid } from "./security.js";
import { appendExecutionEvent } from "./executionService.js";

const proofTimeoutMs = 5000;
const authTimeoutMs = 5000;

type PendingProof = {
  deviceId: string;
  nonce: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type SocketState = {
  deviceId: string;
  authenticated: boolean;
  authChallengeId: string;
  authNonce: string;
  authTimeout: NodeJS.Timeout;
  alive: boolean;
};

function verifySignature(publicKey: string, nonce: string, signature: string) {
  try {
    return crypto.verify(null, Buffer.from(nonce, "base64url"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export class OneKeyPresenceError extends Error {
  readonly code = "ONE_KEY_REQUIRED";
}

export class OneKeyPresence {
  private sockets = new Map<string, WebSocket>();
  private states = new WeakMap<WebSocket, SocketState>();
  private pending = new Map<string, PendingProof>();
  private wss?: WebSocketServer;
  private pingTimer?: NodeJS.Timeout;

  constructor(private store: Store) {}

  attach(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/api/one-key/launcher" });
    this.wss.on("connection", (socket, request) => void this.accept(socket, request.url || ""));
    this.pingTimer = setInterval(() => {
      for (const socket of this.wss?.clients ?? []) {
        const state = this.states.get(socket);
        if (!state) continue;
        if (!state.alive) { socket.terminate(); continue; }
        state.alive = false;
        socket.ping();
      }
    }, 45_000);
    this.pingTimer.unref();
  }

  async requireProof(params: { deviceId: string; userId: string; workspaceId: string; method: string; path: string }) {
    const db = await this.store.read();
    const device = db.oneKeyDevices.find((item) => item.id === params.deviceId && item.status === "active");
    if (!device || device.userId !== params.userId || device.workspaceId !== params.workspaceId) {
      throw new OneKeyPresenceError("ONE Key 已挂失或不属于当前账号");
    }
    const socket = this.sockets.get(device.id);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new OneKeyPresenceError("请插入 ONE Key 并双击 ONE 图标");

    const challengeId = uid("prf");
    const nonce = crypto.randomBytes(32).toString("base64url");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(challengeId);
        reject(new OneKeyPresenceError("ONE Key 未响应，请确认 U 盘仍然插着"));
      }, proofTimeoutMs);
      this.pending.set(challengeId, { deviceId: device.id, nonce, resolve, reject, timeout });
      socket.send(JSON.stringify({ type: "request_challenge", challengeId, nonce, method: params.method, path: params.path }), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(challengeId);
        reject(new OneKeyPresenceError("ONE Key 连接已断开"));
      });
    });
  }

  isConnected(deviceId: string) {
    const socket = this.sockets.get(deviceId);
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }

  async startExecution(deviceId: string, taskId: string, instruction: string) {
    await this.sendToDevice(deviceId, { type: "execution_start", taskId, instruction });
  }

  async continueExecution(deviceId: string, taskId: string, instruction: string) {
    await this.sendToDevice(deviceId, { type: "execution_continue", taskId, instruction });
  }

  async cancelExecution(deviceId: string, taskId: string) {
    await this.sendToDevice(deviceId, { type: "execution_cancel", taskId });
  }

  async close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const proof of this.pending.values()) { clearTimeout(proof.timeout); proof.reject(new Error("服务已关闭")); }
    this.pending.clear();
    await new Promise<void>((resolve) => this.wss ? this.wss.close(() => resolve()) : resolve());
  }

  private async accept(socket: WebSocket, rawUrl: string) {
    const deviceId = new URL(rawUrl, "http://localhost").searchParams.get("deviceId")?.trim() || "";
    const db = await this.store.read();
    const device = db.oneKeyDevices.find((item) => item.id === deviceId && item.status === "active");
    if (!device) { socket.close(4003, "ONE Key unavailable"); return; }

    const authChallengeId = uid("wsa");
    const authNonce = crypto.randomBytes(32).toString("base64url");
    const state: SocketState = {
      deviceId,
      authenticated: false,
      authChallengeId,
      authNonce,
      alive: true,
      authTimeout: setTimeout(() => socket.close(4008, "Authentication timeout"), authTimeoutMs)
    };
    this.states.set(socket, state);
    socket.on("pong", () => { state.alive = true; });
    socket.on("message", (data) => void this.message(socket, data.toString()));
    socket.on("close", () => this.remove(socket));
    socket.on("error", () => this.remove(socket));
    socket.send(JSON.stringify({ type: "auth_challenge", challengeId: authChallengeId, nonce: authNonce }));
  }

  private async message(socket: WebSocket, raw: string) {
    const state = this.states.get(socket);
    if (!state) return;
    let message: {
      type?: string; challengeId?: string; signature?: string; taskId?: string;
      kind?: string; text?: string; providerThreadId?: string; targetName?: string; status?: string;
    };
    try { message = JSON.parse(raw); } catch { socket.close(4000, "Invalid message"); return; }
    if (message.type === "auth_response" && !state.authenticated && message.challengeId === state.authChallengeId && message.signature) {
      const db = await this.store.read();
      const device = db.oneKeyDevices.find((item) => item.id === state.deviceId && item.status === "active");
      if (!device || !verifySignature(device.publicKey, state.authNonce, message.signature)) { socket.close(4003, "Invalid signature"); return; }
      clearTimeout(state.authTimeout);
      state.authenticated = true;
      const previous = this.sockets.get(state.deviceId);
      if (previous && previous !== socket) {
        previous.close(4009, "Another copy connected");
        await this.store.mutate((mutable) => mutable.auditLogs.push({
          id: uid("aud"), workspaceId: device.workspaceId, actorUserId: device.userId,
          action: "one_key.concurrent_connection", targetType: "one_key_device", targetId: device.id,
          details: { serialNumber: device.serialNumber }, createdAt: new Date().toISOString()
        }));
      }
      this.sockets.set(state.deviceId, socket);
      socket.send(JSON.stringify({ type: "ready", deviceId: state.deviceId }));
      return;
    }
    if (message.type === "proof_response" && state.authenticated && message.challengeId && message.signature) {
      const proof = this.pending.get(message.challengeId);
      if (!proof || proof.deviceId !== state.deviceId) return;
      this.pending.delete(message.challengeId);
      clearTimeout(proof.timeout);
      const db = await this.store.read();
      const device = db.oneKeyDevices.find((item) => item.id === state.deviceId && item.status === "active");
      if (!device || !verifySignature(device.publicKey, proof.nonce, message.signature)) proof.reject(new OneKeyPresenceError("ONE Key 请求签名无效"));
      else proof.resolve();
      return;
    }
    if (message.type === "execution_event" && state.authenticated && message.taskId && message.kind) {
      await this.executionEvent(state.deviceId, { taskId: message.taskId, kind: message.kind, text: message.text, providerThreadId: message.providerThreadId, targetName: message.targetName, status: message.status });
    }
  }

  private async sendToDevice(deviceId: string, payload: Record<string, unknown>) {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new OneKeyPresenceError("本机执行未连接，请插入 ONE Key 并双击 ONE 图标");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(payload), (error) => error ? reject(new OneKeyPresenceError("本机执行连接已断开")) : resolve()));
  }

  private async executionEvent(deviceId: string, message: {
    taskId: string; kind: string; text?: string; providerThreadId?: string; targetName?: string; status?: string;
  }) {
    const allowedKinds = new Set(["status", "message", "command", "file_change", "error"]);
    const kind = allowedKinds.has(message.kind) ? message.kind as "status" | "message" | "command" | "file_change" | "error" : "status";
    const text = typeof message.text === "string" ? message.text.trim().slice(0, 20_000) : "";
    await this.store.mutate((database) => {
      const device = database.oneKeyDevices.find((item) => item.id === deviceId && item.status === "active");
      const task = database.executionTasks.find((item) => item.id === message.taskId && item.deviceId === deviceId);
      if (!device || !task || task.workspaceId !== device.workspaceId || task.userId !== device.userId) return;
      const timestamp = new Date().toISOString();
      if (message.providerThreadId) task.providerThreadId = message.providerThreadId.slice(0, 200);
      if (message.targetName) task.targetName = message.targetName.slice(0, 200);
      if (message.status === "selecting_target") task.status = "selecting_target";
      if (message.status === "running") { task.status = "running"; task.startedAt ??= timestamp; task.lastError = undefined; }
      if (message.status === "completed") { task.status = "completed"; task.completedAt = timestamp; if (text) task.finalResponse = text; }
      if (message.status === "failed") { task.status = "failed"; task.completedAt = timestamp; task.lastError = text || "Codex 执行失败"; }
      if (message.status === "cancelled") { task.status = "cancelled"; task.completedAt = timestamp; }
      task.updatedAt = timestamp;
      if (text) appendExecutionEvent(database, { id: uid("exe"), workspaceId: task.workspaceId, userId: task.userId, taskId: task.id, kind, text, createdAt: timestamp });
    });
  }

  private remove(socket: WebSocket) {
    const state = this.states.get(socket);
    if (!state) return;
    clearTimeout(state.authTimeout);
    if (this.sockets.get(state.deviceId) === socket) this.sockets.delete(state.deviceId);
    for (const [id, proof] of this.pending) if (proof.deviceId === state.deviceId) {
      clearTimeout(proof.timeout); this.pending.delete(id); proof.reject(new OneKeyPresenceError("ONE Key 连接已断开"));
    }
  }
}
