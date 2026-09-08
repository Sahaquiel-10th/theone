import assert from "node:assert/strict";
import test from "node:test";
import { buildContextTraceSections } from "./contextTrace.js";

test("context trace separates every model input into readable text sections", () => {
  const sections = buildContextTraceSections({
    safetyRules: "安全规则", modelPrompt: "模型提示词", knowledgeContext: "召回片段",
    attachmentContext: "附件正文", webSearchContext: "",
    history: [{ role: "user", content: "上一问", modelId: "m1", createdAt: "2026-01-01T00:00:00.000Z" }],
    currentInput: "这一问"
  });
  assert.equal(sections.length, 7);
  assert.match(sections.find((item) => item.key === "history")?.content || "", /【1 · 用户】\n上一问/);
});
