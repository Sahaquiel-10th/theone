import test from 'node:test';
import assert from 'node:assert/strict';
import type {TeachingActivity,TeachingSubmission} from '../server/teachingTypes';
import {activityDraft,editableGrade,emptyCourseDraft,newActivityDraft} from './teachingState';
import {assignmentNeedsCurrentBasis,courseViewKey,decodeCourseAiAttempt,decodeCourseEditor,decodeCourseView,encodeCourseView,submissionGradingActivity,validCourseView} from './teacherCourseState';

const owner={userId:'teacher-a',workspaceId:'workspace-a'};
const activity={...newActivityDraft('after','assignment'),id:'work',revision:2,courseId:'course-a',workspaceId:owner.workspaceId,userId:owner.userId,status:'published',createdAt:'now',updatedAt:'now',rubric:[{id:'accuracy',label:'准确性',description:'依据原文',maxScore:100}]} as TeachingActivity;
const submissionBase:TeachingSubmission={...owner,id:'submission-a',courseId:'course-a',activityId:activity.id,activityRevision:1,participantName:'学生',participantRef:'',operationId:'original-submission-0001',payloadHash:'hash',text:'',answers:{},attachmentIds:[],activitySnapshot:activity,createdAt:'now'};
test('course stage selections are bound to both owner and course, and stale activities never select another course',()=>{
  const view={stage:'after' as const,activityId:activity.id,panel:'collect' as const},encoded=encodeCourseView(view,owner,'course-a');
  assert.deepEqual(decodeCourseView(encoded,owner,'course-a'),view);
  for(const scope of [{...owner,userId:'teacher-b'},{...owner,workspaceId:'workspace-b'}])assert.equal(decodeCourseView(encoded,scope,'course-a').activityId,'');
  assert.equal(decodeCourseView(encoded,owner,'course-b').activityId,'');
  assert.notEqual(courseViewKey(owner,'course-a'),courseViewKey(owner,'course-b'));
  assert.equal(validCourseView({...view,activityId:'foreign-activity'},{activities:[activity]}).activityId,activity.id);
  for(const raw of ['null','[]','{broken'])assert.equal(decodeCourseView(raw,owner,'course-a').activityId,'');
});
test('an original AI request can recover only for its exact course and identity, without generating a new operation id',()=>{
  const saved={...owner,courseId:'course-a',operationId:'original-operation-0001',payload:JSON.stringify({kind:'grade',activityId:activity.id,submissionId:'submission-a',budgetConfirmed:true})};
  const restored=decodeCourseAiAttempt(JSON.stringify(saved),owner,'course-a');assert.equal(restored?.operationId,saved.operationId);assert.equal(restored?.payload,saved.payload);
  assert.equal(decodeCourseAiAttempt(JSON.stringify(saved),{...owner,workspaceId:'other'},'course-a'),undefined);
  assert.equal(decodeCourseAiAttempt(JSON.stringify(saved),owner,'other-course'),undefined);
  for(const value of [null,[],{...saved,payload:'null'},{...saved,payload:'{"kind":"unknown","activityId":"work"}'}])assert.equal(decodeCourseAiAttempt(JSON.stringify(value),owner,'course-a'),undefined);
});
test('post-collection grading compares only replaceable basis fields and preserves original task instructions',()=>{
  const submission:TeachingSubmission={...submissionBase,activitySnapshot:{...activity,instructions:'学生原任务'},gradingRevision:1,gradingSnapshot:{...activity,instructions:'学生原任务'}};
  assert.equal(assignmentNeedsCurrentBasis(submission,{...activity,instructions:'新任务说明'}),false);
  assert.equal(assignmentNeedsCurrentBasis(submission,{...activity,avatarPrompt:'新的AI评阅引导'}),true);
  const source={provider:'notion' as const,connectionId:'connection',binding:'binding',scope:'page' as const,pageId:'page',label:'评分参考'};
  assert.equal(assignmentNeedsCurrentBasis(submission,{...activity,knowledgeSources:[source]}),true);
  assert.equal(assignmentNeedsCurrentBasis(submission,{...activity,rubric:[{...activity.rubric[0],maxScore:50}]}),true);
  submission.grade={criteria:[],feedback:'已发布',total:0,status:'published',source:'teacher',needsReview:false};assert.equal(assignmentNeedsCurrentBasis(submission,{...activity,referenceText:'新参考'}),false);
});
test('manual grading and retained drafts use the active grading snapshot without mutating original answers',()=>{
  const submission:TeachingSubmission={...submissionBase,activitySnapshot:{...activity,rubric:[]},gradingSnapshot:activity,gradingRevision:2};
  assert.equal(submissionGradingActivity(submission),activity);const grade=editableGrade(submission);assert.equal(grade.criteria[0].criterionId,'accuracy');assert.equal(grade.gradingRevision,2);assert.deepEqual(submission.activitySnapshot.rubric,[]);
  const draft={...owner,courseId:'course-a',revision:2,form:{...emptyCourseDraft(),title:'课程草稿'},drafts:{'course-a:after:work':activityDraft(activity)}};
  assert.equal(decodeCourseEditor(JSON.stringify(draft),owner,'course-a')?.form.title,'课程草稿');assert.equal(decodeCourseEditor(JSON.stringify(draft),{...owner,userId:'other'},'course-a'),undefined);assert.equal(decodeCourseEditor('null',owner,'course-a'),undefined);
});
