import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WelcomeDelivery} from './WelcomeDelivery';
const actions={busy:false,onOpen:()=>{},onRetry:()=>{},onCheck:()=>{},onDismiss:()=>{}};
test('accepted and failed welcome handoffs always show a visible next action without exposing a prompt',()=>{
  for(const taskId of [undefined,'owned-task']){
    const html=renderToStaticMarkup(createElement(WelcomeDelivery,{...actions,delivery:{operationId:'op',state:'failed',taskId,message:'暂时没安排成功。',canRetry:!taskId}}));
    assert.match(html,taskId?/查看任务/:/重试安排/);assert.match(html,/收起欢迎礼物提示/);assert.doesNotMatch(html,/提示词|API|作图要求/);
  }
  const html=renderToStaticMarkup(createElement(WelcomeDelivery,{...actions,delivery:{operationId:'op',state:'preparing',message:'正在准备。',canRetry:false}}));
  assert.match(html,/检查状态/);assert.doesNotMatch(html,/收起欢迎礼物提示|重试安排/);
});
