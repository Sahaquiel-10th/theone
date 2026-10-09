import crypto from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Store } from "./db.js";
import { uid } from "./security.js";
import type { CodexGatewayConfiguration } from "./codexGateway.js";
import type { ExecutionTask } from "./types.js";
import { appendExecutionEvent, executionTerminal, saveExecutionReceipt } from "./executionService.js";
import { validInstallationId } from "./oneKeyInstallation.js";
import { compareRuntimeVersions, validRuntimeVersion, type RuntimeArchitecture, type RuntimeIdentity, type RuntimePlatform, type SignedRuntimeUpdate } from "./runtimeUpdate.js";
import { recoverRuntimeUpdate, disconnectedRuntimeUpdate, confirmedRuntimeUpdate, runtimeRecoveryReceipt, type UpdateOwner } from './runtimeUpdateRecovery.js';

const proofTimeoutMs = 2000;
const authTimeoutMs = 5000;
const updateHeartbeatGraceMs = 30 * 60 * 1000;

type PendingProof = {
  deviceId: string;
  socket: WebSocket;
  nonce: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type PendingLocalRequest = {
  deviceId: string;
  socket: WebSocket;
  taskId: string;
  configuration?: boolean;
  change?: boolean;
  preparationPhase?: string;
  workspaceId?: string;
  userId?: string;
  resolve: (value: { targetName?: string; output?: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type RuntimeUpdateProgress = {
  requestId: string;
  status: "requested" | "downloading" | "verifying" | "installing" | "completed" | "failed";
  version: string;
  message?: string;
  updatedAt: string;
  recoveryRequired?: boolean;
};

export type LocalToolName = "list_files" | "read_file" | "search_text" | "write_file" | "replace_in_file" | "run_command";

type SocketState = {
  deviceId: string;
  installationId: string;
  authenticated: boolean;
  authChallengeId: string;
  authNonce: string;
  authTimeout: NodeJS.Timeout;
  alive: boolean;
  capabilities: Set<string>;
  runtime?: RuntimeIdentity;
  update?: RuntimeUpdateProgress;
  updateStartedAt?: number;
  updateLoaded?: boolean;
  executorPreparationError?: string;
};

function verifySignature(publicKey: string, nonce: string, signature: string) {
  try {
    return crypto.verify(null, Buffer.from(nonce, "base64url"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export class OneKeyPresenceError extends Error {
  constructor(message: string, readonly code = "ONE_KEY_REQUIRED") { super(message); }
}

export class OneKeyPresence {
  private sockets = new Map<string, WebSocket>();
  private states = new WeakMap<WebSocket, SocketState>();
  private pending = new Map<string, PendingProof>();
  private pendingLocal = new Map<string, PendingLocalRequest>();
  private wss?: WebSocketServer;
  private pingTimer?: NodeJS.Timeout;

  constructor(private store: Store) {}

  private codexGateway?: (task: ExecutionTask) => Promise<CodexGatewayConfiguration>;
  configureCodexGateway(prepare: (task: ExecutionTask) => Promise<CodexGatewayConfiguration>) { this.codexGateway = prepare; }

  private async gatewayConfiguration(taskId: string, deviceId: string, installationId?: string) {
    if (!this.codexGateway) return undefined;
    const socket = await this.executionSocket(deviceId, taskId, installationId);
    if (!this.states.get(socket)?.capabilities.has("codex_gateway_v1")) throw new Error("请升级 ONE 启动器后使用统一执行接口；不会切换到个人 Codex 账号");
    const task = (await this.store.read()).executionTasks.find(t => t.id === taskId && t.deviceId === deviceId && t.installationId === installationId);
    if (!task) throw new Error("执行任务不存在");
    return this.codexGateway(task);
  }

  private updateInProgress(state?: SocketState) {
    return Boolean(state?.update && !state.update.recoveryRequired && !["completed", "failed"].includes(state.update.status)
      && Date.now() - (state.updateStartedAt ?? 0) < updateHeartbeatGraceMs);
  }

  private preserveUpdateTransport(state?: SocketState) {
    return this.updateInProgress(state) || Boolean(state?.update?.status === 'completed'
      && !state.update.recoveryRequired && Date.now() - Date.parse(state.update.updatedAt) < 30_000);
  }

  attach(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/api/one-key/launcher" });
    this.wss.on("connection", (socket, request) => void this.accept(socket, request.url || ""));
    this.pingTimer = setInterval(() => {
      for (const socket of this.wss?.clients ?? []) {
        const state = this.states.get(socket);
        if (!state) continue;
        const updateInProgress = this.preserveUpdateTransport(state);
        // Some launchers install synchronously and cannot consume WebSocket pong frames
        // while replacing themselves. Keep only an explicitly requested update alive for
        // a bounded window; ordinary unplug detection still uses the normal heartbeat.
        if (!state.alive && !updateInProgress) { socket.terminate(); continue; }
        state.alive = false;
        socket.ping();
      }
    }, 45_000);
    this.pingTimer.unref();
  }

  async requireProof(params: { deviceId: string; installationId?: string; userId: string; workspaceId: string; method: string; path: string }) {
    if (!validInstallationId(params.installationId)) throw new OneKeyPresenceError("请更新 ONE Key 启动器，再从 U 盘双击 ONE 图标登录", "ONE_KEY_UPGRADE_REQUIRED");
    const db = await this.store.read();
    const device = db.oneKeyDevices.find((item) => item.id === params.deviceId && item.status === "active");
    if (!device || device.userId !== params.userId || device.workspaceId !== params.workspaceId) {
      throw new OneKeyPresenceError("ONE Key 已挂失或不属于当前账号");
    }
    const socket = this.sockets.get(device.id);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new OneKeyPresenceError("请插入 ONE Key");
    if (this.states.get(socket)?.installationId !== params.installationId) throw new OneKeyPresenceError("请将 ONE Key 插入当前这台电脑");

    const challengeId = uid("prf");
    const nonce = crypto.randomBytes(32).toString("base64url");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(challengeId);
        // A half-open socket after sleep must not block its replacement until
        // the next 45-second heartbeat. Never accept the request without proof.
        // Still reject the protected request. Do not destroy an install just
        // because an older synchronous launcher cannot sign during replacement.
        if (!this.preserveUpdateTransport(this.states.get(socket))) {
          this.remove(socket);
          socket.terminate();
        }
        reject(new OneKeyPresenceError("ONE Key 未响应，请确认 U 盘仍然插着"));
      }, proofTimeoutMs);
      this.pending.set(challengeId, { deviceId: device.id, socket, nonce, resolve, reject, timeout });
      socket.send(JSON.stringify({ type: "request_challenge", challengeId, nonce, method: params.method, path: params.path }), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(challengeId);
        reject(new OneKeyPresenceError("ONE Key 连接已断开"));
      });
    });
  }

  isConnected(deviceId: string, installationId?: string) {
    const socket = this.sockets.get(deviceId);
    const state = socket ? this.states.get(socket) : undefined;
    return Boolean(validInstallationId(installationId) && socket && socket.readyState === WebSocket.OPEN && state?.authenticated && state.installationId === installationId);
  }

  supportsLocalAgent(deviceId: string, installationId?: string) {
    const socket = this.sockets.get(deviceId);
    const state = socket ? this.states.get(socket) : undefined;
    return Boolean(this.isConnected(deviceId, installationId) && state?.capabilities.has("local_tools_v1"));
  }

  supportsCodex(deviceId: string, installationId?: string) {
    const socket = this.sockets.get(deviceId), state = socket ? this.states.get(socket) : undefined;
    return Boolean(this.isConnected(deviceId, installationId) && state && (state.capabilities.has("codex_exec_v1") || !state.capabilities.has("local_tools_v1")));
  }

  async runtimeStatus(params: { deviceId: string; installationId?: string; userId: string; workspaceId: string }): Promise<{ runtime?: RuntimeIdentity; update?: RuntimeUpdateProgress; confirmation?: { requestId: string; version: string }; connectionState: 'connected' | 'reconnecting' }> {
    // Metadata only: a short hand-off has no socket. Return this computer's
    // journal as unconfirmed, never as proof of Key presence or completion.
    if (!this.isConnected(params.deviceId, params.installationId)) {
      if (!validInstallationId(params.installationId)) throw new OneKeyPresenceError('请更新 ONE Key 启动器');
      const db = await this.store.read();
      const device = db.oneKeyDevices.find(item => item.id === params.deviceId && item.status === 'active'
        && item.userId === params.userId && item.workspaceId === params.workspaceId);
      if (!device) throw new OneKeyPresenceError('ONE Key 已挂失或不属于当前账号');
      const saved = disconnectedRuntimeUpdate(db.auditLogs ?? [], params);
      if (saved) return { ...saved, confirmation: undefined, connectionState: 'reconnecting' as const };
      throw new OneKeyPresenceError('请将 ONE Key 插入当前这台电脑');
    }
    const socket = await this.ownedSocket(params);
    const state = this.states.get(socket)!;
    await this.restoreUpdate(state, params);
    if (this.sockets.get(params.deviceId) !== socket || !state.authenticated) throw new OneKeyPresenceError('ONE 更新连接已变更，请检查状态');
    if (state.update && !["failed", "completed"].includes(state.update.status) && !this.updateInProgress(state)) {
      state.update = { ...state.update, recoveryRequired: true };
    }
    const db = await this.store.read();
    if (this.sockets.get(params.deviceId) !== socket || !state.authenticated) throw new OneKeyPresenceError('ONE 更新连接已变更');
    return { runtime: state.runtime, update: state.update, confirmation: state.runtime ? confirmedRuntimeUpdate(db.auditLogs ?? [], params, state.runtime) : undefined, connectionState: 'connected' as const };
  }

  async requestRuntimeUpdate(params: { deviceId: string; installationId?: string; userId: string; workspaceId: string; version: string; envelope: SignedRuntimeUpdate }) {
    const socket = await this.ownedSocket(params);
    if ([...this.pendingLocal.values()].some(p => p.socket === socket && p.configuration && p.change)) throw new OneKeyPresenceError('正在更换目录或准备工具，请完成后再更新 ONE');
    const state = this.states.get(socket)!;
    await this.restoreUpdate(state, params);
    if (this.sockets.get(params.deviceId) !== socket || !state.authenticated) throw new OneKeyPresenceError('ONE 更新连接已变更，请检查状态');
    if (!state.runtime || state.runtime.updateProtocol !== 1 || !state.capabilities.has("runtime_update_v1")) throw new OneKeyPresenceError("当前 ONE 启动器不支持在线更新", "ONE_RUNTIME_UPDATE_UNSUPPORTED");
    if (state.update && state.update.status !== 'failed'
      && !(state.update.status === 'completed' && compareRuntimeVersions(params.version, state.update.version) > 0)) return state.update;
    const requestId = uid("upd");
    state.updateStartedAt = Date.now();
    state.update = { requestId, status: "requested", version: params.version, updatedAt: new Date().toISOString() };
    try {
      // Commit before dispatch: losing the socket/server must not forget a write.
      await this.checkpointUpdate(state);
      if (this.sockets.get(params.deviceId) !== socket || !state.authenticated) throw new OneKeyPresenceError('ONE 更新连接已变更');
      await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({ type: "update_install", requestId, envelope: params.envelope }), error => error ? reject(new OneKeyPresenceError("ONE 更新连接已断开")) : resolve()));
    } catch (error) {
      state.update = { ...state.update, recoveryRequired: true, message: "更新指令状态未确认，请检查连接" };
      throw error;
    }
    return state.update;
  }

  private async restoreUpdate(state: SocketState, owner: UpdateOwner) {
    if (state.updateLoaded || state.update || !state.runtime) return;
    const db = await this.store.read();
    if (!state.update) state.update = recoverRuntimeUpdate(db.auditLogs ?? [], owner, state.runtime);
    state.updateLoaded = true;
  }

  private async checkpointUpdate(state: SocketState) {
    const progress = state.update;
    if (!progress || !state.runtime) return;
    const platform = state.runtime.platform;
    await this.store.mutate(db => {
      const device = db.oneKeyDevices.find(item => item.id === state.deviceId && item.status === 'active');
      if (!device) throw new OneKeyPresenceError('ONE Key 已挂失');
      db.auditLogs.push({ id: uid('aud'), workspaceId: device.workspaceId, actorUserId: device.userId,
        action: 'one_runtime.update.checkpoint', targetType: 'one_key_device', targetId: device.id,
        requestId: progress.requestId, createdAt: progress.updatedAt,
        details: { installationId: state.installationId, platform, architecture: state.runtime!.architecture, fromVersion: state.runtime!.version, version: progress.version,
          status: progress.status, startedAt: state.updateStartedAt } });
    });
  }

  async prepareLocalExecution(deviceId: string, taskId: string, installationId?: string) {
    const requestId = uid("loc");
    return this.localRequest(deviceId, taskId, requestId, { type: "local_prepare", taskId, requestId }, 120_000, installationId);
  }

  async localConfiguration(scope: { deviceId: string; installationId?: string; workspaceId: string; userId: string }, change: boolean) {
    await this.requireProof({ ...scope, method: change ? "POST" : "GET", path: "/api/me/local-device" });
    const socket = this.sockets.get(scope.deviceId), state = socket && this.states.get(socket);
    if (!socket || !state?.authenticated || state.installationId !== scope.installationId || !state.capabilities.has("local_configuration_v1")) throw new OneKeyPresenceError("此启动器尚不支持目录设置，请先升级 ONE");
    const db = await this.store.read();
    if (change && db.executionTasks.some(t => t.deviceId === scope.deviceId && t.installationId === scope.installationId && !executionTerminal(t.status))) throw new OneKeyPresenceError("本机还有任务在执行，请停止或等结束后更换目录");
    if (change && [...this.pendingLocal.values()].some(p => p.socket === socket && p.configuration && p.change)) throw new OneKeyPresenceError('本机正在设置或准备工具，请完成后再更换目录');
    const requestId = uid("cfg");
    return new Promise<{ targetName?: string; output?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingLocal.delete(requestId); reject(new OneKeyPresenceError("本机目录设置未返回，请检查电脑上的选择窗口")); }, 120_000);
      this.pendingLocal.set(requestId, { deviceId: scope.deviceId, socket, taskId: "device_settings", configuration: true, change, workspaceId: scope.workspaceId, userId: scope.userId, resolve, reject, timeout });
      socket.send(JSON.stringify({ type: "local_configuration", taskId: "device_settings", requestId, change }), error => {
        if (!error) return;
        clearTimeout(timeout); this.pendingLocal.delete(requestId); reject(new OneKeyPresenceError("本机连接已断开"));
      });
    });
  }

  async managedExecutor(scope: { deviceId: string; installationId?: string; workspaceId: string; userId: string },
    catalog: (runtime: RuntimeIdentity) => { envelope: SignedRuntimeUpdate; version: string; size: number } | undefined, install = false) {
    await this.requireProof({ ...scope, method: install ? 'POST' : 'GET', path: '/api/me/executor' });
    const socket = await this.ownedSocket(scope), state = this.states.get(socket)!;
    if (!state.runtime || state.runtime.platform !== 'macos' || !state.capabilities.has('managed_codex_v1')) {
      if (install) throw new OneKeyPresenceError('请先升级 ONE 启动器，当前版本不支持一键准备执行工具');
      return { available: false, message: '当前启动器尚不支持一键准备；现有文件工具仍可用' };
    }
    const release = catalog(state.runtime);
    if (!release) {
      if (install) throw new Error('执行工具尚未发布，请稍后再试');
      return { available: false, message: '执行工具正在准备发布；现有文件工具仍可用' };
    }
    const pending = [...this.pendingLocal.values()].find(p => p.socket === socket && p.configuration && p.change);
    if (pending) {
      if (install) throw new OneKeyPresenceError('正在准备工具或更换工作目录，请完成后再试');
      return { available: true, preparing: true, phase: pending.preparationPhase, version: release.version, size: release.size };
    }
    const db = await this.store.read();
    if (install && (this.updateInProgress(state) || db.executionTasks.some(t => t.deviceId === scope.deviceId && t.installationId === scope.installationId && !executionTerminal(t.status))))
      throw new OneKeyPresenceError('本机正在执行任务或更新 ONE，请完成后再准备工具');
    if (install && [...this.pendingLocal.values()].some(p => p.socket === socket && p.configuration && p.change))
      throw new OneKeyPresenceError('正在准备工具或更换工作目录，请完成后再试');
    if (this.sockets.get(scope.deviceId) !== socket || !state.authenticated) throw new OneKeyPresenceError('本机连接已变更，请重新检查');
    const requestId = uid('prep');
    if (install) state.executorPreparationError = undefined;
    const response = new Promise<{ targetName?: string; output?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingLocal.delete(requestId); reject(new OneKeyPresenceError('工具准备尚未返回；请重新检查状态，不会自动执行任务')); }, install ? 540_000 : 60_000);
      this.pendingLocal.set(requestId, { deviceId: scope.deviceId, socket, taskId: 'device_settings', configuration: true, change: install, preparationPhase: install ? 'checking' : undefined, workspaceId: scope.workspaceId, userId: scope.userId, resolve, reject, timeout });
      socket.send(JSON.stringify({ type: install ? 'executor_prepare' : 'executor_status', requestId, envelope: install ? release.envelope : undefined }), error => {
        if (!error) return; clearTimeout(timeout); this.pendingLocal.delete(requestId); reject(new OneKeyPresenceError('本机连接中断，请重新检查工具状态'));
      });
    });
    if (install) {
      // Downloads may outlive an HTTP proxy timeout. Acknowledge dispatch now;
      // status polling checks the actual installed tool, never repeats install.
      void response.catch(error => { state.executorPreparationError = error instanceof Error ? error.message.slice(0, 1000) : '准备未完成，请重新检查'; });
      return { available: true, preparing: true, phase: 'checking', version: release.version, size: release.size };
    }
    const result = await response;
    // Status contains no executable path or gateway credentials.
    const installedVersion = validRuntimeVersion(result.output) ? result.output : undefined;
    const installedSource = installedVersion && result.targetName === 'existing' ? 'existing' : installedVersion ? 'managed' : undefined;
    return { available: true, preparing: false, version: release.version, size: release.size, installedVersion, installedSource,
      error: installedSource === 'existing' || installedVersion === release.version ? undefined : state.executorPreparationError };
  }

  async executeLocalTool(deviceId: string, taskId: string, tool: LocalToolName, args: Record<string, unknown>, installationId?: string) {
    const requestId = uid("tol");
    return this.localRequest(deviceId, taskId, requestId, { type: "tool_request", taskId, requestId, tool, arguments: args }, 190_000, installationId);
  }

  async startExecution(deviceId: string, taskId: string, instruction: string, installationId?: string) {
    const db = await this.store.read();
    const round = db.executionTasks.find(t => t.id === taskId && t.deviceId === deviceId && t.installationId === installationId)?.reportRound ?? 0;
    const gateway = await this.gatewayConfiguration(taskId, deviceId, installationId);
    await this.sendToDevice(deviceId, taskId, installationId, { type: "execution_start", taskId, instruction, round, gateway });
  }

  async continueExecution(deviceId: string, taskId: string, instruction: string, installationId?: string) {
    const db = await this.store.read();
    const round = db.executionTasks.find(t => t.id === taskId && t.deviceId === deviceId && t.installationId === installationId)?.reportRound ?? 0;
    const gateway = await this.gatewayConfiguration(taskId, deviceId, installationId);
    await this.sendToDevice(deviceId, taskId, installationId, { type: "execution_continue", taskId, instruction, round, gateway });
  }

  async cancelExecution(deviceId: string, taskId: string, installationId?: string) {
    const socket = await this.executionSocket(deviceId, taskId, installationId);
    await this.store.mutate(db => {
      const task = db.executionTasks.find(t => t.id === taskId && t.deviceId === deviceId && t.installationId === installationId);
      if (!task || executionTerminal(task.status)) return;
      task.status = "cancelled"; task.updatedAt = task.completedAt = new Date().toISOString();
      task.lastError = "停止请求已提交；已经产生的文件修改不会自动撤销。";
      saveExecutionReceipt(db, task);
    });
    socket.send(JSON.stringify({ type: "execution_cancel", taskId }));
    for (const [id, pending] of this.pendingLocal) if (pending.socket === socket && pending.taskId === taskId) {
      clearTimeout(pending.timeout); this.pendingLocal.delete(id); pending.reject(new Error("执行已停止"));
    }
  }

  async close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const proof of this.pending.values()) { clearTimeout(proof.timeout); proof.reject(new Error("服务已关闭")); }
    this.pending.clear();
    for (const pending of this.pendingLocal.values()) { clearTimeout(pending.timeout); pending.reject(new Error("服务已关闭")); }
    this.pendingLocal.clear();
    await new Promise<void>((resolve) => this.wss ? this.wss.close(() => resolve()) : resolve());
  }

  private async accept(socket: WebSocket, rawUrl: string) {
    const query = new URL(rawUrl, "http://localhost").searchParams;
    const deviceId = query.get("deviceId")?.trim() || "";
    const installationId = query.get("installationId");
    if (!validInstallationId(installationId)) { socket.close(4006, "ONE launcher update required"); return; }
    const db = await this.store.read();
    const device = db.oneKeyDevices.find((item) => item.id === deviceId && item.status === "active");
    if (!device) { socket.close(4003, "ONE Key unavailable"); return; }

    const authChallengeId = uid("wsa");
    const authNonce = crypto.randomBytes(32).toString("base64url");
    const state: SocketState = {
      deviceId,
      installationId,
      authenticated: false,
      authChallengeId,
      authNonce,
      alive: true,
      authTimeout: setTimeout(() => socket.close(4008, "Authentication timeout"), authTimeoutMs),
      capabilities: new Set()
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
      kind?: string; text?: string; providerThreadId?: string; targetName?: string; status?: string; round?: number;
      requestId?: string; ok?: boolean; output?: string; error?: string; capabilities?: unknown;
      platform?: unknown; architecture?: unknown; launcherVersion?: unknown; updateProtocol?: unknown; version?: unknown;
    };
    try { message = JSON.parse(raw); } catch { socket.close(4000, "Invalid message"); return; }
    if (message.type === "auth_response" && !state.authenticated && message.challengeId === state.authChallengeId && message.signature) {
      const db = await this.store.read();
      const device = db.oneKeyDevices.find((item) => item.id === state.deviceId && item.status === "active");
      if (!device || !verifySignature(device.publicKey, state.authNonce, message.signature)) { socket.close(4003, "Invalid signature"); return; }
      clearTimeout(state.authTimeout);
      state.authenticated = true;
      state.capabilities = new Set(Array.isArray(message.capabilities) ? message.capabilities.filter((item): item is string => typeof item === "string").slice(0, 20) : []);
      if ((message.platform === "macos" || message.platform === "windows")
        && (["arm64", "x86_64", "amd64"] as unknown[]).includes(message.architecture)
        && validRuntimeVersion(message.launcherVersion)
        && message.updateProtocol === 1) {
        state.runtime = { platform: message.platform as RuntimePlatform, architecture: message.architecture as RuntimeArchitecture, version: message.launcherVersion, updateProtocol: 1 };
      }
      const previous = this.sockets.get(state.deviceId);
      if (previous && previous !== socket) {
        const previousState = this.states.get(previous);
        const sameComputer = previousState?.installationId === state.installationId;
        const keepPrevious = Boolean(sameComputer && previousState?.authenticated && (
          previousState.runtime && state.runtime
            ? compareRuntimeVersions(previousState.runtime.version, state.runtime.version) >= 0
            : Boolean(previousState.runtime) || !state.runtime
        ));
        if (keepPrevious) {
          if (this.updateInProgress(previousState)) {
            state.authenticated = false;
            socket.close(4009, "ONE update is in progress on this computer");
            return;
          }
          try {
            await this.requireProof({ deviceId: device.id, installationId: state.installationId, userId: device.userId, workspaceId: device.workspaceId, method: "GET", path: "/presence/reconnect" });
            state.authenticated = false;
            socket.close(4009, "ONE is already connected on this computer");
            return;
          } catch {
            // Only replace the stale socket observed above; a concurrent
            // authenticated replacement must not be overwritten by this one.
            if (this.sockets.get(state.deviceId) && this.sockets.get(state.deviceId) !== previous) {
              state.authenticated = false;
              socket.close(4010, "Retry connection");
              return;
            }
          }
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        if (previousState) previousState.authenticated = false;
        this.remove(previous);
        // Another launch on this same installation supersedes the old process.
        // A different computer must remain able to resume after reinsertion.
        previous.close(previousState?.installationId === state.installationId ? 4009 : 4001, "Another launcher connected");
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
    if (message.type === 'runtime_recovery_event' && state.authenticated && state.runtime && message.requestId
      && this.sockets.get(state.deviceId) === socket) {
      const db=await this.store.read();
      const device=db.oneKeyDevices.find(item=>item.id===state.deviceId&&item.status==='active');
      if(!device || !state.authenticated || this.sockets.get(state.deviceId)!==socket) return;
      const receipt=runtimeRecoveryReceipt(db.auditLogs??[],{deviceId:device.id,installationId:state.installationId,userId:device.userId,workspaceId:device.workspaceId},state.runtime,message.requestId,message.version,message.status);
      if(!receipt || (state.update && state.update.requestId!==message.requestId)) return;
      state.update={requestId:message.requestId,version:receipt.version,status:receipt.status,updatedAt:new Date().toISOString(),message:receipt.status==='failed'?'更新中断，旧版已安全恢复，可以重试':undefined};
      state.updateStartedAt=receipt.startedAt;
      await this.checkpointUpdate(state);
      if(state.authenticated&&this.sockets.get(state.deviceId)===socket) socket.send(JSON.stringify({type:'runtime_recovery_ack',requestId:message.requestId}));
      return;
    }
    if (message.type === "update_event" && state.authenticated && message.requestId && state.update?.requestId === message.requestId) {
      if (this.sockets.get(state.deviceId) !== socket || ['completed', 'failed'].includes(state.update.status)) return;
      const allowed = new Set(["downloading", "verifying", "installing", "completed", "failed"]);
      if (!allowed.has(String(message.status))) return;
      state.update = {
        ...state.update,
        status: message.status as RuntimeUpdateProgress["status"],
        message: typeof message.error === "string" ? message.error.slice(0, 500) : undefined,
        updatedAt: new Date().toISOString()
      };
      try { await this.checkpointUpdate(state); } catch {
        // Never turn missing durable confirmation into permission to reinstall.
        state.update.recoveryRequired = true;
      }
      if (state.update.status === "completed" || state.update.status === "failed") {
        const terminal = state.update;
        await this.store.mutate(database => {
          if (!state.authenticated || this.sockets.get(state.deviceId) !== socket) return;
          const device = database.oneKeyDevices.find(item => item.id === state.deviceId && item.status === "active");
          if (!device) return;
          database.auditLogs.push({
            id: uid("aud"), workspaceId: device.workspaceId, actorUserId: device.userId,
            action: terminal.status === "completed" ? "one_runtime.update.completed" : "one_runtime.update.failed",
            targetType: "one_key_device", targetId: device.id,
            details: { version: terminal.version }, createdAt: terminal.updatedAt
          });
        });
      }
      return;
    }
    if (message.type === 'executor_progress' && state.authenticated && message.requestId) {
      const pending = this.pendingLocal.get(message.requestId);
      if (pending?.configuration && pending.change && pending.deviceId === state.deviceId && pending.socket === socket && this.sockets.get(state.deviceId) === socket
        && ['confirming','downloading','verifying','checking'].includes(message.output || '')) pending.preparationPhase = message.output;
      return;
    }
    if ((message.type === "local_ready" || message.type === "local_error" || message.type === "tool_result") && state.authenticated && message.requestId) {
      const pending = this.pendingLocal.get(message.requestId);
      if (!pending || pending.deviceId !== state.deviceId || pending.taskId !== message.taskId || pending.socket !== socket || this.sockets.get(state.deviceId) !== socket) return;
      const db = await this.store.read();
      if (this.pendingLocal.get(message.requestId) !== pending || !state.authenticated || this.sockets.get(state.deviceId) !== socket) return;
      const device = db.oneKeyDevices.find(item => item.id === state.deviceId && item.status === "active");
      const task = db.executionTasks.find(item => item.id === pending.taskId && item.deviceId === state.deviceId && item.installationId === state.installationId);
      this.pendingLocal.delete(message.requestId);
      clearTimeout(pending.timeout);
      if (!device || (pending.configuration ? device.workspaceId !== pending.workspaceId || device.userId !== pending.userId : !task || task.workspaceId !== device.workspaceId || task.userId !== device.userId)) pending.reject(new OneKeyPresenceError("ONE Key 或执行任务已失效"));
      else if (message.type === "local_error" || message.ok === false) pending.reject(new Error(message.error?.slice(0, 2000) || "本机工具执行失败"));
      else pending.resolve({ targetName: message.targetName?.slice(0, 200), output: message.output?.slice(0, 120_000) ?? "" });
      return;
    }
    if (message.type === "proof_response" && state.authenticated && message.challengeId && message.signature) {
      const proof = this.pending.get(message.challengeId);
      if (!proof || proof.deviceId !== state.deviceId || proof.socket !== socket || this.sockets.get(state.deviceId) !== socket) return;
      this.pending.delete(message.challengeId);
      clearTimeout(proof.timeout);
      const db = await this.store.read();
      const device = db.oneKeyDevices.find((item) => item.id === state.deviceId && item.status === "active");
      if (!device || this.sockets.get(state.deviceId) !== socket || !verifySignature(device.publicKey, proof.nonce, message.signature)) proof.reject(new OneKeyPresenceError("ONE Key 请求签名无效"));
      else proof.resolve();
      return;
    }
    if (message.type === "execution_event" && state.authenticated && message.taskId && message.kind) {
      await this.executionEvent(socket, state, { taskId: message.taskId, kind: message.kind, text: message.text, providerThreadId: message.providerThreadId, targetName: message.targetName, status: message.status, round: message.round });
    }
  }

  private async executionSocket(deviceId: string, taskId: string, installationId?: string) {
    if (!validInstallationId(installationId)) throw new OneKeyPresenceError("旧执行任务没有电脑绑定，请更新 ONE Key 后创建新任务", "ONE_KEY_UPGRADE_REQUIRED");
    const db = await this.store.read();
    const device = db.oneKeyDevices.find(item => item.id === deviceId && item.status === "active");
    const task = db.executionTasks.find(item => item.id === taskId && item.deviceId === deviceId && item.installationId === installationId);
    if (!device || !task || task.workspaceId !== device.workspaceId || task.userId !== device.userId) throw new OneKeyPresenceError("执行任务不属于当前 ONE Key 或这台电脑");
    const socket = this.sockets.get(deviceId);
    if (!socket || !this.isConnected(deviceId, installationId)) throw new OneKeyPresenceError("请将 ONE Key 插入任务原来的电脑");
    if ([...this.pendingLocal.values()].some(p => p.socket === socket && p.configuration && p.change)) throw new OneKeyPresenceError("正在更换本机工作目录或准备执行工具，请完成后再执行");
    return socket;
  }

  private async ownedSocket(params: { deviceId: string; installationId?: string; userId: string; workspaceId: string }) {
    if (!validInstallationId(params.installationId)) throw new OneKeyPresenceError("请更新 ONE Key 启动器", "ONE_KEY_UPGRADE_REQUIRED");
    const database = await this.store.read();
    const device = database.oneKeyDevices.find(item => item.id === params.deviceId && item.status === "active");
    if (!device || device.userId !== params.userId || device.workspaceId !== params.workspaceId) throw new OneKeyPresenceError("ONE Key 已挂失或不属于当前账号");
    const socket = this.sockets.get(params.deviceId);
    if (!socket || !this.isConnected(params.deviceId, params.installationId)) throw new OneKeyPresenceError("请将 ONE Key 插入当前这台电脑");
    return socket;
  }

  private async sendToDevice(deviceId: string, taskId: string, installationId: string | undefined, payload: Record<string, unknown>) {
    const socket = await this.executionSocket(deviceId, taskId, installationId);
    if (this.sockets.get(deviceId) !== socket || !this.isConnected(deviceId, installationId)) throw new OneKeyPresenceError("本机执行连接已变更，请重试");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(payload), (error) => error ? reject(new OneKeyPresenceError("本机执行连接已断开")) : resolve()));
    return socket;
  }

  private async localRequest(deviceId: string, taskId: string, requestId: string, payload: Record<string, unknown>, timeoutMs: number, installationId?: string) {
    const socket = await this.executionSocket(deviceId, taskId, installationId);
    if (this.sockets.get(deviceId) !== socket || !this.isConnected(deviceId, installationId)) throw new OneKeyPresenceError("本机执行连接已变更，请重试");
    if (!this.states.get(socket)?.capabilities.has("local_tools_v1")) throw new OneKeyPresenceError("当前 ONE Key 启动器不支持 Local Agent，请更新 U 盘程序");
    return new Promise<{ targetName?: string; output?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingLocal.delete(requestId);
        reject(new OneKeyPresenceError("ONE Local Agent 响应超时"));
      }, timeoutMs);
      this.pendingLocal.set(requestId, { deviceId, socket, taskId, resolve, reject, timeout });
      socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timeout); this.pendingLocal.delete(requestId); reject(new OneKeyPresenceError("ONE Local Agent 连接已断开"));
      });
    });
  }

  private async executionEvent(socket: WebSocket, state: SocketState, message: {
    taskId: string; kind: string; text?: string; providerThreadId?: string; targetName?: string; status?: string; round?: number;
  }) {
    const allowedKinds = new Set(["status", "message", "command", "file_change", "error"]);
    const kind = allowedKinds.has(message.kind) ? message.kind as "status" | "message" | "command" | "file_change" | "error" : "status";
    const text = typeof message.text === "string" ? message.text.trim().slice(0, 20_000) : "";
    await this.store.mutate((database) => {
      if (!state.authenticated || this.sockets.get(state.deviceId) !== socket) return;
      const device = database.oneKeyDevices.find((item) => item.id === state.deviceId && item.status === "active");
      const task = database.executionTasks.find((item) => item.id === message.taskId && item.deviceId === state.deviceId && item.installationId === state.installationId);
      if (!device || !task || task.workspaceId !== device.workspaceId || task.userId !== device.userId) return;
      if (state.capabilities.has("execution_round_v1") && message.round !== (task.reportRound ?? 0)) return;
      // A terminal is immutable until an explicit continuation starts a new round.
      if (executionTerminal(task.status)) return;
      const timestamp = new Date().toISOString();
      if (message.providerThreadId) task.providerThreadId = message.providerThreadId.slice(0, 200);
      if (message.targetName) task.targetName = message.targetName.slice(0, 1000);
      if (message.status === "selecting_target") task.status = "selecting_target";
      if (message.status === "running") { task.status = "running"; task.startedAt ??= timestamp; task.lastError = undefined; }
      if (kind === "message" && text) task.finalResponse = text;
      if (message.status === "completed") {
        const response = task.finalResponse || text;
        const generic = /^Codex 本轮已结束/.test(response);
        task.status = response && !generic ? "completed" : "failed";
        task.completedAt = timestamp;
        if (task.status === "completed") task.finalResponse = response;
        else task.lastError = "执行器已退出，但没有返回可确认的结果。请检查文件，不会自动重跑。";
      }
      if (message.status === "failed") { task.status = "failed"; task.completedAt = timestamp; task.lastError = text || "Codex 执行失败"; }
      if (message.status === "cancelled") { task.status = "cancelled"; task.completedAt = timestamp; }
      task.updatedAt = timestamp;
      if (text) appendExecutionEvent(database, { id: uid("exe"), workspaceId: task.workspaceId, userId: task.userId, taskId: task.id, kind, text, createdAt: timestamp });
      saveExecutionReceipt(database, task);
    });
  }

  private remove(socket: WebSocket) {
    const state = this.states.get(socket);
    if (!state) return;
    clearTimeout(state.authTimeout);
    const current = this.sockets.get(state.deviceId) === socket;
    if (current) this.sockets.delete(state.deviceId);
    for (const [id, proof] of this.pending) if (proof.socket === socket) {
      clearTimeout(proof.timeout); this.pending.delete(id); proof.reject(new OneKeyPresenceError("ONE Key 连接已断开"));
    }
    for (const [id, pending] of this.pendingLocal) if (pending.socket === socket) {
      clearTimeout(pending.timeout); this.pendingLocal.delete(id); pending.reject(new OneKeyPresenceError("ONE Local Agent 连接已断开"));
    }
    if (current && typeof this.store.mutate === "function") void this.store.mutate(db => {
      // A reconnect is not permission to replay a task. A replaced socket must
      // not fail work on the newly authenticated connection.
      if (this.sockets.has(state.deviceId)) return;
      const device = db.oneKeyDevices.find(d => d.id === state.deviceId && d.status === "active");
      if (!device) return;
      for (const task of db.executionTasks ?? []) {
        if (task.deviceId !== state.deviceId || task.installationId !== state.installationId || task.workspaceId !== device.workspaceId || task.userId !== device.userId || executionTerminal(task.status)) continue;
        task.status = "failed"; task.updatedAt = task.completedAt = new Date().toISOString();
        task.lastError = "本机连接中断，执行结果尚未确认。可能已产生部分修改，请检查文件；不会自动重跑。";
        saveExecutionReceipt(db, task);
      }
    }).catch(() => { /* Store failure is handled by the next explicit status request. */ });
  }
}
