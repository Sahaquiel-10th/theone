import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AccountPreferencesLayout} from './AccountPreferencesLayout';
import {ConfirmationContent} from './ConfirmAction';
import {GuideHistoryList} from './SavedWelcomeGuides';

test('settings navigation keeps four independent sections and selected state',()=>{
  const html=renderToStaticMarkup(createElement(AccountPreferencesLayout,{section:'device',onChange:()=>{},children:'content'}));
  for(const label of ['外观与偏好','本机执行','连接与授权','会员与额度'])assert.ok(html.includes(label));
  assert.equal((html.match(/aria-current="page"/g)||[]).length,1);
  assert.ok(html.includes('account-preferences-content'));
});
test('confirmation keeps privacy detail and safe default cancellation without raw HTML',()=>{
  const html=renderToStaticMarkup(createElement(ConfirmationContent,{value:{title:'分享',message:'<script>oops</script>',details:['不含知识正文、聊天记录或本地文件。','链接 7 天有效，随时可以关闭。']},onFinish:()=>{}}));
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-dialog-focus'));assert.ok(html.includes('取消'));assert.ok(html.includes('确认'));assert.ok(html.includes('不含知识正文'));
});
test('guide history uses compact dated rows rather than expanding page content',()=>{
  const html=renderToStaticMarkup(createElement(GuideHistoryList,{guides:[{id:'old',title:'<旧说明>.html',createdAt:'2026-10-17T08:00:00Z',taskId:'old-task'}],api:async()=>{throw new Error('SSR must not request');}}));
  assert.ok(html.includes('welcome-guide-card-compact'));assert.ok(html.includes('&lt;旧说明&gt;'));assert.ok(!html.includes('<details'));
  assert.ok(html.includes('2026'));assert.ok(html.includes('分享'));
});
