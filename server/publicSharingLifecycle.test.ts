import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Database} from './types.js';
import type {Store} from './db.js';
import {activateSavedPublication,activePublication,beginPublicRun,closePublication,createGuest,deletePublication,guest,ownedPublication,publish,restorePublication,usageFor} from './publicSharing.js';
import {authenticateApi,issueApiGrant} from './publicApi.js';
import {issueServiceCode,redeemServiceCode,revokeServiceGrant} from './publicAvatarBusiness.js';
import {installPublicSharingRoutes} from './publicSharingRoutes.js';

const scope={workspaceId:'ws',userId:'owner'};
function fixture(){
 let db={users:[{id:'owner',username:'teacher',enabled:true,defaultWorkspaceId:'ws'},{id:'other',username:'other',enabled:true,defaultWorkspaceId:'other-ws'},{id:'visitor',username:'visitor',enabled:true,defaultWorkspaceId:'visitor-ws'}],workspaces:[{id:'ws',status:'active'},{id:'other-ws',status:'active'},{id:'visitor-ws',status:'active'}],workspaceMembers:[{workspaceId:'ws',userId:'owner',role:'owner'},{workspaceId:'other-ws',userId:'other',role:'owner'},{workspaceId:'visitor-ws',userId:'visitor',role:'owner'}],models:[{id:'model',name:'Fixture',enabled:true,kind:'chat',apiKey:'FIXTURE_ONLY',systemPrompt:'',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1}],settings:{safetyRules:'safe',rechargeCnyPerPower:7},publications:[],publicSessions:[],publicRuns:[],attachments:[],conversations:[],messages:[],knowledgeConnections:[{id:'source',workspaceId:'ws',provider:'notion',status:'connected',clientId:'fixture',encryptedApiKey:'PRIVATE_SOURCE'},{id:'foreign-source',workspaceId:'other-ws',provider:'notion',status:'connected',encryptedApiKey:'FOREIGN_SECRET'}],auditLogs:[],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'power',workspaceId:'ws',userId:'owner',balanceMicros:100e6,reservedMicros:0}]} as unknown as Database;
 const store:Store={read:async()=>db,mutate:async action=>{const previous=structuredClone(db);try{return action(db);}catch(error){db=previous;throw error;}}};
 const input={name:'Lifecycle fixture',description:'Synthetic only',prompt:'PRIVATE_METHOD',modelId:'model',sourceIds:['source'],attachments:false,budget:10,perRun:.5,days:60,confirmed:true};
 return {store,input,get db(){return db;}};
}
async function http(t:TestContext,f:ReturnType<typeof fixture>){
 const app=express();app.use(express.json());installPublicSharingRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}req.user={id:String(req.headers['x-user']??'owner')} as any;req.workspaceId=String(req.headers['x-workspace']??'ws');next();}],f.store,{recallWithDiagnostics:async()=>assert.fail('lifecycle never reads knowledge')} as any,{} as any,'',{previewModelCall:async()=>assert.fail('lifecycle never calls a model')});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${(server.address() as any).port}/api/sharing`,headers={'x-key':'present','Content-Type':'application/json'};
 return {base,get:(path:string,extra:Record<string,string>={})=>fetch(base+path,{headers:{...headers,...extra}}),post:(path:string,body:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)})};
}
const fails=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;

test('closed avatar configuration remains editable without publishing or losing actual history and usage',()=>{
 const f=fixture(),p=publish(f.db,scope,f.input),id=p.id,slug=p.slug;
 const g=createGuest(f.db,p.id),run=beginPublicRun(f.db,p,g.session,{content:'OLD_PRIVATE_QUESTION',operationId:'old_question_operation',attachmentIds:[]}).run;run.status='completed';run.response='OLD_PRIVATE_RESPONSE';
 f.db.modelUsageRecords.push({id:'usage',...scope,conversationId:run.id,chargedMicros:20000,reservedMicros:0,status:'success'} as any);
 const billing=structuredClone({accounts:f.db.powerAccounts,ledger:f.db.powerLedger,usage:f.db.modelUsageRecords,runs:f.db.publicRuns});
 closePublication(f.db,scope,p.id,{version:p.version,confirmed:true});
 const updated=publish(f.db,scope,{...f.input,prompt:'NEW_METHOD',version:p.version,intent:'draft'},p.id);
 assert.equal(updated.status,'closed');assert.equal(updated.id,id);assert.equal(updated.slug,slug);assert.equal(ownedPublication(f.db,'ws','owner',id).userPrompt,'NEW_METHOD');assert.equal(usageFor(f.db,p).spent,20000);
 const again=publish(f.db,scope,{...f.input,prompt:'LATEST_METHOD',version:p.version},p.id);assert.equal(again.status,'closed');
 assert.throws(()=>activePublication(f.db,id),/关闭或到期/);assert.throws(()=>createGuest(f.db,id),/关闭或到期/);
 assert.deepEqual({accounts:f.db.powerAccounts,ledger:f.db.powerLedger,usage:f.db.modelUsageRecords,runs:f.db.publicRuns},billing);assert.equal(f.db.publications!.length,1);assert.ok(p.history!.some(h=>h.userPrompt==='PRIVATE_METHOD'));
});

test('explicit reopen rotates the link and versions, never revives old sessions/API grants and is receipt-idempotent',()=>{
 const f=fixture(),p=publish(f.db,scope,f.input),slug=p.slug,g=createGuest(f.db,p.id),api=issueApiGrant(f.db,scope,p.id,{name:'original API',version:p.version,budget:1,perRun:.1,days:7,confirmed:true});
 assert.equal(authenticateApi(f.db,api.token).publication.id,p.id);
 closePublication(f.db,scope,p.id,{version:p.version,confirmed:true});const closedVersion=p.version;
 assert.throws(()=>activateSavedPublication(f.db,scope,p.id,{version:closedVersion,confirmed:false}),/确认/);
 const reopened=activateSavedPublication(f.db,scope,p.id,{version:closedVersion,confirmed:true});
 assert.equal(reopened.status,'active');assert.equal(reopened.id,p.id);assert.notEqual(reopened.slug,slug);assert.equal(reopened.version,closedVersion!+1);assert.equal(p.apiGrants![0].status,'revoked');
 assert.throws(()=>guest(f.db,slug,g.token),/不存在/);assert.throws(()=>guest(f.db,p.slug,g.token),/重新开始/);assert.throws(()=>beginPublicRun(f.db,p,g.session,{content:'must not rerun',operationId:'old_session_operation',attachmentIds:[]}),/重新开始/);assert.throws(()=>authenticateApi(f.db,api.token),/已撤销|无效/);
 const counts={audits:f.db.auditLogs.length,sessions:f.db.publicSessions!.length,slug:p.slug,version:p.version};
 const receipt=activateSavedPublication(f.db,scope,p.id,{version:closedVersion,confirmed:true});assert.equal(receipt.slug,counts.slug);assert.equal(f.db.auditLogs.length,counts.audits);assert.equal(f.db.publicSessions!.length,counts.sessions);assert.equal(p.version,counts.version);
 const next=createGuest(f.db,p.id);assert.equal(guest(f.db,p.slug,next.token).session.id,next.session.id);assert.equal(f.db.publicRuns!.length,0);assert.equal(f.db.modelUsageRecords.length,0);
});

test('legacy closed or draft activation requires an explicit author prompt save instead of guessing or dropping the old mixed prompt',()=>{
 for(const status of ['closed','draft'] as const){
  const f=fixture(),p=publish(f.db,scope,{...f.input,...(status==='draft'?{intent:'draft'}:{})});
  if(status==='closed')closePublication(f.db,scope,p.id,{version:p.version,confirmed:true});
  delete p.userPrompt;p.prompt='LEGACY_SYSTEM_AND_PRIVATE_AUTHOR_MIX';const before=structuredClone(f.db);
  assert.throws(()=>activateSavedPublication(f.db,scope,p.id,{version:p.version,confirmed:true}),fails('PUBLICATION_LEGACY_PROMPT'));
  assert.deepEqual(f.db,before);assert.equal(p.status,status);assert.equal(p.prompt,'LEGACY_SYSTEM_AND_PRIVATE_AUTHOR_MIX');
  publish(f.db,scope,{...f.input,prompt:'EXPLICIT_AUTHOR_METHOD',version:p.version,...(status==='draft'?{intent:'draft'}:{})},p.id);
  assert.equal(p.status,status);assert.equal(p.userPrompt,'EXPLICIT_AUTHOR_METHOD');
  const active=activateSavedPublication(f.db,scope,p.id,{version:p.version,confirmed:true});assert.equal(active.status,'active');assert.equal(active.userPrompt,'EXPLICIT_AUTHOR_METHOD');assert.match(active.prompt,/EXPLICIT_AUTHOR_METHOD$/);assert.doesNotMatch(active.prompt,/LEGACY_SYSTEM_AND_PRIVATE_AUTHOR_MIX/);assert.equal(active.prompt.split('EXPLICIT_AUTHOR_METHOD').length,2);assert.equal(f.db.modelUsageRecords.length,0);
 }
});

test('soft delete and restore retain all billing/history, cannot revive visibility, and repeated receipts do not mutate twice',()=>{
 const f=fixture(),p=publish(f.db,scope,f.input),oldSlug=p.slug,oldVersion=p.version;
 const api=issueApiGrant(f.db,scope,p.id,{name:'test API',version:p.version,budget:1,perRun:.1,days:7,confirmed:true});
 const records=structuredClone({accounts:f.db.powerAccounts,ledger:f.db.powerLedger,runs:f.db.publicRuns,sessions:f.db.publicSessions});
 const removed=deletePublication(f.db,scope,p.id,{version:oldVersion,confirmed:true});assert.ok(removed.deletedAt);assert.equal(p.status,'closed');assert.equal(p.version,oldVersion!+1);
 assert.throws(()=>ownedPublication(f.db,'ws','owner',p.id),/不存在/);assert.equal(ownedPublication(f.db,'ws','owner',p.id,{includeDeleted:true}).id,p.id);assert.throws(()=>activePublication(f.db,p.id),/关闭或到期/);assert.throws(()=>authenticateApi(f.db,api.token),/已撤销|无效/);
 const auditCount=f.db.auditLogs.length,deletedAt=p.deletedAt;deletePublication(f.db,scope,p.id,{version:oldVersion,confirmed:true});assert.equal(f.db.auditLogs.length,auditCount);assert.equal(p.deletedAt,deletedAt);
 const deletedVersion=p.version;const restored=restorePublication(f.db,scope,p.id,{version:deletedVersion,confirmed:true});assert.equal(restored.deletedAt,undefined);assert.equal(restored.status,'closed');assert.equal(restored.slug,oldSlug);assert.throws(()=>activePublication(f.db,p.id),/关闭或到期/);
 const restoredAuditCount=f.db.auditLogs.length;restorePublication(f.db,scope,p.id,{version:deletedVersion,confirmed:true});assert.equal(f.db.auditLogs.length,restoredAuditCount);
 activateSavedPublication(f.db,scope,p.id,{version:p.version,confirmed:true});assert.notEqual(p.slug,oldSlug);assert.throws(()=>authenticateApi(f.db,api.token),/已撤销|无效/);
 assert.deepEqual({accounts:f.db.powerAccounts,ledger:f.db.powerLedger,runs:f.db.publicRuns,sessions:f.db.publicSessions},records);assert.equal(f.db.publications!.length,1);
});

test('private drafts restore as private and deletion rejects running visitors before touching any record',()=>{
 const f=fixture(),draft=publish(f.db,scope,{...f.input,intent:'draft'}),originalSlug=draft.slug;
 deletePublication(f.db,scope,draft.id,{version:draft.version,confirmed:true});restorePublication(f.db,scope,draft.id,{version:draft.version,confirmed:true});assert.equal(draft.status,'draft');assert.equal(draft.slug,originalSlug);assert.throws(()=>activePublication(f.db,draft.id),/关闭或到期/);
 const active=publish(f.db,scope,f.input),g=createGuest(f.db,active.id),run=beginPublicRun(f.db,active,g.session,{content:'waiting',operationId:'running_visitor_question',attachmentIds:[]}).run;
 const before=structuredClone(active);assert.throws(()=>deletePublication(f.db,scope,active.id,{version:active.version,confirmed:true}),fails('PUBLICATION_BUSY'));assert.deepEqual(active,before);
 closePublication(f.db,scope,active.id,{version:active.version,confirmed:true});assert.equal(active.status,'closed','privacy withdrawal remains available during a visitor question');assert.equal(run.status,'running','close does not fabricate a terminal tool/model result');
 assert.throws(()=>deletePublication(f.db,scope,active.id,{version:active.version,confirmed:true}),fails('PUBLICATION_BUSY'));
 run.status='interrupted';deletePublication(f.db,scope,active.id,{version:active.version,confirmed:true});assert.ok(active.deletedAt);
});

test('closing preserves issued service rights; deleting cannot silently cancel codes/entitlements and reopening reuses their snapshots',()=>{
 const f=fixture(),p=publish(f.db,scope,{...f.input,sourceIds:[],serviceBusiness:{access:'entitlement',plans:[{name:'30-day service',kind:'monthly',quota:.5,priceCny:99,validDays:30,status:'active'}],intakeFields:[]}});
 const plan=p.serviceBusiness!.plans[0],issued=issueServiceCode(f.db,scope,p,{planId:plan.id,source:'gift',expiresDays:2,confirmed:true}),unredeemed=issueServiceCode(f.db,scope,p,{planId:plan.id,source:'gift',expiresDays:2,confirmed:true});
 const identity={userId:'visitor',workspaceId:'visitor-ws'},session=createGuest(f.db,p.id,identity);redeemServiceCode(f.db,p,session.session,issued.code);const promises=structuredClone(p.serviceBusiness);
 assert.throws(()=>deletePublication(f.db,scope,p.id,{version:p.version,confirmed:true}),fails('PUBLICATION_SERVICE_COMMITMENT'));
 closePublication(f.db,scope,p.id,{version:p.version,confirmed:true});assert.equal(p.status,'closed');assert.deepEqual(p.serviceBusiness,promises);
 assert.throws(()=>deletePublication(f.db,scope,p.id,{version:p.version,confirmed:true}),fails('PUBLICATION_SERVICE_COMMITMENT'));
 activateSavedPublication(f.db,scope,p.id,{version:p.version,confirmed:true});assert.deepEqual(p.serviceBusiness,promises);
 const fresh=createGuest(f.db,p.id,identity),run=beginPublicRun(f.db,p,fresh.session,{content:'use old account allowance',operationId:'existing_entitlement_use',attachmentIds:[]}).run;assert.equal(run.serviceEntitlement!.id,promises!.entitlements[0].id);run.status='completed';
 const second=redeemServiceCode(f.db,p,fresh.session,unredeemed.code);assert.ok(second.id);
 for(const code of p.serviceBusiness!.codes)revokeServiceGrant(f.db,scope,p,code.id);
 deletePublication(f.db,scope,p.id,{version:p.version,confirmed:true});assert.ok(p.deletedAt);assert.equal(p.serviceBusiness!.codes.length,2);assert.equal(p.serviceBusiness!.entitlements.length,2);
});

test('HTTP lifecycle filters owner trash/search, protects confirmation/version and never exposes private config across scopes',async t=>{
 const f=fixture(),api=await http(t,f),p=publish(f.db,scope,f.input),slug=p.slug,current=()=>f.db.publications!.find(item=>item.id===p.id)!;
 const invalidScopes:Record<string,string>[]=[{'x-user':'other'},{'x-workspace':'other-ws'},{'x-user':'other','x-workspace':'other-ws'}];
 for(const headers of invalidScopes)for(const action of ['close','delete','restore','publish'])assert.equal((await api.post(`/manage/${p.id}/${action}`,{version:current().version,confirmed:true},headers)).status,404);
 assert.equal((await api.post(`/manage/${p.id}/delete`,{version:current().version,confirmed:true},{'x-key':''})).status,428);
 assert.equal((await api.post(`/manage/${p.id}/delete`,{version:current().version,confirmed:false})).status,400);
 assert.equal((await api.post(`/manage/${p.id}/close`,{version:999,confirmed:true})).status,409);
 const closed=await api.post(`/manage/${p.id}/close`,{version:current().version,confirmed:true});assert.equal(closed.status,200);const closedReceipt=await closed.json();assert.equal(closedReceipt.status,'closed');assert.equal(closedReceipt.version,current().version);
 const config=await(await api.get(`/manage/${p.id}/config`)).json();assert.equal(config.days,60);assert.equal(config.status,'closed');
 const update=await api.post(`/manage/${p.id}/update`,{...config,prompt:'LATEST_PRIVATE_METHOD',confirmed:true,intent:'draft'});assert.equal(update.status,200);const updateReceipt=await update.json();assert.equal(updateReceipt.status,'closed');assert.equal(updateReceipt.slug,undefined);assert.equal((await api.get('/'+slug)).status,410);
 const removal=await api.post(`/manage/${p.id}/delete`,{version:current().version,confirmed:true});assert.equal(removal.status,200);const removed=await removal.json();assert.ok(removed.deletedAt);
 const normal=await(await api.get('/manage')).json();assert.equal(normal.items.length,0);assert.equal(normal.trashTotal,1);
 const trash=await(await api.get('/manage?trash=1&q=lifecycle')).json();assert.equal(trash.items[0].id,p.id);assert.ok(trash.items[0].deletedAt);assert.equal(trash.items[0].slug,undefined);assert.doesNotMatch(JSON.stringify(trash),/LATEST_PRIVATE_METHOD|PRIVATE_SOURCE|FOREIGN_SECRET|tokenHash/);
 assert.equal((await(await api.get('/manage?trash=1&q=missing')).json()).total,0);assert.equal((await api.get('/manage?trash=2')).status,400);assert.equal((await api.get(`/manage/${p.id}/config`)).status,404);assert.equal((await api.post(`/manage/${p.id}/publish`,{version:current().version,confirmed:true})).status,404);assert.equal((await api.post(`/manage/${p.id}/update`,{...config,version:current().version,confirmed:true})).status,404);
 for(const headers of invalidScopes){assert.equal((await api.post(`/manage/${p.id}/restore`,{version:current().version,confirmed:true},headers)).status,404);const foreign=await api.get('/manage?trash=1',headers);if(foreign.status===200)assert.equal((await foreign.json()).total,0);else assert.doesNotMatch(await foreign.text(),/PRIVATE_METHOD|PRIVATE_SOURCE|Lifecycle fixture/);}
 const usage=await api.get(`/manage/${p.id}/usage`);assert.equal(usage.status,200);assert.doesNotMatch(await usage.text(),/LATEST_PRIVATE_METHOD|PRIVATE_SOURCE/);
 const restored=await api.post(`/manage/${p.id}/restore`,{version:current().version,confirmed:true});assert.equal(restored.status,200);assert.equal((await restored.json()).status,'closed');assert.equal((await api.get('/'+slug)).status,410);
 const opened=await api.post(`/manage/${p.id}/publish`,{version:current().version,confirmed:true});assert.equal(opened.status,200);const receipt=await opened.json();assert.equal(receipt.status,'active');assert.notEqual(receipt.slug,slug);assert.equal((await api.get('/'+slug)).status,404);assert.equal((await api.get('/'+receipt.slug)).status,200);
 assert.equal(f.db.modelUsageRecords.length,0);assert.equal(f.db.publicRuns!.length,0);
});

test('deleted/reopened lifecycle and revoked original API survive actual JSON-store process restarts without charging or auto-publishing',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-avatar-lifecycle-restart-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const env={...process.env,DB_PROVIDER:'json',ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:'synthetic-lifecycle-password',YYLX_API_KEY:'',NODE_ENV:'test'},run=promisify(execFile);
 const evaluate=async(code:string)=>JSON.parse((await run(process.execPath,['--import','tsx','--input-type=module','-e',code],{env})).stdout);
 const created=await evaluate(`const {store}=await import('./server/db.ts');const {publish,deletePublication}=await import('./server/publicSharing.ts');const {issueApiGrant}=await import('./server/publicApi.ts');const {encryptCredential}=await import('./server/knowledge/credentialCipher.ts');console.log(JSON.stringify(await store.mutate(db=>{db.models.push({id:'lifecycle-model',enabled:true,kind:'chat',apiKey:'FIXTURE_ONLY',encryptedApiKey:encryptCredential('FIXTURE_ONLY'),systemPrompt:''});const u=db.users[0],s={workspaceId:u.defaultWorkspaceId,userId:u.id},p=publish(db,s,{name:'Restart fixture',description:'',prompt:'PRIVATE_METHOD',modelId:'lifecycle-model',sourceIds:[],attachments:false,budget:1,perRun:.1,days:14,confirmed:true}),api=issueApiGrant(db,s,p.id,{name:'old',version:p.version,budget:.1,perRun:.1,days:1,confirmed:true});const oldSlug=p.slug;deletePublication(db,s,p.id,{version:p.version,confirmed:true});return {id:p.id,oldSlug,token:api.token,version:p.version,deletedAt:p.deletedAt};})));`);
 const restored=await evaluate(`const {store}=await import('./server/db.ts');const {restorePublication,activateSavedPublication}=await import('./server/publicSharing.ts');console.log(JSON.stringify(await store.mutate(db=>{const p=db.publications.find(x=>x.id===${JSON.stringify(created.id)}),u=db.users[0],s={workspaceId:u.defaultWorkspaceId,userId:u.id};const before={deletedAt:p.deletedAt,status:p.status,version:p.version};restorePublication(db,s,p.id,{version:p.version,confirmed:true});const restoredStatus=p.status;activateSavedPublication(db,s,p.id,{version:p.version,confirmed:true});return {before,restoredStatus,slug:p.slug,version:p.version,revoked:p.apiGrants[0].status,calls:db.modelUsageRecords.length,runs:db.publicRuns.length};})));`);
 assert.equal(restored.before.deletedAt,created.deletedAt);assert.equal(restored.before.status,'closed');assert.equal(restored.restoredStatus,'closed');assert.notEqual(restored.slug,created.oldSlug);assert.equal(restored.revoked,'revoked');assert.equal(restored.calls,0);assert.equal(restored.runs,0);
 const final=await evaluate(`const {store}=await import('./server/db.ts');const {authenticateApi}=await import('./server/publicApi.ts');const d=await store.read(),p=d.publications.find(x=>x.id===${JSON.stringify(created.id)});let denied=false;try{authenticateApi(d,${JSON.stringify(created.token)});}catch{denied=true;}console.log(JSON.stringify({slug:p.slug,status:p.status,deletedAt:p.deletedAt,version:p.version,denied,calls:d.modelUsageRecords.length,runs:d.publicRuns.length}));`);
 assert.equal(final.slug,restored.slug);assert.equal(final.version,restored.version);assert.equal(final.status,'active');assert.equal(final.deletedAt,undefined);assert.equal(final.denied,true);assert.equal(final.calls,0);assert.equal(final.runs,0);
});
