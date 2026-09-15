import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { BetaFeedbackControls, Onboarding, ProfileNameEditor, type AccountProfile } from "./Onboarding.js";
import { BetaUserInsights } from "./BetaUserInsights.js";

const profile: AccountProfile = { workspaceId: "w", displayName: "", onboarding: { knowledgeChoice: "pending" }, updatedAt: "2026-01-01T00:00:00Z" };

test("onboarding starts with a nickname and completed accounts see no repeat welcome", () => {
  const props = { profile, knowledgeConnected: false, onSave: async () => undefined, onOpenKnowledge: () => undefined, onStartQuestion: () => undefined };
  const welcome = renderToStaticMarkup(createElement(Onboarding, props));
  assert.ok(welcome.includes("怎么称呼你"));
  assert.ok(welcome.includes('autoComplete="nickname"'));
  assert.ok(!welcome.includes("password"));
  assert.ok(!welcome.includes("不用设置一大堆东西"));
  assert.ok(!welcome.includes("很高兴认识你"));
  assert.equal(renderToStaticMarkup(createElement(Onboarding, { ...props, profile: { ...profile, displayName: "A", onboarding: { knowledgeChoice: "skipped", nameSetAt: "today", completedAt: "today" } } })), "");
});

test("knowledge onboarding is action-first and keeps only the required disclosure", () => {
  const props = { knowledgeConnected: false, onSave: async () => undefined, onOpenKnowledge: () => undefined, onStartQuestion: () => undefined };
  const knowledge = renderToStaticMarkup(createElement(Onboarding, { ...props, profile: { ...profile, displayName: "小马", onboarding: { knowledgeChoice: "pending", nameSetAt: "today" } } }));
  assert.ok(knowledge.includes("小马，连接你的知识"));
  assert.ok(knowledge.includes("连接知识来源"));
  assert.ok(!knowledge.includes("换电脑不用重来"));
  const ready = renderToStaticMarkup(createElement(Onboarding, { ...props, profile: { ...profile, displayName: "小马", onboarding: { knowledgeChoice: "skipped", nameSetAt: "today" } } }));
  assert.ok(ready.includes("现在，问我一件事"));
  assert.ok(ready.includes("保持 ONE Key 插入"));
  assert.ok(!ready.includes("从一件真实的事开始"));
});

test("profile names render as plain text and feedback does not reveal a saved shared comment before expanding", () => {
  const name = renderToStaticMarkup(createElement(ProfileNameEditor, { profile: { ...profile, displayName: "<script>bad</script>" }, onSave: async () => undefined }));
  assert.ok(!name.includes("<script>"));
  const feedback = renderToStaticMarkup(createElement(BetaFeedbackControls, { messageId: "m", feedback: { id: "f", messageId: "m", rating: "helped", sharedComment: true, comment: "a saved optional comment", updatedAt: "today" }, onSave: async () => { throw new Error("not clicked"); } }));
  assert.ok(feedback.includes("帮上忙了"));
  assert.ok(!feedback.includes("a saved optional comment"));
});

test("per-user beta insights starts folded without requesting or rendering any other user's data", () => {
  let requests = 0;
  const html = renderToStaticMarkup(createElement(BetaUserInsights, { userId: "a", api: async <T,>() => { requests++; return {} as T; } }));
  assert.equal(requests, 0);
  assert.ok(html.includes("实际使用与内测反馈"));
  assert.ok(!html.includes("one-beta-insights-body"));
});
