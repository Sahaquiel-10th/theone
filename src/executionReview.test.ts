import test from 'node:test';
import assert from 'node:assert/strict';
import {executionNeedsReview} from './executionReview';
test('executor exit does not make an explicitly incomplete document green',()=>{
 const task={status:'completed',finalResponse:'停止操作。无法确认是否包含内容，未完成回读验证。'};
 assert.equal(executionNeedsReview(task),true);
 assert.equal(task.status,'completed','presentation must not rewrite the durable receipt');
 assert.equal(executionNeedsReview({status:'completed',finalResponse:'已创建并回读，53.5 元；覆盖失败路径的测试通过。'}),false);
 assert.equal(executionNeedsReview({status:'completed',finalResponse:'文档已创建并验证。没有创建其他文件，未创建或修改任何无关文件。'}),false);
});
test('tool warning with a real answer is review, never proof of completion', () => {
  const task = {status:'failed',finalResponse:'回读完成',lastError:'回读完成\n\n本轮有工具执行失败，完成情况需检查，不会自动重跑。'};
  assert.equal(executionNeedsReview(task),true);
  assert.equal(task.status,'failed');
  for (const other of [{...task,status:'cancelled'}, {...task,status:'completed'}, {...task,lastError:'连接中断'}, {...task,finalResponse:''}]) assert.equal(executionNeedsReview(other),false);
});
