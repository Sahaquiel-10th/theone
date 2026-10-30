import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PracticeOnboarding} from './PracticeOnboarding';
import {createPracticePreviewRequest,practicePreviewView} from './PracticeOnboardingPreview';
import {practiceLink,practiceRecap,practiceRoundDone,practiceSubmission,practiceWebDone} from './practiceOnboardingState';
import type {PracticeView} from '../server/onboardingPractice';

const render=(view:PracticeView,extra:Record<string,unknown>={})=>renderToStaticMarkup(createElement(PracticeOnboarding,{journeyId:'journey_practice_test',initialView:view,request:async()=>{throw Error('render cannot make requests');},onKnowledge:()=>{},onDismiss:()=>{},onFinish:async()=>{},onSkip:async()=>{},...extra}));
test('a completed status without an actual result never unlocks the next paid step',()=>{
  const view=practicePreviewView('result'),round=view.practice!.first;
  assert.equal(practiceRoundDone(round),true);
  assert.equal(practiceRoundDone({...round,resultMessageId:undefined}),false);
  assert.equal(practiceRoundDone({...round,outcome:'partial'}),false);
  assert.equal(practiceRoundDone({...round,outcome:'needs_input'}),false);
  const html=render({...view,practice:{...view.practice!,first:{...round,resultMessageId:undefined}}});
  assert.doesNotMatch(html,/把这份成果做成网页/);
  assert.match(html,/已有内容和本次用量都保留着/);
});
test('web delivery requires the exact completed round and a saved attachment',()=>{
  const view=practicePreviewView('web');assert.equal(practiceWebDone(view.practice),true);
  assert.equal(practiceWebDone({...view.practice!,web:{...view.practice!.web!,attachment:undefined}}),false);
  assert.equal(practiceWebDone({...view.practice!,web:{...view.practice!.web!,state:'failed'}}),false);
});
test('opening source selection or an in-flight task cannot submit or complete practice',()=>{
  let writes=0;
  const extra={request:async()=>{writes++;throw Error('not called');},onFinish:async()=>{writes++;},onSkip:async()=>{writes++;}};
  const source=render(practicePreviewView('choose'),extra);assert.match(source,/笔记标题或关键词/);assert.match(source,/先用一份示例体验/);assert.equal(writes,0);
  const running=render(practicePreviewView('running'),extra);assert.match(running,/回主对话，继续聊/);assert.match(running,/查看这件事/);assert.doesNotMatch(running,/跳过这次体验|这次体验完成了|把这份成果做成网页/);assert.equal(writes,0);
});
test('explicit sample selection remains distinct from a private note at entry and recap',()=>{
  const source=render(practicePreviewView('choose'),{defaultSample:true});assert.match(source,/ONE 提供的示例 · 不是你的笔记/);assert.match(source,/确认|交给 ONE 整理/);
  const view=practicePreviewView('complete');view.practice!.source.sample=true;
  const recap=practiceRecap(view.practice!);assert.match(recap[1].label,/明确标记的示例/);assert.doesNotMatch(recap[1].label,/真实资料/);
});
test('failed pre-queue handoff offers one explicit recovery using the original attempt',()=>{
  const view=practicePreviewView('failure');view.practice!.first.taskId='';
  const html=render(view);assert.match(html,/重新交接这次要求/);assert.match(html,/核对|检查状态/);assert.doesNotMatch(html,/这次体验完成了/);
});
test('an uncertain request retains its ID; changed intent gets a fresh ID',()=>{
  let generated=0;const create=()=>`request_${++generated}`;
  const first=practiceSubmission(undefined,'same-request-hash',create);
  assert.equal(practiceSubmission(first,'same-request-hash',create).operationId,first.operationId);assert.equal(generated,1);
  assert.notEqual(practiceSubmission(first,'changed-request-hash',create).operationId,first.operationId);assert.equal(generated,2);
});
test('untrusted note URLs cannot execute or navigate to another origin through protocol-relative URLs',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,x','//example.com/a','/\\example.com','file:///tmp/private'])assert.equal(practiceLink(value),undefined);
  assert.equal(practiceLink('/api/attachments/known/content'),'/api/attachments/known/content');assert.equal(practiceLink('https://example.com/note'),'https://example.com/note');
});
test('the preview API is synthetic and rejects every route outside its bounded fixture',async()=>{
  const request=createPracticePreviewRequest(practicePreviewView('choose'));
  const found=await request<{results:{selectionId:string}[]}>('/api/me/onboarding-practice/search',{method:'POST',body:'{}'});assert.equal(found.results.length,1);
  await assert.rejects(()=>request('/api/me/profile'),/本地合成数据/);
  await assert.rejects(()=>request('https://example.com/start'),/本地合成数据/);
  const first=await request<PracticeView>('/api/me/onboarding-practice/start',{method:'POST',body:JSON.stringify({operationId:'stable_preview_operation',sample:true})});assert.equal(first.practice!.first.operationId,'stable_preview_operation');assert.equal(first.practice!.source.sample,true);
});

test('a blocked round sends clarification to its exact task rather than an unrelated main-chat request',()=>{
  const view=practicePreviewView('failure');
  const html=render(view);
  assert.match(html,/打开这件事，继续处理/);
  assert.match(html,new RegExp('task='+view.practice!.first.taskId));
  assert.doesNotMatch(html,/回主对话补充要求/);
});
