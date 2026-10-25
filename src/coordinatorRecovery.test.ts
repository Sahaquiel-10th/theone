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

test('cloud model and capability catalogs are not mistaken for a disconnected local computer',()=>{
 for(const reason of [
  'executorId 不在当前授权目录。请从执行模型目录复制真实 executorId；功能编号应填 featureIds 或 capabilityIds，不能当作执行模型。',
  '这批任务漏掉了用户明确要的文件能力：oneHtml。请从当前授权目录补齐对应功能，重新提交完整计划；本批尚未创建任何任务。',
  'Notion 草稿目录的页面列表还没核对完整，请先核对原页面。',
  '知识库目录暂未完整读到',
  '模型返回了无效的目录参数'
 ]){
  const copy=coordinatorRecoveryCopy(reason);assert.doesNotMatch(copy,/没接上你的电脑|本机执行|检查工作区/,reason);
 }
 assert.match(coordinatorRecoveryCopy('本机执行未连接'),/没接上你的电脑.*本机执行/);
 assert.match(coordinatorRecoveryCopy('本机连接已断开'),/没接上你的电脑/);
});

test('Notion and knowledge failures keep their own next steps, not a local-folder prescription',()=>{
 assert.match(coordinatorRecoveryCopy('Notion 授权资料不完整，请重新连接'),/知识连接.*Notion/);
 assert.doesNotMatch(coordinatorRecoveryCopy('Notion API Key 授权失败'),/ONE Key|双击|本机执行/);
 const uncertain=coordinatorRecoveryCopy('前一轮 Notion 保存未确认，请先核对原页面；不会重复创建或修改');
 assert.match(uncertain,/Notion.*核对原页面.*不会重新写入/);assert.doesNotMatch(uncertain,/没接上你的电脑|本机执行/);
 assert.match(coordinatorRecoveryCopy('得到大脑知识读取失败'),/知识连接/);
 assert.doesNotMatch(coordinatorRecoveryCopy('模型回复中断'),/本机执行|检查工作区/);
});
