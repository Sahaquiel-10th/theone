import type {TeachingCourse,TeachingKnowledgeSource} from '../server/teachingTypes';
import type {TeachingRequest,TeachingUpload} from './teachingUploads';

export type CourseManagerOwner={userId:string;workspaceId:string};
export type CourseMaterialForm={title:string;subject:string;materialText:string;materialAttachmentIds:string[];knowledgeSources:TeachingKnowledgeSource[]};
export type CourseCreateAttempt={clientRequestId:string;payload:CourseMaterialForm};
export type CourseSaveAttempt={courseId:string;revision:number;payload:CourseMaterialForm};
export type CourseManagerDraft={form:CourseMaterialForm;remoteId?:string;baseRevision?:number;baseForm?:CourseMaterialForm;createAttempt?:CourseCreateAttempt;saveAttempt?:CourseSaveAttempt;files:TeachingUpload[]};
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>;
export const emptyCourseMaterialForm=():CourseMaterialForm=>({title:'',subject:'',materialText:'',materialAttachmentIds:[],knowledgeSources:[]});
export const courseMaterialForm=(course:TeachingCourse):CourseMaterialForm=>({title:course.title,subject:course.subject,materialText:course.materialText,materialAttachmentIds:[...course.materialAttachmentIds],knowledgeSources:structuredClone(course.knowledgeSources??[])});
export const courseManagerDraftKey=(owner:CourseManagerOwner,courseId?:string)=>`one-course-materials:v1:${encodeURIComponent(owner.workspaceId)}:${encodeURIComponent(owner.userId)}:${encodeURIComponent(courseId??'new')}`;
function validForm(value:unknown):value is CourseMaterialForm{
  const form=value as CourseMaterialForm|undefined;
  return !!form&&typeof form.title==='string'&&form.title.length<=160&&typeof form.subject==='string'&&form.subject.length<=120&&typeof form.materialText==='string'&&form.materialText.length<=120000&&Array.isArray(form.materialAttachmentIds)&&form.materialAttachmentIds.length<=20&&form.materialAttachmentIds.every(id=>typeof id==='string'&&id.length<=100)&&Array.isArray(form.knowledgeSources)&&form.knowledgeSources.length<=5&&form.knowledgeSources.every(source=>!!source&&typeof source.provider==='string'&&typeof source.connectionId==='string'&&typeof source.binding==='string'&&typeof source.label==='string'&&['page','connection'].includes(source.scope));
}
export function decodeCourseManagerDraft(raw:string|null,owner:CourseManagerOwner):CourseManagerDraft|undefined{
  try{
    if(!raw||raw.length>700000)return;
    const value=JSON.parse(raw);
    if(value?.userId!==owner.userId||value?.workspaceId!==owner.workspaceId||!validForm(value.form)||!Array.isArray(value.files))return;
    if(value.remoteId!==undefined&&(typeof value.remoteId!=='string'||value.remoteId.length>120))return;
    if(value.baseRevision!==undefined&&(!Number.isSafeInteger(value.baseRevision)||value.baseRevision<1))return;
    if(value.baseForm!==undefined&&!validForm(value.baseForm))return;
    if(value.createAttempt&&(!/^[A-Za-z0-9_-]{8,120}$/.test(value.createAttempt.clientRequestId)||!validForm(value.createAttempt.payload)))return;
    if(value.saveAttempt&&(typeof value.saveAttempt.courseId!=='string'||!Number.isSafeInteger(value.saveAttempt.revision)||value.saveAttempt.revision<1||!validForm(value.saveAttempt.payload)))return;
    const files=value.files.filter((file:TeachingUpload)=>!!file&&typeof file.id==='string'&&typeof file.originalName==='string').slice(0,100).map((file:TeachingUpload)=>({id:file.id,originalName:file.originalName,status:file.status,size:file.size,mimeType:file.mimeType}));
    return {form:value.form,remoteId:value.remoteId,baseRevision:value.baseRevision,baseForm:value.baseForm,createAttempt:value.createAttempt,saveAttempt:value.saveAttempt,files};
  }catch{return;}
}
export function saveCourseManagerDraft(storage:Storage,key:string,owner:CourseManagerOwner,draft:CourseManagerDraft){storage.setItem(key,JSON.stringify({...draft,...owner}));}
export function clearCourseManagerDraft(storage:Storage,key:string){storage.removeItem(key);}
export function sameCourseMaterials(left:CourseMaterialForm,right:CourseMaterialForm){
  const projection=(form:CourseMaterialForm)=>[form.title.trim(),form.subject.trim(),form.materialText,form.materialAttachmentIds,form.knowledgeSources.map(source=>[source.provider,source.connectionId,source.binding,source.scope,source.pageId??'',source.label])];
  return JSON.stringify(projection(left))===JSON.stringify(projection(right));
}
export function courseMatchesMaterialSave(course:TeachingCourse,form:CourseMaterialForm){return sameCourseMaterials(courseMaterialForm(course),form);}
export class CourseMaterialConflict extends Error{constructor(readonly course:TeachingCourse){super('课程资料已在其他页面更新。你的修改已保留，请先核对再继续。');}}

/** A lost creation response always reuses its scoped receipt, never a title match. */
export async function resolveCourseCreation(request:TeachingRequest,attempt:CourseCreateAttempt,reconcile=true):Promise<TeachingCourse>{
  if(reconcile){const result=await request<{courses:TeachingCourse[]}>('/api/teaching/courses');const found=result.courses.find(course=>course.clientCreateKey===attempt.clientRequestId);if(found)return found;}
  return (await request<{course:TeachingCourse}>('/api/teaching/courses',{method:'POST',body:JSON.stringify({...attempt.payload,title:attempt.payload.title.trim(),subject:attempt.payload.subject.trim(),materialAttachmentIds:[],clientRequestId:attempt.clientRequestId})})).course;
}
/** PATCH is reconciled against exact saved fields before a revision can be retried. */
export async function resolveCourseMaterialSave(request:TeachingRequest,attempt:CourseSaveAttempt):Promise<TeachingCourse>{
  const path=`/api/teaching/courses/${encodeURIComponent(attempt.courseId)}`;
  const current=(await request<{course:TeachingCourse}>(path)).course;
  if(courseMatchesMaterialSave(current,attempt.payload))return current;
  if(current.revision!==attempt.revision)throw new CourseMaterialConflict(current);
  try{return (await request<{course:TeachingCourse}>(path,{method:'PATCH',body:JSON.stringify({...attempt.payload,title:attempt.payload.title.trim(),subject:attempt.payload.subject.trim(),revision:attempt.revision})})).course;}
  catch(error){
    if(error&&typeof error==='object'&&'status'in error&&error.status===409){const latest=(await request<{course:TeachingCourse}>(path)).course;if(courseMatchesMaterialSave(latest,attempt.payload))return latest;throw new CourseMaterialConflict(latest);}
    throw error;
  }
}
