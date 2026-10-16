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
test('completion is short, hides the storyboard and keeps paid use explicit without another consent screen',()=>{
 const p={...profile,onboarding:{...profile.onboarding,journey:{...profile.onboarding.journey!,stage:'ready' as const,nameChoice:'skipped' as const}}};
 const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:true,pricePower:.012}}));
 assert.match(html,/确认电力，再画一张/);assert.match(html,/0.012.*电力/);assert.match(html,/不画了，直接开始/);assert.doesNotMatch(html,/四格|没睡醒|主角|交付位置|故事|PPT/);
 const gift=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:true,pricePower:.012,firstGift:true}}));
 assert.match(gift,/开始使用 ONE/);assert.doesNotMatch(gift,/电力|漫画|图|故事|赠送/);
 const unavailable=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,offer:{available:false}}));assert.match(unavailable,/开始使用 ONE/);assert.doesNotMatch(unavailable,/disabled|图片通道|电力/);
});
test('features are selected for storytelling without granting purchase or execution',()=>{
 const p={...profile,onboarding:{...profile.onboarding,journey:{...profile.onboarding.journey!,stage:'features' as const}}};
 const html=renderToStaticMarkup(createElement(StoryOnboarding,{...props,profile:p,context:{platforms:['Notion'],features:[{id:'write',name:'方案提纲',description:'理清思路'}]}}));
 assert.match(html,/方案提纲/);assert.match(html,/不会运行或购买功能/);assert.match(html,/先用基础能力/);assert.doesNotMatch(html,/漫画|故事/);
});
