import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "./types.js";
import { appendOwnerContextTrace, buildContextTraceSections, ownerContextTraces } from "./contextTrace.js";

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

test("context diagnostics never expose another user or workspace to an administrator", () => {
  const contextTraces = [
    { id: "own", workspaceId: "workspace-a", userId: "admin-a" },
    { id: "other-user", workspaceId: "workspace-a", userId: "user-a" },
    { id: "other-workspace", workspaceId: "workspace-b", userId: "admin-a" }
  ];
  const db = { contextTraces } as unknown as Database;
  assert.deepEqual(ownerContextTraces(db, "workspace-a", "admin-a").map(item => item.id), ["own"]);
});

test("one account cannot evict another account's context diagnostics", () => {
  const other = { id: "other", workspaceId: "workspace-b", userId: "user-b", createdAt: "2026-01-01T00:00:00.000Z" };
  const db = { contextTraces: [other] } as unknown as Database;
  for (let index = 0; index < 3; index++) appendOwnerContextTrace(db, {
    id: `own-${index}`, workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", assistantMessageId: `message-${index}`,
    modelId: "model-a", query: "q", responsePreview: "r", sections: [], createdAt: `2026-01-01T00:00:0${index + 1}.000Z`
  }, 2);
  assert.ok(db.contextTraces.some(item => item.id === "other"));
  assert.deepEqual(ownerContextTraces(db, "workspace-a", "user-a").map(item => item.id), ["own-1", "own-2"]);
});
