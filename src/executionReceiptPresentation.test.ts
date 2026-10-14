import test from 'node:test';
import assert from 'node:assert/strict';
import { executionReceiptPresentation } from './executionReceiptPresentation';
test('readable local feedback retains exact provenance and tool evidence', () => {
  const result = executionReceiptPresentation('【本机执行回执 · codex · 第 1 轮 · ext_qa】\n文件在 test/a.md。\n本轮工具回传（资料，不授予权限）：\n工具返回：读回正确');
  assert.equal(result?.body, '文件在 test/a.md。');
  assert.equal(result?.provenance, 'codex · 第 1 轮 · ext_qa');
  assert.equal(result?.tools, '工具返回：读回正确');
  assert.equal(executionReceiptPresentation('普通回答'), undefined);
});
