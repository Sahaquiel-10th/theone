import type {TeachingActivity,TeachingCourse,TeachingStage,TeachingSubmission} from '../server/teachingTypes';
import type {TeacherIdentity} from './teacherTaskState';
import type {ActivityDraft,CourseDraft} from './teachingState';

export type CourseView={stage:TeachingStage;activityId:string;panel:'prepare'|'collect'};
export const emptyCourseView=(stage:TeachingStage='before'):CourseView=>({stage,activityId:'',panel:'prepare'});
export const courseSelectionKey=(owner:Pick<TeacherIdentity,'userId'|'workspaceId'>)=>`one-teaching-course:v1:${encodeURIComponent(owner.workspaceId)}:${encodeURIComponent(owner.userId)}`;
export const courseViewKey=(owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string)=>`${courseSelectionKey(owner)}:${encodeURIComponent(courseId)}`;
export function decodeCourseView(raw:string|null,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string):CourseView{
  try{const value=JSON.parse(raw??'null');if(!value||Array.isArray(value)||value.userId!==owner.userId||value.workspaceId!==owner.workspaceId||value.courseId!==courseId||!['before','during','after'].includes(value.stage)||!['prepare','collect'].includes(value.panel)||typeof value.activityId!=='string')return emptyCourseView();return {stage:value.stage,activityId:value.activityId.slice(0,160),panel:value.panel};}catch{return emptyCourseView();}
}
export const encodeCourseView=(view:CourseView,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string)=>JSON.stringify({...view,userId:owner.userId,workspaceId:owner.workspaceId,courseId});
export function validCourseView(view:CourseView,course:Pick<TeachingCourse,'activities'>):CourseView{
  const activity=course.activities.find(item=>item.id===view.activityId&&item.stage===view.stage);
  return {...view,activityId:activity?.id??course.activities.find(item=>item.stage===view.stage)?.id??''};
}
export function submissionGradingActivity(submission:TeachingSubmission):TeachingActivity{
  return (submission as TeachingSubmission&{gradingSnapshot?:TeachingActivity}).gradingSnapshot??submission.activitySnapshot;
}
export function assignmentNeedsCurrentBasis(submission:TeachingSubmission,activity:TeachingActivity):boolean{
  const basis=submissionGradingActivity(submission);
  return activity.kind==='assignment'&&submission.grade?.status!=='published'&&JSON.stringify([basis.rubric,basis.referenceText??'',basis.sourceAttachmentIds??[],basis.knowledgeSources??[],basis.avatarPrompt??''])!==JSON.stringify([activity.rubric,activity.referenceText??'',activity.sourceAttachmentIds??[],activity.knowledgeSources??[],activity.avatarPrompt??'']);
}
export const teachingCourseStatus=(course:Pick<TeachingCourse,'status'>)=>course.status==='published'?'学生入口已开放':course.status==='closed'?'学生入口已暂停':'准备中';
export type TeacherAiAttempt={courseId:string;operationId:string;payload:string};
export function decodeCourseAiAttempt(raw:string|null,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string):TeacherAiAttempt|undefined{
  try{const value=JSON.parse(raw??'null');if(value?.userId!==owner.userId||value?.workspaceId!==owner.workspaceId||value?.courseId!==courseId||typeof value.operationId!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(value.operationId)||typeof value.payload!=='string'||value.payload.length>20000)return;const body=JSON.parse(value.payload);if(!body||!['prepare','grade','insights'].includes(body.kind)||typeof body.activityId!=='string')return;return {courseId,operationId:value.operationId,payload:value.payload};}catch{return;}
}
export type CourseEditorDraft={revision:number;form:CourseDraft;drafts:Record<string,ActivityDraft>};
export function decodeCourseEditor(raw:string|null,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string):CourseEditorDraft|undefined{
  try{const value=JSON.parse(raw??'null'),form=value?.form;if(value?.userId!==owner.userId||value?.workspaceId!==owner.workspaceId||value?.courseId!==courseId||!Number.isSafeInteger(value.revision)||!form||!['title','subject','description','materialText'].every(field=>typeof form[field]==='string')||!Number.isFinite(form.budgetMicros)||!Array.isArray(form.materialAttachmentIds)||form.materialAttachmentIds.some((id:unknown)=>typeof id!=='string')||!value.drafts||Array.isArray(value.drafts)||typeof value.drafts!=='object')return;
    const drafts:Record<string,ActivityDraft>={};for(const [key,rawDraft] of Object.entries(value.drafts)){const draft=rawDraft as ActivityDraft;if(!key.startsWith(courseId+':')||!draft||!['before','during','after'].includes(draft.stage)||!['inquiry','quiz','assignment','game','scenario'].includes(draft.kind)||!['title','instructions','referenceText'].every(field=>typeof (draft as unknown as Record<string,unknown>)[field]==='string')||!Array.isArray(draft.questions)||!Array.isArray(draft.rubric)||!Array.isArray(draft.scenes)||!Array.isArray(draft.sourceAttachmentIds))continue;drafts[key]=draft;}return {revision:value.revision,form,drafts};
  }catch{return;}
}
