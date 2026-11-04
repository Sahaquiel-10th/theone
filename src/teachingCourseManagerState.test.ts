import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {TeachingCourse} from '../server/teachingTypes';
import type {TeachingRequest} from './teachingUploads';
import {CourseMaterialConflict,courseManagerDraftKey,courseMaterialForm,decodeCourseManagerDraft,emptyCourseMaterialForm,resolveCourseCreation,resolveCourseMaterialSave,sameCourseMaterials,saveCourseManagerDraft,type CourseManagerDraft} from './teachingCourseManagerState';

const owner={userId:'teacher-a',workspaceId:'workspace-a'};
function course(patch:Partial<TeachingCourse>={}):TeachingCourse{return {...owner,id:'course-a',revision:1,...emptyCourseMaterialForm(),title:'文化导论',description:'旧介绍应保留',budgetMicros:5000000,status:'published',slug:'unchanged-public-link',activities:[],createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z',...patch};}
function requestWith(handler:(path:string,options?:RequestInit)=>unknown|Promise<unknown>):TeachingRequest{return async<T,>(path:string,options?:RequestInit)=>await handler(path,options) as T;}

test('course material drafts and their original receipts cannot cross user or workspace boundaries',()=>{
  const draft:CourseManagerDraft={form:{...emptyCourseMaterialForm(),title:'尚未上传的课程'},files:[],createAttempt:{clientRequestId:'original-create-0001',payload:{...emptyCourseMaterialForm(),title:'尚未上传的课程'}}};
  let raw='';saveCourseManagerDraft({setItem:(_key,value)=>{raw=value;},getItem:()=>raw,removeItem:()=>{}},'draft',owner,draft);
  assert.deepEqual(decodeCourseManagerDraft(raw,owner),{...draft,remoteId:undefined,baseRevision:undefined,baseForm:undefined,saveAttempt:undefined});
  assert.equal(decodeCourseManagerDraft(raw,{...owner,userId:'teacher-b'}),undefined);
  assert.equal(decodeCourseManagerDraft(raw,{...owner,workspaceId:'workspace-b'}),undefined);
  assert.notEqual(courseManagerDraftKey(owner),courseManagerDraftKey({...owner,userId:'teacher-b'}));
  assert.notEqual(courseManagerDraftKey(owner,'course-a'),courseManagerDraftKey(owner,'course-b'));
  assert.equal(decodeCourseManagerDraft('{broken',owner),undefined);
  const invalid=JSON.parse(raw);invalid.createAttempt.payload.materialAttachmentIds=Array.from({length:21},(_,i)=>String(i));assert.equal(decodeCourseManagerDraft(JSON.stringify(invalid),owner),undefined);
});

test('storage failure is surfaced before a caller can send a new creation receipt',()=>{
  assert.throws(()=>saveCourseManagerDraft({getItem:()=>null,removeItem:()=>{},setItem(){throw Error('quota');}},'draft',owner,{form:emptyCourseMaterialForm(),files:[]}),/quota/);
});

test('a lost creation response is found by its stable receipt, never by a matching course title',async()=>{
  const attempt={clientRequestId:'stable-create-request-0001',payload:{...emptyCourseMaterialForm(),title:'文化导论'}},records=[course({id:'unrelated-same-title'})];let posts=0;
  const request=requestWith((path,options)=>{
    assert.equal(path,'/api/teaching/courses');
    if(options?.method==='POST'){posts++;const body=JSON.parse(String(options.body));assert.equal(body.clientRequestId,attempt.clientRequestId);assert.equal(body.workspaceId,undefined);assert.deepEqual(body.materialAttachmentIds,[]);records.push(course({id:'received-course',clientCreateKey:body.clientRequestId}));throw Error('response lost');}
    return {courses:records};
  });
  await assert.rejects(resolveCourseCreation(request,attempt,false),/response lost/);
  const recovered=await resolveCourseCreation(request,attempt,true);
  assert.equal(recovered.id,'received-course');assert.equal(posts,1);assert.equal(records.length,2);
});

test('an unreceived creation replays exactly the same payload and request ID',async()=>{
  const attempt={clientRequestId:'stable-create-request-0002',payload:{...emptyCourseMaterialForm(),title:' 文化导论 ',subject:' 通识 '}};let received:unknown;
  const request=requestWith((_path,options)=>{if(!options)return {courses:[]};received=JSON.parse(String(options.body));return {course:course({clientCreateKey:attempt.clientRequestId})};});
  await resolveCourseCreation(request,attempt);
  assert.deepEqual(received,{...attempt.payload,title:'文化导论',subject:'通识',clientRequestId:attempt.clientRequestId});
});

test('a lost PATCH response is reconciled by exact material fields without a second write or link rotation',async()=>{
  let saved=course(),patches=0;const payload={...courseMaterialForm(saved),materialText:'新的课程学习资料',materialAttachmentIds:['file-a']},attempt={courseId:saved.id,revision:saved.revision,payload};
  const request=requestWith((_path,options)=>{
    if(options?.method==='PATCH'){patches++;const body=JSON.parse(String(options.body));assert.equal(body.revision,1);assert.equal(body.status,undefined);assert.equal(body.activities,undefined);assert.equal(body.budgetMicros,undefined);saved={...saved,...body,revision:2};throw Error('lost PATCH response');}
    return {course:saved};
  });
  await assert.rejects(resolveCourseMaterialSave(request,attempt),/lost PATCH response/);
  const recovered=await resolveCourseMaterialSave(request,attempt);
  assert.equal(patches,1);assert.equal(recovered.slug,'unchanged-public-link');assert.equal(recovered.status,'published');assert.equal(recovered.description,'旧介绍应保留');assert.equal(recovered.budgetMicros,5000000);
});

test('a different newer version is returned for review without overwriting it',async()=>{
  const saved=course({revision:4,materialText:'其他页面保存的资料'}),payload={...courseMaterialForm(saved),materialText:'本机尚未保存的资料'};let writes=0;
  const request=requestWith((_path,options)=>{if(options?.method==='PATCH')writes++;return {course:saved};});
  await assert.rejects(resolveCourseMaterialSave(request,{courseId:saved.id,revision:3,payload}),error=>error instanceof CourseMaterialConflict&&error.course===saved);
  assert.equal(writes,0);assert.equal(payload.materialText,'本机尚未保存的资料');
});

test('a concurrent same-content save returning 409 is reconciled rather than repeated',async()=>{
  const before=course(),payload={...courseMaterialForm(before),materialText:'相同的新资料'};let reads=0,writes=0;
  const request=requestWith((_path,options)=>{if(options?.method==='PATCH'){writes++;throw Object.assign(Error('revision changed'),{status:409});}reads++;return {course:reads===1?before:course({...payload,revision:2})};});
  const saved=await resolveCourseMaterialSave(request,{courseId:before.id,revision:1,payload});assert.equal(saved.revision,2);assert.equal(writes,1);assert.equal(reads,2);
});

test('source bindings and attachment references are part of the exact save comparison',()=>{
  const original={...emptyCourseMaterialForm(),title:'文化导论',knowledgeSources:[{provider:'notion' as const,connectionId:'connection-a',binding:'binding-a',scope:'page' as const,pageId:'page-a',label:'教材'}]};
  assert.equal(sameCourseMaterials(original,{...original,title:' 文化导论 '}),true);
  assert.equal(sameCourseMaterials(original,{...original,materialAttachmentIds:['file-b']}),false);
  assert.equal(sameCourseMaterials(original,{...original,knowledgeSources:[{...original.knowledgeSources[0],binding:'binding-b'}]}),false);
});

test('the manager exposes materials and reversible course actions without tool execution or course-wide publication controls',()=>{
  const text=fs.readFileSync(new URL('./TeachingCoursesPage.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(text,/\/api\/teaching\/tasks|\/ai['"`]|\/publish['"`]|\/close['"`]|TeacherTaskFlow|TeachingCourseInbox|RubricEditor|QuestionEditor/);
  assert.match(text,/items:confirmation.map\(course=>\(\{courseId:course.id,revision:course.revision\}\)\)/);
  assert.match(text,/onChange=\{sources=>update\(current=>\(\{\.\.\.current,form:\{\.\.\.current.form,knowledgeSources:sources\}\}\)\)\}/);
  const upload=text.slice(text.indexOf('  async function upload('),text.indexOf('  async function checkUploads('));assert.ok(upload.indexOf('Array.from(files??[])')<upload.indexOf('await ensureCourse()'));assert.match(upload,/signal:row.controller.signal/);
});
