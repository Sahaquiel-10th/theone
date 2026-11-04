import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationTimeline} from './conversationTimeline';
test('main chat, previous introductions and a new introduction share chronological history',()=>{
  const rows=conversationTimeline([{id:'old-chat',role:'user',text:'原来的聊天',createdAt:'2026-11-04T01:00:00Z'},{id:'between',role:'assistant',text:'正常聊天继续',createdAt:'2026-11-04T03:00:00Z'},{id:'new-chat',role:'user',text:'现在做正事',createdAt:'2026-11-04T05:00:00Z'}],[{id:'old-intro',createdAt:'2026-11-04T02:00:00Z',content:'旧介绍'},{id:'new-intro',createdAt:'2026-11-04T04:00:00Z',content:'重新认识'}]);
  assert.deepEqual(rows.map(row=>row.kind==='message'?row.message.id:row.entry.id),['old-chat','old-intro','between','new-intro','new-chat']);
});
test('legacy undated messages keep order; optimistic sends remain after the current feature turn',()=>{
  const rows=conversationTimeline([{id:'legacy-1',role:'user',text:'旧聊天'},{id:'legacy-2',role:'assistant',text:'旧回复'},{id:'outgoing_new',role:'user',text:'新的草稿'}],[{id:'intro',createdAt:'2026-11-04T02:00:00Z',content:'介绍'}]);
  assert.deepEqual(rows.map(row=>row.kind==='message'?row.message.id:row.entry.id),['legacy-1','legacy-2','intro','outgoing_new']);
});
