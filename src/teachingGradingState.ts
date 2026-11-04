import type {TeachingActivity,TeachingCourse} from '../server/teachingTypes';
import {activityDraft,type ActivityDraft} from './teachingState';
import type {TeacherIdentity} from './teacherTaskState';

export function gradingFields(value:ActivityDraft|TeachingActivity){
  return structuredClone({rubric:value.rubric,referenceText:value.referenceText??'',sourceAttachmentIds:value.sourceAttachmentIds??[],knowledgeSources:value.knowledgeSources??[],avatarPrompt:value.avatarPrompt??''});
}
/** Grading updates cannot change the student's assignment or the live entry. */
export function gradingUpdatePayload(course:Pick<TeachingCourse,'revision'>,activity:Pick<TeachingActivity,'revision'>,draft:ActivityDraft){
  return {revision:course.revision,activityRevision:activity.revision,...gradingFields(draft)};
}
export function gradingDraftChanged(draft:ActivityDraft,activity:TeachingActivity){return JSON.stringify(gradingFields(draft))!==JSON.stringify(gradingFields(activity));}

export function decodeGradingEditor(raw:string|null,owner:Pick<TeacherIdentity,'workspaceId'|'userId'>,courseId:string,activity:TeachingActivity):{revision:number;draft:ActivityDraft}|undefined{
  try{
    const value=JSON.parse(raw??'null'),form=value?.form;
    if(!value||Array.isArray(value)||value.workspaceId!==owner.workspaceId||value.userId!==owner.userId||value.courseId!==courseId||value.activityId!==activity.id||!Number.isSafeInteger(value.revision)||!form||Array.isArray(form))return;
    if(typeof form.referenceText!=='string'||typeof form.avatarPrompt!=='string'||!Array.isArray(form.sourceAttachmentIds)||form.sourceAttachmentIds.some((id:unknown)=>typeof id!=='string'))return;
    if(!Array.isArray(form.rubric)||form.rubric.length>20||form.rubric.some((row:unknown)=>!row||typeof row!=='object'||!['id','label','description'].every(key=>typeof (row as Record<string,unknown>)[key]==='string')||!Number.isFinite((row as {maxScore?:unknown}).maxScore)))return;
    if(!Array.isArray(form.knowledgeSources)||form.knowledgeSources.length>5||form.knowledgeSources.some((source:unknown)=>!source||typeof source!=='object'||!['provider','connectionId','binding','label','scope'].every(key=>typeof (source as Record<string,unknown>)[key]==='string')||!['page','connection'].includes((source as {scope:string}).scope)))return;
    return {revision:value.revision,draft:{...activityDraft(activity),...gradingFields(form)}};
  }catch{return;}
}
