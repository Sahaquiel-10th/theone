import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { CodexGateway, installCodexGatewayRoutes } from "./codexGateway.js";
import type { Store } from "./db.js";
import type { Database, ExecutionTask, ModelConfig } from "./types.js";

const request = { model: "one-executor", input: [{ role: "user", content: "Create a test page" }], stream: true, store: false };
function fixture() {
  const model = { id: "model", enabled: true, kind: "chat", protocol: "openai", baseUrl: "https://supplier.example/v1", apiKey: "upstream-secret", model: "coding-model", systemPrompt: "test", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 2 } as ModelConfig;
  const task = { id: "task", workspaceId: "wa", userId: "a", deviceId: "da", installationId: "a".repeat(32), conversationId: "ca", provider: "codex", reportRound: 0, status: "queued" } as ExecutionTask;
  const db = { models: [model], settings: {}, users: [{ id: "a", enabled: true }, { id: "b", enabled: true }],
    workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }],
    oneKeyDevices: [{ id: "da", userId: "a", workspaceId: "wa", status: "active" }], executionTasks: [task],
    modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "pa", workspaceId: "wa", userId: "a", balanceMicros: 10_000_000 }, { id: "pb", workspaceId: "wb", userId: "b", balanceMicros: 10_000_000 }]
  } as unknown as Database;
  let calls = 0, proof = 0, clock = Date.now(), mode = "success", deny = false;
  const store: Store = { read: async () => db, mutate: async fn => fn(db) };
  const gateway = new CodexGateway(store, async scope => {
    proof++; assert.equal(scope.workspaceId, "wa"); assert.equal(scope.userId, "a"); assert.equal(scope.installationId, task.installationId);
    if (deny) throw Error("Key absent");
  }, { enabled: true, baseUrl: "https://one.example/api/executor-gateway/v1", modelId: model.id, now: () => clock,
    fetch: async (url, init) => {
      calls++; assert.equal(url, "https://supplier.example/v1/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer upstream-secret");
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, "coding-model"); assert.equal(body.store, false);
      assert.ok(!Object.hasOwn(body, "client_metadata")); assert.ok(body.prompt_cache_key.startsWith("codex_"));
      assert.ok(body.instructions.includes("本机执行器"));
      if (mode === "error") return new Response("upstream-secret", { status: 403 });
      const events = [{ type: "response.created", response: { id: "resp_1", model: "coding-model" } },
        { type: "response.output_text.delta", item_id: "item_1", delta: "done" },
        ...(mode === "truncated" ? [] : [{ type: "response.completed", response: { id: "resp_1", status: "completed", model: "coding-model", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }])];
      const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
      // Bytewise frames exercise boundaries, CRLF splitting and incremental decode.
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
  });
  return { gateway, db, task, calls: () => calls, proof: () => proof, setMode: (value: string) => { mode = value; }, deny: () => { deny = true; }, advance: () => { clock += 61 * 60_000; } };
}
const signal = () => new AbortController().signal;

test("Codex streams through ONE, hides supplier credentials and settles its own workspace once", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  assert.equal(config.model, "one-executor"); assert.ok(!JSON.stringify(config).includes("upstream-secret"));
  const events: Record<string, unknown>[] = [];
  await f.gateway.responses(config.token, request, signal(), event => {
    if (event.type === "response.completed") assert.equal(f.db.modelUsageRecords[0].status, "success");
    events.push(event);
  });
  assert.deepEqual(events.map(event => event.type), ["response.created", "response.output_text.delta", "response.completed"]);
  assert.equal((events[0].response as any).model, "one-executor");
  assert.equal(f.calls(), 1); assert.equal(f.proof(), 1); assert.equal(f.db.powerLedger.length, 1);
  assert.equal(f.db.powerAccounts[1].balanceMicros, 10_000_000);
  await assert.rejects(f.gateway.responses(config.token, { ...request, client_metadata: { retry: "different" }, prompt_cache_key: "another-user" }, signal(), () => {}));
  assert.equal(f.calls(), 1); assert.equal(f.db.powerLedger.length, 1);
});

test("expired, replaced, terminal and misbound grants reject before supplier calls", async () => {
  for (const change of ["expired", "replacement", "cancelled", "round", "workspace", "installation", "revoked", "membership"] as const) {
    const f = fixture(), config = await f.gateway.prepare(f.task);
    if (change === "expired") f.advance();
    if (change === "replacement") await f.gateway.prepare(f.task);
    if (change === "cancelled") f.task.status = "cancelled";
    if (change === "round") f.task.reportRound = 1;
    if (change === "workspace") f.task.workspaceId = "wb";
    if (change === "installation") f.task.installationId = "b".repeat(32);
    if (change === "revoked") f.db.oneKeyDevices[0].status = "revoked" as any;
    if (change === "membership") f.db.workspaceMembers = [];
    await assert.rejects(f.gateway.responses(config.token, request, signal(), () => {})); assert.equal(f.calls(), 0);
  }
});

test("Key proof, request policy and pre-abort fail before reservation", async () => {
  for (const extra of [{ previous_response_id: "another_workspace" }, { tools: [{ type: "web_search" }] }, { tools: [{ type: "namespace", name: "hidden", tools: [{ type: "web_search" }] }] }, { model: "other" }, { stream: false }, { store: true }, { upstream_url: "https://evil.example" }]) {
    const f = fixture(), config = await f.gateway.prepare(f.task);
    await assert.rejects(f.gateway.responses(config.token, { ...request, ...extra }, signal(), () => {}));
    assert.equal(f.calls(), 0); assert.equal(f.db.modelUsageRecords.length, 0);
  }
  const f = fixture(), config = await f.gateway.prepare(f.task); f.deny();
  await assert.rejects(f.gateway.responses(config.token, request, signal(), () => {})); assert.equal(f.calls(), 0);
  const other = fixture(), ready = await other.gateway.prepare(other.task), aborted = new AbortController(); aborted.abort();
  await assert.rejects(other.gateway.responses(ready.token, request, aborted.signal, () => {})); assert.equal(other.calls(), 0);
});

test("failed or truncated supplier output cannot complete and cannot be automatically replayed", async () => {
  for (const mode of ["error", "truncated"]) {
    const f = fixture(), config = await f.gateway.prepare(f.task); f.setMode(mode);
    const events: Record<string, unknown>[] = [];
    await assert.rejects(f.gateway.responses(config.token, request, signal(), event => events.push(event)));
    assert.ok(!events.some(event => event.type === "response.completed"));
    assert.equal(f.db.modelUsageRecords[0].status, "failed");
    await assert.rejects(f.gateway.responses(config.token, request, signal(), () => {})); assert.equal(f.calls(), 1);
  }
});

test("cancellation before late completed event stays terminal and completion is suppressed", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task), events: string[] = [];
  await assert.rejects(f.gateway.responses(config.token, request, signal(), event => {
    events.push(String(event.type)); if (event.type === "response.output_text.delta") f.task.status = "cancelled";
  }));
  assert.equal(f.task.status, "cancelled"); assert.ok(!events.includes("response.completed"));
});

test("HTTP route accepts no cookies as executor auth and returns sanitized errors", async () => {
  const f = fixture(), app = express(); app.use(express.json()); installCodexGatewayRoutes(app, f.gateway);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  const url = `http://127.0.0.1:${address.port}/api/executor-gateway/v1/responses`;
  try {
    const unauthenticated = await fetch(url, { method: "POST", headers: { "content-type": "application/json", cookie: "session=anything" }, body: JSON.stringify(request) });
    assert.equal(unauthenticated.status, 401);
    const config = await f.gateway.prepare(f.task); f.setMode("error");
    const failed = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify(request) });
    assert.equal(failed.status, 409); assert.ok(!(await failed.text()).includes("upstream-secret"));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
