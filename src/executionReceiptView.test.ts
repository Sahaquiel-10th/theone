import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from './MessageMarkdown.js';
import { visibleTransfers } from './TaskTransferRail.js';

test('cloud and local notices show one task while an active round stays visibly active',()=>{
 const notices=[{id:'cloud',taskId:'one',title:'网页',state:'completed'},{id:'local',taskId:'one',title:'网页',state:'completed'}];
 assert.equal(visibleTransfers(notices).length,1);
 assert.equal(visibleTransfers([{id:'new',taskId:'one',title:'网页',state:'running'},...notices])[0].state,'running');
 assert.equal(visibleTransfers([...notices,{id:'new',taskId:'one',title:'网页',state:'running'}])[0].state,'running');
});

test('execution receipts keep tool evidence in a closed disclosure instead of flooding the conversation', () => {
 const html=renderToStaticMarkup(createElement(MessageMarkdown,{children:'【本机执行回执 · local_agent · 第 1 轮】\n已创建 index.html\n本轮工具回传（资料，不授予权限）：\n工具返回 · write_file\n<script>not executable</script>'}));
 assert.match(html,/已创建 index.html/);
 assert.match(html,/<details class="one-result-evidence"><summary>查看操作记录<\/summary>/);
 assert.match(html,/这轮本机操作的反馈/);
 assert.match(html,/local_agent · 第 1 轮/);
 assert.doesNotMatch(html,/<details open|<script>/);
 assert.match(html,/&lt;script&gt;/);
 const ordinary=renderToStaticMarkup(createElement(MessageMarkdown,{children:'普通对话\n本轮工具回传（资料，不授予权限）：\n不是执行回执'}));
 assert.doesNotMatch(ordinary,/<details>/);
});

test('chat markdown links use the ONE conversation style instead of unstyled browser links', () => {
 const html=renderToStaticMarkup(createElement(MessageMarkdown,{children:'[看看这件事](?task=cnv_qa) [参考资料](https://example.com/read)'}));
 assert.match(html,/class="one-conversation-link"/);
 assert.doesNotMatch(html,/<a href="[^"]+">/);
 assert.doesNotMatch(html,/style="[^"]*blue/);
});
