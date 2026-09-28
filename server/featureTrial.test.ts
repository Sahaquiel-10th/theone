import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { installFeatureTrialRoutes } from "./featureTrialRoutes.js";
import { requireRole } from "./middleware.js";
import { runFeatureTrial, trialResult } from "./featureTrial.js";
import { featureValues } from "./officialFeatures.js";
import type { Store } from "./db.js";
import type { Database, ModelConfig } from "./types.js";
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" as const };
function fixture() {
  const model = { id: "model", kind: "chat", name: "Synthetic model", enabled: true, systemPrompt: "base", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 2 } as ModelConfig;
  const values = { name: "园区助手", author: "ONE", description: "测试", instructions: "查资料再回答", limitations: "合成数据", integration: "question_answer", modelId: "model", tools: [{ id: "sandboxLookup", description: "查园区规则" }, { id: "sandboxInventory", description: "查库存" }] };
  let db = { users: [{ id: "a", role: "admin", enabled: true }, { id: "b", role: "admin", enabled: true }], workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }], models: [model], modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "pa", userId: "a", workspaceId: "wa", balanceMicros: 1000000 }, { id: "pb", userId: "b", workspaceId: "wb", balanceMicros: 1000000 }], conversations: [], messages: [], contextTraces: [], chatOperations: [], settings: { safetyRules: "safe", officialFeatures: [{ id: "test-agent", revision: 1, status: "draft", draft: values, history: [] }] } } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: fn => { const next = queue.then(() => { const before = structuredClone(db); try { return fn(db); } catch (e) { db = before; throw e; } }); queue = next.catch(() => undefined); return next; } };
  return { store, values, db: () => db, scope: { workspaceId: "wa", userId: "a" }, body: { revision: 1, operationId: "trial_123456789012345", prompt: "规则和库存？", budget: .1, confirmed: true } };
}
test("agent calls two structured tools, bills actual usage, saves private trace and replays without calls", async () => {
  const f = fixture(); let calls = 0, reads = 0, proofs = 0;
  const deps: Parameters<typeof runFeatureTrial>[5] = { transport: async url => { reads++; return url.pathname.endsWith("lookup") ? { synthetic: true, found: true, title: "规则", answer: "60 分钟" } : { synthetic: true, itemId: 101, name: "笔", available: 12 }; }, modelCall: async (_m, messages, tools) => {
    calls++; if (calls === 1) { assert.equal((tools[1].function.parameters as any).properties.itemId.type, "integer"); return { content: "", usage, toolCalls: [{ id: "a", type: "function", function: { name: "sandboxLookup", arguments: '{"topic":"meeting"}' } }, { id: "b", type: "function", function: { name: "sandboxInventory", arguments: '{"itemId":101}' } }] }; }
    assert.match(JSON.stringify(messages), /60 分钟/); assert.match(JSON.stringify(messages), /available/); return { content: "60 分钟，12 支笔", toolCalls: [], usage, finishReason: "stop" };
  } };
  const result = await runFeatureTrial(f.store, f.scope, "test-agent", f.body, async () => { proofs++; }, deps);
  assert.equal(result.trace.length, 2); assert.equal(reads, 2); assert.equal(result.charges.length, 2); assert.ok(proofs > 3);
  const replay = await runFeatureTrial(f.store, f.scope, "test-agent", f.body, async () => {}, deps);
  assert.equal(replay.content, result.content); assert.equal(calls, 2); assert.equal(f.db().powerLedger.length, 2);
  assert.equal(f.db().powerAccounts[1].balanceMicros, 1000000);
  assert.throws(() => trialResult(f.db(), { userId: "b", workspaceId: "wb" }, f.body.operationId));
  assert.throws(() => trialResult(f.db(), { userId: "a", workspaceId: "wb" }, f.body.operationId));
});
test("budget and Key failures prevent model calls; mutations cancel further execution", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(runFeatureTrial(f.store, f.scope, "test-agent", f.body, async () => { throw new Error("Key removed"); }, { modelCall: async () => { assert.fail(); } }), /Key removed/);
  assert.equal(f.db().chatOperations?.length, 0);
  await assert.rejects(runFeatureTrial(f.store, f.scope, "test-agent", { ...f.body, budget: .001 }, async () => {}, { modelCall: async () => { calls++; assert.fail(); } }), /上限/);
  assert.equal(calls, 0); assert.equal(f.db().modelUsageRecords.length, 0);
  await assert.rejects(runFeatureTrial(f.store, f.scope, "test-agent", { ...f.body, operationId: "trial_other123456789" }, async () => {}, { modelCall: async () => { await f.store.mutate(db => { db.settings.officialFeatures![0].revision++; }); return { content: "", usage, toolCalls: [{ id: "x", type: "function", function: { name: "sandboxLookup", arguments: '{"topic":"meeting"}' } }] }; }, transport: async () => { assert.fail("revoked tool ran"); } }), /配置已变化/);
});
test("tool definitions reject endpoint injection and preserve legacy metadata", () => {
  const f = fixture(); assert.equal(featureValues(f.values).tools?.length, 2);
  assert.throws(() => featureValues({ ...f.values, tools: [{ id: "evil", description: "x", document: { servers: [{ url: "http://127.0.0.1" }] }, operationId: "evil" }] }));
  assert.throws(() => featureValues({ ...f.values, tools: [{ ...f.values.tools[0], secret: "no" }] }));
  const legacy = { ...f.values, tools: undefined, modelId: undefined }; assert.equal(featureValues(legacy).tools, undefined);
});

test("HTTP trial results enforce admin, Key and own workspace; failed runs remain queryable", async t => {
  const f = fixture();
  await assert.rejects(runFeatureTrial(f.store, f.scope, "test-agent", { ...f.body, budget: .001 }, async () => {}, { modelCall: async () => { assert.fail(); } }));
  const app = express(); app.use(express.json());
  installFeatureTrialRoutes(app, [(req, res, next) => {
    if (req.headers['x-key'] !== 'present') { res.sendStatus(428); return; }
    const other = req.headers['x-account'] === 'b';
    req.user = { id: other ? 'b' : 'a', role: req.headers['x-role'] === 'user' ? 'user' : 'admin' } as any;
    req.workspaceId = other ? 'wb' : 'wa'; next();
  }, requireRole('admin')], f.store, async () => {});
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/admin/official-features/test-agent/trial`;
  for (const [path, method] of [[url, 'POST'], [url + '/' + f.body.operationId, 'GET']]) {
    assert.equal((await fetch(path, { method })).status, 428);
    assert.equal((await fetch(path, { method, headers: { 'x-key': 'present', 'x-role': 'user' } })).status, 403);
  }
  const resultUrl = url + '/' + f.body.operationId;
  assert.equal((await fetch(resultUrl, { headers: { 'x-key': 'present', 'x-account': 'b' } })).status, 404);
  const own = await fetch(resultUrl + '?workspaceId=wb', { headers: { 'x-key': 'present' } });
  assert.equal(own.status, 200); assert.equal(own.headers.get('cache-control'), 'no-store');
  assert.equal((await own.json()).status, 'failed');
  assert.equal(f.db().modelUsageRecords.length, 0);
});
