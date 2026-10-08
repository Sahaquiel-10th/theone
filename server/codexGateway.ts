import crypto from "node:crypto";
import type { Express } from "express";
import type { Store } from "./db.js";
import type { ExecutionTask, ModelConfig } from "./types.js";
import { executionTerminal } from "./executionService.js";
import { resolveAiTask } from "./aiTaskConfig.js";
import { runBilledModel } from "./modelBilling.js";
import { MODEL_MAX_OUTPUT_TOKENS, parseProviderUsage } from "./modelGateway.js";

export type CodexGatewayConfiguration = { baseUrl: string; token: string; model: "one-executor" };
type Grant = Pick<ExecutionTask, "id" | "workspaceId" | "userId" | "deviceId" | "installationId" | "conversationId"> & {
  round: number; expiresAt: number; model: ModelConfig;
};
type Proof = (scope: { workspaceId: string; userId: string; deviceId: string; installationId?: string; method: string; path: string }) => Promise<void>;
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const unavailable = () => new Error("ONE_CODEX_GATEWAY_UNAVAILABLE");
function localToolDefinition(value: unknown, nested = false): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  if (tool.type === "function" || tool.type === "custom") return typeof tool.name === "string" && tool.name.length <= 200;
  return !nested && tool.type === "namespace" && typeof tool.name === "string" && tool.name.length <= 200
    && Array.isArray(tool.tools) && tool.tools.length <= 100 && tool.tools.every(item => localToolDefinition(item, true));
}

/** Ephemeral per-round grants; never export upstream credentials to a device. */
export class CodexGateway {
  private grants = new Map<string, Grant>();
  constructor(private store: Store, private proof: Proof, private options: {
    baseUrl: string; modelId: string; enabled: boolean; fetch?: typeof fetch; now?: () => number;
  }) {}
  enabled() { return this.options.enabled; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private active(db: Awaited<ReturnType<Store["read"]>>, grant: Grant) {
    const task = db.executionTasks.find(item => item.id === grant.id && item.workspaceId === grant.workspaceId
      && item.userId === grant.userId && item.deviceId === grant.deviceId && item.installationId === grant.installationId);
    if (!task || task.provider !== "codex" || executionTerminal(task.status) || (task.reportRound ?? 0) !== grant.round
      || !db.users.some(item => item.id === grant.userId && item.enabled)
      || !db.workspaceMembers.some(item => item.userId === grant.userId && item.workspaceId === grant.workspaceId)
      || !db.workspaces.some(item => item.id === grant.workspaceId && item.status === "active")
      || !db.oneKeyDevices.some(item => item.id === grant.deviceId && item.userId === grant.userId && item.workspaceId === grant.workspaceId && item.status === "active")) throw unavailable();
    return task;
  }
  async prepare(task: ExecutionTask): Promise<CodexGatewayConfiguration> {
    if (!this.enabled()) throw unavailable();
    const url = new URL(this.options.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !url.pathname.endsWith("/api/executor-gateway/v1")) throw unavailable();
    const db = await this.store.read();
    const fallback = db.models.find(item => item.id === this.options.modelId && item.enabled && item.kind === "chat");
    if (!fallback) throw unavailable();
    const model = resolveAiTask(db.settings, db.models, "codex_execution", fallback).model;
    const upstream = new URL(model.baseUrl);
    if (model.protocol !== "openai" || !model.apiKey || upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search || upstream.hash) throw unavailable();
    const grant: Grant = { id: task.id, workspaceId: task.workspaceId, userId: task.userId, conversationId: task.conversationId,
      deviceId: task.deviceId, installationId: task.installationId, round: task.reportRound ?? 0, expiresAt: this.now() + 60 * 60_000, model: structuredClone(model) };
    if (!grant.installationId) throw unavailable();
    this.active(db, grant);
    for (const [key, saved] of this.grants) if (saved.expiresAt <= this.now() || (saved.id === grant.id && saved.workspaceId === grant.workspaceId && saved.userId === grant.userId)) this.grants.delete(key);
    if (this.grants.size >= 1000) throw unavailable();
    const token = crypto.randomBytes(32).toString("base64url");
    this.grants.set(digest(token), grant);
    return { baseUrl: url.toString(), token, model: "one-executor" };
  }
  async responses(token: string, raw: unknown, signal: AbortSignal, emit: (event: Record<string, unknown>) => void) {
    const grant = this.grants.get(digest(token));
    if (!this.enabled() || !grant || grant.expiresAt <= this.now()) throw unavailable();
    this.active(await this.store.read(), grant);
    await this.proof({ ...grant, method: "POST", path: "/api/executor-gateway/v1/responses" });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unavailable();
    const input = raw as Record<string, unknown>;
    const allowed = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "stream", "store", "include", "max_output_tokens", "prompt_cache_key", "client_metadata"]);
    if (Object.keys(input).some(key => !allowed.has(key)) || input.model !== "one-executor" || input.stream !== true
      || input.store === true || (!Array.isArray(input.input) && typeof input.input !== "string")
      || (input.instructions !== undefined && typeof input.instructions !== "string")
      || (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 100 || input.tools.some(tool => !localToolDefinition(tool))))) throw unavailable();
    const forwarded = { ...input };
    // Client metadata is diagnostic only, never identity, billing or upstream routing.
    delete forwarded.client_metadata;
    delete forwarded.prompt_cache_key;
    const prefix = `codex_${digest(`${grant.workspaceId}:${grant.userId}:${grant.id}:${grant.round}`).slice(0, 24)}_`;
    const body = { ...forwarded, model: grant.model.model, store: false, max_output_tokens: MODEL_MAX_OUTPUT_TOKENS,
      prompt_cache_key: prefix, instructions: [grant.model.systemPrompt, input.instructions].filter(Boolean).join("\n\n") };
    const requestId = prefix + digest(canonical(body)).slice(0, 32);
    let completed: Record<string, unknown> | undefined;
    let usage: ReturnType<typeof parseProviderUsage>;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, 150_000);
    const check = setInterval(() => void this.store.read().then(db => { try { this.active(db, grant); } catch { abort(); } }).catch(abort), 1000);
    try {
      await runBilledModel(this.store, { workspaceId: grant.workspaceId, userId: grant.userId, conversationId: grant.conversationId,
        model: grant.model, input: { taskId: grant.id, round: grant.round, request: body }, activity: "codex_execution", requestId,
        beforeReserve: db => {
          this.active(db, grant);
          const calls = db.modelUsageRecords.filter(row => row.workspaceId === grant.workspaceId && row.userId === grant.userId && row.requestId?.startsWith(prefix));
          if (signal.aborted || calls.some(row => row.requestId === requestId || row.status === "pending") || calls.length >= 64) throw unavailable();
        }
      }, async model => {
        const response = await (this.options.fetch ?? fetch)(`${model.baseUrl.replace(/\/$/, "")}/responses`, {
          method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey}` },
          body: JSON.stringify(body), signal: controller.signal
        });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw unavailable();
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pending = "", total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > 32 * 1024 * 1024) throw unavailable();
            pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
              const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data || data === "[DONE]") continue;
              const event = JSON.parse(data) as Record<string, unknown>;
              if (typeof event.type !== "string" || !event.type.startsWith("response.") || completed) throw unavailable();
              if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "response.error") throw unavailable();
              const result = event.response as Record<string, unknown> | undefined;
              // Public alias only; errors and upstream headers are never relayed.
              if (result) result.model = "one-executor";
              if (event.type === "response.completed") {
                if (result?.status !== "completed") throw unavailable();
                completed = event; usage = parseProviderUsage(result.usage);
              } else emit(event);
            }
          }
          if (!completed || pending.trim() || controller.signal.aborted) throw unavailable();
          return { usage };
        } finally { await reader.cancel().catch(() => undefined); }
      });
      // Do not signal successful completion before ONE has durably settled usage.
      this.active(await this.store.read(), grant);
      if (signal.aborted || controller.signal.aborted) throw unavailable();
      emit(completed!);
    } finally { clearTimeout(timeout); clearInterval(check); signal.removeEventListener("abort", abort); }
  }
}

export function installCodexGatewayRoutes(app: Express, gateway: CodexGateway) {
  app.post("/api/executor-gateway/v1/responses", async (req, res) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "")?.[1];
    if (!token) { res.status(401).json({ error: { code: "ONE_EXECUTOR_AUTH_REQUIRED", message: "执行授权不可用" } }); return; }
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      await gateway.responses(token, req.body, controller.signal, event => {
        if (res.destroyed || res.writableLength > 2 * 1024 * 1024) { controller.abort(); throw unavailable(); }
        if (!res.headersSent) { res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" }); res.flushHeaders(); }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      res.end();
    } catch {
      if (!res.headersSent) res.status(409).json({ error: { code: "ONE_EXECUTOR_REQUEST_FAILED", message: "执行请求未完成，请检查 ONE 连接和模型配置；不会自动重跑" } });
      else res.end(`event: error\ndata: ${JSON.stringify({ type: "error", code: "ONE_EXECUTOR_REQUEST_FAILED", message: "执行请求未完成；不会自动重跑" })}\n\n`);
    }
  });
}
