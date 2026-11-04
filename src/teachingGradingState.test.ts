import test from 'node:test';
import assert from 'node:assert/strict';
import type {TeachingActivity} from '../server/teachingTypes';
import {activityDraft,newActivityDraft} from './teachingState';
import {decodeGradingEditor,gradingDraftChanged,gradingFields,gradingUpdatePayload} from './teachingGradingState';

const owner={workspaceId:'workspace-a',userId:'teacher-a'};
const activity:TeachingActivity={...newActivityDraft('after','assignment'),...owner,id:'assignment-a',courseId:'course-a',revision:3,title:'原作业',instructions:'学生已经看到的原要求',status:'published',createdAt:'now',updatedAt:'now'};
const rubric=[{id:'accuracy',label:'准确性',description:'依据原作业',maxScore:100}];

test('live grading changes send only teacher grading fields and the two version checks',()=>{
  const draft={...activityDraft(activity),title:'不能改学生标题',instructions:'不能改学生要求',rubric,referenceText:'教师专用答案',avatarPrompt:'先说明依据再给建议',sourceAttachmentIds:['reference-file']};
  const payload=gradingUpdatePayload({revision:5},activity,draft);
  assert.deepEqual(Object.keys(payload).sort(),['revision','activityRevision','rubric','referenceText','sourceAttachmentIds','knowledgeSources','avatarPrompt'].sort());
  assert.equal(payload.revision,5);assert.equal(payload.activityRevision,3);
  assert.equal('instructions' in payload,false);assert.equal('status' in payload,false);assert.equal('slug' in payload,false);
  assert.equal(payload.referenceText,'教师专用答案');assert.equal(activity.instructions,'学生已经看到的原要求');
  payload.rubric[0].maxScore=50;assert.equal(draft.rubric[0].maxScore,100);
});

test('grading drafts restore only in their exact owner, course and assignment, preserving the current student task',()=>{
  const draft={...activityDraft(activity),rubric,referenceText:'教师参考'};
  const saved={...owner,courseId:activity.courseId,activityId:activity.id,revision:3,form:{...gradingFields(draft),instructions:'本机缓存不允许改学生任务'}};
  const restored=decodeGradingEditor(JSON.stringify(saved),owner,activity.courseId,activity);
  assert.equal(restored?.draft.instructions,activity.instructions);assert.deepEqual(restored?.draft.rubric,rubric);
  for(const scope of [{...owner,userId:'other'},{...owner,workspaceId:'other'}])assert.equal(decodeGradingEditor(JSON.stringify(saved),scope,activity.courseId,activity),undefined);
  assert.equal(decodeGradingEditor(JSON.stringify(saved),owner,'other-course',activity),undefined);
  assert.equal(decodeGradingEditor(JSON.stringify(saved),owner,activity.courseId,{...activity,id:'other-activity'}),undefined);
  assert.equal(gradingDraftChanged(draft,activity),true);
  assert.equal(gradingDraftChanged({...activityDraft(activity),instructions:'其他任务草稿'},activity),false);
});

test('malformed browser grading drafts never render null criteria or knowledge records',()=>{
  const saved={...owner,courseId:activity.courseId,activityId:activity.id,revision:3,form:gradingFields(activity)};
  for(const raw of ['null','[]','{broken',JSON.stringify({...saved,form:{...saved.form,rubric:[null]}}),JSON.stringify({...saved,form:{...saved.form,knowledgeSources:[null]}})])assert.equal(decodeGradingEditor(raw,owner,activity.courseId,activity),undefined);
});
