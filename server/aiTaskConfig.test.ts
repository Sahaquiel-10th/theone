import test from "node:test";
import assert from "node:assert/strict";
import { defaultTaskValues, resolveAiTask, updateTaskConfig, validateTaskValues } from "./aiTaskConfig.js";
import type { ModelConfig, SystemSettings } from "./types.js";

const model = { id: "a", enabled: true, kind: "chat", systemPrompt: "base", apiKey: "not-for-client" } as ModelConfig;
const second = { ...model, id: "b" };
const settings = (): SystemSettings => ({ safetyRules: "immutable", rechargeCnyPerPower: 7 });
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
  for (const id of ["__proto__", "orchestrator", "unknown"]) assert.throws(() => validateTaskValues(id, defaultTaskValues(id), [model]));
  assert.throws(() => validateTaskValues("image_generation", { ...defaultTaskValues("image_generation"), modelId: "a" }, [model]));
  assert.throws(() => validateTaskValues("chat", { ...defaultTaskValues("chat"), tools: ["run_command"] }, [model]));
  assert.throws(() => validateTaskValues("local_agent", { ...defaultTaskValues("local_agent"), maxSteps: 999 }, [model]));
  assert.deepEqual(validateTaskValues("local_agent", { ...defaultTaskValues("local_agent"), tools: [] }, [model]).tools, []);
});
