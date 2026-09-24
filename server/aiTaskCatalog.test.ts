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
    assert.deepEqual(intersectTaskTools({ ...policy, entryPoint }), []);
  }
  assert.deepEqual(intersectTaskTools({ ...policy, granted: [], entryPoint: "workspace" }), []);
});

test("public QA ceiling cannot be widened by grants, global configuration or localOnly labels", () => {
  const names = ["knowledge_search", "web_search", "write_file", "read_file", "run_command", "save_note", "send_message", "publish", "image_generation", "attachment_summary", "execution_compile", "local_agent", "new_future_tool"];
  for (const entryPoint of ["published_web", "published_api"] as const) {
    const input = { entryPoint, configured: names, granted: names, available: names.map(name => ({ name, localOnly: false })) };
    assert.deepEqual(intersectTaskTools(input), ["knowledge_search"]);
    assert.deepEqual(intersectTaskTools({ ...input, granted: [] }), []);
    assert.deepEqual(intersectTaskTools({ ...input, available: [{ name: "knowledge_search", localOnly: true }] }), []);
    assert.deepEqual(intersectTaskTools({ ...input, entryPoint: "unknown" as never }), []);
  }
});
