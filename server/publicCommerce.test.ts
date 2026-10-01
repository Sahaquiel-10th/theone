import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import type {Database,ModelConfig} from './types.js';
import type {Store} from './db.js';
import {registerVisitor,loginVisitor} from './visitorAccounts.js';
import {installVisitorRoutes,visitorIdentity} from './visitorRoutes.js';
import {publish,createGuest,beginPublicRun,checkRunBudget,publicRun} from './publicSharing.js';
import {issueApiGrant,authenticateApi,checkApiBudget} from './publicApi.js';
import {installPublicApiRoutes} from './publicApiRoutes.js';
import {grantSponsorship} from './publicCommerce.js';
import {creditPower} from './powerBilling.js';
import {runBilledModel,reconcileInterruptedBilling,resolveBillingReview,settleBillingRecord,modelReservationMicros} from './modelBilling.js';
import {publicUsageRecord} from './serializers.js';
import {executePublicQuestion,installPublicSharingRoutes} from './publicSharingRoutes.js';
import {installPublicCommerceRoutes} from './publicCommerceRoutes.js';
import {auth} from './middleware.js';
import {AttachmentService} from './attachmentService.js';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fixture(){
  const model={id:'model',name:'Fixture',apiKey:'fixture-not-real',enabled:true,kind:'chat',systemPrompt:'',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig;
  let db={users:[],workspaces:[],workspaceMembers:[],powerAccounts:[],powerLedger:[],rechargeOrders:[],auditLogs:[],models:[model],settings:{safetyRules:'safe',rechargeCnyPerPower:7,publicCommercePolicy:{revision:1,visitorPaymentsEnabled:true,publisherShareBps:7500}},publications:[],publicSessions:[],publicRuns:[],attachments:[],knowledgeConnections:[],messages:[],modelUsageRecords:[]} as unknown as Database;
  const owner=registerVisitor(db,{username:'owner',password:'owner-password'}),visitor=registerVisitor(db,{username:'visitor',password:'visitor-password'}),other=registerVisitor(db,{username:'other',password:'other-password'});
  const scope={userId:owner.id,workspaceId:owner.defaultWorkspaceId};
  creditPower(db,{...scope,amountMicros:100e6,type:'gift',title:'Fixture'});
  creditPower(db,{userId:visitor.id,workspaceId:visitor.defaultWorkspaceId,amountMicros:100e6,type:'recharge',title:'Fixture'});
  let queue=Promise.resolve<unknown>(undefined);
  const store:Store={read:async()=>db,mutate:<T>(fn:(d:Database)=>T)=>{const next=queue.then(()=>{const old=structuredClone(db);try{return fn(db);}catch(e){db=old;throw e;}});queue=next.catch(()=>undefined);return next;}};
  const input={name:'Fixture',description:'',prompt:'Answer only',modelId:'model',sourceIds:[],attachments:true,budget:10,perRun:1,days:7,confirmed:true};
  return {get db(){return db;},store,owner,visitor,other,scope,model,input};
}
const question=(id:string)=>({content:'Question',operationId:id.padEnd(16,'_'),attachmentIds:[],confirmedPayment:true,confirmedPriceVersion:1});
const recall={recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'not_connected' as const})};

test('visitor accounts have private workspace binding, no registration gift and hashed passwords',()=>{
  const f=fixture();assert.equal(loginVisitor(f.db,{username:'VISITOR',password:'visitor-password'}).id,f.visitor.id);
  assert.doesNotMatch(JSON.stringify(f.db.users),/visitor-password/);
  assert.throws(()=>loginVisitor(f.db,{username:'visitor',password:'wrong'}),/错误/);
  assert.throws(()=>registerVisitor(f.db,{username:'Visitor',password:'other-password'}),/使用/);
  assert.equal(f.db.powerAccounts.find(a=>a.userId===f.other.id)!.balanceMicros,0);
  f.visitor.defaultWorkspaceId=f.owner.defaultWorkspaceId;
  assert.throws(()=>loginVisitor(f.db,{username:'visitor',password:'visitor-password'}),/不可用/);
});

test('real visitor HTTP cookies are independent, account switches fail closed, password revokes prior sessions',async t=>{
  const f=fixture(),app=express();app.use(express.json());installVisitorRoutes(app,f.store,'fixture-secret');
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}/api/visitors`;
  const response=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'visitor',password:'visitor-password'})});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie')!;assert.match(cookie,/one_visitor=.*HttpOnly; SameSite=Strict; Path=\/api/);assert.doesNotMatch(cookie,/one_session/);
  assert.equal((await fetch(base+'/me')).status,401);
  assert.equal((await fetch(base+'/me',{headers:{Cookie:cookie,'X-ONE-Visitor':f.owner.id}})).status,409);
  const me=await(await fetch(base+'/me',{headers:{Cookie:cookie}})).json();assert.equal(me.user.id,f.visitor.id);assert.doesNotMatch(JSON.stringify(me),/passwordHash|workspaceId/);
  const changed=await fetch(base+'/password',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({currentPassword:'visitor-password',newPassword:'new-visitor-password'})});assert.equal(changed.status,200);
  assert.equal((await fetch(base+'/me',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(base+'/me',{headers:{Cookie:changed.headers.get('set-cookie')!}})).status,200);
  assert.equal(visitorIdentity(f.db,{headers:{cookie:cookie.replace('one_visitor=','one_session=')}} as any,'fixture-secret'),undefined);
});

test('API hash, ownership, version, independent requests and reservation quota are enforced',async()=>{
  const f=fixture(),p=publish(f.db,f.scope,f.input);
  assert.throws(()=>issueApiGrant(f.db,{userId:f.other.id,workspaceId:f.other.defaultWorkspaceId},p.id,{name:'test',version:1,budget:1,perRun:1,days:1,confirmed:true}),/不存在/);
  const issued=issueApiGrant(f.db,f.scope,p.id,{name:'test',version:1,budget:1,perRun:.5,days:1,confirmed:true});
  assert.doesNotMatch(JSON.stringify(f.db),new RegExp(issued.token));assert.equal(issued.grant.version,1);
  const a=authenticateApi(f.db,issued.token),r=beginPublicRun(f.db,p,a.session,question('api-one')).run;
  await executePublicQuestion(f.store,recall as any,r.id,async()=>({content:'HISTORY_PRIVATE',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2,source:'provider'}}));
  const r2=beginPublicRun(f.db,p,a.session,question('api-two')).run;
  await executePublicQuestion(f.store,recall as any,r2.id,async(_m,messages)=>{assert.doesNotMatch(JSON.stringify(messages),/HISTORY_PRIVATE/);return {content:'Answer',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2,source:'provider'}};});
  assert.equal(beginPublicRun(f.db,p,a.session,question('api-two')).created,false);
  assert.throws(()=>checkApiBudget(f.db,p,p.apiGrants![0],r2.id,500000),/额度/);
  publish(f.db,f.scope,{...f.input,version:1},p.id);assert.throws(()=>authenticateApi(f.db,issued.token),/更新/);
  p.apiGrants![0].status='revoked';assert.throws(()=>authenticateApi(f.db,issued.token),/撤销/);
});

test('real API routes require owner Key, isolate keys and cancel without resurrecting or double charging',async t=>{
  const f=fixture(),p=publish(f.db,f.scope,f.input),app=express();app.use(express.json());let calls=0,release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  installPublicApiRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}req.user=f.owner;req.workspaceId=f.scope.workspaceId;next();}],f.store,recall as any,async()=>{calls++;entered();await waiting;return {content:'done',finishReason:'stop',usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}};});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{release();server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const manage=`/api/sharing-api/manage/${p.id}/keys`,payload={name:'one',version:1,budget:1,perRun:1,days:1,confirmed:true};
  assert.equal((await fetch(base+manage)).status,428);
  const issued=await(await fetch(base+manage,{method:'POST',headers:{'x-key':'present','Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
  const h={Authorization:`Bearer ${issued.token}`,'Content-Type':'application/json'},body=JSON.stringify({question:'Question',operationId:'http-api-operation',workspaceId:f.other.defaultWorkspaceId,tools:['run_command']});
  const receipt=await(await fetch(base+'/api/v1/tasks',{method:'POST',headers:h,body})).json();await started;
  const second=issueApiGrant(f.db,f.scope,p.id,{...payload,name:'two'});
  assert.equal((await fetch(base+`/api/v1/tasks/${receipt.task.id}`,{headers:{Authorization:`Bearer ${second.token}`}})).status,404);
  assert.equal((await fetch(base+'/api/v1/tasks',{method:'POST',headers:h,body})).status,200);assert.equal(calls,1);
  assert.equal((await fetch(base+`/api/v1/tasks/${receipt.task.id}/cancel`,{method:'POST',headers:h})).status,200);release();
  for(let i=0;i<100&&!f.db.modelUsageRecords[0]?.completedAt;i++)await new Promise(r=>setTimeout(r,10));
  const result=await(await fetch(base+`/api/v1/tasks/${receipt.task.id}`,{headers:h})).json();assert.equal(result.task.status,'failed');assert.equal(result.task.response,undefined);assert.equal(f.db.powerLedger.filter(l=>l.type==='usage').length,1);
  assert.equal((await fetch(base+manage+`/${issued.grant.id}/revoke`,{method:'POST',headers:{'x-key':'present'}})).status,200);
  assert.equal((await fetch(base+`/api/v1/tasks/${receipt.task.id}`,{headers:h})).status,401);
});

async function billed(f:ReturnType<typeof fixture>,multiplier:number,bonus=0,unknown=false){
  if(bonus)creditPower(f.db,{workspaceId:f.visitor.defaultWorkspaceId,userId:f.visitor.id,amountMicros:bonus,type:'gift',title:'Fixture bonus'});
  const p=publish(f.db,f.scope,{...f.input,visitorPercent:multiplier*100}),a=createGuest(f.db,p.id,{userId:f.visitor.id,workspaceId:f.visitor.defaultWorkspaceId});
  assert.throws(()=>beginPublicRun(f.db,p,a.session,{...question('paid-question'),confirmedPayment:false}),/确认/);
  const r=beginPublicRun(f.db,p,a.session,question('paid-question')).run;
  await runBilledModel(f.store,{...f.scope,conversationId:r.id,model:f.model,input:'question',activity:'public_answer',requestId:r.id,commerce:r.commerce,beforeReserve:(db,n)=>checkRunBudget(db,r.id,n)},async()=>({usage:unknown?undefined:{inputTokens:1000,outputTokens:0,totalTokens:1000,source:'provider'}}));
  return {p,r,row:f.db.modelUsageRecords[0]};
}
test('visitor pays actual multiplier; only consumed recharge markup creates split revenue, never充值 or gifts',async()=>{
  const f=fixture(),{r,row}=await billed(f,1.2);assert.equal(row.chargedMicros,1000);assert.equal(row.commercial!.payerChargedMicros,1200);assert.equal(row.commercial!.publisherRevenueMicros,150);assert.equal(row.commercial!.platformRevenueMicros,50);
  assert.equal(f.db.powerAccounts.find(a=>a.userId===f.owner.id)!.balanceMicros,100e6);
  assert.equal(publicUsageRecord(row).chargedMicros,0);assert.equal(publicRun(r,f.db).chargedMicros,1200);
  settleBillingRecord(f.db,{workspaceId:f.scope.workspaceId,userId:f.owner.id,usageId:row.id},{inputTokens:1000,outputTokens:0,totalTokens:1000,source:'provider'},1);assert.equal(f.db.powerLedger.filter(l=>l.type==='usage').length,1);
  const gifted=fixture(),g=await billed(gifted,1.2,1200);assert.equal(g.row.commercial!.publisherRevenueMicros,0);assert.equal(g.row.commercial!.bonusMicros,1200);
  const mixed=fixture(),m=await billed(mixed,1.2,600);assert.equal(m.row.commercial!.paidPrincipalMicros,600);assert.equal(m.row.commercial!.publisherRevenueMicros,75);
});
test('subsidies reserve and charge the exact owner share; unknown usage restores both holds once',async()=>{
  const f=fixture(),{row}=await billed(f,.8);assert.equal(row.commercial!.payerChargedMicros,800);assert.equal(row.commercial!.publisherChargedMicros,200);assert.equal(publicUsageRecord(row).chargedMicros,200);assert.equal(row.commercial!.publisherRevenueMicros,0);
  const u=fixture(),unknown=await billed(u,.8,0,true),c=unknown.row.commercial!;assert.equal(unknown.row.status,'needs_review');assert.ok(c.payerReservedMicros>0&&c.publisherReservedMicros>0);
  const before=u.db.powerAccounts.map(a=>a.reservedMicros);reconcileInterruptedBilling(u.db);assert.deepEqual(u.db.powerAccounts.map(a=>a.reservedMicros),before);reconcileInterruptedBilling(u.db);assert.deepEqual(u.db.powerAccounts.map(a=>a.reservedMicros),before);
  assert.throws(()=>resolveBillingReview(u.db,{workspaceId:u.other.defaultWorkspaceId,userId:u.other.id,usageId:unknown.row.id,action:'waive'}),/不属于/);
  resolveBillingReview(u.db,{...u.scope,usageId:unknown.row.id,action:'waive'});assert.equal(c.status,'released');assert.ok(u.db.powerAccounts.every(a=>a.reservedMicros===0));
});
test('named owner sponsorship enforces visitor identity, expiry, revocation and explicit paid consent',()=>{
  const f=fixture(),p=publish(f.db,f.scope,{...f.input,visitorPercent:120,allowedUsernames:['visitor']});
  assert.throws(()=>createGuest(f.db,p.id),/登录/);assert.throws(()=>createGuest(f.db,p.id,{userId:f.other.id,workspaceId:f.other.defaultWorkspaceId}),/开放/);
  grantSponsorship(f.db,f.scope,p.id,{username:'visitor',budget:.01,confirmed:true});const gift=p.sponsorships![0],a=createGuest(f.db,p.id,{userId:f.visitor.id,workspaceId:f.visitor.defaultWorkspaceId}),r=beginPublicRun(f.db,p,a.session,question('sponsored')).run;
  assert.equal(r.commerce!.multiplier,0);assert.throws(()=>checkRunBudget(f.db,r.id,10001),/赠送/);
  gift.status='revoked';assert.throws(()=>checkRunBudget(f.db,r.id,1),/撤销/);gift.status='active';a.session.expiresAt=new Date(0).toISOString();assert.throws(()=>checkRunBudget(f.db,r.id,1),/停止/);
});

test('simultaneous paid runs cannot spend the same visitor balance; provider failure releases dual holds without income',async()=>{
  const f=fixture(),p=publish(f.db,f.scope,{...f.input,visitorPercent:80}),identity={userId:f.visitor.id,workspaceId:f.visitor.defaultWorkspaceId};
  const a=createGuest(f.db,p.id,identity),b=createGuest(f.db,p.id,identity),r1=beginPublicRun(f.db,p,a.session,question('concurrent-one')).run,r2=beginPublicRun(f.db,p,b.session,question('concurrent-two')).run;
  const held=Math.ceil(modelReservationMicros(f.model,'question')*.8-1e-7),account=f.db.powerAccounts.find(a=>a.userId===f.visitor.id)!;account.balanceMicros=held;account.paidBalanceMicros=held;
  let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const params=(r:typeof r1)=>({...f.scope,conversationId:r.id,model:f.model,input:'question',activity:'public_answer',requestId:r.id,commerce:r.commerce,beforeReserve:(db:Database,n:number)=>checkRunBudget(db,r.id,n)});
  const first=runBilledModel(f.store,params(r1),async()=>{entered();await wait;throw Error('fixture failure');});await started;
  await assert.rejects(runBilledModel(f.store,params(r2),async()=>assert.fail('second call must not start')),/电力不足/);release();await assert.rejects(first,/fixture failure/);
  assert.ok(f.db.powerAccounts.every(a=>a.reservedMicros===0));assert.equal(f.db.modelUsageRecords.length,1);assert.equal(f.db.modelUsageRecords[0].commercial!.status,'released');assert.equal(f.db.modelUsageRecords[0].commercial!.publisherRevenueMicros,undefined);assert.equal(f.db.powerLedger.filter(l=>l.type==='usage').length,0);
});

test('paid sharing HTTP binds logged-in visitor, rejects stolen sessions and never exposes questions in earnings',async t=>{
  const f=fixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let calls=0;
  const gateway=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;assert.equal(JSON.parse(body).tools,undefined);calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'PRIVATE_VISITOR_ANSWER'},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:0,total_tokens:1000}}));});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');t.after(()=>{gateway.closeAllConnections();gateway.close();});
  Object.assign(f.model,{protocol:'openai',model:'fixture',baseUrl:`http://127.0.0.1:${(gateway.address() as any).port}`});
  const app=express();app.use(express.json());const secret='fixture-secret';installVisitorRoutes(app,f.store,secret);
  const key:express.RequestHandler=(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}const u=req.headers['x-user']==='other'?f.other:f.owner;req.user=u;req.workspaceId=u.defaultWorkspaceId;next();};
  installPublicSharingRoutes(app,[key],f.store,recall as any,new AttachmentService(f.store,dir),secret);installPublicCommerceRoutes(app,[key],[key],f.store);
  app.get('/private',auth(secret,{store:f.store,oneKeyPresence:{requireProof:async()=>assert.fail('visitor token must never invoke Key proof'),runtimeStatus:async()=>assert.fail()}}),(_req,res)=>res.sendStatus(200));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const login=async(username:string,password:string)=>(await fetch(base+'/api/visitors/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).headers.get('set-cookie')!;
  const cookie=await login('visitor','visitor-password'),otherCookie=await login('other','other-password');const raw=cookie.split(';')[0].slice('one_visitor='.length);
  assert.equal((await fetch(base+'/private',{headers:{Authorization:`Bearer ${decodeURIComponent(raw)}`}})).status,401);
  const p=publish(f.db,f.scope,{...f.input,visitorPercent:120}),url=`/api/sharing/${p.slug}`;
  assert.equal((await fetch(base+url+'/sessions',{method:'POST'})).status,401);
  const token=(await(await fetch(base+url+'/sessions',{method:'POST',headers:{Cookie:cookie}})).json()).token;
  const h={Cookie:cookie,Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(base+url+'/session',{headers:{...h,Cookie:otherCookie}})).status,401);
  const payload={...question('paid-http-question'),content:'PRIVATE_VISITOR_QUESTION'};
  assert.equal((await fetch(base+url+'/questions',{method:'POST',headers:h,body:JSON.stringify({...payload,confirmedPayment:false})})).status,409);
  const receipt=await(await fetch(base+url+'/questions',{method:'POST',headers:h,body:JSON.stringify(payload)})).json();assert.ok(receipt.run.id);
  let answer:any;for(let i=0;i<100;i++){answer=await(await fetch(base+url+`/questions/${receipt.run.id}`,{headers:h})).json();if(answer.run.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(answer.run.status,'completed');assert.equal(answer.run.chargedMicros,1200);assert.equal(calls,1);
  const expenses=await(await fetch(base+'/api/visitors/billing/history?kind=usage',{headers:{Cookie:cookie}})).json();assert.equal(expenses.items[0].chargedMicros,1200);assert.doesNotMatch(JSON.stringify(expenses),/PRIVATE_VISITOR|workspaceId|publicationId/);
  assert.equal((await(await fetch(base+'/api/visitors/billing/history?kind=usage',{headers:{Cookie:otherCookie}})).json()).total,0);
  const earningsPath=`/api/sharing-commerce/manage/${p.id}/earnings`;
  assert.equal((await fetch(base+earningsPath)).status,428);assert.equal((await fetch(base+earningsPath,{headers:{'x-key':'present','x-user':'other'}})).status,404);
  const earnings=await(await fetch(base+earningsPath,{headers:{'x-key':'present'}})).text();assert.doesNotMatch(earnings,/PRIVATE_VISITOR|passwordHash|tokenHash/);assert.equal(JSON.parse(earnings).pendingRevenueMicros,150);
  f.db.settings.publicCommercePolicy!.visitorPaymentsEnabled=false;
  assert.equal((await fetch(base+url+'/questions',{method:'POST',headers:h,body:JSON.stringify({...payload,operationId:'policy-pause-question'})})).status,503);assert.equal(calls,1);
});
