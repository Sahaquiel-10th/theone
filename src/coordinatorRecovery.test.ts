import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorRecoveryCopy,dispatchCommitment} from './coordinatorRecovery.js';
test('promised action needs a receipt, but clarification and ordinary conversation do not',()=>{
 for(const text of ['我会把漫画做成四格，并把网页和漫画放在同一件任务里处理。','我来画一张图。','已经安排好了。'])assert.equal(dispatchCommitment(text),true,text);
 for(const text of ['你能给张照片吗？','如果你愿意，我来制作。','下次我会安排。','你好呀。','文章如下：今天开始了新的一天。','我来整理如下：\n1. 先说明目标。\n2. 再确认下一步。','工具还没就位，我会先核对。'])assert.equal(dispatchCommitment(text),false,text);
});
test('recovery is actionable and does not echo diagnostics, credentials or claim success',()=>{
 assert.match(coordinatorRecoveryCopy('功能未开放、已下架或版本已变更'),/工具还没就位.*继续刚才那件事/);
 for(const reason of ['upstream api_key=SECRET','stream disconnected before response.completed','execution_unconfirmed']){
  const text=coordinatorRecoveryCopy(reason);assert.doesNotMatch(text,/SECRET|api_key|execution_unconfirmed|response.completed/);assert.match(text,/核对/);
 }
 assert.match(coordinatorRecoveryCopy('暂未找到接收记录'),/放回输入框.*再发送.*沿用这次的提交编号/);
 assert.match(coordinatorRecoveryCopy('',true),/单独停止/);
 assert.match(coordinatorRecoveryCopy('ONE Key 连接已失效'),/双击盘里的 ONE.*不重复安排/);
 assert.doesNotMatch(coordinatorRecoveryCopy('ONE Key 连接已失效'),/本机执行|工作区/,'cloud-task authentication loss must not be described as a folder permission issue');
});
