import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import type {CuriousOnboardingView} from '../server/curiousOnboarding';
import {CuriousOnboarding} from './CuriousOnboarding';
import {companionChoices,companionIntensityChoices,companionSample} from './companionPersonas';

const fixture=():CuriousOnboardingView=>({
  profile:{workspaceId:'synthetic-workspace',displayName:'小林',companion:{persona:'puppy',intensity:'normal'},onboarding:{knowledgeChoice:'pending'},updatedAt:'2026-11-04T00:00:00Z'},
  context:{platforms:[],features:[]},handbookOffer:{available:true,firstGift:true},billingNotice:'对话按正常用量，首次说明书由 ONE 赠送。',
  session:{id:'synthetic-curious',revision:3,status:'active',stage:'context',startedAt:'2026-11-04T00:00:00Z',facts:{name:'小林',activity:{id:'writing',label:'写东西、做内容'},context:[],habits:[]},
    messages:[{id:'hello',role:'assistant',content:'怎么称呼你？'},{id:'name',role:'user',content:'小林'},{id:'followup',role:'assistant',content:'最近写东西时，哪一块最费劲？'}],
    current:{id:'synthetic-question',text:'最近写东西时，哪一块最费劲？',allowText:true,options:[{id:'reply_0',label:'手上材料太散',reply:'手上材料太散'},{id:'reply_1',label:'想法很多，难落笔',reply:'想法很多，难落笔'},{id:'reply_2',label:'边聊边想',reply:'边聊边想'}]}}
});
const render=(view:CuriousOnboardingView,extra:Record<string,unknown>={})=>renderToStaticMarkup(createElement(CuriousOnboarding,{profile:view.profile,initialView:view,request:async()=>{throw Error('render must be read-only');},onKnowledge:()=>{},onProfile:()=>{},onComplete:()=>{},onContinueChat:()=>{},...extra}));

test('conversation retains earlier replies and exposes only current server choices',()=>{
  const html=render(fixture());
  assert.match(html,/data-role="user"/);assert.match(html,/小林/);assert.match(html,/怎么称呼你/);
  assert.equal((html.match(/最近写东西时，哪一块最费劲/g)??[]).length,1);
  assert.equal((html.match(/>手上材料太散<\/span>/g)??[]).length,1);
  assert.doesNotMatch(html,/步骤|第 3 步|任务已经完成|已读取/);
  assert.match(html,/发送这条回复/);assert.match(html,/先做别的/);
});

test('completed or paused conversations stay reviewable without an active onboarding composer',()=>{
  for(const status of ['paused','completed'] as const){
    const view=fixture();view.session!.status=status;view.session!.current=undefined;
    const html=render(view);
    assert.match(html,/curious-transcript/);assert.match(html,/怎么称呼你/);assert.match(html,/点开回看/);
    assert.doesNotMatch(html,/<textarea|发送这条回复|>手上材料太散<\/span>/);
    assert.equal(html.includes('接着认识'),status==='paused');
  }
});

test('source settings actions remain distinct from a confirmed source choice',()=>{
  const view=fixture();view.session!.stage='knowledge';
  view.session!.current={id:'knowledge-q',text:'可以连接自己的资料，也可以以后再接。',options:[{id:'connect',label:'去连接我的资料',action:'connect'},{id:'connection:own-note',label:'用已连接的 Notion',reply:'以后需要时用 Notion'},{id:'later',label:'以后再接'}]};
  const html=render(view);assert.match(html,/data-action="connect"/);assert.match(html,/用已连接的 Notion/);assert.match(html,/以后再接/);
  assert.match(html,/带回主对话/);assert.match(html,/aria-label="直接聊这件事"/);
  assert.doesNotMatch(html,/连接成功|已经读过|已查资料/);
});

test('handbook handoff displays the real delivery state and no invented task card',()=>{
  const view=fixture();view.session!.status='completed';view.session!.current=undefined;
  assert.doesNotMatch(render(view),/curious-handoff/);
  view.welcomeDelivery={operationId:'gift',state:'failed',taskId:'exact-real-task',message:'使用说明这次没做好，点开任务看看。',canRetry:false};
  const html=render(view,{onOpenTask:()=>{}});
  assert.match(html,/使用说明这次没做好/);assert.match(html,/打开这件事/);
  assert.doesNotMatch(html,/正在生成|生成完成|再生成一份|%/);
});

test('untrusted names, messages, option labels and delivery copy render as text',()=>{
  const view=fixture(),attack='<img src=x onerror="alert(1)">';
  view.profile.displayName=attack;view.session!.facts.name=attack;view.session!.messages[1].content=attack;view.session!.current!.options[0].label=attack;
  view.welcomeDelivery={operationId:'gift',state:'failed',message:attack,canRetry:false};
  const html=render(view);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x|<script/);
});

test('the eight approved voices have distinct local examples at all three strengths',()=>{
  assert.deepEqual(companionChoices.map(p=>p.name),['中二病','高冷傲娇','霸总','嘴欠损友','元气小狗','古风军师','赛博机器人','疯科学家']);
  for(const persona of companionChoices){
    const samples=companionIntensityChoices.map(level=>companionSample(persona.id,level.id,'小林'));
    assert.equal(new Set(samples).size,3);assert.ok(samples.every(s=>s.includes('小林')));
  }
  // The personality service imports Node crypto and must never enter the client graph.
  const metadata=readFileSync(new URL('./companionPersonas.ts',import.meta.url),'utf8');
  assert.match(metadata,/import type .*server\/oneCompanion/);assert.doesNotMatch(metadata,/import\s*\{[^}]+\}\s*from ['"]\.\.\/server/);
});
