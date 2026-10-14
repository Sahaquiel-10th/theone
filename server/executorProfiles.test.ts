import test from "node:test";
import assert from "node:assert/strict";
import type { Database, ModelConfig } from "./types.js";
import { defaultTaskValues } from "./aiTaskConfig.js";
import { executorDefaults, resolveExecutor, resolveRoutingExecutorId, setupDefaultExecutors, updateExecutor } from "./executorProfiles.js";

const model = (id: string, name: string): ModelConfig => ({ id, name, model: name, enabled: true, kind: "chat", apiKey: "synthetic-key", baseUrl: "https://synthetic.invalid/v1", provider: "synthetic", protocol: "openai", systemPrompt: "existing-model-prompt", isDefault: id === "gpt", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: .2, costOutputPowerPerMillion: .4, pricing: { version: 3, label: "existing-price", referenceInput: 2, referenceOutput: 4, multiplier: .6, publishedAt: "fixture" }, createdAt: "fixture" });
function fixture(): Database {
  return { users: [{ id: "admin", enabled: true, role: "admin" }, { id: "user", enabled: true, role: "user" }], settings: { safetyRules: "safe", rechargeCnyPerPower: 7 }, models: [model("gpt", "gpt-6.1"), model("claude", "claude-sonnet")], auditLogs: [] } as unknown as Database;
}

test("explicit default setup publishes versioned GPT logic and Claude writing, preserving prices and repeated setup", () => {
  const db = fixture(), prices = structuredClone(db.models);
  const result = setupDefaultExecutors(db, "admin", { publish: true });
  assert.deepEqual(result.added, ["logic", "writing"]);
  for (const [id, modelId] of [["logic", "gpt"], ["writing", "claude"]]) {
    const profile = db.settings.executorProfiles!.find((entry) => entry.id === id)!;
    assert.equal(profile.enabled, true); assert.equal(profile.published!.version, 1);
    assert.equal(profile.published!.modelId, modelId); assert.deepEqual(profile.published!.featureIds, []);
    assert.equal(resolveExecutor(db, id, db.models[0]).model.id, modelId);
  }
  const before = structuredClone(db.settings.executorProfiles);
  const repeated = setupDefaultExecutors(db, "admin", { publish: true });
  assert.deepEqual(repeated.added, []); assert.deepEqual(db.settings.executorProfiles, before);
  assert.deepEqual(db.models, prices);
  assert.throws(() => setupDefaultExecutors(db, "user", { publish: true }), /无权/);
});

test("missing or ambiguous Claude stays unpublished and never silently switches to GPT", () => {
  for (const ambiguous of [false, true]) {
    const db = fixture();
    if (ambiguous) db.models.push(model("claude-two", "claude-opus")); else db.models = db.models.filter((entry) => entry.id !== "claude");
    const result = setupDefaultExecutors(db, "admin", { publish: true });
    const writing = db.settings.executorProfiles!.find((entry) => entry.id === "writing")!;
    assert.equal(writing.enabled, false); assert.equal(writing.published, undefined); assert.equal(writing.draft.modelId, "");
    assert.ok(result.unavailable.some((entry) => entry.id === "writing"));
    assert.throws(() => resolveExecutor(db, "writing", db.models[0]), /停用|发布/);
    assert.throws(() => updateExecutor(db, "admin", "writing", { revision: writing.revision, action: "publish" }), /明确的执行模型/);
  }
});

test("setup preserves administrator drafts and published capabilities and validates all selected models before mutation", () => {
  const db = fixture();
  const custom = updateExecutor(db, "admin", undefined, { revision: 0, action: "draft", values: { ...executorDefaults(), name: "定制逻辑", routingRole: "logic", modelId: "claude", prompt: "administrator draft" } });
  const before = structuredClone(custom);
  setupDefaultExecutors(db, "admin", { publish: true });
  assert.deepEqual(db.settings.executorProfiles![0], before);
  assert.equal(db.settings.executorProfiles!.length, 2);
  const fresh = fixture();
  assert.throws(() => setupDefaultExecutors(fresh, "admin", { publish: true, logicModelId: "gpt", writingModelId: "gpt" }), /Claude/);
  assert.deepEqual(fresh.settings.executorProfiles, []); assert.equal(fresh.auditLogs.length, 0);
});

test("published routing description and execution prompt are independent immutable versions", () => {
  const db = fixture();
  const profile = updateExecutor(db, "admin", undefined, { revision: 0, action: "draft", values: { ...executorDefaults(), description: "什么时候用 A", prompt: "具体怎么做 A", modelId: "gpt" } });
  updateExecutor(db, "admin", profile.id, { revision: 1, action: "publish" });
  updateExecutor(db, "admin", profile.id, { revision: 2, action: "draft", values: { ...executorDefaults(), description: "什么时候用 B", prompt: "具体怎么做 B", modelId: "claude" } });
  assert.equal(resolveExecutor(db, profile.id, db.models[0]).values.description, "什么时候用 A");
  updateExecutor(db, "admin", profile.id, { revision: 3, action: "publish" });
  assert.equal(resolveExecutor(db, profile.id, db.models[0]).values.description, "什么时候用 B");
  assert.equal(db.settings.executorProfiles![0].history[0].description, "什么时候用 A");
  updateExecutor(db, "admin", profile.id, { revision: 4, action: "pause" });
  assert.throws(() => resolveExecutor(db, profile.id, db.models[0]), /停用/);
});

test("routing role resolves custom persisted IDs, rejects unavailable profiles and avoids ambiguous aliases", () => {
  const db = fixture();
  const custom = updateExecutor(db, "admin", undefined, { revision: 0, action: "draft", values: { ...executorDefaults(), routingRole: "logic", modelId: "gpt" } });
  updateExecutor(db, "admin", custom.id, { revision: 1, action: "publish" });
  setupDefaultExecutors(db, "admin", { publish: true });
  assert.equal(db.settings.executorProfiles!.some((profile) => profile.id === "logic"), false);
  assert.equal(resolveRoutingExecutorId(db, "logic"), custom.id);
  const second = updateExecutor(db, "admin", undefined, { revision: 0, action: "draft", values: { ...executorDefaults(), routingRole: "logic", modelId: "gpt" } });
  updateExecutor(db, "admin", second.id, { revision: 1, action: "publish" });
  assert.throws(() => resolveRoutingExecutorId(db, "logic"), /多个/);
  updateExecutor(db, "admin", second.id, { revision: 2, action: "pause" });
  assert.equal(resolveRoutingExecutorId(db, "logic"), custom.id);
  updateExecutor(db, "admin", custom.id, { revision: 2, action: "pause" });
  assert.throws(() => resolveRoutingExecutorId(db, "logic"), /停用/);
  assert.equal(resolveRoutingExecutorId(db, "writing"), "writing");
  db.models.find((model) => model.id === "claude")!.enabled = false;
  assert.throws(() => resolveRoutingExecutorId(db, "writing"), /停用/);
});

test("default setup extends an enabled dispatcher tools while retaining published model, prompt, prices and unfinished draft", () => {
  const db = fixture(), values = { ...defaultTaskValues("coordinator"), enabled: true, modelId: "gpt", prompt: "published router", tools: ["delegate_task", "read_task"] };
  db.settings.aiTasks = { coordinator: { revision: 4, draft: { ...values, prompt: "unfinished custom draft", modelId: "claude" }, published: { ...values, version: 2, publishedAt: "before", publishedBy: "admin" }, history: [] } };
  const models = structuredClone(db.models);
  const result = setupDefaultExecutors(db, "admin", { publish: true });
  const coordinator = db.settings.aiTasks.coordinator!;
  assert.equal(result.coordinatorUpdated, true); assert.equal(coordinator.published!.version, 3);
  assert.equal(coordinator.published!.prompt, "published router"); assert.equal(coordinator.published!.modelId, "gpt");
  assert.equal(coordinator.draft.prompt, "unfinished custom draft"); assert.equal(coordinator.draft.modelId, "claude");
  assert.ok(coordinator.published!.tools.includes("delegate_tasks")); assert.ok(coordinator.published!.tools.includes("generate_image"));
  assert.equal(setupDefaultExecutors(db, "admin", { publish: true }).coordinatorUpdated, false);
  assert.deepEqual(db.models, models);
  coordinator.published!.enabled = false; coordinator.published!.tools = [];
  assert.equal(setupDefaultExecutors(db, "admin", { publish: true }).coordinatorUpdated, false);
  assert.equal(coordinator.published!.enabled, false);
});
