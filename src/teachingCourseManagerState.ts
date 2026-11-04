import type {TeachingCourse,TeachingKnowledgeSource} from '../server/teachingTypes';
import type {TeachingRequest,TeachingUpload} from './teachingUploads';

export type CourseManagerOwner={userId:string;workspaceId:string};
export type CourseMaterialForm={title:string;subject:string;sourceMode:'knowledge';knowledgeSources:TeachingKnowledgeSource[]};
/** Old unresolved requests retain their exact fields and nonce until reconciled. */
export type LegacyCourseMaterialForm={title:string;subject:string;materialText:string;materialAttachmentIds:string[];knowledgeSources:TeachingKnowledgeSource[]};
export type CourseMaterialPayload=CourseMaterialForm|LegacyCourseMaterialForm;
export type CourseCreateAttempt={clientRequestId:string;payload:CourseMaterialPayload};
export type CourseSaveAttempt={courseId:string;revision:number;payload:CourseMaterialPayload};
export type CourseManagerDraft={form:CourseMaterialForm;remoteId?:string;baseRevision?:number;baseForm?:CourseMaterialForm;createAttempt?:CourseCreateAttempt;saveAttempt?:CourseSaveAttempt;files:TeachingUpload[];legacyMaterials?:{materialText:string;materialAttachmentIds:string[]}};
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>;
export const emptyCourseMaterialForm=():CourseMaterialForm=>({title:'',subject:'',sourceMode:'knowledge',knowledgeSources:[]});
export const courseMaterialForm=(course:TeachingCourse):CourseMaterialForm=>({title:course.title,subject:course.subject,sourceMode:'knowledge',knowledgeSources:structuredClone(course.knowledgeSources??[])});
export const courseManagerDraftKey=(owner:CourseManagerOwner,courseId?:string)=>`one-course-materials:v1:${encodeURIComponent(owner.workspaceId)}:${encodeURIComponent(owner.userId)}:${encodeURIComponent(courseId??'new')}`;
const hasLegacyMaterials=(form:CourseMaterialPayload):form is LegacyCourseMaterialForm=>'materialText'in form;
function validForm(value:unknown):value is CourseMaterialPayload{
  const form=value as Record<string,any>|undefined;
  if(!form||typeof form.title!=='string'||form.title.length>160||typeof form.subject!=='string'||form.subject.length>120||!Array.isArray(form.knowledgeSources)||form.knowledgeSources.length>5||!form.knowledgeSources.every((source:any)=>!!source&&typeof source.provider==='string'&&typeof source.connectionId==='string'&&typeof source.binding==='string'&&typeof source.label==='string'&&['page','connection'].includes(source.scope)))return false;
  if(form.sourceMode==='knowledge')return form.materialText===undefined&&form.materialAttachmentIds===undefined;
  return form.sourceMode===undefined&&typeof form.materialText==='string'&&form.materialText.length<=120000&&Array.isArray(form.materialAttachmentIds)&&form.materialAttachmentIds.length<=20&&form.materialAttachmentIds.every((id:unknown)=>typeof id==='string'&&id.length<=100);
}
const knowledgeForm=(form:CourseMaterialPayload):CourseMaterialForm=>({title:form.title,subject:form.subject,sourceMode:'knowledge',knowledgeSources:form.knowledgeSources});
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
    const legacyMaterials=hasLegacyMaterials(value.form)?{materialText:value.form.materialText,materialAttachmentIds:value.form.materialAttachmentIds}:value.legacyMaterials;
    return {form:knowledgeForm(value.form),remoteId:value.remoteId,baseRevision:value.baseRevision,baseForm:value.baseForm?knowledgeForm(value.baseForm):undefined,createAttempt:value.createAttempt,saveAttempt:value.saveAttempt,files,...(legacyMaterials?{legacyMaterials}:{})};
  }catch{return;}
}
export function saveCourseManagerDraft(storage:Storage,key:string,owner:CourseManagerOwner,draft:CourseManagerDraft){storage.setItem(key,JSON.stringify({...draft,...owner}));}
export function clearCourseManagerDraft(storage:Storage,key:string){storage.removeItem(key);}
const sourcesProjection=(form:CourseMaterialPayload)=>form.knowledgeSources.map(source=>[source.provider,source.connectionId,source.binding,source.scope,source.pageId??'',source.label]);
export function sameCourseMaterials(left:CourseMaterialPayload,right:CourseMaterialPayload){
  const projection=(form:CourseMaterialPayload)=>[form.title.trim(),form.subject.trim(),sourcesProjection(form),hasLegacyMaterials(form)?['legacy',form.materialText,form.materialAttachmentIds]:['knowledge']];
  return JSON.stringify(projection(left))===JSON.stringify(projection(right));
}
export function courseMatchesMaterialSave(course:TeachingCourse,form:CourseMaterialPayload){
  if(hasLegacyMaterials(form))return sameCourseMaterials({title:course.title,subject:course.subject,materialText:course.materialText,materialAttachmentIds:course.materialAttachmentIds,knowledgeSources:course.knowledgeSources??[]},form);
  return (course as TeachingCourse&{sourceMode?:string}).sourceMode==='knowledge'&&sameCourseMaterials(courseMaterialForm(course),form);
}
export class CourseMaterialConflict extends Error{constructor(readonly course:TeachingCourse){super('课程资料已在其他页面更新。你的修改已保留，请先核对再继续。');}}

/** A lost creation response always reuses its scoped receipt, never a title match. */
export async function resolveCourseCreation(request:TeachingRequest,attempt:CourseCreateAttempt,reconcile=true):Promise<TeachingCourse>{
  if(reconcile){const result=await request<{courses:TeachingCourse[]}>('/api/teaching/courses');const found=result.courses.find(course=>course.clientCreateKey===attempt.clientRequestId);if(found)return found;}
  return (await request<{course:TeachingCourse}>('/api/teaching/courses',{method:'POST',body:JSON.stringify({...attempt.payload,title:attempt.payload.title.trim(),subject:attempt.payload.subject.trim(),...(hasLegacyMaterials(attempt.payload)?{materialAttachmentIds:[]}:{}),clientRequestId:attempt.clientRequestId})})).course;
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

export type CoursePurgeItem={courseId:string;revision:number};
export type CoursePurgeImpact={courses:number;activities:number;sessions:number;submissions:number;operations:number;files:number;retainedFiles:number;fileBytes:number};
export type CoursePurgePreview={impactHash:string;impact:CoursePurgeImpact};
export type CoursePurgeAttempt={requestId:string;impactHash:string;items:CoursePurgeItem[];titles:string[];confirmed:true};
export type CoursePurgeReceipt={id:string;status:'completed'|'files_pending';impact:CoursePurgeImpact;remainingFiles:number};
export const coursePurgeDraftKey=(owner:CourseManagerOwner)=>`one-course-purge:v1:${encodeURIComponent(owner.workspaceId)}:${encodeURIComponent(owner.userId)}`;
export function decodeCoursePurgeAttempt(raw:string|null,owner:CourseManagerOwner):CoursePurgeAttempt|undefined{
  try{if(!raw||raw.length>40000)return;const value=JSON.parse(raw),a=value.attempt;if(value.userId!==owner.userId||value.workspaceId!==owner.workspaceId||!a||a.confirmed!==true||!/^[A-Za-z0-9_-]{8,120}$/.test(a.requestId)||typeof a.impactHash!=='string'||a.impactHash.length>256||!Array.isArray(a.items)||a.items.length<1||a.items.length>50||!a.items.every((item:CoursePurgeItem)=>typeof item?.courseId==='string'&&item.courseId.length<=120&&Number.isSafeInteger(item.revision)&&item.revision>0)||!Array.isArray(a.titles)||a.titles.length!==a.items.length||!a.titles.every((title:unknown)=>typeof title==='string'&&title.length<=160))return;return a;}catch{return;}
}
export function saveCoursePurgeAttempt(storage:Storage,owner:CourseManagerOwner,attempt:CoursePurgeAttempt){storage.setItem(coursePurgeDraftKey(owner),JSON.stringify({...owner,attempt}));}
export function clearCoursePurgeAttempt(storage:Storage,owner:CourseManagerOwner){storage.removeItem(coursePurgeDraftKey(owner));}
export async function previewCoursePurge(request:TeachingRequest,items:CoursePurgeItem[]):Promise<CoursePurgePreview>{return request('/api/teaching/purge/preview',{method:'POST',body:JSON.stringify({items})});}
export async function resolveCoursePurge(request:TeachingRequest,attempt:CoursePurgeAttempt):Promise<CoursePurgeReceipt>{return (await request<{purge:CoursePurgeReceipt}>('/api/teaching/purge',{method:'POST',body:JSON.stringify({items:attempt.items,impactHash:attempt.impactHash,requestId:attempt.requestId,confirmed:true})})).purge;}
