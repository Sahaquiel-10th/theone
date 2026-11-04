import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type {Store} from './db.js';
import type {Attachment,Database} from './types.js';
import type {TeachingActivity,TeachingCourse,TeachingOperation,TeachingScope} from './teachingTypes.js';
import {installTeachingRoutes} from './teachingRoutes.js';
import {addTeachingSubmission,authTeachingSession,createTeachingActivity,createTeachingCourse,createTeachingSession,publishTeachingCourse,teachingState,updateTeachingCourse} from './teaching.js';
import {mutateTeachingTrash,setTeachingActivityOpen} from './teachingLifecycle.js';
import {cleanTeachingPurgeFiles,commitTeachingPurge,ownedTeachingPurge,planTeachingPurge,previewTeachingPurge,publicTeachingPurge} from './teachingPurge.js';
import {removeAttachmentFiles} from './attachmentService.js';

const a={userId:'purge-a',workspaceId:'wa'},sameUser={userId:a.userId,workspaceId:'wb'},other={userId:'purge-b',workspaceId:'wa'};
function database(){return {users:[{id:a.userId,enabled:true},{id:other.userId,enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[a,sameUser,other].map(scope=>({...scope,role:'owner'})),attachments:[],modelUsageRecords:[],powerLedger:[],powerAccounts:[],auditLogs:[],conversations:[],messages:[],knowledgeConnections:[],executionTasks:[],executionEvents:[],settings:{}} as unknown as Database;}
function make(db:Database,scope:TeachingScope=a,kind:TeachingActivity['kind']='assignment'){
  const course=createTeachingCourse(db,scope,{title:'课程',budgetMicros:1_000_000});
  const activity=createTeachingActivity(db,scope,course.id,{revision:course.revision,title:'教学保存项',kind,stage:kind==='inquiry'?'before':'after',status:'draft',rubric:kind==='assignment'?[{id:'score',label:'评价',description:'依据原作业',maxScore:100}]:[]}).activity;
  return {course,activity};
}
function item(course:TeachingCourse,activity?:TeachingActivity){return {courseId:course.id,revision:course.revision,...(activity?{activityId:activity.id,activityRevision:activity.revision}:{})};}
function trash(db:Database,course:TeachingCourse,activity?:TeachingActivity){mutateTeachingTrash(db,{userId:course.userId,workspaceId:course.workspaceId},{confirmed:true,items:[item(course,activity)]},false);return item(course,activity);}
const operation=(course:TeachingCourse,activity:TeachingActivity,status:TeachingOperation['status']='completed'):TeachingOperation=>({userId:course.userId,workspaceId:course.workspaceId,id:`operation-${activity.id}`,courseId:course.id,activityId:activity.id,operationId:`request-${activity.id}`,payloadHash:'hash',kind:'prepare',status,createdAt:'now'});
async function fixture(t:TestContext,failCleanup=false){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-teaching-purge-'));let db=database(),tail:Promise<unknown>=Promise.resolve(),fail=failCleanup;
  const store:Store={read:async()=>db,mutate:<T>(change:(db:Database)=>T)=>{const next=tail.then(()=>{const previous=structuredClone(db);try{return change(db);}catch(error){db=previous;throw error;}});tail=next.catch(()=>{});return next;}};
  const headers={'Content-Type':'application/json','x-user':a.userId,'x-workspace':a.workspaceId};
  const app=express();app.use(express.json());const auth:express.RequestHandler=(req,res,next)=>{const user=db.users.find(row=>row.id===req.get('x-user'));if(!user){res.sendStatus(401);return;}req.user=user;req.workspaceId=req.get('x-workspace');next();};
  installTeachingRoutes(app,[auth],store,{directory,verifyKey:async()=>{},purgeRemoveFiles:async value=>{if(fail)throw new Error('SYNTHETIC_PRIVATE_STORAGE_PATH');await removeAttachmentFiles(value);}});
  app.use((error:Error&{status?:number},_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??500).json({error:'synthetic request rejected'}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();server.close();await fs.rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/teaching`;
  const request=async(url:string,body?:unknown,extra:Record<string,string>={})=>{const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
  let fileCount=0;
  const file=async(course:TeachingCourse,userId=course.userId)=>{const id=`att_purge_${++fileCount}`,storagePath=path.join(directory,id+'.txt');await fs.writeFile(storagePath,'PRIVATE_ORIGINAL',{mode:0o600});await fs.writeFile(storagePath+'.segments','PRIVATE_SEGMENTS',{mode:0o600});const attachment:Attachment={id,workspaceId:course.workspaceId,userId,conversationId:`teaching:${course.id}`,storagePath,originalName:id+'.txt',mimeType:'text/plain',kind:'text',size:16,status:'ready',extractedText:'PRIVATE_ORIGINAL',createdAt:'now'};db.attachments.push(attachment);return attachment;};
  return {get db(){return db;},store,directory,request,file,allowCleanup:()=>{fail=false;}};
}

test('new learning sources are knowledge only; an explicit transition preserves historical fields and original submission snapshots',()=>{
  const db=database(),{course,activity}=make(db);
  assert.equal(course.sourceMode,'knowledge');
  assert.throws(()=>createTeachingCourse(db,a,{title:'拒绝原文',materialText:'新教材原文'}),/关联知识库/);
  assert.throws(()=>createTeachingCourse(db,a,{title:'拒绝附件',materialAttachmentIds:['new-file']}),/关联知识库/);
  delete course.sourceMode;course.materialText='HISTORICAL_MATERIAL';course.materialAttachmentIds=['historical-file'];
  const submission=addTeachingSubmission(db,a,course,{activityId:activity.id,participantName:'学生',text:'原作业',operationId:'original-submission-01'}).submission,before=structuredClone(submission);
  updateTeachingCourse(db,a,course.id,{revision:course.revision,title:'更新名称',sourceMode:'knowledge',knowledgeSources:[]});
  assert.equal(course.materialText,'HISTORICAL_MATERIAL');assert.deepEqual(course.materialAttachmentIds,['historical-file']);assert.deepEqual(submission,before);assert.equal(course.sourceMode,'knowledge');
  assert.throws(()=>updateTeachingCourse(db,a,course.id,{revision:course.revision,materialText:'新增原文'}),/不再新增/);
  assert.throws(()=>updateTeachingCourse(db,a,course.id,{revision:course.revision,materialAttachmentIds:['different-file']}),/不再新增/);
});

test('an original historical create receipt remains replayable without reopening material writes for a new course',()=>{
  const db=database(),body={title:'旧创建',subject:'',description:'',materialText:'HISTORICAL_ORIGINAL',knowledgeSources:[],budgetMicros:0},course=createTeachingCourse(db,a,{title:'旧创建'});
  delete course.sourceMode;course.materialText=body.materialText;course.clientCreateKey='legacy-create-key';course.createPayloadHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.equal(createTeachingCourse(db,a,{...body,clientRequestId:course.clientCreateKey}),course);
  assert.throws(()=>createTeachingCourse(db,a,{...body,clientRequestId:'another-create-key'}),/关联知识库/);
});

test('permanent deletion requires exact trashed owners, versions, unchanged impact and no active or uncertain AI',()=>{
  const db=database(),{course,activity}=make(db);
  assert.throws(()=>previewTeachingPurge(db,a,{items:[item(course,activity)]}),/只能永久删除/);
  const selected=trash(db,course,activity),original=JSON.stringify(db);
  for(const scope of [sameUser,other])assert.throws(()=>previewTeachingPurge(db,scope,{items:[selected]}),/不存在/);
  assert.equal(JSON.stringify(db),original);
  assert.throws(()=>previewTeachingPurge(db,a,{items:[{...selected,revision:0}]}),/版本|变化/);
  const preview=previewTeachingPurge(db,a,{items:[selected]});
  const active=operation(course,activity,'running');teachingState(db,a).operations.push(active);
  for(const status of ['running','uncertain'] as const){active.status=status;assert.throws(()=>commitTeachingPurge(db,a,{items:[selected],impactHash:preview.impactHash,requestId:'active-purge-request-0001',confirmed:true},{directoryAvailable:true}),/尚未核对/);}
  active.status='completed';
  assert.throws(()=>commitTeachingPurge(db,a,{items:[selected],impactHash:preview.impactHash,requestId:'changed-purge-request-001',confirmed:true},{directoryAvailable:true}),/影响已变化/);
  assert.equal(course.activities.length,1);
});

test('purging one item preserves course-wide and sibling student access while removing only the exact item session and records',()=>{
  const db=database(),{course,activity}=make(db,a,'inquiry'),sibling=createTeachingActivity(db,a,course.id,{revision:course.revision,title:'保留工具',kind:'inquiry',stage:'before',status:'published'}).activity;
  activity.status='published';publishTeachingCourse(db,a,course.id,{revision:course.revision,confirmed:true});
  setTeachingActivityOpen(db,a,course.id,activity.id,{revision:course.revision,activityRevision:activity.revision,confirmed:true},true);
  setTeachingActivityOpen(db,a,course.id,sibling.id,{revision:course.revision,activityRevision:sibling.revision,confirmed:true},true);
  const legacy=createTeachingSession(db,course.slug!,{participantName:'旧入口学生',consent:true});
  const exact=createTeachingSession(db,activity.slug!,{participantName:'本项学生',consent:true}),otherSession=createTeachingSession(db,sibling.slug!,{participantName:'另一项学生',consent:true});
  const keepToken=authTeachingSession(db,sibling.slug!,otherSession.token).session,legacySession=authTeachingSession(db,course.slug!,legacy.token).session;
  addTeachingSubmission(db,a,course,{activityId:activity.id,participantName:'教师代传',operationId:'purge-target-submit-001',text:'删除的作业'});
  const kept=addTeachingSubmission(db,a,course,{activityId:sibling.id,participantName:'保留学生',operationId:'purge-kept-submit-0001',text:'保留作业'}).submission;
  const selected=trash(db,course,activity),preview=previewTeachingPurge(db,a,{items:[selected]});assert.equal(preview.impact.sessions,1);assert.equal(preview.impact.submissions,1);
  commitTeachingPurge(db,a,{items:[selected],impactHash:preview.impactHash,requestId:'per-item-purge-request01',confirmed:true},{directoryAvailable:true});
  assert.equal(authTeachingSession(db,sibling.slug!,otherSession.token).session.id,keepToken.id);assert.equal(authTeachingSession(db,course.slug!,legacy.token).session.id,legacySession.id);
  assert.ok(teachingState(db,a).submissions.some(row=>row.id===kept.id));assert.ok(!teachingState(db,a).sessions.some(row=>row.id===exact.sessionId));assert.equal(course.activities.length,1);
  assert.doesNotThrow(()=>addTeachingSubmission(db,a,course,{activityId:sibling.id,operationId:'legacy-sibling-after-purge',text:'旧课程会话继续交另一项作业'},authTeachingSession(db,course.slug!,legacy.token).session));
});

test('HTTP purge removes exact originals and segments, preserves financial ledgers, and replays after the course no longer exists',async t=>{
  const f=await fixture(t),{course,activity}=make(f.db),original=await f.file(course);activity.sourceAttachmentIds=[original.id];
  teachingState(f.db,a).operations.push(operation(course,activity));
  f.db.modelUsageRecords.push({...a,id:'financial-usage',conversationId:`teaching:${course.id}`,requestId:`operation-${activity.id}`,modelId:'fixture',inputTokens:1,outputTokens:1,totalTokens:2,source:'provider',status:'success',chargedMicros:123,createdAt:'now'});
  f.db.powerLedger.push({...a,id:'original-ledger',type:'usage',amountMicros:-123,balanceBeforeMicros:1000,balanceAfterMicros:877,title:'保留的计费记录',createdAt:'now'});
  const usage=structuredClone(f.db.modelUsageRecords),ledger=structuredClone(f.db.powerLedger),selected=trash(f.db,course);
  const preview=await f.request('/purge/preview',{items:[selected]});assert.equal(preview.status,200);assert.equal(preview.body.impact.files,1);assert.doesNotMatch(JSON.stringify(preview.body),/storagePath|PRIVATE_|tokenHash|requestHash/);
  const body={items:[selected],impactHash:preview.body.impactHash,requestId:'permanent-original-request1',confirmed:true};
  const result=await f.request('/purge',body);assert.equal(result.status,200);assert.equal(result.body.purge.status,'completed');assert.equal(result.body.purge.remainingFiles,0);assert.equal(teachingState(f.db,a).courses.length,0);assert.equal(f.db.attachments.length,0);
  await assert.rejects(fs.stat(original.storagePath),/ENOENT/);await assert.rejects(fs.stat(original.storagePath+'.segments'),/ENOENT/);
  assert.deepEqual(f.db.modelUsageRecords,usage);assert.deepEqual(f.db.powerLedger,ledger);assert.ok(f.db.auditLogs.some(row=>row.action==='teaching.purged'));
  const replay=await f.request('/purge',body);assert.equal(replay.status,200);assert.equal(replay.body.purge.id,result.body.purge.id);
  const lookup=await f.request('/purge/'+body.requestId);assert.equal(lookup.body.purge.status,'completed');assert.doesNotMatch(JSON.stringify(lookup.body),/storagePath|PRIVATE_|pendingFiles|workspaceId|userId/);
  assert.equal((await f.request('/purge/'+body.requestId,undefined,{'x-workspace':sameUser.workspaceId})).status,404);
  assert.equal((await f.request('/purge',body,{'x-user':other.userId})).status,404);
});

test('shared original references in other teaching snapshots, chats, execution tasks and industry lineage are retained',async t=>{
  const f=await fixture(t),{course,activity}=make(f.db),sibling=createTeachingActivity(f.db,a,course.id,{revision:course.revision,title:'保留原件引用',kind:'assignment',stage:'after'}).activity;
  const files=await Promise.all(Array.from({length:5},()=>f.file(course)));activity.sourceAttachmentIds=files.map(row=>row.id);
  const kept=addTeachingSubmission(f.db,a,course,{activityId:sibling.id,participantName:'保留',operationId:'retained-snapshot-0001',text:'保留作业'}).submission;kept.activitySnapshot.sourceAttachmentIds=[files[0].id];
  f.db.messages.push({...a,id:'other-chat-message',conversationId:'other-chat',role:'user',content:'保留引用',attachmentIds:[files[1].id],createdAt:'now'});
  f.db.executionTasks.push({...a,id:'other-task',input:{fileId:files[2].id}} as any);
  f.db.users[0].industry={commerceJobs:[{...a,id:'lineage',userId:a.userId,result:{source:{imageId:files[3].id}}}]} as any;
  const selected=trash(f.db,course,activity),preview=previewTeachingPurge(f.db,a,{items:[selected]});assert.equal(preview.impact.files,1);assert.equal(preview.impact.retainedFiles,4);
  const receipt=commitTeachingPurge(f.db,a,{items:[selected],impactHash:preview.impactHash,requestId:'preserve-other-references',confirmed:true},{directoryAvailable:true});
  await cleanTeachingPurgeFiles(f.store,a,receipt.requestId,f.directory);
  for(const file of files.slice(0,4))assert.equal(await fs.readFile(file.storagePath,'utf8'),'PRIVATE_ORIGINAL');await assert.rejects(fs.stat(files[4].storagePath),/ENOENT/);
  assert.equal(f.db.attachments.length,4);assert.deepEqual(kept.activitySnapshot.sourceAttachmentIds,[files[0].id]);
});

test('a failed private file cleanup is journalled and exact request replay finishes it without deleting another record',async t=>{
  const f=await fixture(t,true),{course,activity}=make(f.db),original=await f.file(course);activity.sourceAttachmentIds=[original.id];const selected=trash(f.db,course);
  const preview=await f.request('/purge/preview',{items:[selected]}),body={items:[selected],impactHash:preview.body.impactHash,requestId:'cleanup-failure-request001',confirmed:true};
  const pending=await f.request('/purge',body);assert.equal(pending.status,200);assert.equal(pending.body.purge.status,'files_pending');assert.equal(pending.body.purge.remainingFiles,1);assert.equal(teachingState(f.db,a).courses.length,0);assert.equal(await fs.readFile(original.storagePath,'utf8'),'PRIVATE_ORIGINAL');assert.doesNotMatch(JSON.stringify(pending.body),/PRIVATE_STORAGE_PATH|storagePath|pendingFiles/);
  const journal=ownedTeachingPurge(f.db,a,body.requestId);assert.equal(journal.pendingFiles[0].storagePath,original.storagePath);
  const different={...body,impactHash:'0'.repeat(64)};assert.equal((await f.request('/purge',different)).status,409);
  f.allowCleanup();const done=await f.request('/purge',body);assert.equal(done.body.purge.status,'completed');await assert.rejects(fs.stat(original.storagePath),/ENOENT/);assert.equal(teachingState(f.db,a).purges!.length,1);
});

test('foreign paths and another attachment pointing to the same physical source are never removed',async t=>{
  const f=await fixture(t),{course,activity}=make(f.db),original=await f.file(course),outside=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'one-purge-outside-')),'outside.txt');t.after(()=>fs.rm(path.dirname(outside),{recursive:true,force:true}));await fs.writeFile(outside,'OUTSIDE_PRIVATE');
  const invalid={...original,id:'att_outside',storagePath:outside};f.db.attachments.push(invalid);activity.sourceAttachmentIds=[invalid.id];
  const selected=trash(f.db,course,activity),preview=previewTeachingPurge(f.db,a,{items:[selected]}),receipt=commitTeachingPurge(f.db,a,{items:[selected],impactHash:preview.impactHash,requestId:'path-safety-purge-request',confirmed:true},{directoryAvailable:true});
  assert.equal((await cleanTeachingPurgeFiles(f.store,a,receipt.requestId,f.directory)).status,'files_pending');assert.equal(await fs.readFile(outside,'utf8'),'OUTSIDE_PRIVATE');
  const next=make(f.db),shared=await f.file(next.course);f.db.attachments.push({...shared,id:'foreign-alias',workspaceId:'wb',userId:'other'});next.activity.sourceAttachmentIds=[shared.id];const nextItem=trash(f.db,next.course,next.activity);assert.equal(planTeachingPurge(f.db,a,{items:[nextItem]}).impact.files,0);assert.equal(await fs.readFile(shared.storagePath,'utf8'),'PRIVATE_ORIGINAL');
});

test('a changed batch, unconfigured file cleanup, unfinished parsing and financial review cannot partially purge originals',async t=>{
  const f=await fixture(t),first=make(f.db),second=make(f.db),original=await f.file(first.course);first.activity.sourceAttachmentIds=[original.id];
  const firstItem=trash(f.db,first.course),secondItem=trash(f.db,second.course),items=[firstItem,secondItem],preview=previewTeachingPurge(f.db,a,{items});
  assert.throws(()=>commitTeachingPurge(f.db,a,{items,impactHash:preview.impactHash,requestId:'missing-directory-request1',confirmed:true},{directoryAvailable:false}),/没有删除/);assert.equal(teachingState(f.db,a).courses.length,2);assert.equal(f.db.attachments.length,1);
  original.status='parsing';assert.throws(()=>previewTeachingPurge(f.db,a,{items}),/仍在解析/);original.status='ready';
  const savedOperation=operation(first.course,first.activity);teachingState(f.db,a).operations.push(savedOperation);
  f.db.modelUsageRecords.push({...a,id:'reserved-review',requestId:savedOperation.id,conversationId:`teaching:${first.course.id}`,modelId:'fixture',inputTokens:0,outputTokens:0,totalTokens:0,source:'unknown',reservedMicros:10,status:'needs_review',createdAt:'now'});
  assert.throws(()=>previewTeachingPurge(f.db,a,{items}),/尚未核对/);f.db.modelUsageRecords[0].reservedMicros=0;f.db.modelUsageRecords[0].status='waived';
  const reviewed=previewTeachingPurge(f.db,a,{items});mutateTeachingTrash(f.db,a,{confirmed:true,items:[item(second.course)]},true);
  const refused=await f.request('/purge',{items,impactHash:reviewed.impactHash,requestId:'batch-changed-request-001',confirmed:true});assert.equal(refused.status,409);assert.equal(teachingState(f.db,a).courses.length,2);assert.equal(f.db.attachments.length,1);assert.equal(await fs.readFile(original.storagePath,'utf8'),'PRIVATE_ORIGINAL');assert.equal(teachingState(f.db,a).purges?.length??0,0);assert.ok(!f.db.auditLogs.some(row=>row.action==='teaching.purged'));
});

test('private purge journals and pending cleanup survive an actual Store restart',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-purge-restart-'));try{
    const env={...process.env,NODE_ENV:'test',DB_PROVIDER:'json',ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:'isolated-purge-fixture-password'};
    const imports="import fs from 'node:fs/promises';import path from 'node:path';import {store} from './server/db.ts';import * as t from './server/teaching.ts';import * as l from './server/teachingLifecycle.ts';import * as p from './server/teachingPurge.ts';";
    const create=imports+"const dir=path.join(process.env.ONE_DATA_DIR,'uploads');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'att_durable.txt'),'PRIVATE_DURABLE');await store.mutate(db=>{const u=db.users[0],s={userId:u.id,workspaceId:u.defaultWorkspaceId},c=t.createTeachingCourse(db,s,{title:'durable'});db.attachments.push({id:'att_durable',...s,conversationId:'teaching:'+c.id,storagePath:path.join(dir,'att_durable.txt'),originalName:'durable.txt',mimeType:'text/plain',kind:'text',size:15,extractedText:'',status:'ready',createdAt:'now'});l.mutateTeachingTrash(db,s,{confirmed:true,items:[{courseId:c.id,revision:c.revision}]},false);const items=[{courseId:c.id,revision:c.revision}],preview=p.previewTeachingPurge(db,s,{items});p.commitTeachingPurge(db,s,{items,impactHash:preview.impactHash,requestId:'durable-purge-request-0001',confirmed:true},{directoryAvailable:true});});";
    execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',create],{cwd:process.cwd(),env});
    const recover=imports+"const db=await store.read(),u=db.users[0],s={userId:u.id,workspaceId:u.defaultWorkspaceId};const before=p.publicTeachingPurge(p.ownedTeachingPurge(db,s,'durable-purge-request-0001'));const done=await p.cleanTeachingPurgeFiles(store,s,'durable-purge-request-0001',path.join(process.env.ONE_DATA_DIR,'uploads'));console.log(JSON.stringify({before:before.status,after:done.status,remaining:done.remainingFiles,courses:t.teachingState(await store.read(),s).courses.length}));";
    const result=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',recover],{cwd:process.cwd(),env,encoding:'utf8'}).trim());assert.deepEqual(result,{before:'files_pending',after:'completed',remaining:0,courses:0});await assert.rejects(fs.stat(path.join(directory,'uploads','att_durable.txt')),/ENOENT/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
