import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WelcomeDelivery,followWelcomeDelivery} from './WelcomeDelivery';
const actions={busy:false,onOpen:()=>{},onRetry:()=>{},onCheck:()=>{},onDismiss:()=>{}};
test('welcome progress follows recovery of its own task and stops watching terminal results',()=>{
  const failed={operationId:'op',state:'failed' as const,taskId:'owned-task',message:'没做好',canRetry:false};
  assert.equal(followWelcomeDelivery(failed,'running'),true);
  assert.equal(followWelcomeDelivery(failed,'completed'),true);
  assert.equal(followWelcomeDelivery(failed,'failed'),false);
  assert.equal(followWelcomeDelivery(failed,undefined),false);
  assert.equal(followWelcomeDelivery({...failed,taskId:undefined},'running'),false);
  assert.equal(followWelcomeDelivery({...failed,state:'completed'},'completed'),false);
  assert.equal(followWelcomeDelivery({...failed,state:'running'},'running'),true);
});
test('accepted and failed welcome handoffs always show a visible next action without exposing a prompt',()=>{
  for(const taskId of [undefined,'owned-task']){
    const html=renderToStaticMarkup(createElement(WelcomeDelivery,{...actions,delivery:{operationId:'op',state:'failed',taskId,message:'暂时没安排成功。',canRetry:!taskId}}));
    assert.match(html,taskId?/查看任务/:/重试安排/);assert.match(html,/收起使用说明提示/);assert.doesNotMatch(html,/提示词|API|作图要求/);
  }
  const html=renderToStaticMarkup(createElement(WelcomeDelivery,{...actions,delivery:{operationId:'op',state:'preparing',message:'正在准备。',canRetry:false}}));
  assert.match(html,/检查状态/);assert.doesNotMatch(html,/收起使用说明提示|重试安排/);
});
