import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ResponseProgress} from './ResponseProgress';

test('reply waiting keeps a decorative progress line with one live stage and a nearby stop action',()=>{
 const html=renderToStaticMarkup(createElement(ResponseProgress,{phase:'正在等待模型回答',onStop:async()=>{}}));
 assert.match(html,/role="status" aria-live="polite" aria-atomic="true">正在生成回复/);
 assert.match(html,/response-progress-stop[^>]*>停止回复/);
 assert.match(html,/class="response-wait-track" aria-hidden="true"/);
 assert.match(html,/class="response-wait-fill" style="transform:scaleX\(/);
 assert.doesNotMatch(html,/aria-valuenow|one-waiting-copy|想得久一点|我还在这儿|\d+%|已等待/);
 assert.equal((html.match(/role="status"/g)||[]).length,1);
});
test('only real elapsed time is displayed and it does not create another live announcement',context=>{
 context.mock.method(Date,'now',()=>Date.parse('2026-10-28T00:10:00.000Z'));
 const html=renderToStaticMarkup(createElement(ResponseProgress,{phase:'正在查找已授权知识库',startedAt:new Date(Date.now()-66000).toISOString()}));
 assert.match(html,/正在查找知识资料/);
 assert.match(html,/class="response-progress-elapsed" aria-live="off">已等待 1 分 6 秒/);
 const invalid=renderToStaticMarkup(createElement(ResponseProgress,{startedAt:'invalid'}));
 assert.doesNotMatch(invalid,/已等待|NaN/);
});
test('completion briefly acknowledges the actual response and removes waiting, spinner and stop controls',()=>{
 const html=renderToStaticMarkup(createElement(ResponseProgress,{phase:'正在等待模型回答',startedAt:new Date(Date.now()-70000).toISOString(),onStop:async()=>{},completed:true}));
 assert.match(html,/data-state="completed"/);
 assert.match(html,/回复已返回/);
 assert.match(html,/transform:scaleX\(1\)/);
 assert.doesNotMatch(html,/停止回复|已等待|task-transfer-spinner|progressbar/);
});
