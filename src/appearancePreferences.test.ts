import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { resolvedAppearanceScene } from "./appearancePreferences.js";
import type { AccountProfile } from "./Onboarding.js";

const profile: AccountProfile = { workspaceId: "a", displayName: "", onboarding: { knowledgeChoice: "pending" }, updatedAt: "today" };

test("existing accounts use graphite without inventing a persisted preference", () => {
  assert.equal(resolvedAppearanceScene(), "graphite");
  assert.equal(resolvedAppearanceScene(null), "graphite");
  assert.equal(resolvedAppearanceScene(profile), "graphite");
  assert.equal(profile.appearance, undefined);
  assert.equal(resolvedAppearanceScene({ appearance: { scene: "silver" } }), "silver");
  assert.equal(resolvedAppearanceScene({ appearance: { scene: "invalid" } } as unknown as AccountProfile), "graphite");
});

test("appearance settings render two keyboard-accessible choices and distinguish execution from the saved scene", () => {
  let saves = 0;
  const html = renderToStaticMarkup(createElement(AppearanceSettings, { profile, onSave: async () => { saves++; } }));
  assert.equal(saves, 0);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.match(html.match(/<input[^>]*value="graphite"[^>]*>/)?.[0] ?? "", /checked=""/);
  assert.match(html, /石墨框景/);
  assert.match(html, /浅银光场/);
  assert.doesNotMatch(html, /两种外观保留相同的布局|选择会随账号保存/);
  assert.match(html, /本机执行时会暂时转黑/);
  assert.doesNotMatch(html, /localStorage|跟随系统|执行已完成/);
  const silver = renderToStaticMarkup(createElement(AppearanceSettings, { profile: { ...profile, appearance: { scene: "silver" } }, onSave: async () => {} }));
  assert.match(silver.match(/<input[^>]*value="silver"[^>]*>/)?.[0] ?? "", /checked=""/);
  assert.doesNotMatch(silver.match(/<input[^>]*value="graphite"[^>]*>/)?.[0] ?? "", /checked=""/);
});
