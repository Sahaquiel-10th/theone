import test from 'node:test';
import assert from 'node:assert/strict';
import type {TeachingActivity,TeachingCourse,TeachingOperation} from '../server/teachingTypes';
import {activityDraft} from './teachingState';
import {activityMatchesTool,decodeToolAttempt,decodeToolDraft,encodeToolDraft,makeToolDraft,normalizeTeachingToolStep,quizReviewProblem,reconcileToolDraft,teachingEntryIsOpen,teachingEntryLink,teachingToolInfo,teachingToolPreviewHistory,teachingToolStorageKey,toolActivityPayload,toolTrashPayload} from './teachingToolState';

const owner={workspaceId:'workspace-a',userId:'teacher-a'};
const course:TeachingCourse={...owner,id:'course-a',revision:4,title:'课程',subject:'主题',description:'',materialText:'教材原文',materialAttachmentIds:[],budgetMicros:0,status:'draft',activities:[],createdAt:'now',updatedAt:'now'};
const makeActivity=(tool:'ask'|'game'|'quiz'|'grade'):TeachingActivity=>({...makeToolDraft(tool).activity,...owner,id:'activity-a',courseId:course.id,revision:2,status:'draft',createdAt:'now',updatedAt:'now'});

test('the four tools have separate page sequences, while old scenario entries remain discoverable',()=>{
  assert.deepEqual(teachingToolInfo.grade.steps.map(step=>step.id),['submissions','grading','results']);
  assert.deepEqual(teachingToolInfo.quiz.steps.map(step=>step.id),['upload','review','publish','answers']);
  assert.equal(normalizeTeachingToolStep('ask','grading'),'list');
  assert.equal(normalizeTeachingToolStep('game','play'),'play');
  for(const tool of ['ask','game','quiz','grade'] as const)assert.equal(normalizeTeachingToolStep(tool,'trash'),'trash');
  assert.equal(activityMatchesTool({kind:'scenario'},'game'),true);
  assert.equal(activityMatchesTool({kind:'assignment'},'ask'),false);
});

test('unfinished tool content restores only in its exact owner, course and tool',()=>{
  const draft=makeToolDraft('quiz');draft.activity.title='未完成试卷';draft.activity.referenceText='教师答案原件';
  const raw=encodeToolDraft(draft,owner,course.id,'quiz');
  assert.deepEqual(decodeToolDraft(raw,owner,course.id,'quiz'),draft);
  for(const scope of [{...owner,userId:'other'},{...owner,workspaceId:'other'}])assert.equal(decodeToolDraft(raw,scope,course.id,'quiz'),undefined);
  assert.equal(decodeToolDraft(raw,owner,'other-course','quiz'),undefined);
  assert.equal(decodeToolDraft(raw,owner,course.id,'ask'),undefined);
  assert.notEqual(teachingToolStorageKey(owner,course.id,'quiz'),teachingToolStorageKey({...owner,workspaceId:'other'},course.id,'quiz'));
  for(const value of [null,[],{...draft,...owner,courseId:course.id,tool:'quiz',activity:{...draft.activity,questions:[null]}}])assert.equal(decodeToolDraft(JSON.stringify(value),owner,course.id,'quiz'),undefined);
});

test('lost AI receipts preserve the original operation and payload without crossing tool or activity scopes',()=>{
  const payload=JSON.stringify({kind:'answer',activityId:'activity-a',preview:true,conversationId:'conversation-original',content:'我的原问题',budgetConfirmed:true});
  const saved={...owner,courseId:course.id,tool:'ask',operationId:'original-operation-0001',activityId:'activity-a',payload};
  const restored=decodeToolAttempt(JSON.stringify(saved),owner,course.id,'ask');
  assert.equal(restored?.operationId,saved.operationId);assert.equal(restored?.payload,payload);
  assert.equal(decodeToolAttempt(JSON.stringify(saved),owner,course.id,'game'),undefined);
  assert.equal(decodeToolAttempt(JSON.stringify(saved),{...owner,userId:'other'},course.id,'ask'),undefined);
  assert.equal(decodeToolAttempt(JSON.stringify({...saved,activityId:'other'}),owner,course.id,'ask'),undefined);
});

test('teacher trial history never displays student sessions or other activity and conversation records',()=>{
  const row:TeachingOperation={...owner,id:'operation-a',courseId:course.id,activityId:'activity-a',operationId:'request-a',payloadHash:'hash',kind:'answer',question:'问题',conversationId:'trial-a',status:'completed',createdAt:'2026-11-04T00:00:00Z'};
  const rows=[row,{...row,id:'student',sessionId:'student-session'},{...row,id:'other-item',activityId:'other-item'},{...row,id:'other-trial',conversationId:'other-trial'}];
  assert.deepEqual(teachingToolPreviewHistory(rows,'activity-a','trial-a').map(item=>item.id),['operation-a']);
});

test('activity creation uses its durable idempotency key while later edits include both revisions',()=>{
  const draft=makeToolDraft('quiz');draft.activity.title='  随堂测验  ';draft.activity.referenceText='仅教师的答案';
  const creation=toolActivityPayload(course,draft);assert.equal('clientRequestId' in creation?creation.clientRequestId:undefined,draft.draftId);assert.equal(creation.status,'draft');assert.equal(creation.title,'随堂测验');
  const activity=makeActivity('quiz'),edit=toolActivityPayload(course,draft,activity);assert.equal(edit.revision,4);assert.equal('activityRevision' in edit?edit.activityRevision:undefined,2);assert.equal('clientRequestId' in edit,false);
  assert.equal(creation.referenceText,'仅教师的答案');assert.equal(draft.activity.title,'  随堂测验  ');
});

test('batch recycle and restore payloads explicitly select exact current owner records and all versions',()=>{
  const activity=makeActivity('grade'),payload=toolTrashPayload(course,[activity]);
  assert.deepEqual(payload,{confirmed:true,items:[{courseId:course.id,revision:4,activityId:activity.id,activityRevision:2}]});
  for(const changed of [{...activity,userId:'other'},{...activity,workspaceId:'other'},{...activity,courseId:'other'}])assert.throws(()=>toolTrashPayload(course,[changed]),/不属于/);
  assert.throws(()=>toolTrashPayload(course,[activity,activity]),/不同条目/);assert.throws(()=>toolTrashPayload(course,[]),/明确选择/);
});

test('saved grading changes and access revisions do not turn into false conflicts after navigation or HMR',()=>{
  const activity=makeActivity('grade'),local=makeToolDraft('grade',activity),updated={...activity,revision:3,rubric:[{id:'score',label:'准确性',description:'依据原件',maxScore:100}]};
  const restored=reconcileToolDraft(local,updated,'grade');assert.equal(restored.stale,false);assert.equal(restored.draft.activityRevision,3);assert.deepEqual(restored.draft.activity.rubric,updated.rubric);assert.equal(restored.draft.activity.instructions,activity.instructions);
  const quiz=makeActivity('quiz'),quizLocal=makeToolDraft('quiz',quiz);quizLocal.activity.instructions='本机尚未保存说明';
  const conflict=reconcileToolDraft(quizLocal,{...quiz,revision:3},'quiz');assert.equal(conflict.stale,true);assert.equal(conflict.draft.activity.instructions,'本机尚未保存说明');
  const clean=reconcileToolDraft(makeToolDraft('quiz',quiz),{...quiz,revision:3},'quiz');assert.equal(clean.stale,false);assert.equal(clean.draft.activityRevision,3);
});

test('independent entry links retain legacy access only until that exact item is explicitly closed',()=>{
  const activity={...makeActivity('ask'),status:'published' as const},legacy={...course,status:'published' as const,slug:'legacy-slug'};
  assert.equal(teachingEntryIsOpen(legacy,activity),true);
  assert.equal(teachingEntryLink(legacy,activity,'https://one.example'),'https://one.example/learn/legacy-slug?activityId=activity-a');
  assert.equal(teachingEntryLink(legacy,{...activity,isOpen:false},'https://one.example'),'');
  assert.equal(teachingEntryLink(course,{...activity,isOpen:true,slug:'exact-item'},'https://one.example'),'https://one.example/learn/exact-item');
});

test('quiz review rejects incomplete question contracts and single answers that are not exact option values',()=>{
  const draft=activityDraft(makeActivity('quiz'));assert.ok(quizReviewProblem(draft));
  draft.questions=[{id:'question',prompt:'请选择',type:'single',options:['杭州','宁波'],answer:'A',points:10}];assert.ok(quizReviewProblem(draft));
  draft.questions[0].answer='杭州';assert.equal(quizReviewProblem(draft),'');
});
