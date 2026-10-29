import type {TeachingActivity,TeachingCourse,TeachingGrade,TeachingKind,TeachingOperation,TeachingStage,TeachingSubmission} from '../server/teachingTypes';

export const teachingStages: {id:TeachingStage;title:string;description:string}[] = [
  {id:'before',title:'课前工具包',description:'了解学情，准备这一堂课'},
  {id:'during',title:'课中工具包',description:'情境讨论与现场导学'},
  {id:'after',title:'课后工具包',description:'收取答卷与作业，复核批注'},
];
export const teachingKinds:Record<TeachingKind,string>={inquiry:'学情调研 / 现场导学',scenario:'情境活动',quiz:'在线答题',assignment:'作业与批改'};
export const stageKinds=(stage:TeachingStage):TeachingKind[]=>stage==='before'?['inquiry']:stage==='during'?['scenario','inquiry']:['assignment','quiz'];
export type ActivityDraft=Pick<TeachingActivity,'title'|'stage'|'kind'|'instructions'|'questions'|'scenes'|'rubric'>&{referenceText:string;sourceAttachmentIds:string[]};
export function newActivityDraft(stage:TeachingStage,kind:TeachingKind=stageKinds(stage)[0]):ActivityDraft{return {title:'',stage,kind,instructions:'',referenceText:'',sourceAttachmentIds:[],questions:[],scenes:[],rubric:[]};}
export function activityDraft(activity:TeachingActivity):ActivityDraft{return structuredClone({title:activity.title,stage:activity.stage,kind:activity.kind,instructions:activity.instructions,referenceText:activity.referenceText??'',sourceAttachmentIds:activity.sourceAttachmentIds??[],questions:activity.questions,scenes:activity.scenes,rubric:activity.rubric});}
export const activityDraftKey=(courseId:string,stage:TeachingStage,activityId?:string)=>`${courseId}:${stage}:${activityId??'new'}`;
export const draftChanged=(draft:ActivityDraft,activity?:TeachingActivity)=>JSON.stringify(draft)!==JSON.stringify(activity?activityDraft(activity):newActivityDraft(draft.stage,draft.kind));
/** A previously completed draft must not replace a teacher's newer saved activity. */
export function canApplyTeachingPreparation(operation:Pick<TeachingOperation,'kind'|'status'|'courseRevision'|'activityId'>,course:Pick<TeachingCourse,'revision'|'activities'>):boolean{return operation.kind==='prepare'&&operation.status==='completed'&&operation.courseRevision===course.revision&&course.activities.some(activity=>activity.id===operation.activityId);}
export function applyPreparation(draft:ActivityDraft,value:unknown):ActivityDraft{
  if(!value||typeof value!=='object')return draft;
  const result=value as {kind?:string;draft?:Partial<ActivityDraft>};if(result.kind!=='prepare'||!result.draft)return draft;
  const next=result.draft;
  return {...draft,...(typeof next.instructions==='string'?{instructions:next.instructions}:{}),...(Array.isArray(next.questions)?{questions:structuredClone(next.questions)}:{}),...(Array.isArray(next.scenes)?{scenes:structuredClone(next.scenes)}:{}),...(Array.isArray(next.rubric)?{rubric:structuredClone(next.rubric)}:{})};
}
export function editableGrade(submission:TeachingSubmission):TeachingGrade{
  if(submission.grade)return structuredClone(submission.grade);
  const criteria=submission.activitySnapshot.kind==='quiz'?submission.activitySnapshot.questions.map(q=>({criterionId:q.id,score:0,comment:'',evidence:''})):submission.activitySnapshot.rubric.map(c=>({criterionId:c.id,score:0,comment:'',evidence:''}));
  return {criteria,total:0,feedback:'',source:'teacher',status:'suggested',needsReview:true};
}
export const teachingScoreTotal=(criteria:{score:number}[])=>Math.round(criteria.reduce((sum,item)=>sum+item.score,0)*100)/100;
export function teachingCsv(submissions:TeachingSubmission[]):string{
  const cell=(value:unknown)=>{let s=String(value??'');if(/^[\s]*[=+@\-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\uFEFF'+[['姓名 / 昵称','学号 / 识别码','提交时间','得分','反馈状态','教师反馈'],...submissions.map(s=>[s.participantName,s.participantRef,s.createdAt,s.grade?.total??'',s.grade?.status==='published'?'已发布':s.grade?'待复核':'待批改',s.grade?.feedback??''])].map(row=>row.map(cell).join(',')).join('\r\n');
}
export type CourseDraft=Pick<TeachingCourse,'title'|'subject'|'description'|'materialText'|'materialAttachmentIds'|'budgetMicros'>;
export const emptyCourseDraft=():CourseDraft=>({title:'',subject:'',description:'',materialText:'',materialAttachmentIds:[],budgetMicros:5_000_000});
export const publicSessionStorageKey=(slug:string)=>`one-teaching-session:${slug}`;
