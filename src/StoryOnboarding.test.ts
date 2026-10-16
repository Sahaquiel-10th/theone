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
test('there is no fifth reveal or payment-summary page',()=>{
 const p={...profile,onboarding:{...profile.onboarding,journey:{...profile.onboarding.journey!,stage:'ready' as const,nameChoice:'skipped' as const}}};
 const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:true,pricePower:.012}}));
 assert.match(html,/保存设置/);assert.doesNotMatch(html,/确认电力|漫画|图|故事|礼物|5 \/ 5/);
 const gift=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:true,pricePower:.012,firstGift:true}}));
 assert.doesNotMatch(gift,/电力|漫画|图|故事|赠送/);
 const unavailable=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:false}}));assert.doesNotMatch(unavailable,/图片通道|电力/);
});
test('features are selected for storytelling without granting purchase or execution',()=>{
 const p={...profile,onboarding:{...profile.onboarding,journey:{...profile.onboarding.journey!,stage:'features' as const}}};
 const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,context:{platforms:['Notion'],features:[{id:'write',name:'方案提纲',description:'理清思路'}]}}));
 assert.match(html,/你主要想用 ONE 做什么/);assert.match(html,/写作与表达/);assert.match(html,/整理文件与表格/);assert.match(html,/开始使用 ONE/);assert.doesNotMatch(html,/方案提纲|漫画|故事|礼物|选最多 3 个/);
});
