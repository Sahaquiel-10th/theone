import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// Source contracts complement the browser wheel, disclosure and split checks.
// They guard the fixed-height/overflow regressions that originally hid Edit.
const css=readFileSync(new URL('./avatar-workbench.css',import.meta.url),'utf8');
function rule(selector:string){
  const start=css.indexOf(`${selector} {`);
  assert.notEqual(start,-1,`Missing scoped rule: ${selector}`);
  return css.slice(start,css.indexOf('}',start)+1);
}
const scope='main.one-fluid-workspace.one-shell.one-studio .fluid-formal-work-layer .sharing-panel.sharing-hierarchy';

test('avatar records derive their height from content rather than fixed scroll cards',()=>{
  const record=rule(`${scope} .sharing-owner-cards>.sharing-owner>.sharing-owner-split`);
  assert.match(record,/height:auto;/);
  assert.match(record,/max-height:none;/);
  assert.match(record,/display:grid;/);
  assert.match(record,/transition:none;/);
  assert.doesNotMatch(record,/height:\s*(?:108|132|178|246)px/);
});

test('both share-record children participate in row sizing and never trap list wheel input',()=>{
  const start=css.indexOf(`${scope} .sharing-owner-split>.fluid-split-primary,`);
  const children=css.slice(start,css.indexOf('}',start)+1);
  assert.match(children,/sharing-owner-split>\.fluid-split-secondary/);
  assert.match(children,/position:relative;/);
  assert.match(children,/grid-area:1\/1;/);
  assert.match(children,/overflow:visible;/);
  assert.match(children,/overscroll-behavior:auto;/);
  assert.doesNotMatch(children,/overflow:\s*(?:auto|scroll)/);
  assert.match(rule(`${scope} .sharing-owner-split>.fluid-split-secondary[hidden]`),/display:none;/);
  assert.match(rule(`${scope} .sharing-workspace-split>.fluid-split-primary`),/overflow-y:auto;/);
});

test('editor hosts delegate scrolling to their full-height form and debug panes',()=>{
  assert.match(rule(`${scope} .sharing-workspace-split>.fluid-split-secondary:has(.avatar-editor-workbench)`),/overflow:hidden;/);
  assert.match(rule(`${scope} .sharing-workspace-split>.fluid-split-secondary[hidden]`),/display:none;/);
  assert.match(rule(`${scope} .sharing-subview:has(.avatar-editor-workbench)>.sharing-subview-body`),/overflow:hidden;/);
  assert.match(rule(`${scope} .avatar-editor-split`),/--fluid-split-height:100%;/);
  assert.match(rule('.sharing-hierarchy .avatar-editor-split>.fluid-split-secondary'),/overflow-y:auto;/);
});

test('debug mode yields list room without deleting the list or the editor split material',()=>{
  assert.match(rule(`${scope}.avatar-debug-open>.sharing-workspace-split>.fluid-split-primary`),/display:none;/);
  assert.match(rule(`${scope}.avatar-debug-open>.sharing-workspace-split>.fluid-split-secondary`),/width:100%;/);
  assert.match(rule(`${scope}.avatar-debug-open>.sharing-workspace-split>.fluid-split-material`),/display:none;/);
  assert.doesNotMatch(css,/avatar-editor-split[^{}]*>\.fluid-split-material\s*\{[^}]*display:none/);
});

test('avatar-only sizing keeps the plain list bounded and section hierarchy readable',()=>{
  assert.match(rule('main.one-fluid-workspace.one-shell.one-studio .one-settings-dialog.fluid-work-layer.fluid-work-layer-avatars:not(.is-maximized)'),/width:min\(1480px,calc\(100vw - 64px\)\)/);
  assert.match(rule('main.one-fluid-workspace.one-shell.one-studio .one-settings-dialog.fluid-work-layer.fluid-work-layer-avatars:not(.is-maximized):has(.sharing-workspace-split[data-split-open=false])'),/width:min\(1040px/);
  assert.match(rule('.sharing-hierarchy .avatar-editor-section'),/border-bottom:1px solid var\(--fluid-line/);
  assert.match(css,/\.avatar-debug-panel\) :is\(button,a\):focus-visible/);
});
