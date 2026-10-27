import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {emptyAvatarBusiness,emptyAvatarService} from './AvatarService';

/** Exercise only the synthetic API's state transitions. This is not a DOM or
 * browser-operation script; visual flows use the real local page controls. */
function fixture(){
  const source=readFileSync(new URL('../scripts/qa-avatar-workbench.tsx',import.meta.url),'utf8');
  const logic=source.slice(source.indexOf('const models='),source.indexOf('function App()'))+'\nglobalThis.qaFixtureApi=fixtureApi;';
  let nativeCalls=0;
  class ApiError extends Error{constructor(message:string,readonly requestId?:string,readonly status=400,readonly code?:string){super(message);}}
  const sandbox={URL,Date,structuredClone,crypto:{randomUUID},emptyAvatarBusiness,emptyAvatarService,ApiError,fetch(){nativeCalls++;throw new Error('A synthetic API must not access the network');},qaFixtureApi:undefined as undefined|((path:string,options?:RequestInit)=>Promise<any>)};
  const compiled=ts.transpileModule(logic,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  vm.runInNewContext(compiled,sandbox,{filename:'qa-avatar-workbench-fixture.js'});
  async function request(path:string,body?:unknown){
    try{return {status:200,data:await sandbox.qaFixtureApi!(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)})};}
    catch(error){if(error instanceof ApiError)return {status:error.status,data:{error:error.message,code:error.code}};throw error;}
  }
  return {request,get nativeCalls(){return nativeCalls;}};
}

test('closed fixture avatars edit in place and only explicit reopening rotates their public link',async()=>{
  const f=fixture(),base='/api/sharing/manage/local-avatar-3';
  const listed=await f.request('/api/sharing/manage');assert.equal(listed.data.total,8);assert.equal(listed.data.trashTotal,0);
  const original=listed.data.items.find((row:any)=>row.id==='local-avatar-3'),config=(await f.request(`${base}/config`)).data;
  assert.equal(config.status,'closed');
  assert.equal((await f.request(`${base}/update`,{...config,name:'修改后仍未开放',confirmed:false})).status,400);
  const updated=await f.request(`${base}/update`,{...config,intent:'draft',name:'修改后仍未开放',confirmed:true});
  assert.equal(updated.data.status,'closed');assert.equal(updated.data.version,2);assert.equal(updated.data.slug,undefined);
  assert.equal((await f.request(`${base}/config`)).data.name,'修改后仍未开放');
  assert.equal((await f.request(`${base}/publish`,{version:1,confirmed:true})).status,409);
  const published=await f.request(`${base}/publish`,{version:2,confirmed:true});
  assert.equal(published.data.status,'active');assert.equal(published.data.version,3);assert.notEqual(published.data.slug,original.slug);
  assert.deepEqual((await f.request(`${base}/publish`,{version:2,confirmed:true})).data,published.data);
  const active=(await f.request(`${base}/config`)).data;
  const activeUpdated=await f.request(`${base}/update`,{...active,name:'更新但保持当前链接',confirmed:true});
  assert.equal(activeUpdated.data.slug,published.data.slug);assert.equal(activeUpdated.data.version,4);
  const closed=await f.request(`${base}/close`,{version:4,confirmed:true});
  assert.equal(closed.data.status,'closed');assert.equal(closed.data.version,5);
  assert.deepEqual((await f.request(`${base}/close`,{version:4,confirmed:true})).data,closed.data);
  const reopened=await f.request(`${base}/publish`,{version:5,confirmed:true});
  assert.equal(reopened.data.version,6);assert.notEqual(reopened.data.slug,published.data.slug);assert.equal(f.nativeCalls,0);
});

test('fixture delete is recoverable, hidden from the regular list, and restoration never republishes',async()=>{
  const f=fixture(),base='/api/sharing/manage/local-avatar-2';
  assert.equal((await f.request(`${base}/delete`,{version:1,confirmed:false})).status,400);
  assert.equal((await f.request(`${base}/delete`,{version:9,confirmed:true})).status,409);
  const removed=await f.request(`${base}/delete`,{version:1,confirmed:true});
  assert.equal(removed.data.status,'closed');assert.equal(removed.data.version,2);assert.ok(removed.data.deletedAt);
  assert.equal((await f.request('/api/sharing/manage')).data.total,7);
  const trash=await f.request('/api/sharing/manage?trash=1');assert.equal(trash.data.total,1);assert.equal(trash.data.trashTotal,1);assert.equal(trash.data.items[0].slug,undefined);
  assert.equal((await f.request(`${base}/config`)).status,404);
  assert.equal((await f.request(`${base}/update`,{version:2,confirmed:true})).status,404);
  assert.deepEqual((await f.request(`${base}/delete`,{version:1,confirmed:true})).data,removed.data);
  assert.equal((await f.request(`${base}/usage`)).status,200);
  const restored=await f.request(`${base}/restore`,{version:2,confirmed:true});
  assert.equal(restored.data.status,'closed');assert.equal(restored.data.version,3);assert.equal(restored.data.deletedAt,undefined);assert.equal(restored.data.slug,undefined);
  assert.deepEqual((await f.request(`${base}/restore`,{version:2,confirmed:true})).data,restored.data);
  assert.equal((await f.request('/api/sharing/manage?trash=1')).data.total,0);
  assert.equal((await f.request('/api/sharing/manage')).data.total,8);
  assert.equal(f.nativeCalls,0);
});

test('draft fixture restoration remains private and author configuration survives round trips',async()=>{
  const f=fixture(),base='/api/sharing/manage/local-avatar-1';
  const original=(await f.request(`${base}/config`)).data;
  const removed=await f.request(`${base}/delete`,{version:1,confirmed:true});assert.equal(removed.data.status,'draft');
  const restored=await f.request(`${base}/restore`,{version:2,confirmed:true});assert.equal(restored.data.status,'draft');assert.equal(restored.data.slug,undefined);
  const result=(await f.request(`${base}/config`)).data;assert.equal(result.service.method,original.service.method);assert.equal(result.version,3);
  const created=await f.request('/api/sharing/manage',{...original,intent:'draft',name:'新的合成私有分身',confirmed:true});
  assert.equal(created.data.status,'draft');assert.equal(created.data.version,1);assert.equal(created.data.slug,undefined);
  const updated=await f.request(`/api/sharing/manage/${created.data.id}/update`,{...original,intent:'draft',name:'重新打开后仍能编辑',version:1,confirmed:true});
  assert.equal(updated.data.version,2);assert.equal(updated.data.slug,undefined);
  assert.equal((await f.request(`/api/sharing/manage/${created.data.id}/config`)).data.name,'重新打开后仍能编辑');
  assert.equal((await f.request('/api/sharing/manage?trash=invalid')).status,400);
  assert.equal((await f.request('/api/sharing/manage',{...original,intent:'draft',sourceIds:['foreign-connection'],confirmed:true})).status,403);
  assert.equal(f.nativeCalls,0);
});

test('fixture short-answer receipts are synthetic, zero-cost and idempotent with no network fallback',async()=>{
  const f=fixture(),body={operationId:'fixture-preview-000001',content:'请介绍方法',config:{service:{mode:'knowledge'}}};
  const first=await f.request('/api/sharing/manage/preview',body),again=await f.request('/api/sharing/manage/preview',body);
  assert.deepEqual(first.data,again.data);assert.equal(first.data.chargedMicros,0);assert.equal(first.data.heldMicros,0);assert.match(first.data.response,/本地合成回答/);
  assert.equal((await f.request('/api/unknown-local-fixture')).status,400);assert.equal(f.nativeCalls,0);
  const source=readFileSync(new URL('../scripts/qa-avatar-workbench.tsx',import.meta.url),'utf8');
  assert.match(source,/draftScope=\{\{userId:'local-qa-user',workspaceId:'local-qa-workspace'\}\}/);
  const html=readFileSync(new URL('../scripts/qa-avatar-workbench.html',import.meta.url),'utf8');
  assert.match(html,/connect-src ws:\/\/127\.0\.0\.1:5177;/);
});
