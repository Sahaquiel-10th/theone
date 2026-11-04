import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { commerceFixture, commerceOwner as owner, commercePeer as peer, commerceOther as other } from './commerce.fixture.js';
import { COMMERCE_MAIN_AGENT_ID, COMMERCE_EDIT_AGENT_ID, commerceJobAccess } from './commerce.js';
import { installCommerceRoutes } from './commerceRoutes.js';
import { IndustryStore, recoverIndustryOperations } from './industryState.js';

async function httpFixture(t:TestContext){
  const f=commerceFixture(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-http-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let keyPresent=true;
  const dependencies={...f.dependencies,saveImage:async(url:string,job:Parameters<typeof f.dependencies.saveImage>[1],variant:Parameters<typeof f.dependencies.saveImage>[2])=>{
    const image=await f.dependencies.saveImage(url,job,variant);image.storagePath=path.join(directory,image.id+'.png');await fs.writeFile(image.storagePath,Buffer.from(`SYNTHETIC_PRIVATE_IMAGE_${image.id}`));return image;
  }};
  for(const a of f.db.attachments){a.storagePath=path.join(directory,a.id+'.png');await fs.writeFile(a.storagePath,Buffer.from(`SYNTHETIC_INPUT_${a.id}`));}
  const start=async()=>{
    const app=express();app.use(express.json());
    const auth:express.RequestHandler=(req,res,next)=>{const user=f.db.users.find(u=>u.id===req.headers['x-user']);if(!user){res.sendStatus(401);return;}req.user=user;req.workspaceId=String(req.headers['x-workspace']||'');next();};
    const installed=installCommerceRoutes(app,[auth],new IndustryStore(f.base),{...dependencies,verifyKey:async()=>{if(!keyPresent)throw Object.assign(Error('Key removed'),{status:428});}});
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{installed.close();server.closeAllConnections();server.close();});
    return `http://127.0.0.1:${(server.address() as {port:number}).port}/api/commerce`;
  };
  const base=await start();
  const request=(url:string,body?:unknown,actor=owner,endpoint=base)=>fetch(endpoint+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-user':actor.id,'x-workspace':actor.workspaceId},body:body===undefined?undefined:JSON.stringify(body)});
  return {...f,get db(){return f.db;},baseUrl:base,request,start,removeKey:()=>{keyPresent=false;}};
}

test('HTTP main workbench plans, generates one result, exports private ZIP and rejects cross-owner/workspace access',async t=>{
  const f=await httpFixture(t),body={agentId:COMMERCE_MAIN_AGENT_ID,brief:f.brief,requestKey:'http-main-request-00001',usageSessionId:f.mainSession.id};
  const created=await f.request('/jobs',body);assert.equal(created.status,202,await created.clone().text());const job=(await created.json()).job;await f.idle(job.id);
  assert.equal((await f.request('/jobs',body)).status,202);assert.equal(f.calls.length,2);
  assert.equal((await f.request('/jobs',{...body,brief:{...f.brief,notes:'changed'}})).status,409);
  const full=await (await f.request('/jobs/'+job.id)).json();const variant=full.job.variants[0];assert.doesNotMatch(JSON.stringify(full),/apiKey|SYNTHETIC_NOT_SENT|imagePrompt|usageSessionId|requestHash|workspaceId|userId/);
  const generated={variantId:variant.id,referenceImageId:'ref-b',requestKey:'http-generate-request-1',usageSessionId:f.mainSession.id};
  assert.equal((await f.request(`/jobs/${job.id}/generate`,generated)).status,202);await f.idle(job.id);
  assert.equal((await f.request(`/jobs/${job.id}/generate`,generated)).status,202);assert.equal(f.calls.filter(c=>c.kind==='image').length,1);
  for(const actor of [peer,other]){
    assert.equal((await f.request('/jobs/'+job.id,undefined,actor)).status,404);
    assert.equal((await f.request(`/jobs/${job.id}/download`,undefined,actor)).status,404);
    assert.deepEqual((await (await f.request('/jobs',undefined,actor)).json()).jobs,[]);
  }
  const download=await f.request(`/jobs/${job.id}/download?handoff=1`);assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'no-store');
  const zip=await JSZip.loadAsync(await download.arrayBuffer());assert.ok(zip.file('标题与方案说明.txt'));const image=Object.values(zip.files).find(file=>!file.dir&&!file.name.includes('/')&&file.name.endsWith('.png'))!;assert.match(await image.async('string'),/^SYNTHETIC_PRIVATE_IMAGE_/);
  assert.ok(Object.keys(zip.files).some(name=>name.startsWith('原始素材/')));
  f.removeKey();assert.equal((await f.request('/jobs',{...body,requestKey:'missing-key-request-001'})).status,428);
});

test('HTTP batch edit keeps independent instructions and returns only this owner\'s results',async t=>{
  const f=await httpFixture(t),body={agentId:COMMERCE_EDIT_AGENT_ID,requestKey:'http-edit-request-00001',usageSessionId:f.editSession.id,instruction:'价格改69元',items:[{imageId:'product'},{imageId:'detail',instruction:'删除右上角角标'}]};
  assert.equal((await f.request('/edits',body,peer)).status,409);
  const response=await f.request('/edits',body);assert.equal(response.status,202,await response.clone().text());const job=(await response.json()).job;await f.idle(job.id);
  assert.deepEqual(f.calls.filter(c=>c.kind==='image').map(c=>c.messages[0].inputImageDataUrls),[['product'],['detail']]);
  assert.equal((await f.request('/edits',body)).status,202);assert.equal(f.calls.length,2);
  const zip=await JSZip.loadAsync(await (await f.request(`/jobs/${job.id}/download`)).arrayBuffer());const instructions=await zip.file('修改说明.txt')!.async('string');assert.match(instructions,/价格改69元/);assert.match(instructions,/删除右上角角标/);
  assert.equal(Object.values(zip.files).filter(file=>file.name.endsWith('.png')).length,2);
});

test('HTTP auxiliary receipts survive reloads and replay cached results without a second model call',async t=>{
  const f=await httpFixture(t),body={imageIds:['product'],requestKey:'http-recognize-request-0001',usageSessionId:f.mainSession.id};
  const first=await f.request('/recognize',body);assert.equal(first.status,200,await first.clone().text());const expected=await first.json();assert.equal(f.calls.length,1);
  const restarted=await f.start();assert.deepEqual(await (await f.request('/recognize',body,owner,restarted)).json(),expected);assert.equal(f.calls.length,1);
  assert.equal((await f.request('/recognize',{...body,imageIds:['detail']})).status,409);assert.equal(f.calls.length,1);
  const operation=f.db.users.find(u=>u.id===owner.id)!.industry!.operations[0];operation.status='running';delete operation.result;
  await recoverIndustryOperations(new IndustryStore(f.base));
  const unknown=await f.request('/recognize',body);assert.equal(unknown.status,409);assert.equal(f.calls.length,1);assert.equal(operation.status,'uncertain');
  assert.equal((await f.request('/recognize',{...body,imageIds:['peer-image'],requestKey:'foreign-recognize-request'})).status,403);assert.equal(f.calls.length,1);
});
