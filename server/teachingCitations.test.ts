import test from 'node:test';
import assert from 'node:assert/strict';
import {teachingCitationOptions,selectTeachingCitations} from './teachingCitations.js';
import {executeTeachingAi} from './teachingAi.js';
import {reviewStory} from './teachingStories.js';
const scope={workspaceId:'w',userId:'u'},course={...scope,id:'c',title:'杭州通论',subject:'历史',materialText:'杭州位于钱塘江下游。\n西湖疏浚的\t原文含有特殊空白。',activities:[]} as any;
const model={id:'chat',enabled:true,kind:'chat'} as any,activity={...scope,id:'a',courseId:'c',kind:'inquiry',instructions:'学习杭州',avatarPrompt:''} as any;
const response=(x:unknown)=>({content:JSON.stringify(x),finishReason:'stop'});
test('citation bank ranks relevant original passages and never rewrites source whitespace',()=>{
 const original='苏轼组织疏浚西湖，\t民夫参与修堤。';
 const sources={material:Array.from({length:100},(_,i)=>`无关条目${i}。`).join('')+original,attachment:'本次学生提供的材料。'};
 const bank=teachingCitationOptions(sources,'苏轼疏浚西湖');assert.equal(bank.length,24);assert.equal(bank[0].quote,original);assert.deepEqual(selectTeachingCitations([bank[0].id],bank),[{source:'material',quote:original}]);assert.ok(bank.every(x=>sources[x.source].includes(x.quote)));assert.equal(new Set(bank.map(x=>x.id)).size,bank.length);
});
test('unknown, foreign, duplicated and malformed IDs cannot become citations',()=>{
 const own=teachingCitationOptions({material:'当前资料。',attachment:''},'当前'),foreign=teachingCitationOptions({material:'别人的资料。',attachment:''},'别人');
 for(const ids of [['other-workspace-id'],['M1','M1'],[null],{},Array(9).fill('M1')])assert.throws(()=>selectTeachingCitations(ids,own));
 // Identical local IDs always resolve only against the current request, never a global bank.
 assert.equal(selectTeachingCitations([foreign[0].id],own)[0].quote,'当前资料。');
});
test('grounded model answers select source IDs while the server returns verbatim citation DTOs',async()=>{
 const result=await executeTeachingAi({kind:'answer',course,activity,model,question:'杭州的地理位置？'},{call:async messages=>{
  const data=JSON.parse(messages[1].content).untrustedTeachingData,choice=data.citationOptions.find((x:any)=>x.quote.includes('钱塘江'));
  assert.match(messages[0].content,/citationIds/);return response({answer:'杭州位于钱塘江下游。',materialInsufficient:false,needsLocationClarification:false,locationCandidates:[],citationIds:[choice.id]});
 }});assert.equal(result.kind,'answer');if(result.kind==='answer')assert.deepEqual(result.citations,[{source:'material',quote:'杭州位于钱塘江下游。'}]);
 await assert.rejects(()=>executeTeachingAi({kind:'answer',course,activity,model,question:'位置'},{call:async()=>response({answer:'位置',materialInsufficient:false,needsLocationClarification:false,locationCandidates:[],citationIds:['unseen-id']})}),/引用/);
});
test('student manuscript review also projects exact server-owned evidence instead of model-written quotations',async()=>{
 let calls=0;const original='苏轼组织疏浚西湖，利用淤泥修堤。';
 const result=await reviewStory(async messages=>{if(++calls===2)return response({directorPrompt:'五轮普通人故事'});const data=JSON.parse(messages[1].content).untrustedTeachingData;return response({approved:true,title:'船工',role:'杭州船工',event:'疏浚西湖',feedback:'符合要求',annotations:[],citationIds:[data.citationOptions[0].id]});},course,activity,'苏轼疏浚西湖时，普通船工参与劳动。',original);
 assert.equal(calls,2);assert.deepEqual(result.citations,[{quote:original}]);
});
