import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Database} from './types.js';
import {createTeachingActivity,createTeachingCourse,publishTeachingCourse,publicTeachingCourse,updateTeachingCourse} from './teaching.js';
import {setTeachingActivityOpen} from './teachingLifecycle.js';

const scope={workspaceId:'budget-ws',userId:'budget-teacher'};
const db=()=>({users:[{id:scope.userId,enabled:true}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[{...scope,role:'owner'}],attachments:[],knowledgeConnections:[]} as unknown as Database);

test('new manual teaching defaults to balance, while absent old modes and their caps never change on an ordinary edit',()=>{
  const data=db(),fresh=createTeachingCourse(data,scope,{title:'新课程'});assert.equal(fresh.teacherBudgetMode,'balance');assert.equal(fresh.budgetMicros,0);
  const old=createTeachingCourse(data,scope,{title:'旧课程',budgetMicros:12345});delete old.teacherBudgetMode;
  updateTeachingCourse(data,scope,old.id,{revision:old.revision,title:'仅改名称'});assert.equal(old.teacherBudgetMode,undefined);assert.equal(old.budgetMicros,12345);
  updateTeachingCourse(data,scope,old.id,{revision:old.revision,teacherBudgetMode:'balance'});assert.equal(old.teacherBudgetMode,'balance');assert.equal(old.budgetMicros,12345);
  updateTeachingCourse(data,scope,old.id,{revision:old.revision,teacherBudgetMode:'course'});assert.equal(old.teacherBudgetMode,'course');assert.equal(old.budgetMicros,12345);
  for(const mode of ['unlimited',['balance'],{},null])assert.throws(()=>updateTeachingCourse(data,scope,old.id,{revision:old.revision,teacherBudgetMode:mode}),/保护方式/);
  const explicit=createTeachingCourse(data,scope,{title:'明确课程限制',teacherBudgetMode:'course',budgetMicros:10});assert.equal(explicit.teacherBudgetMode,'course');
});

test('pre-mode knowledge course create receipts replay their original nonce without migrating its mode or original limit',()=>{
  const data=db(),body={title:'已保存课程',subject:'',description:'',sourceMode:'knowledge',knowledgeSources:[],budgetMicros:12345,clientRequestId:'knowledge-before-mode-key'};
  const existing=createTeachingCourse(data,scope,body);delete existing.teacherBudgetMode;
  const oldContent={sourceMode:'knowledge',title:body.title,subject:'',description:'',materialText:'',knowledgeSources:[],budgetMicros:body.budgetMicros};
  existing.createPayloadHash=createHash('sha256').update(JSON.stringify(oldContent)).digest('hex');
  const replay=createTeachingCourse(data,scope,body);assert.equal(replay.id,existing.id);assert.equal(replay.teacherBudgetMode,undefined);assert.equal(replay.budgetMicros,12345);assert.equal(data.users[0].teaching!.courses.length,1);
  assert.throws(()=>createTeachingCourse(data,scope,{...body,teacherBudgetMode:'balance'}),/另一份课程|另一份|另一|内容|课程内容/);
  assert.equal(existing.teacherBudgetMode,undefined);assert.equal(data.users[0].teaching!.courses.length,1);
});

test('student AI entries require a positive cumulative cap even for balance teachers; pure submissions do not',()=>{
  for(const kind of ['inquiry','game','scenario','quiz','assignment'] as const){
    const data=db(),course=createTeachingCourse(data,scope,{title:'零上限',teacherBudgetMode:'balance'}),activity=createTeachingActivity(data,scope,course.id,{revision:course.revision,title:'入口',kind,stage:kind==='inquiry'?'before':'after',status:'published'}).activity;
    const open=()=>setTeachingActivityOpen(data,scope,course.id,activity.id,{revision:course.revision,activityRevision:activity.revision,confirmed:true},true);
    if(['inquiry','game','scenario'].includes(kind)){
      assert.throws(open,/学生 AI 入口/);assert.throws(()=>publishTeachingCourse(data,scope,course.id,{revision:course.revision,confirmed:true}),/学生 AI 入口/);
      updateTeachingCourse(data,scope,course.id,{revision:course.revision,budgetMicros:100});assert.doesNotThrow(open);
    }else assert.doesNotThrow(open);
    assert.doesNotMatch(JSON.stringify(publicTeachingCourse(course)),/teacherBudgetMode/);
  }
});
