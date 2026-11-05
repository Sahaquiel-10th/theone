import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewStory,advanceStory,approvedStory,publicStoryResult,STORY_REVIEW_PROMPT,STORY_COMPILE_PROMPT,STORY_TURN_PROMPT} from './teachingStories.js';
import type {TeachingAiCall} from './teachingAi.js';
import type {TeachingCourse,TeachingActivity,TeachingOperation} from './teachingTypes.js';
const course={id:'c',workspaceId:'w',userId:'u',title:'杭州通论'} as TeachingCourse,activity={id:'a',instructions:'普通人参与历史',avatarPrompt:'紧凑历史悬疑'} as TeachingActivity;
const materials='苏轼组织疏浚西湖，利用淤泥修堤。',script='船工担心家人生计。';
const review={approved:true,title:'船工的一天',role:'船工',event:'疏浚西湖',feedback:'符合普通人的处境',annotations:[{excerpt:'船工',comment:'补充时代背景'}],citations:[{quote:'苏轼组织疏浚西湖'}]};
const reply=(x:unknown)=>({content:JSON.stringify(x),finishReason:'stop'});
test('review and compilation are separate bounded calls; missing sources, fabricated citations or annotations cannot publish',async()=>{
 const calls:any[]=[];const call:TeachingAiCall=async(messages)=>{calls.push(messages);return reply(calls.length===1?review:{directorPrompt:'DIRECTOR_PRIVATE'});};
 const result=await reviewStory(call,course,activity,script,materials);assert.equal(result.approved,true);assert.equal(calls.length,2);assert.match(calls[0][0].content,/普通人/);assert.match(calls[1][0].content,/五轮/);assert.doesNotMatch(JSON.stringify(publicStoryResult(result)),/DIRECTOR_PRIVATE/);
 for(const wrong of [{...review,citations:[{quote:'唐代修苏堤'}]},{...review,citations:[]},{...review,annotations:[{excerpt:'不在原稿中的句子',comment:'错'}]}])await assert.rejects(()=>reviewStory(async()=>reply(wrong),course,activity,script,materials));
 let count=0;await assert.rejects(()=>reviewStory(async()=>{count++;return reply(review);},course,activity,script,''));assert.equal(count,0);
 const rejected=await reviewStory(async()=>reply({...review,approved:false,citations:[]}),course,activity,script,materials);assert.equal(rejected.directorPrompt,undefined);
});
test('five server-counted choices produce a sixth response ending; invented choices and a seventh call are blocked',async()=>{
 const turns:TeachingOperation[]=[],story={...review,kind:'script' as const,directorPrompt:'private'};
 for(let round=0;round<=5;round++){
  let captured:any;const result=await advanceStory(async messages=>{captured=JSON.parse(messages[1].content).untrustedTeachingData;return reply({answer:'虚构场景',choices:round===5?[]:['帮助邻居','先去工地'],historyExplanation:round===5?'史实不可改变':'',reflection:round===5?'你如何理解普通人的作用？':'',imagePrompt:round===5?'宋代杭州船工夕照':''});},story,turns,round?'帮助邻居':'开场','random-run');
  assert.equal(captured.round,round);assert.equal(result.ended,round===5);assert.equal(result.choices.length,round===5?0:2);
  turns.push({id:'o'+round,kind:'story_turn',status:'completed',question:round?'帮助邻居':'开场',result} as TeachingOperation);
  if(round===0)await assert.rejects(()=>advanceStory(async()=>assert.fail('must not call'),story,turns,'擅自改史','run'));
 }
 await assert.rejects(()=>advanceStory(async()=>assert.fail('must not call'),story,turns,'帮助邻居','run'));
});
test('approved work lookup binds owner, workspace, course and activity and exposes no raw manuscript or director',()=>{
 const operation={id:'story',workspaceId:'w',userId:'u',courseId:'c',activityId:'a',kind:'script',status:'completed',question:'RAW_PRIVATE',result:{...review,kind:'script',directorPrompt:'DIRECTOR_PRIVATE'}};
 const db={users:[{id:'u',defaultWorkspaceId:'w',enabled:true,teaching:{courses:[],sessions:[],submissions:[],operations:[operation]}}],workspaces:[{id:'w',status:'active'}],workspaceMembers:[{workspaceId:'w',userId:'u',role:'owner'}]} as any;
 assert.equal(approvedStory(db,{workspaceId:'w',userId:'u'},'c','a','story').result.title,review.title);
 for(const scope of [{workspaceId:'foreign',userId:'u'},{workspaceId:'w',userId:'foreign'}])assert.throws(()=>approvedStory(db,scope,'c','a','story'));
 for(const [c,a] of [['other','a'],['c','other']])assert.throws(()=>approvedStory(db,{workspaceId:'w',userId:'u'},c,a,'story'));
 assert.doesNotMatch(JSON.stringify(publicStoryResult(operation.result)),/RAW_PRIVATE|DIRECTOR_PRIVATE/);
 assert.match(STORY_REVIEW_PROMPT,/穿越者/);assert.match(STORY_COMPILE_PROMPT,/DND/);assert.match(STORY_TURN_PROMPT,/5必须结局/);
});

test('a failed compiler preserves the reviewed checkpoint without publishing an incomplete work',async()=>{
 let calls=0,checkpoint:any;
 await assert.rejects(()=>reviewStory(async()=>reply(++calls===1?review:{}),course,activity,script,materials,async r=>{checkpoint=r;}));
 assert.equal(calls,2);assert.equal(checkpoint.approved,true);assert.equal(checkpoint.directorPrompt,undefined);assert.equal(checkpoint.feedback,review.feedback);
});
