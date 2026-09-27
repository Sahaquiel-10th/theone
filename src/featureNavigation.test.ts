import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const main = fs.readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const sharing = fs.readFileSync(new URL("./PublicSharing.tsx", import.meta.url), "utf8");
test("features is a top-level destination; knowledge and OAuth returns live in settings", () => {
  const nav = main.slice(main.indexOf('<nav className="studio-navigation"'), main.indexOf('<div className="one-chrome-actions"'));
  assert.match(nav, />功能<\/button>/);
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
});
