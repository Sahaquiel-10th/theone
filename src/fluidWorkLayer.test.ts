import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FluidWorkLayer } from "./FluidWorkLayer.js";
import { SettingsDialog } from "./SettingsControls.js";

test("work layer has one native dialog with close and independent maximize controls", () => {
  const html = renderToStaticMarkup(createElement(FluidWorkLayer, { title: "任务详情", eyebrow: "工作台", onClose: () => {}, children: createElement("textarea", { defaultValue: "保留中的草稿" }) }));
  assert.equal((html.match(/<dialog /g) ?? []).length, 1);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-label="放大工作面板"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-label="关闭"/);
  assert.match(html, /保留中的草稿/);
  assert.match(html, /settings-dialog-eyebrow/);
  assert.doesNotMatch(html, /is-maximized/);
  assert.match(html, /<h2[^>]*>任务详情<\/h2>/);
});

test("large workspaces can start maximized and title text remains escaped", () => {
  const html = renderToStaticMarkup(createElement(FluidWorkLayer, { title: "<任务>", initialMaximized: true, className: "task-review", onClose: () => {}, children: "内容" }));
  assert.match(html, /is-maximized task-review/);
  assert.match(html, /aria-label="还原工作面板"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /&lt;任务&gt;/);
  assert.doesNotMatch(html, /<任务>/);
});

test("ordinary small dialogs do not acquire work-layer controls", () => {
  const html = renderToStaticMarkup(createElement(SettingsDialog, { title: "选一个位置", onClose: () => {}, children: "选项" }));
  assert.equal((html.match(/<dialog /g) ?? []).length, 1);
  assert.match(html, /aria-label="关闭"/);
  assert.doesNotMatch(html, /放大工作面板|fluid-formal-work-layer|settings-dialog-header-actions/);
});
