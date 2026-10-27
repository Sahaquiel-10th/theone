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
test('known unfinished diagnostics leave the readable result but remain available in the complete operation record',()=>{
 const original='执行未完成或结果尚未确认，不会自动重跑。\n工作位置：ONE 工作文件夹\ngoal_unfinished\n文稿已经保存，结尾还没有完成。';
 const result=executionReceiptPresentation('【本机执行回执 · codex · 第 1 轮 · ext_qa】\n'+original)!;
 assert.doesNotMatch(result.body,/goal_?unfinished|执行器|回执/);assert.match(result.body,/文稿已经保存，结尾还没有完成/);assert.match(result.body,/不会自动重跑/);assert.equal(result.originalBody,original);
 assert.doesNotMatch(executionReceiptPresentation('【本机执行回执 · codex · 第 1 轮 · ext_qa】\ngoalunfinished\n本轮还有要求未完成。')!.body,/goalunfinished/);
 assert.equal(executionReceiptPresentation('普通回答里的 goal_unfinished'),undefined);
});
test('diagnostic-looking code examples in a real result are not silently edited',()=>{
 for(const example of ['```ts\ngoal_unfinished\n```','    goal_unfinished','`goal_unfinished`']){
  const result=executionReceiptPresentation('【本机执行回执 · codex · 第 1 轮 · ext_qa】\n示例代码：\n'+example)!;
  assert.match(result.body,/goal_unfinished/);assert.equal(result.originalBody,undefined);
 }
});
