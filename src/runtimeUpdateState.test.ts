import assert from "node:assert/strict";
import test from "node:test";
import fs from 'node:fs';
import { runtimeUpdateView, type RuntimeUpdateStatus } from "./runtimeUpdateState.js";

const now = Date.now();
const status: RuntimeUpdateStatus = { configured: true, supported: true, available: true, progress: { requestId: "upd-a", status: "requested", version: "0.3.9", updatedAt: new Date(now).toISOString() } };

test("update UI resumes polling an active install after a page refresh", () => {
  assert.equal(runtimeUpdateView(status, false, now).busy, true);
});
test("stale prepare/download/reconnect stages never leave the update button busy forever", () => {
  for (const phase of ["requested", "downloading", "verifying", "installing", "completed"] as const) {
    const result = runtimeUpdateView({ ...status, progress: { ...status.progress!, status: phase } }, true, now + 60 * 60_000);
    assert.equal(result.busy, false);
    assert.ok(result.issue);
  }
});
test("reconnected launchers without a progress record stop the old spinner", () => {
  assert.equal(runtimeUpdateView({ ...status, progress: undefined }, true).busy, false);
  assert.ok(runtimeUpdateView({ ...status, progress: undefined }, true).issue);
  assert.deepEqual(runtimeUpdateView({ ...status, progress: undefined }, false), { busy: false, issue: "" });
});
test("current version and explicit failure clear the pending state", () => {
  assert.deepEqual(runtimeUpdateView({ ...status, available: false }, true), { busy: false, issue: "" });
  assert.deepEqual(runtimeUpdateView({ ...status, progress: { ...status.progress!, status: "failed" } }, true), { busy: false, issue: "" });
});
test('restored ambiguous updates never become an ordinary update button after refresh', () => {
  const restored = { ...status, progress: { ...status.progress!, recoveryRequired: true } };
  const view = runtimeUpdateView(restored, false, now);
  assert.equal(view.busy, false);
  assert.match(view.issue, /勿重复安装/);
  assert.deepEqual(runtimeUpdateView({ ...restored, available: false }, true, now), { busy: false, issue: '' });
});
test('manual update checks expose feedback and identity without dispatching installation', () => {
  const source = fs.readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const check = source.split('async function refreshRuntimeUpdate(manual = false)')[1].split('async function installRuntimeUpdate()')[0];
  assert.ok(check.includes('setRuntimeChecking(true)'));
  assert.ok(check.includes('setRuntimeChecking(false)'));
  assert.match(check, /已检查/);
  assert.ok(check.includes('catch (checkError)'));
  assert.doesNotMatch(check, /method: "POST"/);
  assert.match(source, /当前账号：{user.username}/);
  const css = fs.readFileSync(new URL('./one-beta.css', import.meta.url), 'utf8');
  const rule = css.match(/.one-runtime-update small {([^}]+)}/)![1];
  assert.match(rule, /white-space: normal/);
  assert.doesNotMatch(rule, /ellipsis/);
});
