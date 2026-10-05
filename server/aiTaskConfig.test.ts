import test from "node:test";
import assert from "node:assert/strict";
import { defaultTaskValues, editableTaskValues, resolveAiTask, updateTaskConfig, validateTaskValues } from "./aiTaskConfig.js";
import type { ModelConfig, SystemSettings } from "./types.js";
import { aiTaskCatalog } from "./aiTaskCatalog.js";

const model = { id: "a", enabled: true, kind: "chat", systemPrompt: "base", apiKey: "not-for-client" } as ModelConfig;
const second = { ...model, id: "b" };
const settings = (): SystemSettings => ({ safetyRules: "immutable", rechargeCnyPerPower: 7 });
test("coordinator attachment handoff guidance stays editable, without replacing published prompts", () => {
  const preset = defaultTaskValues("coordinator");
  assert.match(preset.prompt, /attachmentsRequireDelegation=true/);
  assert.match(preset.prompt, /并没有附件正文/);
  assert.match(preset.prompt, /必须调用 delegate_task/);
  const s = settings();
  updateTaskConfig(s, [model], "coordinator", { revision: 0, action: "draft", values: { ...preset, prompt: "管理员自定义分派", enabled: true } }, "admin", "t1");
  updateTaskConfig(s, [model], "coordinator", { revision: 1, action: "publish" }, "admin", "t2");
  assert.equal(resolveAiTask(s, [model], "coordinator", model).values.prompt, "管理员自定义分派");
});
test("every implemented AI role has an editable runtime prompt and model binding",()=>{
 for(const role of aiTaskCatalog){
  const fallback={...model,kind:role.modelKind} as ModelConfig;
  const defaults=defaultTaskValues(role.id);
  assert.ok(defaults.prompt.trim(),role.id);
  const s=settings();
  assert.equal(resolveAiTask(s,[fallback],role.id,fallback).values.prompt,defaults.prompt);
  updateTaskConfig(s,[fallback],role.id,{revision:0,action:"draft",values:{...defaults,modelId:fallback.id,prompt:"管理员的可编辑指令"}},"admin","t");
  updateTaskConfig(s,[fallback],role.id,{revision:1,action:"publish"},"admin","t");
  assert.equal(resolveAiTask(s,[fallback],role.id,fallback).values.prompt,"管理员的可编辑指令");
 }
});
test("runtime defaults match editable templates, never mutate models or replace published overrides", () => {
  const s = settings();
  for (const id of ["chat", "shared_answer", "attachment_summary", "execution_compile", "local_agent", "orchestrator"] as const) {
    const resolved = resolveAiTask(s, [model], id, model);
    assert.deepEqual(resolved.values, defaultTaskValues(id));
    assert.equal(resolved.model.systemPrompt, `base\n\n${resolved.values.prompt}`);
    assert.equal(resolved.replacesPrompt, true);
  }
  const empty = { ...defaultTaskValues("chat"), prompt: "" };
  updateTaskConfig(s, [model], "chat", { action: "draft", revision: 0, values: empty }, "admin", "t1");
  updateTaskConfig(s, [model], "chat", { action: "publish", revision: 1 }, "admin", "t2");
  assert.equal(resolveAiTask(s, [model], "chat", model).model.systemPrompt, "base");
  assert.equal(model.systemPrompt, "base");
});
test("presets are editable and legacy additive instructions survive conversion", () => {
  const defaults = defaultTaskValues("local_agent");
  assert.ok(defaults.prompt); assert.ok(defaults.toolDescriptions?.read_file);
  const legacy = { modelId: "", prompt: "legacy instructions", tools: [], maxSteps: 1 };
  assert.match(editableTaskValues("local_agent", legacy).prompt, /legacy instructions/);
  assert.deepEqual(editableTaskValues("local_agent", legacy).tools, []);
  assert.throws(() => validateTaskValues("local_agent", { ...defaults, toolDescriptions: { hacked_tool: "call me" } }, [model]));
  assert.equal(defaultTaskValues("orchestrator").enabled, false);
});
test("draft, publish, immutable running snapshot, rollback and optimistic revision", () => {
  const s = settings(); const models = [model, second];
  const values = { ...defaultTaskValues("execution_compile"), modelId: "b", prompt: "new instruction" };
  updateTaskConfig(s, models, "execution_compile", { action: "draft", revision: 0, values }, "admin", "t1");
  assert.equal(resolveAiTask(s, models, "execution_compile", model).model.id, "a");
  assert.throws(() => updateTaskConfig(s, models, "execution_compile", { action: "publish", revision: 0 }, "admin", "t2"));
  updateTaskConfig(s, models, "execution_compile", { action: "publish", revision: 1 }, "admin", "t2");
  const running = resolveAiTask(s, models, "execution_compile", model);
  assert.equal(running.model.id, "b"); assert.equal(running.model.systemPrompt, "base\n\nnew instruction");
  updateTaskConfig(s, models, "execution_compile", { action: "draft", revision: 2, values: defaultTaskValues("execution_compile") }, "admin", "t3");
  updateTaskConfig(s, models, "execution_compile", { action: "publish", revision: 3 }, "admin", "t4");
  assert.equal(running.model.id, "b");
  assert.equal(resolveAiTask(s, models, "execution_compile", model).model.id, "a");
  updateTaskConfig(s, models, "execution_compile", { action: "rollback", revision: 4, version: 1 }, "admin", "t5");
  assert.equal(resolveAiTask(s, models, "execution_compile", model).version, 3);
  assert.equal(resolveAiTask(s, models, "execution_compile", model).model.id, "b");
  assert.equal(s.safetyRules, "immutable"); assert.equal(model.systemPrompt, "base");
  assert.throws(() => resolveAiTask(s, [model, { ...second, enabled: false }], "execution_compile", model));
});
test("unknown/planned tasks, wrong model kind and arbitrary tools fail closed", () => {
  for (const id of ["__proto__", "unknown"]) assert.throws(() => validateTaskValues(id, defaultTaskValues(id), [model]));
  assert.throws(() => validateTaskValues("image_generation", { ...defaultTaskValues("image_generation"), modelId: "a" }, [model]));
  assert.throws(() => validateTaskValues("chat", { ...defaultTaskValues("chat"), tools: ["run_command"] }, [model]));
  assert.throws(() => validateTaskValues("local_agent", { ...defaultTaskValues("local_agent"), maxSteps: 999 }, [model]));
  assert.deepEqual(validateTaskValues("local_agent", { ...defaultTaskValues("local_agent"), tools: [] }, [model]).tools, []);
});
