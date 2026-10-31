import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {coordinatorDrafts,coordinatorSubmissionPayload,saveCoordinatorDraft,forgetCoordinatorDraft,markCoordinatorDraft} from './coordinatorDrafts';
import {chatSubmission,forgetChatSubmission} from './chatSubmission';
import type {CoordinatorSubmission} from './useCoordinator';
function storage(t:TestContext,blocked=false){
  const values=new Map<string,string>();const previous=new Map(['sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(blocked)throw new Error('quota');values.set(key,value);}}});
  t.after(()=>{for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});return values;
}
const draft=(operationId=randomUUID()):CoordinatorSubmission=>({operationId,text:'preserved original',modelId:'model-a',boundTaskId:'task-a',outputDestination:'notion',localExecution:false,webSearch:true,confirmedExternal:true,attachmentIds:['attachment-a'],featureIds:['feature-a'],featureApprovals:[{id:'feature-a',releaseId:'release-a',version:1,multiplier:3}]});
test('a reloaded draft keeps original replay flags and references within the exact user and workspace',t=>{
  const values=storage(t),user=randomUUID(),original=draft();saveCoordinatorDraft(user,'workspace-a',original);
  const saved=coordinatorDrafts(user,'workspace-a')[0];
  assert.deepEqual(coordinatorSubmissionPayload(saved),coordinatorSubmissionPayload(original));
  assert.deepEqual(coordinatorDrafts(user,'workspace-b'),[]);assert.deepEqual(coordinatorDrafts(randomUUID(),'workspace-a'),[]);
  const freshUser=randomUUID();const serialized=[...values.values()][0];values.set(`one.coordinator-drafts.v1:${JSON.stringify([freshUser,'workspace-a'])}`,serialized);
  assert.equal(coordinatorDrafts(freshUser,'workspace-a')[0].operationId,original.operationId);
});
test('storage uses a whitelist and cannot acquire credentials, bodies or extra approval fields',t=>{
  const values=storage(t),user=randomUUID();const input={...draft(),apiKey:'SECRET_SENTINEL',body:'FILE_BODY_SENTINEL',featureApprovals:[{id:'feature-a',releaseId:'release-a',version:1,multiplier:3,token:'APPROVAL_TOKEN_SENTINEL'}]};
  saveCoordinatorDraft(user,'workspace',input);const serialized=[...values.values()][0];
  for(const secret of ['SECRET_SENTINEL','FILE_BODY_SENTINEL','APPROVAL_TOKEN_SENTINEL'])assert.ok(!serialized.includes(secret));
  assert.deepEqual(coordinatorDrafts(user,'workspace')[0].attachmentIds,['attachment-a']);
});
test('settling an older operation only removes that draft, while failed and missing drafts remain recoverable',t=>{
  storage(t);const user=randomUUID(),first=draft(),second=draft();saveCoordinatorDraft(user,'workspace',first);saveCoordinatorDraft(user,'workspace',second);
  markCoordinatorDraft(user,'workspace',second.operationId,'missing');forgetCoordinatorDraft(user,'workspace',first.operationId);
  assert.deepEqual(coordinatorDrafts(user,'workspace').map(value=>[value.operationId,value.state]),[[second.operationId,'missing']]);
  markCoordinatorDraft(user,'workspace',second.operationId,'failed');assert.equal(coordinatorDrafts(user,'workspace')[0].state,'failed');
});
test('blocked storage retains references in this tab and old drafts expire without renewing on a status update',t=>{
  storage(t,true);const user=randomUUID(),input=draft();saveCoordinatorDraft(user,'workspace',input);const original=coordinatorDrafts(user,'workspace')[0];
  assert.equal(original.operationId,input.operationId);markCoordinatorDraft(user,'workspace',input.operationId,'failed');
  assert.equal(coordinatorDrafts(user,'workspace')[0].createdAt,original.createdAt);
  assert.deepEqual(coordinatorDrafts(user,'workspace',Date.now()+8*24*60*60*1000),[]);
});
test('corrupted storage is ignored and capacity is bounded',t=>{
  const values=storage(t),user=randomUUID();values.set(`one.coordinator-drafts.v1:${JSON.stringify([user,'workspace'])}`,'{"not":"an array"}');
  assert.deepEqual(coordinatorDrafts(user,'workspace'),[]);
  for(let index=0;index<25;index++)saveCoordinatorDraft(user,'workspace',draft());assert.equal(coordinatorDrafts(user,'workspace').length,20);
});
test('manual resend reuses the same ID only while all replay semantics match the original hash',async t=>{
  storage(t);const user=randomUUID(),scope=`coordinator:${user}:workspace`,original=draft(),payload=coordinatorSubmissionPayload(original);
  const operationId=await chatSubmission(scope,payload);saveCoordinatorDraft(user,'workspace',{...original,operationId},'missing');
  const restored=coordinatorSubmissionPayload(coordinatorDrafts(user,'workspace')[0]);
  assert.equal(await chatSubmission(scope,restored),operationId);
  for(const change of [{webSearch:false},{modelId:'model-b'},{boundTaskId:'task-b'},{outputDestination:'chat' as const},{localExecution:true},{attachmentIds:[]},{featureIds:[]},{featureApprovals:[]}]){
    assert.notEqual(await chatSubmission(scope,{...restored,...change}),operationId);
  }
});

test('terminal replies use a fresh retry ID while partial and uncertain business results remain review-only drafts',async t=>{
  storage(t);const user=randomUUID(),scope=`coordinator:${user}:workspace`,original=draft(),payload=coordinatorSubmissionPayload(original);
  const operationId=await chatSubmission(scope,payload);
  saveCoordinatorDraft(user,'workspace',{...original,operationId});
  // The hook resolves the idempotency entry for a confirmed terminal reply,
  // while retaining the separately scoped original for the restore action.
  forgetChatSubmission(scope,operationId);markCoordinatorDraft(user,'workspace',operationId,'failed');
  assert.equal(coordinatorDrafts(user,'workspace')[0].operationId,operationId);
  assert.notEqual(await chatSubmission(scope,payload),operationId);
  markCoordinatorDraft(user,'workspace',operationId,'review');
  assert.equal(coordinatorDrafts(user,'workspace')[0].state,'review');
});

test('a rejected local request preserves its safe reason across reload without storing diagnostics or authorizing replay',t=>{
 const values=storage(t),user=randomUUID(),input={...draft(),outputDestination:'local' as const};saveCoordinatorDraft(user,'workspace',input);
 markCoordinatorDraft(user,'workspace',input.operationId,'failed',{failure:{code:'local_attachments_unsupported',stage:'accepting',outcome:'not_started'},requestId:'req-reviewed'});
 const saved=coordinatorDrafts(user,'workspace')[0];assert.equal(saved.outputDestination,'local');assert.equal(saved.state,'failed');assert.equal(saved.rejection?.failure.code,'local_attachments_unsupported');assert.equal(saved.rejection.requestId,'req-reviewed');
 const fresh=randomUUID();values.set(`one.coordinator-drafts.v1:${JSON.stringify([fresh,'workspace'])}`,JSON.stringify([{...saved,rejection:{...saved.rejection,raw:'SECRET',failure:{...saved.rejection.failure,token:'SECRET'}}}]));
 const reloaded=coordinatorDrafts(fresh,'workspace')[0];assert.deepEqual(reloaded.rejection,saved.rejection);assert.ok(!JSON.stringify(reloaded).includes('SECRET'));
});
