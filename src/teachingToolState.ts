import type {TeachingActivity,TeachingCourse,TeachingOperation,TeachingTaskKind} from '../server/teachingTypes';
import {activityDraft,newActivityDraft,type ActivityDraft} from './teachingState';
import type {TeacherIdentity} from './teacherTaskState';

export const teachingToolInfo:Record<TeachingTaskKind,{title:string;create:string;steps:{id:string;title:string}[]}>= {
  ask:{title:'知识问答辅导',create:'新建辅导',steps:[{id:'setup',title:'设置辅导'},{id:'preview',title:'试问与预览'},{id:'share',title:'分享与参与'}]},
  game:{title:'文字游戏构建',create:'新建游戏',steps:[{id:'setup',title:'构建游戏'},{id:'play',title:'试玩'},{id:'share',title:'分享游戏'}]},
  quiz:{title:'上传试卷',create:'新建试卷',steps:[{id:'upload',title:'上传试卷'},{id:'review',title:'核对题目'},{id:'publish',title:'发布测验'},{id:'answers',title:'答卷与批改'}]},
  grade:{title:'批改作业',create:'新建作业收件',steps:[{id:'submissions',title:'学生作业'},{id:'grading',title:'评分要求'},{id:'results',title:'批改结果'}]},
};
export function normalizeTeachingToolStep(tool:TeachingTaskKind,step:string){return step==='list'||step==='trash'||teachingToolInfo[tool].steps.some(item=>item.id===step)?step:'list';}
export function activityMatchesTool(activity:Pick<TeachingActivity,'kind'>,tool:TeachingTaskKind){return activity.kind===(tool==='ask'?'inquiry':tool==='grade'?'assignment':tool)||tool==='game'&&activity.kind==='scenario';}
export function newToolActivity(tool:TeachingTaskKind):ActivityDraft{
  const value=newActivityDraft(tool==='grade'||tool==='quiz'?'after':tool==='game'?'during':'before',tool==='ask'?'inquiry':tool==='grade'?'assignment':tool);
  if(tool==='ask')value.avatarPrompt='依据本课程允许学生学习的资料回答。通过简短追问帮助学生理解，资料不足时明确说明，不编造事实。';
  if(tool==='game'){value.avatarPrompt='以杭州普通人的生计、制度阻力和人情往来构建紧凑的历史悬疑。主角必须是当时可能存在的小人物。五轮决策，每轮两个有代价的选择，玩家选择后再生成后果。同一剧本允许不同个人命运，历史大事件的基本史实不可改写。结局解释个人选择如何参与大历史，并区分史实与虚构。';value.allowStudentPrompt=true;}
  return value;
}
export type TeachingToolDraft={draftId:string;activityId?:string;activityRevision?:number;activity:ActivityDraft;conversationId:string;createPayload?:string};
export const teachingToolStorageKey=(owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string,tool:TeachingTaskKind,itemId='new')=>`one-teaching-tool:v1:${[owner.workspaceId,owner.userId,courseId,tool,itemId].map(encodeURIComponent).join(':')}`;
export function makeToolDraft(tool:TeachingTaskKind,activity?:TeachingActivity):TeachingToolDraft{return {draftId:crypto.randomUUID(),...(activity?{activityId:activity.id,activityRevision:activity.revision}:{}),activity:activity?activityDraft(activity):newToolActivity(tool),conversationId:crypto.randomUUID()};}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const strings=(value:unknown,max:number):value is string[]=>Array.isArray(value)&&value.length<=max&&value.every(item=>typeof item==='string');
export function validToolActivityDraft(value:unknown,tool:TeachingTaskKind):value is ActivityDraft{
  if(!record(value)||!activityMatchesTool(value as unknown as ActivityDraft,tool)||!['before','during','after'].includes(String(value.stage))||!['title','instructions','referenceText'].every(key=>typeof value[key]==='string')||!strings(value.sourceAttachmentIds,40))return false;
  if(value.avatarPrompt!==undefined&&typeof value.avatarPrompt!=='string'||value.allowStudentPrompt!==undefined&&typeof value.allowStudentPrompt!=='boolean')return false;
  if(!Array.isArray(value.questions)||value.questions.length>40||value.questions.some(question=>!record(question)||!['id','prompt','answer'].every(key=>typeof question[key]==='string')||!['single','text'].includes(String(question.type))||!strings(question.options,20)||typeof question.points!=='number'||!Number.isFinite(question.points)))return false;
  if(!Array.isArray(value.rubric)||value.rubric.length>20||value.rubric.some(row=>!record(row)||!['id','label','description'].every(key=>typeof row[key]==='string')||typeof row.maxScore!=='number'||!Number.isFinite(row.maxScore)))return false;
  if(!Array.isArray(value.scenes)||value.scenes.length>10||value.scenes.some(row=>!record(row)||!['id','title','content','reflection'].every(key=>typeof row[key]==='string')||!strings(row.choices,10)))return false;
  if(value.knowledgeSources!==undefined&&(!Array.isArray(value.knowledgeSources)||value.knowledgeSources.length>5||value.knowledgeSources.some(source=>!record(source)||!['provider','connectionId','binding','label'].every(key=>typeof source[key]==='string')||!['page','connection'].includes(String(source.scope)))))return false;
  return true;
}
export function decodeToolDraft(raw:string|null,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string,tool:TeachingTaskKind):TeachingToolDraft|undefined{
  try{const saved:unknown=JSON.parse(raw??'null');if(!record(saved)||saved.userId!==owner.userId||saved.workspaceId!==owner.workspaceId||saved.courseId!==courseId||saved.tool!==tool||typeof saved.draftId!=='string'||typeof saved.conversationId!=='string'||!validToolActivityDraft(saved.activity,tool)||saved.activityId!==undefined&&typeof saved.activityId!=='string'||saved.activityRevision!==undefined&&!Number.isSafeInteger(saved.activityRevision)||saved.createPayload!==undefined&&typeof saved.createPayload!=='string')return;return {draftId:saved.draftId,activity:saved.activity,conversationId:saved.conversationId,...(typeof saved.activityId==='string'?{activityId:saved.activityId}:{}),...(typeof saved.activityRevision==='number'?{activityRevision:saved.activityRevision}:{}),...(typeof saved.createPayload==='string'?{createPayload:saved.createPayload}:{})};}catch{return;}
}
export function encodeToolDraft(draft:TeachingToolDraft,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string,tool:TeachingTaskKind){return JSON.stringify({...draft,...owner,courseId,tool});}
export type TeachingToolAttempt={operationId:string;activityId:string;payload:string};
export function decodeToolAttempt(raw:string|null,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>,courseId:string,tool:TeachingTaskKind):TeachingToolAttempt|undefined{
  try{const value=JSON.parse(raw??'null');if(!record(value)||value.userId!==owner.userId||value.workspaceId!==owner.workspaceId||value.courseId!==courseId||value.tool!==tool||typeof value.operationId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(value.operationId)||typeof value.activityId!=='string'||typeof value.payload!=='string'||value.payload.length>20000)return;const payload=JSON.parse(value.payload);if(!record(payload)||payload.activityId!==value.activityId||!['answer','prepare','grade','insights'].includes(String(payload.kind)))return;return {operationId:value.operationId,activityId:value.activityId,payload:value.payload};}catch{return;}
}
export function toolActivityPayload(course:Pick<TeachingCourse,'revision'>,draft:TeachingToolDraft,activity?:TeachingActivity){return {...structuredClone(draft.activity),title:draft.activity.title.trim(),status:'draft' as const,revision:course.revision,...(activity?{activityRevision:activity.revision}:{clientRequestId:draft.draftId}),questions:draft.activity.questions.map(q=>({...q,options:q.options.map(value=>value.trim()).filter(Boolean)}))};}
export function teachingToolPreviewHistory(operations:TeachingOperation[],activityId:string,conversationId:string){return operations.filter(operation=>operation.activityId===activityId&&!operation.sessionId&&operation.conversationId===conversationId&&operation.kind==='answer').sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).slice(-12);}
export function quizReviewProblem(draft:ActivityDraft){if(!draft.questions.length)return '请先整理或添加题目。';if(draft.questions.some(question=>!question.prompt.trim()||question.points<=0||question.type==='single'&&(question.options.filter(Boolean).length<2||!question.options.includes(question.answer))))return '请补全题目、分值和参考答案；单选题答案必须与一个选项完全相同。';return '';}
export function toolTrashPayload(course:Pick<TeachingCourse,'id'|'revision'|'workspaceId'|'userId'>,items:TeachingActivity[]){
  if(!items.length||items.length>50||new Set(items.map(item=>item.id)).size!==items.length)throw new Error('请明确选择 1–50 个不同条目。');
  if(items.some(item=>item.courseId!==course.id||item.workspaceId!==course.workspaceId||item.userId!==course.userId))throw new Error('所选条目不属于当前课程与账号。');
  return {confirmed:true,items:items.map(item=>({courseId:course.id,revision:course.revision,activityId:item.id,activityRevision:item.revision}))};
}
export function teachingEntryIsOpen(course:Pick<TeachingCourse,'status'>,activity:TeachingActivity){return activity.isOpen===true||activity.isOpen===undefined&&course.status==='published'&&activity.status==='published';}
export function teachingEntryLink(course:TeachingCourse,activity:TeachingActivity,origin:string){if(!teachingEntryIsOpen(course,activity))return '';return activity.slug?`${origin}/learn/${encodeURIComponent(activity.slug)}`:course.slug?`${origin}/learn/${encodeURIComponent(course.slug)}?activityId=${encodeURIComponent(activity.id)}`:'';}
/** Assignment grading has its own durable editor; its saved updates must never
 * become a stale copy of a student's task in the outer tool page. */
export function reconcileToolDraft(local:TeachingToolDraft,activity:TeachingActivity,tool:TeachingTaskKind){
  const isSaved=local.activityId===activity.id&&local.activityRevision!==undefined;
  const stale=isSaved&&tool!=='grade'&&local.activityRevision!==activity.revision&&JSON.stringify(local.activity)!==JSON.stringify(activityDraft(activity));
  return {draft:{...local,activityId:activity.id,createPayload:undefined,...(!isSaved||tool==='grade'||!stale&&local.activityRevision!==activity.revision?{activity:activityDraft(activity),activityRevision:activity.revision}:{})},stale};
}
