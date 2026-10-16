import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StoryOnboarding,welcomeBenefits} from './StoryOnboarding';
import type {AccountProfile} from '../server/betaProfile';
const profile:AccountProfile={workspaceId:'w',displayName:'',onboarding:{knowledgeChoice:'pending',journey:{id:'journey_test_012345',launchId:'launch_test_012345',version:2,stage:'name',startedAt:'now',featureIds:[],events:[]}},updatedAt:'now'};
const props={profile,onBegin:async()=>{},onAction:async()=>{},onKnowledge:()=>{},onDevice:()=>{},onDismiss:()=>{},context:{platforms:[],features:[]}};
test('welcome is skippable, includes outcomes rather than jargon, and rendering cannot start a paid task',()=>{
 let actions=0;const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,onAction:async()=>{actions++;}}));
 assert.match(html,/怎么称呼你/);assert.match(html,/先不填/);assert.match(html,/稍后继续新手引导/);assert.equal(actions,0);assert.equal(welcomeBenefits.length,4);
 assert.doesNotMatch(html,/API|执行器|回执/);
});
test('the final step with no data still offers a priced comic and distinguishes story from real file creation',()=>{
 const p={...profile,onboarding:{...profile.onboarding,journey:{...profile.onboarding.journey!,stage:'ready' as const,nameChoice:'skipped' as const}}};
 const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:true,pricePower:.012}}));
 assert.match(html,/完成引导，画我的漫画/);assert.match(html,/0.012 电力/);assert.match(html,/不会真的替你创建 PPT/);assert.match(html,/暂未连接/);
 const unavailable=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:false}}));assert.match(unavailable,/图片通道暂时不可用/);assert.match(unavailable,/先开始使用/);
 const replay=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:{...p,onboarding:{...p.onboarding,completedAt:'before'}},offer:{available:true,pricePower:.012}}));assert.match(replay,/这张漫画，也是一件任务/);assert.doesNotMatch(replay,/成为你的第一件任务/);
});
test('features are selected for storytelling without granting purchase or execution',()=>{
 const p={...profile,onboarding:{...profile.onboarding,journey:{...profile.onboarding.journey!,stage:'features' as const}}};
 const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,context:{platforms:['Notion'],features:[{id:'write',name:'方案提纲',description:'理清思路'}]}}));
 assert.match(html,/方案提纲/);assert.match(html,/选择不会运行或购买功能/);assert.match(html,/先用基础能力/);
});
