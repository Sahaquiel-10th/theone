import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {TeachingCourse,TeachingKnowledgeSource} from '../server/teachingTypes';
import type {TeachingRequest} from './teachingUploads';
import {CourseMaterialConflict,courseManagerDraftKey,courseMaterialForm,decodeCourseManagerDraft,decodeCoursePurgeAttempt,emptyCourseMaterialForm,previewCoursePurge,resolveCourseCreation,resolveCourseMaterialSave,resolveCoursePurge,sameCourseMaterials,saveCourseManagerDraft,saveCoursePurgeAttempt,type CourseManagerDraft,type CoursePurgeAttempt,type CoursePurgeImpact} from './teachingCourseManagerState';

const owner={userId:'teacher-a',workspaceId:'workspace-a'};
const source:TeachingKnowledgeSource={provider:'notion',connectionId:'connection-a',binding:'binding-a',scope:'page',pageId:'page-a',label:'文化教材'};
function course(patch:Partial<TeachingCourse>&{sourceMode?:'knowledge'}={}):TeachingCourse{return {...owner,id:'course-a',revision:1,...emptyCourseMaterialForm(),title:'文化导论',description:'旧介绍应保留',materialText:'历史讲义仍在后台',materialAttachmentIds:['historical-original'],budgetMicros:5000000,status:'published',slug:'unchanged-public-link',activities:[],createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z',...patch};}
function requestWith(handler:(path:string,options?:RequestInit)=>unknown|Promise<unknown>):TeachingRequest{return async<T,>(path:string,options?:RequestInit)=>await handler(path,options) as T;}
const memoryStorage=()=>{let raw='';return {get raw(){return raw;},getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value;},removeItem:()=>{raw='';}};};

test('course knowledge drafts and original receipts stay isolated by user, workspace and course',()=>{
  const draft:CourseManagerDraft={form:{...emptyCourseMaterialForm(),title:'尚未保存的课程'},files:[],createAttempt:{clientRequestId:'original-create-0001',payload:{...emptyCourseMaterialForm(),title:'尚未保存的课程'}}};
  const storage=memoryStorage();saveCourseManagerDraft(storage,'draft',owner,draft);
  assert.deepEqual(decodeCourseManagerDraft(storage.raw,owner),{...draft,remoteId:undefined,baseRevision:undefined,baseForm:undefined,saveAttempt:undefined});
  assert.equal(decodeCourseManagerDraft(storage.raw,{...owner,userId:'teacher-b'}),undefined);
  assert.equal(decodeCourseManagerDraft(storage.raw,{...owner,workspaceId:'workspace-b'}),undefined);
  assert.notEqual(courseManagerDraftKey(owner),courseManagerDraftKey({...owner,userId:'teacher-b'}));
  assert.notEqual(courseManagerDraftKey(owner,'course-a'),courseManagerDraftKey(owner,'course-b'));
  assert.equal(decodeCourseManagerDraft('{broken',owner),undefined);
});

test('a legacy pending draft exposes only knowledge fields while preserving exact original requests and local originals',()=>{
  const legacy={title:'原课程',subject:'人文',materialText:'未决原文不能丢',materialAttachmentIds:['original-file'],knowledgeSources:[source]},attempt={clientRequestId:'legacy-request-0001',payload:legacy};
  const decoded=decodeCourseManagerDraft(JSON.stringify({...owner,form:legacy,baseForm:legacy,files:[{id:'original-file',originalName:'原讲义.docx',status:'ready'}],createAttempt:attempt,saveAttempt:{courseId:'course-a',revision:3,payload:legacy}}),owner)!;
  assert.deepEqual(decoded.form,{title:legacy.title,subject:legacy.subject,sourceMode:'knowledge',knowledgeSources:[source]});
  assert.deepEqual(decoded.createAttempt,attempt);assert.deepEqual(decoded.saveAttempt?.payload,legacy);
  assert.deepEqual(decoded.legacyMaterials,{materialText:legacy.materialText,materialAttachmentIds:legacy.materialAttachmentIds});
  assert.equal(decoded.files[0].id,'original-file');
});

test('storage failure surfaces before any caller may issue a new remote mutation',()=>{
  const broken={getItem:()=>null,removeItem:()=>{},setItem(){throw Error('quota');}};
  assert.throws(()=>saveCourseManagerDraft(broken,'draft',owner,{form:emptyCourseMaterialForm(),files:[]}),/quota/);
  assert.throws(()=>saveCoursePurgeAttempt(broken,owner,purgeAttempt()),/quota/);
});

test('new course creation sends knowledge references only and reconciles a lost response by the original nonce, never its title',async()=>{
  const attempt={clientRequestId:'stable-create-request-0001',payload:{...emptyCourseMaterialForm(),title:'文化导论',knowledgeSources:[source]}},records=[course({id:'unrelated-same-title'})];let posts=0;
  const request=requestWith((path,options)=>{assert.equal(path,'/api/teaching/courses');if(options?.method==='POST'){posts++;const body=JSON.parse(String(options.body));assert.equal(body.clientRequestId,attempt.clientRequestId);assert.equal(body.sourceMode,'knowledge');assert.equal(body.workspaceId,undefined);assert.equal(body.materialAttachmentIds,undefined);assert.equal(body.materialText,undefined);records.push(course({...body,id:'received-course',clientCreateKey:body.clientRequestId}));throw Error('response lost');}return {courses:records};});
  await assert.rejects(resolveCourseCreation(request,attempt,false),/response lost/);
  const recovered=await resolveCourseCreation(request,attempt,true);assert.equal(recovered.id,'received-course');assert.equal(posts,1);assert.equal(records.length,2);
});

test('an unreceived legacy creation replays its original fields and nonce instead of migrating its idempotency hash',async()=>{
  const payload={title:' 文化导论 ',subject:' 通识 ',materialText:'原始正文',materialAttachmentIds:[],knowledgeSources:[source]},attempt={clientRequestId:'stable-legacy-request-0002',payload};let received:unknown;
  const request=requestWith((_path,options)=>{if(!options)return {courses:[]};received=JSON.parse(String(options.body));return {course:course({clientCreateKey:attempt.clientRequestId})};});
  await resolveCourseCreation(request,attempt);assert.deepEqual(received,{...payload,title:'文化导论',subject:'通识',clientRequestId:attempt.clientRequestId});
});

test('a lost knowledge PATCH preserves historical materials, sharing and ledger settings and does not write twice',async()=>{
  let saved=course(),patches=0;const payload={...courseMaterialForm(saved),knowledgeSources:[source]},attempt={courseId:saved.id,revision:saved.revision,payload};
  const request=requestWith((_path,options)=>{if(options?.method==='PATCH'){patches++;const body=JSON.parse(String(options.body));assert.equal(body.revision,1);for(const key of ['materialText','materialAttachmentIds','status','activities','budgetMicros','description'])assert.equal(body[key],undefined);saved={...saved,...body,revision:2};throw Error('lost PATCH response');}return {course:saved};});
  await assert.rejects(resolveCourseMaterialSave(request,attempt),/lost PATCH response/);const recovered=await resolveCourseMaterialSave(request,attempt);
  assert.equal(patches,1);assert.equal(recovered.slug,'unchanged-public-link');assert.equal(recovered.status,'published');assert.equal(recovered.description,'旧介绍应保留');assert.equal(recovered.budgetMicros,5000000);assert.equal(recovered.materialText,'历史讲义仍在后台');assert.deepEqual(recovered.materialAttachmentIds,['historical-original']);
});

test('editing a legacy course explicitly switches source mode without clearing its stored originals',async()=>{
  const saved=course({sourceMode:undefined}),payload=courseMaterialForm(saved);let received:any;
  const result=await resolveCourseMaterialSave(requestWith((_path,options)=>{if(!options)return {course:saved};received=JSON.parse(String(options.body));return {course:{...saved,...received,revision:2}};}),{courseId:saved.id,revision:1,payload});
  assert.equal(received.sourceMode,'knowledge');assert.equal(received.materialText,undefined);assert.equal(received.materialAttachmentIds,undefined);assert.equal(result.materialText,saved.materialText);
});

test('a completed legacy PATCH is reconciled against its original payload without changing the source mode or resending it',async()=>{
  const saved=course({sourceMode:undefined}),payload={title:saved.title,subject:saved.subject,materialText:saved.materialText,materialAttachmentIds:saved.materialAttachmentIds,knowledgeSources:saved.knowledgeSources??[]};let writes=0;
  const result=await resolveCourseMaterialSave(requestWith((_path,options)=>{if(options)writes++;return {course:saved};}),{courseId:saved.id,revision:1,payload});assert.equal(result,saved);assert.equal(writes,0);
});

test('a different newer course revision is returned for review without overwriting it',async()=>{
  const saved=course({revision:4,knowledgeSources:[source]}),payload={...courseMaterialForm(saved),title:'本机尚未保存的名称'};let writes=0;
  await assert.rejects(resolveCourseMaterialSave(requestWith((_path,options)=>{if(options?.method==='PATCH')writes++;return {course:saved};}),{courseId:saved.id,revision:3,payload}),error=>error instanceof CourseMaterialConflict&&error.course===saved);assert.equal(writes,0);
});

test('a concurrent same-content save returning 409 is reconciled rather than repeated',async()=>{
  const before=course(),payload={...courseMaterialForm(before),knowledgeSources:[source]};let reads=0,writes=0;
  const request=requestWith((_path,options)=>{if(options?.method==='PATCH'){writes++;throw Object.assign(Error('revision changed'),{status:409});}reads++;return {course:reads===1?before:course({...payload,revision:2})};});
  assert.equal((await resolveCourseMaterialSave(request,{courseId:before.id,revision:1,payload})).revision,2);assert.equal(writes,1);assert.equal(reads,2);
});

test('source scope and binding affect reconciliation while transient whole-library consent survives draft storage',()=>{
  const original={...emptyCourseMaterialForm(),title:'文化导论',knowledgeSources:[{...source,scope:'connection' as const,confirmed:true}]};
  assert.equal(sameCourseMaterials(original,{...original,title:' 文化导论 '}),true);
  assert.equal(sameCourseMaterials(original,{...original,knowledgeSources:[{...original.knowledgeSources[0],binding:'binding-b'}]}),false);
  const storage=memoryStorage();saveCourseManagerDraft(storage,'draft',owner,{form:original,files:[]});const decoded=decodeCourseManagerDraft(storage.raw,owner)!;assert.equal((decoded.form.knowledgeSources[0] as any).confirmed,true);
  assert.equal(sameCourseMaterials(original,{...original,knowledgeSources:[{...source,scope:'connection'}]}),true,'the server removes transient confirmation after binding');
});

const impact:CoursePurgeImpact={courses:1,activities:3,sessions:9,submissions:7,operations:4,files:2,retainedFiles:1,fileBytes:2048};
function purgeAttempt():CoursePurgeAttempt{return {requestId:'purge-original-request-0001',impactHash:'preview-impact-hash',items:[{courseId:'course-a',revision:7}],titles:['原课程'],confirmed:true};}

test('permanent deletion previews exact revisions without sending a destructive confirmation',async()=>{
  const items=purgeAttempt().items;let received:any;
  const result=await previewCoursePurge(requestWith((path,options)=>{assert.equal(path,'/api/teaching/purge/preview');received=JSON.parse(String(options?.body));return {impactHash:'preview-impact-hash',impact};}),items);
  assert.equal(received.confirmed,undefined);assert.deepEqual(received,{items});assert.deepEqual(result.impact,impact);
});

test('lost permanent-deletion receipts keep exactly the same confirmed scope, impact and request ID across reload',async()=>{
  const original=purgeAttempt(),storage=memoryStorage();saveCoursePurgeAttempt(storage,owner,original);const restored=decodeCoursePurgeAttempt(storage.raw,owner)!;const bodies:any[]=[];let calls=0;
  const request=requestWith((path,options)=>{assert.equal(path,'/api/teaching/purge');bodies.push(JSON.parse(String(options?.body)));if(++calls===1)throw Error('lost delete response');return {purge:{id:original.requestId,status:'completed',impact,remainingFiles:0}};});
  await assert.rejects(resolveCoursePurge(request,original),/lost delete response/);const receipt=await resolveCoursePurge(request,restored);
  assert.equal(receipt.status,'completed');assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[0].titles,undefined);assert.deepEqual(bodies[0],{requestId:original.requestId,impactHash:original.impactHash,items:original.items,confirmed:true});
});

test('a pending file cleanup is reported as pending and its recovery receipt cannot cross identities',async()=>{
  const original=purgeAttempt(),storage=memoryStorage();saveCoursePurgeAttempt(storage,owner,original);
  assert.equal(decodeCoursePurgeAttempt(storage.raw,{...owner,workspaceId:'another-workspace'}),undefined);assert.equal(decodeCoursePurgeAttempt(storage.raw,{...owner,userId:'another-user'}),undefined);
  const receipt=await resolveCoursePurge(requestWith(()=>({purge:{id:original.requestId,status:'files_pending',impact,remainingFiles:1}})),original);assert.equal(receipt.status,'files_pending');assert.equal(receipt.remainingFiles,1);assert.deepEqual(decodeCoursePurgeAttempt(storage.raw,owner),original);
});

test('the course manager has no direct material input or tool execution, and permanent deletion is only offered in trash',()=>{
  const text=fs.readFileSync(new URL('./TeachingCoursesPage.tsx',import.meta.url),'utf8');assert.doesNotMatch(text,/<textarea|type="file"|uploadTeachingFile|authenticatedBlob|\/api\/teaching\/tasks|\/ai['"`]|\/publish['"`]|\/close['"`]/);
  assert.match(text,/savedSources=\{currentCourse\?\.knowledgeSources\?\?\[\]\}/);assert.match(text,/defaultOpen/);assert.match(text,/if\(!trash\|\|locked.current\|\|purgeAttempt\)return/);
});
