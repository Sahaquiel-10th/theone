import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type {Database} from './types';
import type {Store} from './db';
import {AttachmentService} from './attachmentService';
import {installPublicSharingRoutes} from './publicSharingRoutes';
import {activateSavedPublication,activePublication,createGuest,publish} from './publicSharing';

function fixture(){
 let db={users:[{id:'owner',username:'owner',enabled:true},{id:'other',username:'other',enabled:true}],workspaces:[{id:'ws',status:'active'},{id:'other-ws',status:'active'}],workspaceMembers:[{workspaceId:'ws',userId:'owner',role:'owner'},{workspaceId:'other-ws',userId:'other',role:'owner'}],models:[{id:'model',name:'Fixture model',enabled:true,kind:'chat',apiKey:'FIXTURE_ONLY',protocol:'openai',model:'fixture',baseUrl:'http://127.0.0.1:1',systemPrompt:'',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1}],settings:{safetyRules:'safe',rechargeCnyPerPower:7},auditLogs:[],publications:[],publicSessions:[],publicRuns:[],attachments:[],knowledgeConnections:[{id:'source',workspaceId:'ws',provider:'notion',status:'connected',clientId:'fixture',encryptedApiKey:'FIXTURE_SOURCE'},{id:'foreign-source',workspaceId:'other-ws',provider:'notion',status:'connected',clientId:'other',encryptedApiKey:'FOREIGN_FIXTURE'}],messages:[],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'power',workspaceId:'ws',userId:'owner',balanceMicros:10000000,reservedMicros:0}]} as unknown as Database;
 const store:Store={read:async()=>db,mutate:async action=>{const before=structuredClone(db);try{return action(db);}catch(error){db=before;throw error;}}};
 const input={intent:'draft',name:'Private fixture',description:'Private description',prompt:'PRIVATE_INSTRUCTIONS',modelId:'model',sourceIds:['source'],attachments:true,budget:1,perRun:.1,days:7,confirmed:true};
 return {store,input,get db(){return db;}};
}
test('private save is durable configuration only, never activation or a paid run',()=>{
 const f=fixture(),before=structuredClone({accounts:f.db.powerAccounts,ledger:f.db.powerLedger,usage:f.db.modelUsageRecords}),p=publish(f.db,{workspaceId:'ws',userId:'owner'},f.input);
 assert.equal(p.status,'draft');assert.equal(p.draftDays,7);assert.equal(p.version,1);assert.ok(p.slug);
 assert.throws(()=>activePublication(f.db,p.id),/关闭或到期/);assert.throws(()=>createGuest(f.db,p.id),/关闭或到期/);
 assert.deepEqual({accounts:f.db.powerAccounts,ledger:f.db.powerLedger,usage:f.db.modelUsageRecords},before);assert.equal(f.db.publicRuns?.length,0);assert.equal(f.db.publicSessions?.length,0);
 const restored=JSON.parse(JSON.stringify(p));assert.equal(restored.status,'draft');assert.equal(restored.draftDays,7);
});
test('activation rechecks source binding and version; its original receipt can be retried without activation twice',()=>{
 const f=fixture(),scope={workspaceId:'ws',userId:'owner'},p=publish(f.db,scope,f.input),slug=p.slug;
 assert.throws(()=>activateSavedPublication(f.db,scope,p.id,{version:1,confirmed:false}),/确认/);
 assert.throws(()=>activateSavedPublication(f.db,scope,p.id,{version:2,confirmed:true}),/变化/);
 f.db.knowledgeConnections[0].encryptedApiKey='CHANGED_FIXTURE';assert.throws(()=>activateSavedPublication(f.db,scope,p.id,{version:1,confirmed:true}),/知识连接已变化/);assert.equal(p.status,'draft');
 f.db.knowledgeConnections[0].encryptedApiKey='FIXTURE_SOURCE';const active=activateSavedPublication(f.db,scope,p.id,{version:1,confirmed:true});
 assert.equal(active.status,'active');assert.equal(active.slug,slug);assert.equal(active.version,2);const audits=f.db.auditLogs.length;
 const receipt=activateSavedPublication(f.db,scope,p.id,{version:1,confirmed:true});assert.equal(receipt.slug,slug);assert.equal(receipt.version,2);assert.equal(f.db.auditLogs.length,audits);assert.equal(f.db.modelUsageRecords.length,0);
});
test('HTTP draft routes isolate owners, hide reserved slugs and reject public access before explicit activation',async t=>{
 const f=fixture(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-private-sharing-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const app=express();app.use(express.json());installPublicSharingRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}req.user={id:String(req.headers['x-user']??'owner')} as any;req.workspaceId=String(req.headers['x-workspace']??'ws');next();}],f.store,{recallWithDiagnostics:async()=>{assert.fail('private save cannot retrieve knowledge');}} as any,new AttachmentService(f.store,directory));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${(server.address() as any).port}/api/sharing`,headers={'x-key':'present','Content-Type':'application/json'};
 const send=async(url:string,body:unknown,extra:Record<string,string>={})=>fetch(base+url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 const response=await send('/manage',{...f.input,workspaceId:'other-ws'});assert.equal(response.status,200);const draft=await response.json();assert.equal(draft.status,'draft');assert.ok(draft.id);assert.equal(draft.slug,undefined);
 const stored=f.db.publications![0];assert.equal(stored.workspaceId,'ws');const reservedSlug=stored.slug;
 const mine=await(await fetch(base+'/manage',{headers})).json();assert.equal(mine.items[0].status,'draft');assert.equal(mine.items[0].slug,undefined);assert.doesNotMatch(JSON.stringify(mine),/PRIVATE_INSTRUCTIONS|FIXTURE_SOURCE/);
 assert.equal((await fetch(base+'/'+reservedSlug)).status,410);assert.equal((await fetch(base+'/'+reservedSlug+'/sessions',{method:'POST'})).status,410);
 const foreignScopes:Array<Record<string,string>>=[{'x-user':'other'},{'x-workspace':'other-ws'},{'x-user':'other','x-workspace':'other-ws'}];
 for(const extra of foreignScopes){
  assert.equal((await fetch(base+`/manage/${draft.id}/config`,{headers:{...headers,...extra}})).status,404);
  assert.equal((await send(`/manage/${draft.id}/publish`,{version:1,confirmed:true},extra)).status,404);
 }
 const before=f.db.publications!.length,audits=f.db.auditLogs.length;assert.equal((await send('/manage',{...f.input,sourceIds:['foreign-source']})).status,400);assert.equal(f.db.publications!.length,before);assert.equal(f.db.auditLogs.length,audits);
 const updated=await send(`/manage/${draft.id}/update`,{...f.input,version:1,name:'Updated private fixture'});assert.equal(updated.status,200);const updatedReceipt=await updated.json();assert.equal(updatedReceipt.status,'draft');assert.equal(updatedReceipt.slug,undefined);assert.equal(updatedReceipt.version,2);assert.equal(f.db.publications![0].status,'draft');
 assert.equal((await send(`/manage/${draft.id}/publish`,{version:1,confirmed:true})).status,409);assert.equal(f.db.publications![0].status,'draft');
 const activated=await send(`/manage/${draft.id}/publish`,{version:2,confirmed:true});assert.equal(activated.status,200);const active=await activated.json();assert.equal(active.status,'active');assert.equal(active.slug,reservedSlug);assert.equal(active.version,3);
 const activationAudits=f.db.auditLogs.length;const repeated=await send(`/manage/${draft.id}/publish`,{version:2,confirmed:true});assert.equal(repeated.status,200);assert.equal((await repeated.json()).slug,reservedSlug);assert.equal(f.db.auditLogs.length,activationAudits);
 assert.equal((await fetch(base+'/'+reservedSlug)).status,200);assert.equal(f.db.modelUsageRecords.length,0);assert.equal(f.db.powerLedger.length,0);assert.equal(f.db.publicRuns!.length,0);assert.equal(f.db.powerAccounts[0].reservedMicros,0);
});
test('an unshared draft survives a real JSON store restart without becoming active or charging',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const run=promisify(execFile);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-private-restart-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const env={...process.env,DB_PROVIDER:'json',ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:'isolated-fixture-password',YYLX_API_KEY:'',NODE_ENV:'test'};
 const evaluate=async(code:string)=>(await run(process.execPath,['--import','tsx','--input-type=module','-e',code],{env})).stdout;
 const created=JSON.parse(await evaluate(`const {store}=await import('./server/db.ts');const {publish}=await import('./server/publicSharing.ts');const p=await store.mutate(db=>{db.models.push({id:'draft-fixture',name:'Fixture',enabled:true,kind:'chat',apiKey:'fixture-only',systemPrompt:''});const owner=db.users[0];return publish(db,{userId:owner.id,workspaceId:owner.defaultWorkspaceId},{intent:'draft',name:'Private restart fixture',description:'',prompt:'',modelId:'draft-fixture',sourceIds:[],attachments:false,budget:1,perRun:1,days:14,confirmed:true});});console.log(JSON.stringify({id:p.id,status:p.status}));`));
 const restored=JSON.parse(await evaluate(`const {store}=await import('./server/db.ts');const d=await store.read(),p=d.publications.find(item=>item.id===${JSON.stringify(created.id)});console.log(JSON.stringify({id:p.id,status:p.status,days:p.draftDays,usage:d.modelUsageRecords.length,runs:d.publicRuns.length,reserved:d.powerAccounts.reduce((n,a)=>n+a.reservedMicros,0)}));`));
 assert.equal(restored.id,created.id);assert.equal(restored.status,'draft');assert.equal(restored.days,14);assert.equal(restored.usage,0);assert.equal(restored.runs,0);assert.equal(restored.reserved,0);
});
test('a draft can wait privately; configured validity starts only when sharing is activated',()=>{
 const f=fixture(),scope={workspaceId:'ws',userId:'owner'},draft=publish(f.db,scope,{...f.input,days:14});
 draft.expiresAt='2000-01-01T00:00:00.000Z';
 const before=Date.now(),active=activateSavedPublication(f.db,scope,draft.id,{version:1,confirmed:true});
 assert.equal(active.status,'active');assert.ok(Date.parse(active.expiresAt)>=before+14*86400000);assert.ok(Date.parse(active.expiresAt)<=Date.now()+14*86400000);
});

test('private draft activation preserves the existing author service method and consented intake configuration',()=>{
 const f=fixture(),scope={workspaceId:'ws',userId:'owner'};
 const service={mode:'knowledge',welcome:'欢迎来聊',starterQuestions:['从哪开始？'],method:'先理解问题，再基于授权资料回答',features:[]};
 const p=publish(f.db,scope,{...f.input,service,serviceBusiness:{access:'open',plans:[],intakeFields:[{id:'question',label:'想了解的问题',type:'text',required:false}]}});
 assert.equal(p.status,'draft');assert.deepEqual(p.service,service);const business=structuredClone(p.serviceBusiness);
 const active=activateSavedPublication(f.db,scope,p.id,{version:1,confirmed:true});
 assert.equal(active.status,'active');assert.deepEqual(active.service,service);assert.deepEqual(active.serviceBusiness,business);
 assert.equal(f.db.modelUsageRecords.length,0);assert.equal(f.db.powerLedger.length,0);
});
