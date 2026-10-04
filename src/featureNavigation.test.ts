import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const main = fs.readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const sharing = fs.readFileSync(new URL("./PublicSharing.tsx", import.meta.url), "utf8");
const featureNav = fs.readFileSync(new URL("./FeatureNav.tsx", import.meta.url), "utf8");
test('preview preserves the main conversation and result identity across navigation',()=>{
 assert.match(main,/preview.enabled&&preview.state.dialogue.length>0\?<CoordinatorConversation/);
 assert.match(main,/preview.enabled\?<ResultSignal/);
 const shelf=fs.readFileSync(new URL('./preview/FeatureShelf.tsx',import.meta.url),'utf8');
 assert.match(shelf,/我的分身/);
 assert.match(shelf,/<SharingPanel api=\{api\} models=\{models\}/);
 const signal=fs.readFileSync(new URL('./preview/ResultSignal.tsx',import.meta.url),'utf8');
 assert.match(signal,/if\(open\)onDismiss\(\)/);
});
test("features is a top-level destination; knowledge and OAuth returns live in settings", () => {
  const nav = main.slice(main.indexOf('<nav className="studio-navigation"'), main.indexOf('<div className="one-chrome-actions"'));
  assert.match(nav, /<FeatureNav/);
  assert.match(nav, /canPeekAtFeatures/);
  assert.match(nav, /openSurface\('features'\)/);
  assert.match(featureNav, /<span>功能<\/span>/);
  assert.doesNotMatch(nav, />知识<\/button>/);
  assert.match(nav, /user.role === "admin"/);
  assert.match(main, /next === "knowledge" \? "account" : next/);
  assert.match(main, /\["knowledge", "知识连接"\]/);
  assert.doesNotMatch(main, /\["sharing", "分享分身"\]/);
});
test("cost disclosure is compact but explicit fee consent remains required", () => {
  assert.match(sharing, /summary aria-label="查看分身费用说明"/);
  assert.match(sharing, /从你的余额扣除/);
  assert.match(sharing, /input required type="checkbox" checked=\{draft.confirmed\}/);
});
test("only the logo moves; previous page cannot leave a double-image trail", () => {
  const css = fs.readFileSync(new URL("./one-studio.css", import.meta.url), "utf8");
  assert.match(css, /studio-presence > \.one-presence \{ view-transition-name: one-presence-logo/);
  assert.match(css, /view-transition-old\(root\) \{ display: none/);
  assert.match(main, /interfaceTransition.current !== transition/);
  assert.match(main, /interfaceTransition.current\?\.skipTransition/);
  assert.match(main, /eyeRoute\(view,/);
  assert.match(main, /if\(route==='edge'&&previousEye&&nextEye\)/);
  assert.match(main, /window.innerWidth,true/);
});
test('equipment view displays authorized capabilities without pretending automatic calling is live',()=>{
 const catalog=fs.readFileSync(new URL('./FeatureCatalog.tsx',import.meta.url),'utf8');
 const marketplace=fs.readFileSync(new URL('./FeatureMarketplace.tsx',import.meta.url),'utf8');
 assert.match(catalog,/对话自动调用 · 待接入/);
 assert.match(catalog,/已为你开放/);
 assert.match(marketplace,/回到 ONE 对话/);
 assert.match(marketplace,/搜索功能市场/);
 assert.doesNotMatch(marketplace,/<details[^>]*equipment-find/);
 assert.doesNotMatch(marketplace,/CapabilityMap/);
});
