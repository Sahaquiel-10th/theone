import test from 'node:test';
import assert from 'node:assert/strict';
import {executionNeedsReview} from './executionReview';
import {executionRecovery} from './executionRecovery';
test('a real completed edit with no incidental files needs no recovery, without promoting failed or unknown executions',()=>{
 const answer='已原地修改 `ONE-QA-LOCAL-1101-D/template.xlsx`：“验收表”B6 从数值 `3000` 改为数值 `3200`。\n- 已实际回读核对 B6 为数值 3200。\n- 工作表 XML 仅 B6 数值发生变化；其他 ZIP 成员内容逐字节一致，其他单元格及格式保持不变。\n- 未创建备份或临时文件；未读取、修改 `receipt.txt`。\n- 未进行可视化测试。';
 const task={id:'same-file-edit',status:'completed',finalResponse:answer},original=structuredClone(task);
 assert.equal(executionNeedsReview(task),false);assert.equal(executionRecovery(task),undefined);assert.deepEqual(task,original);
 for(const status of ['failed','cancelled']){const failed={...task,status};assert.ok(executionRecovery(failed));assert.equal(failed.status,status);}
 assert.equal(executionRecovery({...task,requiresExecutionCheck:true})?.canContinue,false);
 assert.equal(executionRecovery({...task,resultDeliveryPending:true})?.canContinue,false);
 assert.equal(executionNeedsReview({...task,finalResponse:answer+'\n没有创建目标文件。'}),true);
 for(const finalResponse of ['已修改原文件。备份或临时文件是本次要求的最终交付。未创建备份或临时文件。','已修改原文件。未创建备份或临时文件；这是本次要求的最终交付。'])assert.equal(executionNeedsReview({...task,finalResponse}),true);
});
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
test('settled app-server tool warnings are review without clearing unknown execution protection',()=>{
 const warning='\n\n本轮有工具未能完成，请查看工具反馈；不会自动重跑。';
 const task={status:'failed',finalResponse:'标题已修改并回读'+warning,lastError:'execution_unconfirmed'};
 assert.equal(executionNeedsReview(task),true);
 assert.equal(task.status,'failed');
 for(const other of [{...task,lastError:'command_unconfirmed'},{...task,lastError:'launcher_interrupted'},
   {...task,finalResponse:warning},{...task,finalResponse:'没有结束回执'}, {...task,status:'cancelled'}])
   assert.equal(executionNeedsReview(other),false);
});
