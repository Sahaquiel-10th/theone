import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const main = fs.readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const sharing = fs.readFileSync(new URL("./PublicSharing.tsx", import.meta.url), "utf8");
import {primaryWorkspaceNavigation} from './industryWorkspaceState';
test('preview preserves the main conversation and result identity across navigation',()=>{
 assert.match(main,/preview.enabled&&preview.state.dialogue.length>0\?renderMainConversation\(\)/);
 assert.match(main,/renderConversation=\{preview.enabled\?renderMainConversation:undefined\}/);
 assert.match(main,/demo.enabled\?<ResultSignal/);
 assert.match(main,/coordinator.enabled && view==='chat' \? <TaskTransferRail/);
 const shelf=fs.readFileSync(new URL('./preview/FeatureShelf.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(shelf,/我的分身|SharingPanel/);
 assert.match(shelf,/Skills 列表/);
 const signal=fs.readFileSync(new URL('./preview/ResultSignal.tsx',import.meta.url),'utf8');
 assert.match(signal,/if\(open\)onDismiss\(\)/);
});
test('avatars and features have independent destinations in both navigation paths',()=>{
 const shelf=fs.readFileSync(new URL('./preview/FeatureShelf.tsx',import.meta.url),'utf8');
 const marketplace=fs.readFileSync(new URL('./FeatureMarketplace.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(shelf,/SharingPanel|我的分身/);
 assert.doesNotMatch(marketplace,/SharingPanel|我的分身|setKind|kind==='personal'/);
 assert.match(marketplace,/<FeatureShelf maxSelected=\{1\} api=\{api\}/);
 assert.equal(primaryWorkspaceNavigation.find(item=>item.id==='avatars')?.label,'分身');
 assert.equal((main.match(/primaryWorkspaceNavigation.map/g)||[]).length,2);
 assert.match(main,/<FluidWorkLayer title="分身" open=\{!industryPage.open&&workLayer==='avatars'\} className="fluid-work-layer-avatars"/);
});
test("features is a top-level destination; knowledge and OAuth returns live in settings", () => {
  const nav = main.slice(main.indexOf('<nav className="studio-navigation"'), main.indexOf('<div className="one-chrome-actions"'));
  assert.match(nav,/primaryWorkspaceNavigation.map/);
  assert.deepEqual(primaryWorkspaceNavigation.map(item=>item.label),['主页','任务','Skills','行业工作台','分身']);
  assert.doesNotMatch(nav, />知识<\/button>/);
  assert.doesNotMatch(nav, />管理<\/button>/);
  assert.match(main, /next === "knowledge" \? "account" : next/);
  assert.match(main, /AccountPreferencesLayout section=\{section\}/);
  assert.match(fs.readFileSync(new URL('./AccountPreferencesLayout.tsx',import.meta.url),'utf8'), /id:'knowledge',label:'连接与授权'/);
  assert.doesNotMatch(main, /\["sharing", "分享分身"\]/);
});
test("cost disclosure is compact and live/public changes retain explicit fee consent", () => {
  assert.match(sharing, /summary aria-label="查看分身费用说明"/);
  assert.match(sharing, /从你的余额扣除/);
  assert.match(sharing, /!privateEditor\?<label[^>]*><input form=\{editorFormId\} required type="checkbox" checked=\{draft.confirmed\}/);
});
test("only the logo moves; previous page cannot leave a double-image trail", () => {
  const css = fs.readFileSync(new URL("./one-studio.css", import.meta.url), "utf8");
  assert.match(css, /studio-presence > \.one-presence \{ view-transition-name: one-presence-logo/);
  assert.match(css, /view-transition-old\(root\) \{ display: none/);
  const motion = fs.readFileSync(new URL('./interruptibleEye.ts',import.meta.url),'utf8');
  assert.match(main, /eyeMotion.current!.move\(\(\)=>flushSync\(update\)/);
  assert.match(motion, /pointerEvents:'none'/);
  assert.match(motion, /\(ghost \|\| visible\(\)\)\?\.getBoundingClientRect/);
  assert.doesNotMatch(motion, /startViewTransition/);
  assert.match(main, /eyeRoute\(view,/);
  assert.match(motion, /route === 'edge'/);
  assert.match(motion, /window.innerWidth, true/);
});
test('equipment view displays authorized capabilities without pretending automatic calling is live',()=>{
 const catalog=fs.readFileSync(new URL('./FeatureCatalog.tsx',import.meta.url),'utf8');
 const marketplace=fs.readFileSync(new URL('./FeatureMarketplace.tsx',import.meta.url),'utf8');
 assert.match(catalog,/对话自动调用 · 待接入/);
 assert.match(catalog,/已为你开放/);
 assert.match(marketplace,/onDone=\{onAsk\}/);
 assert.match(marketplace,/selected=\{selected\} onChoose=\{onChoose\}/);
 assert.match(catalog,/if\(selectionOnly\)return/);
 assert.doesNotMatch(marketplace,/<details[^>]*equipment-find/);
 assert.doesNotMatch(marketplace,/CapabilityMap/);
});
