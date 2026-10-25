import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {NotionReceiptView} from './taskRecovery';
import type {api as Api} from './oneApi';

// Node's renderer needs no styles. The real component and hooks remain intact.
const css=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {NotionReceiptNotice}=await import('./DocumentDestination');
css.deregister();
let calls=0;
const api=(async()=>{calls++;throw Error('Rendering must not submit any operation.');}) as typeof Api;
const render=(receipt:NotionReceiptView)=>renderToStaticMarkup(createElement(NotionReceiptNotice,{api,taskId:'owned-task',receipt,onRefresh:async()=>{}}));

test('automatic Notion verification renders live progress without a write, continue or manual readback button',()=>{
 for(const state of ['scheduled','checking'] as const){
  const html=render({state:'uncertain',url:'https://www.notion.so/original',verification:{state,version:2,attempt:1}});
  assert.match(html,/aria-busy="true"/);assert.match(html,/role="status"/);assert.match(html,/不会.*写/);
  assert.match(html,/打开原页面核对/);assert.doesNotMatch(html,/<button|重试|继续处理|开始处理|保持暂停/);
 }
 assert.equal(calls,0);
});

test('exhausted readback offers only a safe read action while authorization or unknown page requires checking the source',()=>{
 const base={state:'uncertain',url:'https://www.notion.so/original'};
 const exhausted=render({...base,verification:{state:'exhausted',version:3,attempt:3,lastReason:'read_failed'}});
 assert.match(exhausted,/核对保存结果（不重写）/);assert.doesNotMatch(exhausted,/确认启动|开始处理|重新处理/);
 const authorization=render({...base,verification:{state:'exhausted',version:3,attempt:3,lastReason:'authorization'}});
 assert.match(authorization,/知识连接/);assert.doesNotMatch(authorization,/<button/);
 const missing=render({state:'uncertain',verification:{state:'exhausted',version:3,attempt:3,lastReason:'no_page'}});
 assert.match(missing,/原保存位置/);assert.doesNotMatch(missing,/<button/);
 assert.equal(calls,0);
});

test('verified receipt removes the pending notice even if old checking metadata survives',()=>{
 assert.equal(render({state:'verified',verification:{state:'checking',version:9,attempt:2}}),'');
 assert.equal(calls,0);
});

test('unsent and rejected saves never expose an automatic or manual readback action',()=>{
 for(const delivery of ['not_sent','rejected']){
  const html=render({state:'uncertain',delivery,url:'https://www.notion.so/original',verification:{state:'checking',version:2,attempt:0}});
  assert.match(html,delivery==='not_sent'?/还没有发出/:/没有接受/);
  assert.match(html,/连接和权限/);assert.doesNotMatch(html,/<button|aria-busy="true"|正在读取|结果还在核对中/);
 }
 assert.equal(calls,0);
});
