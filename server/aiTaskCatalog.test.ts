import assert from "node:assert/strict";
import test from "node:test";
import { aiTaskCatalog, findAiTaskDefinition, intersectTaskTools } from "./aiTaskCatalog.js";

test("AI inventory covers auxiliary calls, not just orchestration", () => {
  assert.equal(new Set(aiTaskCatalog.map(task => task.id)).size, aiTaskCatalog.length);
  for (const kind of ["chat", "attachment_summary", "execution_compile", "local_agent", "image_generation", "orchestrator"]) {
    assert.ok(findAiTaskDefinition(kind));
  }
  assert.equal(findAiTaskDefinition("orchestrator")?.implementation, "existing");
  assert.equal(findAiTaskDefinition("unknown"), undefined);
});

test("tool policy intersects all grants and rejects local tools for both published entries", () => {
  const policy = {
    configured: ["search", "write_file", "ungranted", "missing", "search"],
    granted: ["search", "write_file", "missing"],
    available: [{ name: "search", localOnly: false }, { name: "write_file", localOnly: true }, { name: "ungranted", localOnly: false }]
  };
  assert.deepEqual(intersectTaskTools({ ...policy, entryPoint: "workspace" }), ["search", "write_file"]);
  for (const entryPoint of ["published_web", "published_api"] as const) {
    assert.deepEqual(intersectTaskTools({ ...policy, entryPoint }), ["search"]);
  }
  assert.deepEqual(intersectTaskTools({ ...policy, granted: [], entryPoint: "workspace" }), []);
});
