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

test('public service ceiling allows only bounded reviewed feature namespaces, not underlying global tools', () => {
  const names = ['knowledge_search', 'public_feature_0', 'public_feature_3', 'public_oneFinance', 'public_oneTable', 'public_oneHtml', 'public_oneFlowchart', 'public_oneWorkbook', 'public_oneDocument'];
  for (const entryPoint of ['published_web', 'published_api'] as const) {
    const input = { entryPoint, configured: names, granted: names, available: names.map(name => ({ name, localOnly: false })) };
    assert.deepEqual(intersectTaskTools(input), names);
    for (const name of ['public_feature_4', 'public_feature_00', 'public_feature_-1', 'public_feature_0_extra', 'public_oneSlides', 'public_oneImage', 'public_web_search', 'oneFinance', 'oneHtml', 'public_oneFinance__proto__']) {
      assert.deepEqual(intersectTaskTools({ ...input, configured: [name], granted: [name], available: [{ name, localOnly: false }] }), []);
    }
  }
});
