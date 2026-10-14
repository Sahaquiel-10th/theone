import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { Database, ModelConfig } from "./types.js";
import type { Store } from "./db.js";
import { adminCapabilityCatalog, routingCapabilities } from "./capabilityCatalog.js";
import { installCapabilityRoutes } from "./capabilityRoutes.js";
import { executorDefaults, setupDefaultExecutors, updateExecutor } from "./executorProfiles.js";
import { defaultTaskValues } from "./aiTaskConfig.js";
import type { OfficialFeatureRecord } from "./officialFeatures.js";

function fixture(): Database {
  const models = [
    { id: "gpt", model: "gpt-6.1", name: "GPT", kind: "chat", isDefault: true },
    { id: "claude", model: "claude-sonnet", name: "Claude", kind: "chat" },
    { id: "image", model: "gpt-image", name: "图片模型", kind: "image", isDefault: true, imagePowerPerCall: .2, costImagePowerPerCall: .02 },
  ].map((model) => ({ ...model, enabled: true, apiKey: "SECRET_DO_NOT_EXPOSE", baseUrl: "https://private-provider.invalid/v1", provider: "private-provider", protocol: "openai", systemPrompt: "PRIVATE_MODEL_PROMPT", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: .2, costOutputPowerPerMillion: .4, createdAt: "fixture" })) as ModelConfig[];
  const imageValues = { ...defaultTaskValues("image_generation"), modelId: "image" };
  return { models, users: [{ id: "admin", role: "admin", enabled: true }, { id: "a", role: "user", enabled: true }, { id: "b", role: "user", enabled: true }], workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ userId: "a", workspaceId: "wa", role: "owner" }, { userId: "b", workspaceId: "wb", role: "owner" }], settings: { safetyRules: "safe", rechargeCnyPerPower: 7, aiTasks: { image_generation: { revision: 1, draft: imageValues, published: { ...imageValues, version: 1, publishedAt: "fixture", publishedBy: "admin" }, history: [] } } }, auditLogs: [] } as unknown as Database;
}
function feature(id: string, userId: string, mode: "text" | "image" = "text"): OfficialFeatureRecord {
  const values = { name: id, description: `仅授权用户 ${userId}`, author: "ONE", instructions: "PRIVATE_EXECUTION_PROMPT", limitations: "只处理授权范围", integration: "question_answer" as const, modelId: mode === "image" ? "image" : "gpt", usageMultiplier: 1.2, experience: { mode, inputs: [], actions: [{ id: "run", label: "开始", instruction: "完成任务" }] } };
  const version = { version: 1, values, evidence: "Synthetic evidence", approvedBy: "admin", approvedAt: "fixture" };
  return { id, revision: 2, status: "approved", draft: values, current: version, history: [version], release: { id: `release-${id}`, version: 1, userIds: [userId], publishedAt: "fixture", publishedBy: "admin" } };
}

test("routing catalog only exposes real output types and scoped released capabilities without credentials", () => {
  const db = fixture(); setupDefaultExecutors(db, "admin", { publish: true });
  db.settings.officialFeatures = [feature("own-text", "a"), feature("own-image", "a", "image"), feature("foreign-secret", "b")];
  const own = routingCapabilities(db, { workspaceId: "wa", userId: "a" }, { imageStorageAvailable: true });
  assert.ok(own.some((card) => card.executorId === "logic" && card.modelId === "gpt"));
  assert.ok(own.some((card) => card.executorId === "writing" && card.modelId === "claude"));
  assert.ok(own.some((card) => card.executorId === "image_generation" && card.outputKinds[0] === "image"));
  assert.deepEqual(own.find((card) => card.featureId === "own-image")!.outputKinds, ["image"]);
  assert.equal(own.find((card) => card.featureId === "own-text")!.usageMultiplier, 1.2);
  assert.ok(!own.some((card) => card.featureId === "foreign-secret"));
  assert.ok(!own.some((card) => card.outputKinds.includes("local_file")));
  assert.ok(routingCapabilities(db, { workspaceId: "wa", userId: "a" }, { localAvailable: true }).some((card) => card.executorId === "local_special"));
  assert.doesNotMatch(JSON.stringify(own), /SECRET_DO_NOT_EXPOSE|private-provider|PRIVATE_MODEL_PROMPT|PRIVATE_EXECUTION_PROMPT|foreign-secret/);
  assert.throws(() => routingCapabilities(db, { workspaceId: "wb", userId: "a" }), /空间/);
  db.models.find((model) => model.id === "image")!.enabled = false;
  assert.ok(!routingCapabilities(db, { workspaceId: "wa", userId: "a" }).some((card) => card.mode === "image"));
});

test("image routing only becomes available after published binding, per-image pricing and result storage are ready", () => {
  const scope = { workspaceId: "wa", userId: "a" }, db = fixture();
  const image = () => adminCapabilityCatalog(db, { imageStorageAvailable: true }).find((card) => card.executorId === "image_generation")!;
  assert.equal(image().available, true);
  assert.equal(adminCapabilityCatalog(db).find((card) => card.executorId === "image_generation")!.available, false);
  assert.ok(!routingCapabilities(db, scope).some((card) => card.executorId === "image_generation"));
  const saved = structuredClone(db.settings.aiTasks!.image_generation);
  delete db.settings.aiTasks!.image_generation;
  assert.equal(image().available, false); assert.match(image().unavailableReason!, /发布图片/);
  db.settings.aiTasks!.image_generation = saved;
  db.settings.aiTasks!.image_generation!.published!.modelId = "";
  assert.equal(image().available, false);
  db.settings.aiTasks!.image_generation!.published!.modelId = "image";
  const model = db.models.find((entry) => entry.id === "image")!;
  for (const [price, cost] of [[0, .02], [-1, .02], [.2, -1], [.2, NaN], [Infinity, 0]]) {
    model.imagePowerPerCall = price; model.costImagePowerPerCall = cost;
    assert.equal(image().available, false); assert.match(image().unavailableReason!, /额度/);
  }
  model.imagePowerPerCall = .2; model.costImagePowerPerCall = 0;
  assert.equal(image().available, true);
});

test("text executor description cannot invent image output or override an unauthorized bound feature", () => {
  const db = fixture(); db.settings.officialFeatures = [feature("foreign-secret", "b")];
  const profile = updateExecutor(db, "admin", undefined, { revision: 0, action: "draft", values: { ...executorDefaults(), name: "声称会画图", description: "会生成图", modelId: "gpt", featureIds: ["foreign-secret"] } });
  updateExecutor(db, "admin", profile.id, { revision: 1, action: "publish" });
  assert.deepEqual(adminCapabilityCatalog(db).find((card) => card.executorId === profile.id)!.outputKinds, ["text"]);
  assert.ok(!routingCapabilities(db, { workspaceId: "wa", userId: "a" }).some((card) => card.executorId === profile.id));
  assert.ok(routingCapabilities(db, { workspaceId: "wb", userId: "b" }).some((card) => card.executorId === profile.id));
});

test("unified management routes require administrator Key, setup uses authenticated actor and retains existing data", async (t) => {
  let db = fixture();
  const store: Store = { read: async () => db, mutate: async (action) => { const previous = structuredClone(db); try { return action(db); } catch (error) { db = previous; throw error; } } };
  const app = express(); app.use(express.json());
  installCapabilityRoutes(app, [(req, res, next) => {
    if (req.headers["x-key"] !== "present") { res.sendStatus(428); return; }
    if (req.headers["x-role"] !== "admin") { res.sendStatus(403); return; }
    req.user = { id: "admin" } as any; next();
  }], store);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/admin/capabilities`, headers = { "Content-Type": "application/json", "x-key": "present", "x-role": "admin" };
  for (const [path, method] of [["", "GET"], ["/defaults/setup", "POST"]]) {
    assert.equal((await fetch(url + path, { method })).status, 428);
    assert.equal((await fetch(url + path, { method, headers: { ...headers, "x-role": "user" } })).status, 403);
  }
  assert.equal((await fetch(url + "/defaults/setup", { method: "POST", headers, body: JSON.stringify({ publish: true, actorId: "b" }) })).status, 400);
  const created = await fetch(url + "/defaults/setup", { method: "POST", headers, body: JSON.stringify({ publish: true }) }); assert.equal(created.status, 200);
  assert.ok(db.auditLogs.every((row) => row.actorUserId === "admin"));
  const before = structuredClone(db.settings.executorProfiles);
  await fetch(url + "/defaults/setup", { method: "POST", headers, body: JSON.stringify({ publish: true }) });
  assert.deepEqual(db.settings.executorProfiles, before);
  const catalog = await (await fetch(url, { headers })).json(); assert.ok(catalog.items.some((card: any) => card.executorId === "writing"));
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET_DO_NOT_EXPOSE|private-provider|PRIVATE_MODEL_PROMPT/);
});
