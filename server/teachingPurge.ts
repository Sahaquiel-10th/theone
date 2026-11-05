import {createHash,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {StudentScriptSubmission} from './studentLearningTypes.js';
import type {Store} from './db.js';
import type {Attachment,Database} from './types.js';
import type {TeachingActivity,TeachingCourse,TeachingOperation,TeachingPurgeFile,TeachingPurgeImpact,TeachingPurgeReceipt,TeachingScope,TeachingSession,TeachingState,TeachingSubmission} from './teachingTypes.js';
import {TeachingError,teachingConversationId,teachingMember,teachingState,preserveTeachingAccess} from './teaching.js';
import {removeAttachmentFiles} from './attachmentService.js';

type PurgeItem={courseId:string;revision:number;activityId?:string;activityRevision?:number};
type Selection={course:TeachingCourse;activity?:TeachingActivity};
type PurgePlan={items:PurgeItem[];selected:Selection[];courses:TeachingCourse[];activities:TeachingActivity[];sessions:TeachingSession[];updatedSessions:TeachingSession[];submissions:TeachingSubmission[];scriptSubmissions:StudentScriptSubmission[];operations:TeachingOperation[];files:Attachment[];impact:TeachingPurgeImpact;impactHash:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const owned=(value:TeachingScope,scope:TeachingScope)=>value.workspaceId===scope.workspaceId&&value.userId===scope.userId;
function object(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))throw new TeachingError('请检查永久删除请求');return value as Record<string,unknown>;}
function itemsOf(value:unknown):PurgeItem[]{
  if(!Array.isArray(value)||!value.length||value.length>50)throw new TeachingError('请明确选择 1–50 个回收站条目');
  const seen=new Set<string>();
  return value.map(raw=>{const item=object(raw);if(Object.keys(item).some(key=>!['courseId','revision','activityId','activityRevision'].includes(key))||typeof item.courseId!=='string'||item.courseId.length>120||!Number.isSafeInteger(item.revision)||item.activityId!==undefined&&(typeof item.activityId!=='string'||item.activityId.length>120||!Number.isSafeInteger(item.activityRevision)))throw new TeachingError('请使用条目确切编号和当前版本');
    const key=JSON.stringify([item.courseId,item.activityId??'']);if(seen.has(key))throw new TeachingError('不能重复选择同一条目');seen.add(key);
    return {courseId:item.courseId,revision:item.revision as number,...(typeof item.activityId==='string'?{activityId:item.activityId,activityRevision:item.activityRevision as number}:{})};
  }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function normalizedBody(input:unknown){const body=object(input);return {body,items:itemsOf(body.items)};}
function assertTrash(selected:Selection[],items:PurgeItem[]){
  for(const [index,{course,activity}]of selected.entries()){
    if(!(activity??course).deletedAt)throw new TeachingError('只能永久删除已移入回收站的条目',409,'TEACHING_PURGE_NOT_TRASHED');
    if(items[index].revision!==course.revision||activity&&items[index].activityRevision!==activity.revision)throw new TeachingError('回收站条目已变化，请重新查看影响后确认',409,'TEACHING_REVISION_CONFLICT');
  }
}
function snapshotFileIds(value:TeachingActivity|undefined){return value?.sourceAttachmentIds??[];}
/** Check the remaining canonical graph, including other teaching snapshots,
 * chats, execution tasks, publications and complete industry lineage. Exact id
 * and URL-segment references are conservatively retained. Financial ids alone
 * do not require private source bytes to survive an approved permanent purge. */
function retainedFileIds(db:Database,candidates:Set<string>,state:TeachingState,remaining:Pick<TeachingState,'courses'|'sessions'|'submissions'|'operations'>,scope:TeachingScope){
  const referenced=new Set<string>(),seen=new WeakSet<object>();
  const visit=(value:unknown):void=>{
    if(typeof value==='string'){
      if(candidates.has(value))referenced.add(value);
      else if(value.includes('/'))for(const segment of value.split(/[/?#=&]/)){try{const id=decodeURIComponent(segment);if(candidates.has(id))referenced.add(id);}catch{/* Not a URL identifier. */}}
      return;
    }
    if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
    if(Array.isArray(value)){for(const row of value)visit(row);return;}
    for(const nested of Object.values(value))visit(nested);
  };
  for(const [key,value]of Object.entries(db)){
    if(['attachments','auditLogs','modelUsageRecords','powerLedger','powerAccounts','users'].includes(key))continue;
    visit(value);
  }
  for(const user of db.users){
    const {teaching,...other}=user;visit(other);
    if(!teaching)continue;
    // Purge journals are private cleanup metadata, not remaining user content.
    if(teaching===state&&user.id===scope.userId)visit(remaining);
    else{const {purges:_,...content}=teaching;visit(content);}
  }
  for(const file of db.attachments)if(!candidates.has(file.id))visit(file);
  return referenced;
}
export function planTeachingPurge(db:Database,scope:TeachingScope,input:unknown):PurgePlan{
  const {items}=normalizedBody(input),state=teachingState(db,scope);
  const selected=items.map(item=>{const course=state.courses.find(row=>row.id===item.courseId&&owned(row,scope));if(!course)throw new TeachingError('回收站条目不存在',404,'TEACHING_NOT_FOUND');const activity=item.activityId===undefined?undefined:course.activities.find(row=>row.id===item.activityId&&row.courseId===course.id&&owned(row,scope));if(item.activityId!==undefined&&!activity)throw new TeachingError('回收站工具不存在',404,'TEACHING_NOT_FOUND');return {course,activity};});
  assertTrash(selected,items);
  const fullCourses=new Set(selected.filter(row=>!row.activity).map(row=>row.course.id));
  if(selected.some(row=>row.activity&&fullCourses.has(row.course.id)))throw new TeachingError('请分别选择课程及其内部工具，不能重复覆盖同一对象');
  const activityKeys=new Set(selected.filter(row=>row.activity).map(row=>`${row.course.id}:${row.activity!.id}`)),courseIds=new Set(selected.map(row=>row.course.id));
  const targetActivity=(courseId:string,activityId:string|undefined)=>fullCourses.has(courseId)||activityId!==undefined&&activityKeys.has(`${courseId}:${activityId}`);
  const courses=state.courses.filter(row=>owned(row,scope)&&fullCourses.has(row.id));
  const activities=state.courses.filter(row=>owned(row,scope)).flatMap(course=>course.activities.filter(activity=>owned(activity,scope)&&targetActivity(course.id,activity.id)));
  const scriptSubmissions=(state.studentScriptSubmissions??[]).filter(row=>owned(row,scope)&&fullCourses.has(row.courseId));
  const submissions=state.submissions.filter(row=>owned(row,scope)&&targetActivity(row.courseId,row.activityId)),submissionIds=new Set(submissions.map(row=>row.id));
  const sessions=state.sessions.filter(row=>owned(row,scope)&&(fullCourses.has(row.courseId)||row.activityId!==undefined&&targetActivity(row.courseId,row.activityId))),sessionIds=new Set(sessions.map(row=>row.id));
  const operations=state.operations.filter(row=>owned(row,scope)&&(targetActivity(row.courseId,row.activityId)||!!row.submissionId&&submissionIds.has(row.submissionId)||!!row.sessionId&&sessionIds.has(row.sessionId)||courseIds.has(row.courseId)&&row.kind==='insights'&&!row.activityId));
  const operationIds=new Set(operations.map(row=>row.id));
  if(operations.some(row=>row.status==='running'||row.status==='uncertain')||db.modelUsageRecords?.some(row=>owned(row,scope)&&(fullCourses.has(row.conversationId.replace(/^teaching:/,''))||!!row.requestId&&operationIds.has(row.requestId))&&(row.status==='pending'||row.status==='needs_review'||(row.reservedMicros??0)>0)))throw new TeachingError('存在正在执行或尚未核对的 AI/费用记录，请先核对原请求后再永久删除',409,'TEACHING_PURGE_ACTIVE');
  const remainingCourses=state.courses.filter(row=>!courses.includes(row)).map(course=>({...course,activities:course.activities.filter(activity=>!activities.includes(activity))}));
  const updatedSessions=state.sessions.filter(row=>owned(row,scope)&&!sessionIds.has(row.id)&&courseIds.has(row.courseId)&&(row.gameConfigs?.some(config=>targetActivity(row.courseId,config.activityId))||Object.keys(row.activityAccessRevisions??{}).some(activityId=>targetActivity(row.courseId,activityId))));
  const remainingSessions=state.sessions.filter(row=>!sessions.includes(row)).map(session=>updatedSessions.includes(session)?{...session,gameConfigs:session.gameConfigs?.filter(config=>!targetActivity(session.courseId,config.activityId)),activityAccessRevisions:Object.fromEntries(Object.entries(session.activityAccessRevisions??{}).filter(([id])=>!targetActivity(session.courseId,id)))}:session);
  const remaining={courses:remainingCourses,sessions:remainingSessions,submissions:state.submissions.filter(row=>!submissions.includes(row)),operations:state.operations.filter(row=>!operations.includes(row))};
  const ids=new Set<string>();for(const activity of activities)for(const id of snapshotFileIds(activity))ids.add(id);
  for(const submission of submissions)for(const id of [...submission.attachmentIds,...snapshotFileIds(submission.activitySnapshot),...snapshotFileIds(submission.gradingSnapshot)])ids.add(id);
  for(const operation of operations)for(const id of operation.attachmentIds??[])ids.add(id);
  const fileCourseId=(file:Attachment)=>file.conversationId?.startsWith('teaching:')?file.conversationId.slice('teaching:'.length):'';
  const sessionOwnsFile=(file:Attachment)=>state.sessions.some(session=>owned(session,scope)&&session.id===file.userId&&session.courseId===fileCourseId(file)&&sessionIds.has(session.id));
  for(const file of db.attachments)if(file.workspaceId===scope.workspaceId&&((fullCourses.has(fileCourseId(file))&&(file.userId===scope.userId||sessionOwnsFile(file)))||courseIds.has(fileCourseId(file))&&sessionOwnsFile(file)))ids.add(file.id);
  const found=db.attachments.filter(file=>ids.has(file.id));
  const referenced=retainedFileIds(db,ids,state,remaining,scope);
  const files=found.filter(file=>file.workspaceId===scope.workspaceId&&courseIds.has(fileCourseId(file))&&(file.userId===scope.userId||sessionOwnsFile(file))&&!referenced.has(file.id)&&!file.messageId&&!file.sharedConversationIds?.length&&!db.attachments.some(other=>other!==file&&(other.id===file.id||other.storagePath===file.storagePath)));
  if(files.some(file=>file.status==='queued'||file.status==='parsing'))throw new TeachingError('部分原件仍在解析，请处理完成后重新核对永久删除',409,'TEACHING_PURGE_FILES_ACTIVE');
  const impact:TeachingPurgeImpact={courses:courses.length,activities:activities.length,sessions:sessions.length,updatedSessions:updatedSessions.length,submissions:submissions.length,...(scriptSubmissions.length?{scriptSubmissions:scriptSubmissions.length}:{}),operations:operations.length,files:files.length,retainedFiles:found.length-files.length,fileBytes:files.reduce((sum,file)=>sum+file.size,0)};
  const impactHash=digest({scope,items,courses,activities,sessions,updatedSessions,submissions,scriptSubmissions,operations,files:files.map(file=>({...file,extractedText:undefined})),referenced:[...referenced].sort(),impact});
  return {items,selected,courses,activities,sessions,updatedSessions,submissions,scriptSubmissions,operations,files,impact,impactHash};
}
export function previewTeachingPurge(db:Database,scope:TeachingScope,input:unknown){const plan=planTeachingPurge(db,scope,input);return {impactHash:plan.impactHash,impact:plan.impact};}
export function publicTeachingPurge(receipt:TeachingPurgeReceipt){return {id:receipt.id,requestId:receipt.requestId,status:receipt.status,impact:receipt.impact,remainingFiles:receipt.pendingFiles.length,createdAt:receipt.createdAt,...(receipt.completedAt?{completedAt:receipt.completedAt}:{})};}
export function ownedTeachingPurge(db:Database,scope:TeachingScope,requestId:string){const receipt=teachingState(db,scope).purges?.find(row=>owned(row,scope)&&(row.requestId===requestId||row.id===requestId));if(!receipt)throw new TeachingError('永久删除回执不存在',404,'TEACHING_NOT_FOUND');return receipt;}
export function commitTeachingPurge(db:Database,scope:TeachingScope,input:unknown,options:{directoryAvailable:boolean}){
  const {body,items}=normalizedBody(input);
  if(body.confirmed!==true||typeof body.requestId!=='string'||!/^[A-Za-z0-9_-]{16,120}$/.test(body.requestId)||typeof body.impactHash!=='string'||!/^[a-f0-9]{64}$/.test(body.impactHash))throw new TeachingError('请先核对永久删除影响，再明确确认执行');
  const state=teachingState(db,scope,{create:true}),requestHash=digest({items,impactHash:body.impactHash});
  const old=state.purges?.find(row=>owned(row,scope)&&row.requestId===body.requestId);
  // Replay precedes every removed-course lookup, after exact member validation.
  if(old){if(old.requestHash!==requestHash)throw new TeachingError('原删除编号对应另一批内容，请核对原回执',409,'TEACHING_PURGE_CONFLICT');return old;}
  if((state.purges?.length??0)>=2000)throw new TeachingError('永久删除回执数量已达上限，请联系维护人员核对',409,'TEACHING_CAPACITY');
  const plan=planTeachingPurge(db,scope,{items});if(plan.impactHash!==body.impactHash)throw new TeachingError('删除影响已变化，本次尚未执行，请重新预览确认',409,'TEACHING_PURGE_CHANGED');
  if(plan.files.length&&!options.directoryAvailable)throw new TeachingError('文件清理尚未配置，本次没有删除，请联系维护人员',503,'TEACHING_PURGE_UNAVAILABLE');
  const at=new Date().toISOString(),removedActivities=new Set(plan.activities.map(row=>`${row.courseId}:${row.id}`));
  state.courses=state.courses.filter(course=>!plan.courses.includes(course));
  for(const course of state.courses)if(owned(course,scope)&&course.activities.some(activity=>removedActivities.has(`${course.id}:${activity.id}`))){preserveTeachingAccess(course);course.activities=course.activities.filter(activity=>!removedActivities.has(`${course.id}:${activity.id}`));course.revision++;course.updatedAt=at;}
  state.sessions=state.sessions.filter(row=>!plan.sessions.includes(row));
  for(const session of plan.updatedSessions){session.gameConfigs=session.gameConfigs?.filter(config=>!removedActivities.has(`${session.courseId}:${config.activityId}`));if(session.activityAccessRevisions)for(const id of Object.keys(session.activityAccessRevisions))if(removedActivities.has(`${session.courseId}:${id}`))delete session.activityAccessRevisions[id];}
  if(state.studentScriptSubmissions)state.studentScriptSubmissions=state.studentScriptSubmissions.filter(row=>!plan.scriptSubmissions.includes(row));
  state.submissions=state.submissions.filter(row=>!plan.submissions.includes(row));state.operations=state.operations.filter(row=>!plan.operations.includes(row));
  db.attachments=db.attachments.filter(file=>!plan.files.includes(file));
  const pendingFiles:TeachingPurgeFile[]=plan.files.map(file=>({id:file.id,workspaceId:file.workspaceId,userId:file.userId,courseId:file.conversationId!.slice('teaching:'.length),storagePath:file.storagePath}));
  const receipt:TeachingPurgeReceipt={...scope,id:`tpg_${randomBytes(16).toString('hex')}`,requestId:body.requestId,requestHash,impactHash:plan.impactHash,impact:plan.impact,status:pendingFiles.length?'files_pending':'completed',pendingFiles,createdAt:at,...(!pendingFiles.length?{completedAt:at}:{})};
  (state.purges??=[]).push(receipt);
  db.auditLogs?.push({id:`aud_${randomBytes(16).toString('hex')}`,workspaceId:scope.workspaceId,actorUserId:scope.userId,action:'teaching.purged',targetType:'teaching_purge',targetId:receipt.id,requestId:receipt.requestId,details:{impact:plan.impact,items:plan.items},createdAt:at});
  // The ledger and usage collections are deliberately untouched, retaining their
  // original owner/conversation/request identifiers for billing review.
  return receipt;
}

const cleanups=new Map<string,Promise<ReturnType<typeof publicTeachingPurge>>>();
export async function cleanTeachingPurgeFiles(store:Store,scope:TeachingScope,requestId:string,directory:string,removeFiles=removeAttachmentFiles){
  const key=JSON.stringify([scope.workspaceId,scope.userId,requestId]);const old=cleanups.get(key);if(old)return old;
  const task=(async()=>{
    const receipt=ownedTeachingPurge(await store.read(),scope,requestId);
    const files=[...receipt.pendingFiles];
    let base:string;try{base=await fs.realpath(directory);}catch{return publicTeachingPurge(receipt);}
    for(let index=0;index<files.length;index+=8){
      const succeeded=new Set<string>();
      await Promise.all(files.slice(index,index+8).map(async file=>{
        try{
          const fresh=await store.read();ownedTeachingPurge(fresh,scope,requestId);
          if(file.workspaceId!==scope.workspaceId||!file.storagePath||await fs.realpath(path.dirname(path.resolve(file.storagePath)))!==base||!path.basename(file.storagePath).startsWith(file.id+'.')||file.id.includes('/')||fresh.attachments.some(other=>other.id===file.id||path.resolve(other.storagePath)===path.resolve(file.storagePath)))return;
          try{const stat=await fs.lstat(file.storagePath);if(!stat.isFile()||stat.isSymbolicLink())return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;}
          await removeFiles(file.storagePath);succeeded.add(file.id);
        }catch{/* Keep exact private cleanup metadata; never log source paths. */}
      }));
      if(succeeded.size)await store.mutate(db=>{const current=ownedTeachingPurge(db,scope,requestId);current.pendingFiles=current.pendingFiles.filter(file=>!succeeded.has(file.id));if(!current.pendingFiles.length){current.status='completed';current.completedAt=new Date().toISOString();}});
    }
    return publicTeachingPurge(ownedTeachingPurge(await store.read(),scope,requestId));
  })();cleanups.set(key,task);try{return await task;}finally{cleanups.delete(key);}
}
