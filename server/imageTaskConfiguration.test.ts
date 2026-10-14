import test from "node:test";
import assert from "node:assert/strict";
import type { Database, ModelConfig } from "./types.js";
import type { Store } from "./db.js";
import { defaultTaskValues, updateTaskConfig, validateTaskValues } from "./aiTaskConfig.js";
import { callImageTask, resolveImageTask } from "./imageTaskConfiguration.js";
import { adminCapabilityCatalog } from "./capabilityCatalog.js";
import { runBilledModel } from "./modelBilling.js";
import { publicUsageRecord } from "./serializers.js";

const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
function fixture(): Database {
  const gpt: ModelConfig = { id: "gpt", name: "GPT", model: "gpt-6.1", enabled: true, isDefault: true, kind: "chat", protocol: "openai", apiKey: "SECRET_SYNTHETIC_CREDENTIAL", baseUrl: "https://synthetic-provider.invalid/v1", provider: "synthetic", systemPrompt: "model instruction", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: .2, costOutputPowerPerMillion: .4, imagePowerPerCall: 0, costImagePowerPerCall: 0, pricing: { version: 2, multiplier: .6, label: "text price", referenceInput: 2, referenceOutput: 4, publishedAt: "2026-01-01" }, createdAt: "fixture" };
  const claude = { ...gpt, id: "claude", name: "Claude", model: "claude-sonnet", protocol: "anthropic" as const, isDefault: false };
  return { models: [gpt, claude], users: [{ id: "a", enabled: true }, { id: "b", enabled: true }], workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ workspaceId: "wa", userId: "a" }, { workspaceId: "wb", userId: "b" }], settings: { safetyRules: "safe", rechargeCnyPerPower: 7 }, modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "pa", workspaceId: "wa", userId: "a", balanceMicros: 1000000 }, { id: "pb", workspaceId: "wb", userId: "b", balanceMicros: 1000000 }], auditLogs: [] } as unknown as Database;
}
function publish(db: Database, route: "images" | "responses" = "images") {
  const values = { ...defaultTaskValues("image_generation"), modelId: "gpt", imageRoute: route, imageServiceModel: "gpt-image-2", imagePowerPerCall: .4, costImagePowerPerCall: .04 };
  updateTaskConfig(db.settings, db.models, "image_generation", { revision: 0, action: "draft", values }, "admin", "t1");
  updateTaskConfig(db.settings, db.models, "image_generation", { revision: 1, action: "publish" }, "admin", "t2");
}

test("an existing GPT credential supplies a dedicated image service without changing chat model or text prices", () => {
  const db = fixture(), before = structuredClone(db.models); publish(db);
  const config = resolveImageTask(db, true);
  assert.equal(config.route, "images"); assert.equal(config.serviceModel, "gpt-image-2");
  assert.equal(config.credentialModel.kind, "chat"); assert.equal(config.credentialModel.model, "gpt-6.1");
  assert.equal(config.billingModel.id, "gpt"); assert.equal(config.billingModel.kind, "image");
  assert.equal(config.billingModel.model, "gpt-image-2"); assert.equal(config.billingModel.imagePowerPerCall, .4);
  assert.equal(config.billingModel.pricing, undefined); assert.equal(config.billingModel.pricingHistory, undefined);
  assert.doesNotMatch(config.billingModel.systemPrompt, /model instruction/);
  assert.deepEqual(db.models, before);
  assert.ok(adminCapabilityCatalog(db, { imageStorageAvailable: true }).find((card) => card.executorId === "image_generation")!.available);
  assert.doesNotMatch(JSON.stringify(adminCapabilityCatalog(db, { imageStorageAvailable: true })), /SECRET_SYNTHETIC_CREDENTIAL|synthetic-provider/);
});

test("legacy dedicated image-model configuration retains its service identifier and fixed prices", () => {
  const db = fixture(); db.models.push({ ...db.models[0], id: "dedicated", kind: "image", model: "existing-image-service", imagePowerPerCall: .3, costImagePowerPerCall: .03 });
  const values = { ...defaultTaskValues("image_generation"), modelId: "dedicated" };
  updateTaskConfig(db.settings, db.models, "image_generation", { revision: 0, action: "draft", values }, "admin", "t1");
  updateTaskConfig(db.settings, db.models, "image_generation", { revision: 1, action: "publish" }, "admin", "t2");
  const config = resolveImageTask(db, true); assert.equal(config.serviceModel, "existing-image-service"); assert.equal(config.billingModel.imagePowerPerCall, .3);
});

test("image route and price fields reject other AI tasks, incompatible credentials and invalid values", () => {
  const db = fixture(), base = { ...defaultTaskValues("image_generation"), modelId: "gpt" };
  assert.doesNotThrow(() => validateTaskValues("image_generation", base, db.models));
  for (const fields of [{ imageRoute: "arbitrary" }, { imageServiceModel: "https://private.invalid" }, { imagePowerPerCall: -1 }, { imagePowerPerCall: NaN }, { costImagePowerPerCall: Infinity }]) assert.throws(() => validateTaskValues("image_generation", { ...base, ...fields }, db.models));
  assert.throws(() => validateTaskValues("image_generation", { ...base, modelId: "claude" }, db.models), /匹配/);
  assert.throws(() => validateTaskValues("task_worker", { ...defaultTaskValues("task_worker"), imageRoute: "images" }, db.models), /只能/);
  assert.throws(() => validateTaskValues("chat", { ...defaultTaskValues("chat"), imagePowerPerCall: .4 }, db.models), /只能/);
});

test("unconfigured prices, missing publication and missing private storage never expose a usable image capability", () => {
  const db = fixture(); assert.throws(() => resolveImageTask(db, true), /发布/);
  publish(db); assert.throws(() => resolveImageTask(db, false), /存储/);
  const saved = db.settings.aiTasks!.image_generation!.published!;
  saved.imagePowerPerCall = 0; assert.throws(() => resolveImageTask(db, true), /额度/);
  assert.equal(adminCapabilityCatalog(db, { imageStorageAvailable: true }).find((card) => card.executorId === "image_generation")!.available, false);
  saved.imagePowerPerCall = .4; saved.costImagePowerPerCall = undefined; assert.throws(() => resolveImageTask(db, true), /额度/);
});

test("dedicated image route posts one image request to images/generations and preserves returned pixels", async () => {
  const db = fixture(); publish(db); const config = resolveImageTask(db, true), before = structuredClone(db.models);
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(String(url), "https://synthetic-provider.invalid/v1/images/generations");
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer SECRET_SYNTHETIC_CREDENTIAL");
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, "gpt-image-2"); assert.equal(body.n, 1); assert.equal(body.size, "1024x1024");
    return new Response(JSON.stringify({ data: [{ b64_json: imageBytes }], usage: { input_tokens: 10, output_tokens: 5 } }));
  };
  try {
    const result = await callImageTask(config, config.billingModel, [{ role: "user", content: "synthetic image", createdAt: "t" }], "safe", "fixture-request");
    assert.equal(result.imageUrl, `data:image/png;base64,${imageBytes}`); assert.equal(calls, 1); assert.deepEqual(db.models, before);
  } finally { globalThis.fetch = previous; }
});

test("responses image-tool compatibility route retains GPT reasoning model and parses complete SSE image result", async () => {
  const db = fixture(); publish(db, "responses"); const config = resolveImageTask(db, true);
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(String(url), "https://synthetic-provider.invalid/v1/responses");
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, "gpt-6.1"); assert.equal(body.tools[0].model, "gpt-image-2"); assert.equal(body.store, false);
    const response = { status: "completed", output: [{ type: "image_generation_call", status: "completed", output_format: "png", result: imageBytes }, { type: "message", content: [{ type: "output_text", text: "synthetic result" }] }] };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await callImageTask(config, config.billingModel, [{ role: "user", content: "synthetic image", createdAt: "t" }]);
    assert.equal(result.imageUrl, `data:image/png;base64,${imageBytes}`); assert.equal(result.content, "synthetic result"); assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test("route failures retain a safe reason and never retry an uncertain image operation", async () => {
  const db = fixture(); publish(db); const config = resolveImageTask(db, true);
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: "SECRET_SYNTHETIC_CREDENTIAL echo" } }), { status: 403 }); };
  try { await assert.rejects(() => callImageTask(config, config.billingModel, [{ role: "user", content: "test", createdAt: "t" }]), (error: any) => !error.message.includes("SECRET_SYNTHETIC_CREDENTIAL")); assert.equal(calls, 1); }
  finally { globalThis.fetch = previous; }
});

test("one picture deducts a fixed shared-wallet amount, freezes prices and denies another workspace without a provider call", async () => {
  const db = fixture(); publish(db); const config = resolveImageTask(db, true), before = structuredClone(db.models);
  const store: Store = { read: async () => db, mutate: async (action) => action(db) };
  let calls = 0;
  const call = async () => { calls++; db.settings.aiTasks!.image_generation!.published!.imagePowerPerCall = .9; return { imageUrl: `data:image/png;base64,${imageBytes}`, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" } }; };
  const params = { workspaceId: "wa", userId: "a", model: config.billingModel, input: { taskVersion: config.version }, activity: "image_generation", requestId: "fixed-image" };
  await runBilledModel(store, params, call);
  const row = db.modelUsageRecords[0]; assert.equal(row.chargedMicros, 400000); assert.equal(row.costMicros, 40000); assert.equal(row.source, "fixed");
  assert.equal(db.powerAccounts[0].balanceMicros, 600000); assert.equal(db.powerAccounts[1].balanceMicros, 1000000); assert.deepEqual(db.models, before);
  assert.doesNotMatch(JSON.stringify(publicUsageRecord(row)), /SECRET_SYNTHETIC_CREDENTIAL|synthetic-provider/);
  await assert.rejects(() => runBilledModel(store, { ...params, workspaceId: "wb" }, call), /空间/); assert.equal(calls, 1);
  const frozen = resolveImageTask(db, true, { values: config.values, version: config.version }); assert.equal(frozen.billingModel.imagePowerPerCall, .4);
});
