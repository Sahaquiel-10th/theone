import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { CodexGateway, installCodexGatewayRoutes } from "./codexGateway.js";
import type { Store } from "./db.js";
import type { Database, ExecutionTask, ModelConfig } from "./types.js";
import {localExecutionCapabilityGuidance} from './localDocumentPolicy.js';

const request = { model: "one-executor", input: [{ role: "user", content: "Create a test page" }], stream: true, store: false };
function fixture() {
  const model = { id: "model", enabled: true, kind: "chat", protocol: "openai", baseUrl: "https://supplier.example/v1", apiKey: "upstream-secret", model: "coding-model", systemPrompt: "test", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 2 } as ModelConfig;
  const task = { id: "task", workspaceId: "wa", userId: "a", deviceId: "da", installationId: "a".repeat(32), conversationId: "ca", provider: "codex", reportRound: 0, status: "queued",
    deliveryAttempt: { id: "attempt-a", round: 0, issuedAt: "2026-10-15T00:00:00Z" } } as ExecutionTask;
  const db = { models: [model], settings: {}, users: [{ id: "a", enabled: true }, { id: "b", enabled: true }],
    workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }],
    oneKeyDevices: [{ id: "da", userId: "a", workspaceId: "wa", status: "active" }], executionTasks: [task], executionEvents: [], messages: [],
    modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "pa", workspaceId: "wa", userId: "a", balanceMicros: 10_000_000 }, { id: "pb", workspaceId: "wb", userId: "b", balanceMicros: 10_000_000 }]
  } as unknown as Database;
  let calls = 0, proof = 0, clock = Date.now(), mode = "success", deny = false, persistenceFailure = false;
  const instructions: string[] = [];
  let keyAbsent = false, waits = 0, waitEffect: (() => void) | undefined;
  let proofEffect: (() => void | Promise<void>) | undefined, fetchEffect: (() => Promise<void>) | undefined;
  const store: Store = { read: async () => db, mutate: async fn => {
    if (persistenceFailure) { await fn(structuredClone(db)); throw Error("durable commit unavailable"); }
    return fn(db);
  } };
  const gateway = new CodexGateway(store, async scope => {
    proof++; assert.equal(scope.workspaceId, "wa"); assert.equal(scope.userId, "a"); assert.equal(scope.installationId, task.installationId);
    if (deny) throw Error("Key absent");
    if (keyAbsent) throw Object.assign(Error("Key temporarily absent"), { code: "ONE_KEY_REQUIRED" });
    await proofEffect?.();
  }, { enabled: true, baseUrl: "https://one.example/api/executor-gateway/v1", modelId: model.id, now: () => clock,
    waitForKey: async () => { waits++; clock += 1000; waitEffect?.(); },
    fetch: async (url, init) => {
      calls++; assert.equal(url, "https://supplier.example/v1/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer upstream-secret");
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, "coding-model"); assert.equal(body.store, false);
      assert.ok(!Object.hasOwn(body, "client_metadata")); assert.ok(body.prompt_cache_key.startsWith("codex_"));
      assert.ok(body.instructions.includes("本机执行器"));
      instructions.push(body.instructions);
      await fetchEffect?.();
      if (mode === "error") return new Response("upstream-secret", { status: 403 });
      const events = [{ type: "response.created", response: { id: "resp_1", model: "coding-model" } },
        { type: "response.output_text.delta", item_id: "item_1", delta: "done" },
        ...(mode === "truncated" ? [] : [{ type: "response.completed", response: { id: "resp_1", status: "completed", model: "coding-model", usage: mode==='missing_usage'?undefined:{ input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }])];
      const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
      // Bytewise frames exercise boundaries, CRLF splitting and incremental decode.
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
  });
  return { gateway, db, task, instructions, calls: () => calls, proof: () => proof, setMode: (value: string) => { mode = value; }, deny: () => { deny = true; },
    afterProof: (effect: () => void | Promise<void>) => { proofEffect = effect; }, beforeSupplierResponse: (effect: () => Promise<void>) => { fetchEffect = effect; },
    failPersistence: () => { persistenceFailure = true; }, advance: () => { clock += 61 * 60_000; },
    setKeyAbsent: (value: boolean) => { keyAbsent = value; }, onWait: (effect: () => void) => { waitEffect = effect; }, waits: () => waits };
}
const signal = () => new AbortController().signal;
test('Codex receives current sandbox and static-delivery boundaries even with a custom model prompt', async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, {...request, instructions: '按本轮网站要求交付，不添加其他目标。'}, signal(), () => {});
  assert.equal(f.instructions.length, 1);
  assert.ok(f.instructions[0].includes(localExecutionCapabilityGuidance));
  assert.equal(f.instructions[0].split(localExecutionCapabilityGuidance).length, 2, 'inject one shared capability boundary per provider call');
  assert.match(f.instructions[0], /不能联网或监听本地端口/);
  assert.match(f.instructions[0], /不擅自把“必须启动开发服务器”添加为必需目标/);
  assert.match(f.instructions[0], /未实测不得声称功能已验收/);
  assert.match(f.instructions[0], /用户明确要求的后端服务、服务启动或浏览器验证仍是必需目标/);
  assert.match(f.instructions[0], /按本轮网站要求交付，不添加其他目标/);
});
test('missing supplier usage keeps its hold without stopping the next local tool decision',async()=>{
  const f=fixture(),config=await f.gateway.prepare(f.task);f.setMode('missing_usage');
  const events:string[]=[];await f.gateway.responses(config.token,request,signal(),e=>events.push(String(e.type)));
  const pending=f.db.modelUsageRecords[0],held=pending.reservedMicros;
  assert.equal(pending.status,'needs_review');assert.ok(held!>0);assert.ok(events.includes('response.completed'));
  f.setMode('success');await f.gateway.responses(config.token,{...request,input:'Next distinct step after checking the local directory'},signal(),()=>{});
  assert.equal(f.calls(),2);assert.equal(pending.status,'needs_review');assert.equal(pending.reservedMicros,held);
  assert.equal(f.db.modelUsageRecords[1].status,'success');assert.equal(f.db.powerAccounts[1].balanceMicros,10000000);
  assert.equal(f.db.powerLedger.length,1);
});
const followup = { ...request, input: [{ role: "user", content: "Continue after the existing local command returned" }] };
function disconnect(f: ReturnType<typeof fixture>, reason: NonNullable<ExecutionTask["transportInterruption"]>["reason"] = "proof_timeout") {
  f.task.status = "failed"; f.task.lastError = "本机连接中断，结果待确认"; f.task.completedAt = "2026-10-15T00:00:10Z";
  f.task.transportInterruption = { attemptId: f.task.deliveryAttempt!.id, round: f.task.reportRound ?? 0,
    reason, at: "2026-10-15T00:00:10Z" };
}
test("new Codex requests adopt newly published rates, while in-flight snapshots remain frozen", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  f.db.models[0].inputPowerPerMillion = 3;
  f.db.models[0].outputPowerPerMillion = 6;
  await f.gateway.responses(config.token, request, signal(), event => {
    if (event.type === "response.created") f.db.models[0].inputPowerPerMillion = 99;
  });
  assert.equal(f.db.modelUsageRecords[0].inputPowerPerMillionSnapshot, 3);
  assert.equal(f.db.modelUsageRecords[0].chargedMicros, 60);
  assert.equal(f.db.powerAccounts[1].balanceMicros, 10000000);
});

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

test("a fresh Key proof recovers only the frozen attempt for the next distinct request without relaunch or repeat billing", async () => {
  for (const reason of ["proof_timeout", "heartbeat_timeout", "socket_close", "socket_error"] as const) {
    const f = fixture(), config = await f.gateway.prepare(f.task);
    await f.gateway.responses(config.token, request, signal(), () => {});
    disconnect(f, reason);
    const interruption = structuredClone(f.task.transportInterruption), attempt = structuredClone(f.task.deliveryAttempt);
    const oldReceipt = { id: "execution_receipt_task_0", workspaceId: "wa", userId: "a", conversationId: "ca",
      role: "assistant" as const, content: "原先的断线回执，保留历史", createdAt: "2026-10-15T00:00:10Z" };
    f.db.messages.push(oldReceipt);
    const events: string[] = [];
    await f.gateway.responses(config.token, followup, signal(), event => events.push(String(event.type)));
    assert.equal(f.task.status, "running"); assert.equal(f.task.completedAt, undefined); assert.equal(f.task.lastError, undefined);
    assert.deepEqual(f.task.deliveryAttempt, attempt); assert.deepEqual(f.task.transportInterruption, interruption);
    assert.deepEqual(f.db.messages, [oldReceipt]); assert.equal(f.task.reportRound, 0);
    assert.equal(f.db.executionEvents.length, 1); assert.equal(f.db.executionEvents[0].kind, "status");
    assert.equal(f.db.executionEvents[0].workspaceId, "wa"); assert.equal(f.db.executionEvents[0].userId, "a");
    assert.equal(f.db.executionEvents[0].taskId, "task"); assert.equal(f.db.executionEvents[0].round, 0);
    assert.equal(f.db.executionEvents[0].text, "本机连接已恢复，继续处理本轮；没有重新执行任务。");
    assert.ok(events.includes("response.completed")); assert.equal(f.calls(), 2); assert.equal(f.proof(), 2);
    assert.equal(f.db.powerLedger.length, 2); assert.equal(f.db.powerAccounts[1].balanceMicros, 10_000_000);
    await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
    assert.equal(f.calls(), 2); assert.equal(f.db.powerLedger.length, 2); assert.equal(f.db.executionEvents.length, 1);
    disconnect(f, reason);
    await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
    assert.equal(f.task.status, "failed"); assert.equal(f.calls(), 2); assert.equal(f.db.powerLedger.length, 2);
    assert.equal(f.db.executionEvents.length, 1);
  }
});

test("an absent Key cannot recover a pending attempt or reserve another supplier call", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {}); disconnect(f); f.deny();
  await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
  assert.equal(f.task.status, "failed"); assert.equal(f.calls(), 1); assert.equal(f.proof(), 2);
  assert.equal(f.db.modelUsageRecords.length, 1); assert.equal(f.db.powerLedger.length, 1); assert.equal(f.db.executionEvents.length, 0);
});

test("a frozen interrupted round waits for fresh Key proof without replaying work or charging while absent", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {});
  disconnect(f, "socket_close"); const attempt = structuredClone(f.task.deliveryAttempt);
  f.setKeyAbsent(true);
  f.onWait(() => {
    assert.equal(f.calls(), 1); assert.equal(f.db.modelUsageRecords.length, 1);
    assert.equal(f.db.powerLedger.length, 1); assert.equal(f.task.status, "failed");
    if (f.waits() === 3) f.setKeyAbsent(false);
  });
  await f.gateway.responses(config.token, followup, signal(), () => {});
  assert.equal(f.waits(), 3); assert.equal(f.proof(), 5); assert.equal(f.calls(), 2);
  assert.equal(f.task.status, "running"); assert.deepEqual(f.task.deliveryAttempt, attempt);
  assert.equal(f.db.executionEvents.length, 1); assert.equal(f.db.powerLedger.length, 2);
});

test("Key reconnect waiting is bounded and grants no new request when the Key stays absent", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {}); disconnect(f); f.setKeyAbsent(true);
  await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
  assert.equal(f.waits(), 45); assert.equal(f.calls(), 1); assert.equal(f.task.status, "failed");
  assert.equal(f.db.modelUsageRecords.length, 1); assert.equal(f.db.executionEvents.length, 0);
  const initial = fixture(), first = await initial.gateway.prepare(initial.task); initial.setKeyAbsent(true);
  await assert.rejects(initial.gateway.responses(first.token, request, signal(), () => {}));
  assert.equal(initial.waits(), 0); assert.equal(initial.calls(), 0);
});

test("Key reconnect waiting stops on cancellation, replacement, ownership changes and a newer disconnect", async () => {
  for (const change of ["cancelled", "revoked", "workspace", "attempt", "new_disconnect", "receipt", "abort", "replacement", "expiry"] as const) {
    const f = fixture(), config = await f.gateway.prepare(f.task), abort = new AbortController();
    await f.gateway.responses(config.token, request, signal(), () => {}); disconnect(f); f.setKeyAbsent(true);
    f.onWait(() => {
      if (change === "cancelled") f.task.status = "cancelled";
      if (change === "revoked") f.db.oneKeyDevices[0].status = "revoked";
      if (change === "workspace") f.task.workspaceId = "wb";
      if (change === "attempt") f.task.deliveryAttempt!.id = "attempt-other";
      if (change === "new_disconnect") f.task.transportInterruption!.at = "newer";
      if (change === "receipt") f.task.terminalReceipt = { id: "receipt", hash: "hash", round: 0, outcome: "failed", attemptId: "attempt-a", disposition: "accepted", receivedAt: "now" };
      if (change === "abort") abort.abort();
      if (change === "replacement") f.task.transportInterruption!.reason = "connection_replaced";
      if (change === "expiry") f.advance();
      f.setKeyAbsent(false);
    });
    await assert.rejects(f.gateway.responses(config.token, followup, abort.signal, () => {}), change);
    assert.equal(f.waits(), 1, change); assert.equal(f.calls(), 1, change);
    assert.equal(f.db.modelUsageRecords.length, 1, change); assert.equal(f.db.executionEvents.length, 0, change);
  }
});

test("a legacy normal request without an issued attempt cannot later gain reconnect authority", async () => {
  const f = fixture(); f.task.deliveryAttempt = undefined;
  const config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {});
  f.task.deliveryAttempt = { id: "attempt-late", round: 0, issuedAt: "now" }; disconnect(f);
  await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
  assert.equal(f.task.status, "failed"); assert.equal(f.calls(), 1); assert.equal(f.proof(), 1); assert.equal(f.db.executionEvents.length, 0);
});

test("a failed durable recovery commit cannot expose a running state or reserve supplier usage", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {}); disconnect(f);
  const originalTask = structuredClone(f.task); f.failPersistence();
  await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
  assert.deepEqual(f.task, originalTask); assert.equal(f.db.executionEvents.length, 0);
  assert.equal(f.calls(), 1); assert.equal(f.db.modelUsageRecords.length, 1); assert.equal(f.db.powerLedger.length, 1);
});

test("concurrent recovery requests create one recovery event and at most one pending supplier call", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {}); disconnect(f);
  let releaseProof!: () => void, supplierStarted!: () => void, releaseSupplier!: () => void, proofs = 0;
  const proofBarrier = new Promise<void>(resolve => { releaseProof = resolve; });
  const supplierBarrier = new Promise<void>(resolve => { releaseSupplier = resolve; });
  const supplierSignal = new Promise<void>(resolve => { supplierStarted = resolve; });
  f.afterProof(async () => { if (++proofs === 2) releaseProof(); await proofBarrier; });
  f.beforeSupplierResponse(async () => { supplierStarted(); await supplierBarrier; });
  const settled = Promise.allSettled([
    f.gateway.responses(config.token, followup, signal(), () => {}),
    f.gateway.responses(config.token, { ...followup, input: "A different follow-up on this same running attempt" }, signal(), () => {})
  ]);
  await supplierSignal;
  assert.equal(f.calls(), 2); assert.equal(f.db.executionEvents.length, 1);
  assert.equal(f.db.modelUsageRecords.filter(row => row.status === "pending").length, 1);
  releaseSupplier();
  const results = await settled;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(f.calls(), 2); assert.equal(f.db.powerLedger.length, 2); assert.equal(f.db.executionEvents.length, 1);
});

test("pending recovery rejects unfrozen, terminal, old-attempt and cross-workspace bindings before proof or billing", async () => {
  const changes = ["unfrozen", "cancelled", "completed", "ordinary_failure", "round", "attempt", "interruption_attempt", "interruption_round",
    "receipt", "safety_hold", "local_storage", "cancellation_pending", "connection_replaced", "workspace", "user", "installation", "revoked", "membership", "disabled_user", "suspended_workspace"] as const;
  for (const change of changes) {
    const f = fixture(), config = await f.gateway.prepare(f.task);
    if (change !== "unfrozen") await f.gateway.responses(config.token, request, signal(), () => {});
    disconnect(f);
    if (change === "cancelled") f.task.status = "cancelled";
    if (change === "completed") f.task.status = "completed";
    if (change === "ordinary_failure") f.task.transportInterruption = undefined;
    if (change === "round") f.task.reportRound = 1;
    if (change === "attempt") f.task.deliveryAttempt!.id = "attempt-b";
    if (change === "interruption_attempt") f.task.transportInterruption!.attemptId = "attempt-b";
    if (change === "interruption_round") f.task.transportInterruption!.round = 1;
    if (change === "receipt") f.task.terminalReceipt = { id: "receipt", hash: "hash", attemptId: "attempt-a", round: 0,
      receivedAt: "now", outcome: "failed", disposition: "accepted" };
    if (change === "safety_hold") f.task.executionSafetyHold = "launcher_interrupted";
    if (["local_storage", "cancellation_pending", "connection_replaced"].includes(change)) f.task.transportInterruption!.reason = change as NonNullable<ExecutionTask["transportInterruption"]>["reason"];
    if (change === "workspace") f.task.workspaceId = "wb";
    if (change === "user") f.task.userId = "b";
    if (change === "installation") f.task.installationId = "b".repeat(32);
    if (change === "revoked") f.db.oneKeyDevices[0].status = "revoked";
    if (change === "membership") f.db.workspaceMembers = [];
    if (change === "disabled_user") f.db.users[0].enabled = false;
    if (change === "suspended_workspace") f.db.workspaces[0].status = "suspended";
    const calls = f.calls(), proofs = f.proof(), usage = f.db.modelUsageRecords.length;
    await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}), change);
    assert.equal(f.calls(), calls, change); assert.equal(f.proof(), proofs, change);
    assert.equal(f.db.modelUsageRecords.length, usage, change); assert.equal(f.db.executionEvents.length, 0, change);
  }
});

test("recovery revalidates cancellation, scope, attempt, expiry and a newer disconnect after fresh proof", async () => {
  for (const change of ["cancelled", "workspace", "attempt", "receipt", "expired", "new_disconnect", "replacement"] as const) {
    const f = fixture(), config = await f.gateway.prepare(f.task);
    await f.gateway.responses(config.token, request, signal(), () => {}); disconnect(f);
    f.afterProof(async () => {
      if (change === "cancelled") f.task.status = "cancelled";
      if (change === "workspace") f.task.workspaceId = "wb";
      if (change === "attempt") f.task.deliveryAttempt!.id = "attempt-b";
      if (change === "receipt") f.task.terminalReceipt = { id: "receipt", hash: "hash", attemptId: "attempt-a", round: 0,
        receivedAt: "now", outcome: "failed", disposition: "accepted" };
      if (change === "expired") f.advance();
      if (change === "new_disconnect") f.task.transportInterruption!.at = "2026-10-15T00:00:20Z";
      if (change === "replacement") { f.task.status = "running"; await f.gateway.prepare(f.task); }
    });
    await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}), change);
    assert.equal(f.calls(), 1, change); assert.equal(f.db.modelUsageRecords.length, 1, change);
    assert.equal(f.db.executionEvents.length, 0, change);
  }
});

test("a disconnect during proof or an existing stream cannot be converted into an automatically recovered request", async () => {
  const f = fixture(), config = await f.gateway.prepare(f.task);
  await f.gateway.responses(config.token, request, signal(), () => {});
  f.afterProof(() => disconnect(f));
  await assert.rejects(f.gateway.responses(config.token, followup, signal(), () => {}));
  assert.equal(f.calls(), 1); assert.equal(f.task.status, "failed"); assert.equal(f.db.executionEvents.length, 0);
  const stream = fixture(), streamConfig = await stream.gateway.prepare(stream.task), events: string[] = [];
  await assert.rejects(stream.gateway.responses(streamConfig.token, request, signal(), event => {
    events.push(String(event.type)); if (event.type === "response.output_text.delta") disconnect(stream);
  }));
  assert.ok(!events.includes("response.completed")); assert.equal(stream.calls(), 1); assert.equal(stream.task.status, "failed");
  assert.equal(stream.db.executionEvents.length, 0);
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
