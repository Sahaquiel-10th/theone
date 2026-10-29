import test from 'node:test';
import assert from 'node:assert/strict';
import type {TeachingActivity,TeachingSubmission} from '../server/teachingTypes';
import {activityDraft,activityDraftKey,applyPreparation,canApplyTeachingPreparation,draftChanged,editableGrade,newActivityDraft,publicSessionStorageKey,stageKinds,teachingCsv,teachingScoreTotal} from './teachingState';

test('each phase offers only its relevant tools; phase drafts cannot collide across courses or activities',()=>{
  assert.deepEqual(stageKinds('before'),['inquiry']);assert.deepEqual(stageKinds('during'),['scenario','inquiry']);assert.deepEqual(stageKinds('after'),['assignment','quiz']);
  assert.equal(new Set([activityDraftKey('a','before'),activityDraftKey('a','after'),activityDraftKey('b','before'),activityDraftKey('a','before','saved')]).size,4);
});
test('a prepared activity is a reviewable draft and cannot overwrite title, phase or private reference inputs',()=>{
  const draft={...newActivityDraft('after','quiz'),title:'原试卷',referenceText:'仅老师可见',sourceAttachmentIds:['att_private']};
  const result=applyPreparation(draft,{kind:'prepare',draft:{title:'擅改标题',stage:'before',referenceText:'覆盖参考',instructions:'给学生的说明',questions:[{id:'q1',prompt:'问题',type:'text',options:[],answer:'答案',points:10}]}});
  assert.equal(result.title,'原试卷');assert.equal(result.stage,'after');assert.equal(result.referenceText,'仅老师可见');assert.deepEqual(result.sourceAttachmentIds,['att_private']);assert.equal(result.instructions,'给学生的说明');
  result.questions[0].prompt='教师修改';assert.equal(draft.questions.length,0);
});
test('non-prepare results cannot silently alter a teacher draft',()=>{
  const draft=newActivityDraft('before');assert.equal(applyPreparation(draft,{kind:'grade',draft:{instructions:'不应应用'}}),draft);assert.equal(applyPreparation(draft,null),draft);
});
test('a completed preparation applies only to the original course revision and activity',()=>{
  const activity={id:'original-activity'} as TeachingActivity,course={revision:4,activities:[activity]};
  const operation={kind:'prepare' as const,status:'completed' as const,courseRevision:4,activityId:activity.id};
  assert.equal(canApplyTeachingPreparation(operation,course),true);
  assert.equal(canApplyTeachingPreparation(operation,{...course,revision:5}),false);
  assert.equal(canApplyTeachingPreparation(operation,{...course,activities:[{...activity,id:'different-activity'}]}),false);
  assert.equal(canApplyTeachingPreparation({...operation,courseRevision:undefined},course),false);
  assert.equal(canApplyTeachingPreparation({...operation,kind:'grade'},course),false);
});
test('loading old saved activities normalizes optional private sources and starts clean',()=>{
  const activity={...newActivityDraft('after'),id:'a',courseId:'c',revision:1,workspaceId:'w',userId:'u',createdAt:'now',updatedAt:'now',status:'draft'} as TeachingActivity;
  delete activity.referenceText;delete activity.sourceAttachmentIds;
  const draft=activityDraft(activity);assert.equal(draft.referenceText,'');assert.deepEqual(draft.sourceAttachmentIds,[]);assert.equal(draftChanged(draft,activity),false);
  draft.title='未保存';assert.equal(draftChanged(draft,activity),true);assert.notEqual(activity.title,'未保存');
});
test('manual quiz review uses question identifiers while assignment review uses rubric identifiers',()=>{
  const submission={activitySnapshot:{kind:'quiz',questions:[{id:'question-a'}],rubric:[{id:'criterion-a'}]}} as unknown as TeachingSubmission;
  assert.equal(editableGrade(submission).criteria[0].criterionId,'question-a');submission.activitySnapshot.kind='assignment';assert.equal(editableGrade(submission).criteria[0].criterionId,'criterion-a');
});
test('editing a suggested grade never mutates the saved AI suggestion',()=>{
  const submission={grade:{criteria:[{criterionId:'one',score:1,comment:'依据',evidence:'原文'}],feedback:'待复核',total:1,source:'ai',status:'suggested',needsReview:true}} as TeachingSubmission;
  const draft=editableGrade(submission);draft.criteria[0].score=10;assert.equal(submission.grade!.criteria[0].score,1);
});
test('CSV exports quote text and neutralize spreadsheet formulas from student-supplied values',()=>{
  const csv=teachingCsv([{participantName:'=HYPERLINK("https://example.com")',participantRef:'普通,学号',createdAt:'today',grade:{total:2,status:'published',feedback:'@SUM(1)'}} as TeachingSubmission]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"")"'));assert.ok(csv.includes('"普通,学号"'));assert.ok(csv.includes('"\'@SUM(1)"'));assert.ok(csv.includes('已发布'));
});
test('student sessions are stored under a course-specific key',()=>{assert.notEqual(publicSessionStorageKey('course-a'),publicSessionStorageKey('course-b'));assert.ok(publicSessionStorageKey('a').startsWith('one-teaching-session:'));});

test('fractional criterion scores produce the same two-decimal total the server reviews',()=>{assert.equal(teachingScoreTotal([{score:.1},{score:.2}]),.3);assert.equal(teachingScoreTotal([{score:12.255},{score:1}]),13.26);});
