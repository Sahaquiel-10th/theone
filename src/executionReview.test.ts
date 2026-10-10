import test from 'node:test';
import assert from 'node:assert/strict';
import {executionNeedsReview} from './executionReview';
test('tool warning with a real answer is review, never proof of completion', () => {
  const task = {status:'failed',finalResponse:'回读完成',lastError:'回读完成\n\n本轮有工具执行失败，完成情况需检查，不会自动重跑。'};
  assert.equal(executionNeedsReview(task),true);
  assert.equal(task.status,'failed');
  for (const other of [{...task,status:'cancelled'}, {...task,status:'completed'}, {...task,lastError:'连接中断'}, {...task,finalResponse:''}]) assert.equal(executionNeedsReview(other),false);
});
