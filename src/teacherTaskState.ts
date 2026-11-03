import type {TeachingActivity,TeachingCourse,TeachingGrade,TeachingKnowledgeSource,TeachingOperation,TeachingTaskKind} from '../server/teachingTypes';
import {canApplyTeachingPreparation,newActivityDraft,type ActivityDraft} from './teachingState';

export type TeacherIdentity={userId:string;workspaceId:string;revision:number};
export type TaskFile={id:string;originalName:string};
/** File inputs expose a live FileList that is emptied when their value resets. */
export const snapshotTeacherFiles=<T,>(files:ArrayLike<T>|null|undefined):T[]=>files?Array.from(files):[];
export type TeacherTaskDraft={
  id:string;kind:TeachingTaskKind;step:0|1|2;title:string;updatedAt:string;
  materialText:string;materialFiles:TaskFile[];referenceText:string;referenceFiles:TaskFile[];
  knowledgeSources:TeachingKnowledgeSource[];activity:ActivityDraft;budgetMicros:number;
  intake:{participantName:string;participantRef:string;text:string;files:TaskFile[]};
  remote?:{courseId:string;activityId:string};submissionId?:string;review?:TeachingGrade;reviewDirty?:boolean;
  appliedPreparationId?:string;
  pending?:{type:'ai'|'submission';operationId:string;payload:string};operationId?:string;
};
export const teacherTasks:{kind:TeachingTaskKind;title:string;description:string;steps:[string,string,string];result:string}[]=[
  {kind:'grade',title:'批改作业',description:'放入已经收好的作业，按你的要求批改并复核。',steps:['放入学生作业','说明要求与评分','批改并复核'],result:'保存批改结果，或导出给老师使用'},
  {kind:'ask',title:'让学生提问',description:'用你的教材和引导，准备一个本课专用的问答入口。',steps:['放入学习资料','设置提问引导','预览并发链接'],result:'学生使用同一链接提问，老师看学情汇总'},
  {kind:'quiz',title:'发布测验',description:'整理你已有的试卷，学生在线答题，老师收卷批改。',steps:['放入已有试卷','校对题目与答案','预览并发链接'],result:'发布已有试卷，收取学生的在线答卷'},
  {kind:'game',title:'课堂文字游戏',description:'写好角色和玩法，让学生在对话中探索一段情境。',steps:['准备背景资料','写好角色与玩法','预览并发链接'],result:'学生进入文字游戏，与课堂角色互动'},
];
export const taskInfo=(kind:TeachingTaskKind)=>teacherTasks.find(item=>item.kind===kind)!;
export const teacherTaskHasInsights=(kind:TeachingTaskKind)=>kind==='ask';
export const teacherTaskStudentPrivacy=(kind:TeachingTaskKind)=>kind==='game'?'学生各自的角色设定与游戏对话不会自动交给老师。课后可另发作业收取学习反思。':kind==='quiz'?'学生只能看到已校对的题目与答题说明，原试卷和参考答案保持私有。':kind==='ask'?'学生可以用你允许的学习资料与课堂角色互动。学生提问仅以去身份的学情汇总呈现给老师。':'老师上传的作业，结果由老师查看；不会按姓名自动反馈给学生。';
export function newTeacherTask(kind:TeachingTaskKind,id:string,now=new Date().toISOString()):TeacherTaskDraft{
  const activity=newActivityDraft(kind==='grade'||kind==='quiz'?'after':kind==='game'?'during':'before',kind==='grade'?'assignment':kind==='ask'?'inquiry':kind);
  activity.title=taskInfo(kind).title;
  if(kind==='grade')activity.rubric=[{id:'overall',label:'整体完成情况',description:'依据老师的作业要求，核对内容的完整性、准确性和表达。',maxScore:100}];
  if(kind==='ask')activity.avatarPrompt='你是本课的学习助教。优先依据老师提供的学习资料回答，用提问帮助学生理解。资料没有依据时请明确说明，不编造事实。';
  if(kind==='game'){activity.avatarPrompt='你是一位课堂情境的引导者。先介绍情境和学生的角色，每轮提供一个需要思考的选择。根据学生的行动推进故事，并引导他们联系本课知识。';activity.allowStudentPrompt=true;}
  return {id,kind,step:0,title:'',updatedAt:now,materialText:'',materialFiles:[],referenceText:'',referenceFiles:[],knowledgeSources:[],activity,budgetMicros:5_000_000,intake:{participantName:'',participantRef:'',text:'',files:[]}};
}
export const sameTeacherIdentity=(a:TeacherIdentity,b:TeacherIdentity)=>a.userId===b.userId&&a.workspaceId===b.workspaceId&&a.revision===b.revision;
export const teacherDraftStorageKey=(identity:Pick<TeacherIdentity,'userId'|'workspaceId'>)=>`one-teacher-drafts:v1:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.workspaceId)}`;
/** A mismatched account must not read, rewrite, or carry another account's drafts. */
export function decodeTeacherDrafts(value:string|null,identity:Pick<TeacherIdentity,'userId'|'workspaceId'>):TeacherTaskDraft[]{
  if(!value||!identity.userId||!identity.workspaceId)return [];
  try{const parsed=JSON.parse(value) as {version?:number;userId?:string;workspaceId?:string;drafts?:unknown[]};if(parsed.version!==1||parsed.userId!==identity.userId||parsed.workspaceId!==identity.workspaceId||!Array.isArray(parsed.drafts))return [];
    return parsed.drafts.filter((value):value is TeacherTaskDraft=>{if(!value||typeof value!=='object')return false;const d=value as TeacherTaskDraft;return typeof d.id==='string'&&teacherTasks.some(t=>t.kind===d.kind)&&[0,1,2].includes(d.step)&&typeof d.title==='string'&&typeof d.materialText==='string'&&typeof d.referenceText==='string'&&Array.isArray(d.materialFiles)&&Array.isArray(d.referenceFiles)&&Array.isArray(d.knowledgeSources)&&!!d.activity&&Array.isArray(d.activity.questions)&&Array.isArray(d.activity.rubric)&&!!d.intake&&Array.isArray(d.intake.files);}).slice(0,30);
  }catch{return [];}
}
export const encodeTeacherDrafts=(drafts:TeacherTaskDraft[],identity:Pick<TeacherIdentity,'userId'|'workspaceId'>)=>JSON.stringify({version:1,...identity,drafts:drafts.slice(0,30)});
export function teacherStepProblem(draft:TeacherTaskDraft,step=draft.step):string{
  if(step===0){if(draft.kind==='grade'&&!draft.intake.text.trim()&&!draft.intake.files.length)return '先粘贴一份学生作业，或上传作业原件。';if(draft.kind==='ask'&&!draft.materialText.trim()&&!draft.materialFiles.length&&!draft.knowledgeSources.length)return '先提供本课学习资料，学生提问时才有依据。';}
  if(step===1){if(!draft.title.trim())return '给这次任务起一个便于找到的名称。';if(draft.kind==='grade'&&!draft.activity.rubric.length)return '至少保留一项评分要求。';if(draft.kind==='quiz'){if(!draft.activity.questions.length)return '请先整理或添加题目，再预览试卷。';if(draft.activity.questions.some(q=>!q.prompt.trim()||q.type==='single'&&(q.options.filter(o=>o.trim()).length<2||!q.options.includes(q.answer))))return '请补全题目；单选题至少两个选项，参考答案须与某个选项完全一致。';}if((draft.kind==='game'||draft.kind==='ask')&&!draft.activity.avatarPrompt?.trim())return '请写下角色提示词或本课的提问引导。';}
  return '';
}
/** Quiz/reference sources stay private; public learning sources are deliberate. */
export function teacherSavePayloads(draft:TeacherTaskDraft){
  const privateSources=draft.kind==='grade'||draft.kind==='quiz';
  return {course:{title:draft.title.trim()||taskInfo(draft.kind).title,subject:'',description:'',materialText:privateSources?'':draft.materialText,materialAttachmentIds:privateSources?[]:draft.materialFiles.map(f=>f.id),knowledgeSources:privateSources?[]:draft.knowledgeSources,budgetMicros:draft.budgetMicros},activity:{...draft.activity,title:draft.title.trim()||taskInfo(draft.kind).title,referenceText:privateSources?draft.referenceText:'',sourceAttachmentIds:privateSources?draft.referenceFiles.map(f=>f.id):[],knowledgeSources:privateSources?draft.knowledgeSources:[],questions:draft.activity.questions.map(q=>({...q,options:q.options.map(o=>o.trim()).filter(Boolean)})),status:'published' as const}};
}
/** Preview is a projection, never the full private activity or an actual session. */
export function teacherStudentPreview(draft:TeacherTaskDraft){return {title:draft.title||taskInfo(draft.kind).title,kind:draft.kind,instructions:draft.activity.instructions,allowStudentPrompt:!!draft.activity.allowStudentPrompt,questions:draft.activity.questions.map(({id,prompt,type,options,points})=>({id,prompt,type,options:options.filter(Boolean),points}))};}
export function restoredTeacherOperation(operations:TeachingOperation[],activityId:string,currentId?:string){return currentId?operations.find(op=>op.id===currentId||op.operationId===currentId):operations.find(op=>op.activityId===activityId);}
export function draftFromTeachingCourse(course:TeachingCourse,activity:TeachingActivity):TeacherTaskDraft{
  const kind=course.taskKind??(activity.kind==='assignment'?'grade':activity.kind==='quiz'?'quiz':activity.kind==='game'?'game':'ask');
  const draft=newTeacherTask(kind,course.clientDraftId??`saved:${course.id}:${activity.id}`);const privateSources=kind==='grade'||kind==='quiz';
  return {...draft,title:activity.title||course.title,step:2,updatedAt:course.updatedAt,materialText:course.materialText,materialFiles:course.materialAttachmentIds.map(id=>({id,originalName:'已保存学习资料'})),referenceText:activity.referenceText??'',referenceFiles:(activity.sourceAttachmentIds??[]).map(id=>({id,originalName:'已保存教师参考'})),knowledgeSources:privateSources?activity.knowledgeSources??[]:course.knowledgeSources??[],activity:{...activity,referenceText:activity.referenceText??'',sourceAttachmentIds:activity.sourceAttachmentIds??[]},budgetMicros:course.budgetMicros,remote:{courseId:course.id,activityId:activity.id}};
}

/** Only fields that preparation replaces participate in the local-edit conflict. */
export const teacherPreparationContent=(activity:Pick<TeachingActivity,'instructions'|'questions'|'scenes'|'rubric'>)=>JSON.stringify({instructions:activity.instructions,questions:activity.questions,scenes:activity.scenes,rubric:activity.rubric});
export function teacherPreparationAction(draft:Pick<TeacherTaskDraft,'activity'|'appliedPreparationId'>,operation:TeachingOperation|undefined,course:TeachingCourse|undefined):'stale'|'applied'|'confirm'|'apply'{
  if(operation&&draft.appliedPreparationId===operation.id)return 'applied';
  if(!operation||!course||!canApplyTeachingPreparation(operation,course))return 'stale';
  const saved=course.activities.find(activity=>activity.id===operation.activityId)!;
  return teacherPreparationContent(draft.activity)===teacherPreparationContent(saved)?'apply':'confirm';
}
