import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LocalTaskEmptyState} from './LocalTaskEmptyState';

const actions={onCompose:()=>{},onSettings:()=>{},onRetry:()=>{}};
test('no local task is an empty panel, not proof that the computer is idle or connected',()=>{
 const html=renderToStaticMarkup(createElement(LocalTaskEmptyState,{...actions,unavailable:false,canExecute:true}));
 assert.match(html,/暂无接管任务/);
 assert.match(html,/主对话输入框/);
 assert.match(html,/在主对话中填写要求/);
 assert.doesNotMatch(html,/电脑现在空闲|直接告诉|已连接|立即执行|刷新任务/);
});
test('unreadable tasks offer refresh instead of making a false empty claim',()=>{
 const html=renderToStaticMarkup(createElement(LocalTaskEmptyState,{...actions,unavailable:true,canExecute:true}));
 assert.match(html,/本机任务状态尚未确认/);
 assert.match(html,/刷新任务状态/);
 assert.doesNotMatch(html,/暂无接管任务|在主对话中填写要求/);
});
test('when the local execution action is not present, the panel does not instruct users to click it',()=>{
 const html=renderToStaticMarkup(createElement(LocalTaskEmptyState,{...actions,unavailable:false,canExecute:false}));
 assert.doesNotMatch(html,/再点/);
 assert.match(html,/这里显示交给这台电脑执行的任务/);
});
