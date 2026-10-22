import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type {Store} from './db.js';
import type {Database} from './types.js';
import {AttentionService} from './attention.js';
import {installAttentionRoutes} from './attentionRoutes.js';
import {publicUser} from './serializers.js';
const a={workspaceId:'wa',userId:'a'},b={workspaceId:'wb',userId:'b'};
function fixture(){
  let now=Date.parse('2026-10-18T02:00:00Z'),calls=0,proofs=0,online=true,content='PRIVATE_NOTE_BODY',fail=false;
  const db={users:[{id:'a',enabled:true},{id:'b',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a',role:'owner'},{workspaceId:'wb',userId:'b',role:'owner'}],knowledgeConnections:[{id:'ka',workspaceId:'wa',provider:'getnote',status:'connected',clientId:'ca',encryptedApiKey:'private-a'},{id:'kb',workspaceId:'wb',provider:'getnote',status:'connected',clientId:'cb',encryptedApiKey:'private-b'}]} as unknown as Database;
  const store:Store={read:async()=>db,mutate:async fn=>{const saved=structuredClone(db);try{return fn(db);}catch(e){Object.assign(db,saved);throw e;}}};
  const knowledge={recallWithDiagnostics:async(w:string,_q:string,_k:number,ids?:readonly string[],userId?:string)=>{calls++;assert.equal(w,'wa');assert.deepEqual(ids,['ka']);assert.equal(userId,'a');return {status:fail?'failed' as const:'used' as const,chunks:fail?[]:[{id:'note',title:'工作记录',content}],failures:[]};}};
  const deps={now:()=>now,connected:()=>online,verify:async()=>{proofs++;if(!online)throw Error('Key missing');}};
  const service=new AttentionService(store,knowledge,deps);
  const config={revision:0,enabled:true,sourceIds:['ka'],topics:['会议待办'],intervalHours:1,dailyLimit:4,quietStart:22,quietEnd:8,timeZone:'Asia/Shanghai'};
  return {db,store,service,knowledge,deps,config,get calls(){return calls;},get proofs(){return proofs;},advance:(n=3600000)=>now+=n,setContent:(s:string)=>content=s,setFail:(v:boolean)=>fail=v,setOnline:(v:boolean)=>online=v};
}
test('attention is opt-in, bounded, baselined, durable, deduplicated and stores no knowledge body',async()=>{
  const f=fixture();await f.service.tick();assert.equal(f.calls,0);
  await f.service.configure(a,f.config,{deviceId:'da',installationId:'ia'});assert.equal((await f.service.view(a)).settings?.lastStatus,'queued');await f.service.check(a);
  assert.equal(f.calls,1);assert.equal((await f.service.view(a)).notices.length,0);assert.equal((await f.service.view(a)).settings?.lastStatus,'baseline');
  assert.doesNotMatch(JSON.stringify(f.db.users),/PRIVATE_NOTE_BODY|工作记录/);
  f.advance();f.setContent('NEW_PRIVATE_BODY');await f.service.check(a);
  let view=await f.service.view(a);assert.equal(view.notices.length,1);assert.equal(view.settings?.checksToday,2);assert.doesNotMatch(JSON.stringify(view),/encrypted|private-a|lease|sourceBindings|seen/);
  const restarted=new AttentionService(f.store,f.knowledge,f.deps);f.advance();await restarted.check(a);assert.equal((await restarted.view(a)).notices.length,1);
  await restarted.acknowledge(a,view.notices[0].id,'read');f.advance();await restarted.check(a);assert.equal((await restarted.view(a)).notices.length,0,'the same content cannot reappear after reading');
  f.advance();f.setContent('new again');await restarted.check(a,true);assert.equal(f.calls,4,'manual checking does not bypass the daily quota');
  assert.equal((await restarted.view(a)).settings?.lastStatus,'daily_limit');
  assert.equal('attentionStates' in publicUser(f.db.users[0]),false);
});
test('offline Key, quiet hours, source revocation and another workspace never read or expose private updates',async()=>{
  const f=fixture();await f.service.configure(a,f.config,{deviceId:'da',installationId:'ia'});
  f.setOnline(false);await f.service.check(a);assert.equal(f.calls,0);f.setOnline(true);f.advance();await f.service.check(a);
  f.advance();f.setContent('change');await f.service.check(a);const notice=(await f.service.view(a)).notices[0];assert.ok(notice);
  assert.equal((await f.service.view(b)).notices.length,0);await assert.rejects(f.service.acknowledge(b,notice.id,'read'));
  await assert.rejects(f.service.configure(b,{...f.config,sourceIds:['ka']},{deviceId:'db',installationId:'ib'}));
  f.db.knowledgeConnections[0].status='revoked';assert.equal((await f.service.view(a)).notices.length,0);f.advance();const before=f.calls;await f.service.check(a);assert.equal(f.calls,before);
  const q=fixture();q.advance(12*3600000);await q.service.configure(a,q.config,{deviceId:'da',installationId:'ia'});await q.service.check(a);assert.equal(q.calls,0);assert.equal((await q.service.view(a)).settings?.lastStatus,'quiet');
});
test('failed reads do not advance fingerprints; pausing and revoked permissions discard late results',async()=>{
  const f=fixture();await f.service.configure(a,f.config,{deviceId:'da',installationId:'ia'});await f.service.check(a);f.advance();f.setContent('changed');f.setFail(true);await f.service.check(a);assert.equal((await f.service.view(a)).settings?.lastStatus,'failed');assert.equal((await f.service.view(a)).notices.length,0);
  f.advance();f.setFail(false);await f.service.check(a);assert.equal((await f.service.view(a)).notices.length,1);
  const g=fixture();await g.service.configure(a,g.config,{deviceId:'da',installationId:'ia'});await g.service.check(a);g.advance();
  let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  g.knowledge.recallWithDiagnostics=async()=>{entered();await wait;return {status:'used',chunks:[{id:'n',title:'t',content:'late'}],failures:[]};};
  const running=g.service.check(a);await ready;await g.service.configure(a,{enabled:false,revision:1},{deviceId:'da',installationId:'ia'});release();await running;assert.equal((await g.service.view(a)).notices.length,0);assert.equal(g.db.users[0].attentionStates![0].enabled,false);
});
test('parallel ticks claim one lease and snooze/read-all are private and durable',async()=>{
  const f=fixture();await f.service.configure(a,f.config,{deviceId:'da',installationId:'ia'});await Promise.all([f.service.check(a),f.service.check(a)]);assert.equal(f.calls,1);
  f.advance();f.setContent('new');await f.service.check(a);const n=(await f.service.view(a)).notices[0];await f.service.acknowledge(a,n.id,'snooze');assert.equal((await f.service.view(a)).notices.length,0);f.advance(86400000);assert.equal((await f.service.view(a)).notices.length,1);await f.service.acknowledge(a,'all','all');assert.equal((await f.service.view(a)).notices.length,0);
});

test('legacy wrapper fingerprints rebaseline silently once without losing real unread notices',async()=>{
 const f=fixture();await f.service.configure(a,f.config,{deviceId:'da',installationId:'ia'});await f.service.check(a);
 f.advance();f.setContent('real change');await f.service.check(a);
 const notice=(await f.service.view(a)).notices[0];assert.ok(notice);
 const old=f.db.users[0].attentionStates![0];delete old.fingerprintVersion;
 f.advance();f.setContent('same note returned without retrieval wrapper');await f.service.check(a);
 let view=await f.service.view(a);assert.equal(view.settings?.lastStatus,'baseline');assert.equal(view.notices.length,1);assert.equal(view.notices[0].createdAt,notice.createdAt);
 f.advance();await f.service.check(a);view=await f.service.view(a);assert.equal(view.settings?.lastStatus,'checked');assert.equal(view.notices[0].createdAt,notice.createdAt);
 assert.equal(old.fingerprintVersion,1);assert.equal('fingerprintVersion' in view.settings!,false);
});
test('a changed credential discards a late source response and a hanging connector has a bounded failed outcome',async()=>{
  const f=fixture();await f.service.configure(a,f.config,{deviceId:'da',installationId:'ia'});await f.service.check(a);f.advance();
  let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  f.knowledge.recallWithDiagnostics=async()=>{entered();await wait;return {status:'used',chunks:[{id:'late',title:'private',content:'PRIVATE_LATE_RESPONSE'}],failures:[]};};
  const running=f.service.check(a);await ready;f.db.knowledgeConnections[0].encryptedApiKey='rotated';release();await running;assert.equal((await f.service.view(a)).notices.length,0);assert.doesNotMatch(JSON.stringify(f.db.users),/PRIVATE_LATE_RESPONSE/);
  const g=fixture();await g.service.configure(a,g.config,{deviceId:'da',installationId:'ia'});
  const bounded=new AttentionService(g.store,{recallWithDiagnostics:()=>new Promise(()=>{})},{...g.deps,readTimeoutMs:2});await bounded.check(a);assert.equal((await bounded.view(a)).settings?.lastStatus,'failed');
});
test('context and attention HTTP routes authorize the server scope and never disclose configuration in general user APIs',async t=>{
  const f=fixture(),app=express();app.use(express.json());
  const auth:express.RequestHandler=(req,_res,next)=>{req.user=f.db.users.find(u=>u.id===(req.headers['x-user']??'a'))!;req.workspaceId=req.user.id==='a'?'wa':'wb';req.oneKeyDeviceId='device';req.oneKeyInstallationId='install';next();};
  installAttentionRoutes(app,[auth],f.store,f.service,async()=>{});app.use((err:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1');t.after(()=>server.close());await new Promise<void>(r=>server.once('listening',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=(path:string,body:unknown,user='a')=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-user':user},body:JSON.stringify(body)});
  assert.equal((await post('/api/me/context-preferences',{workspaceId:'wb',timeZone:'Asia/Shanghai',city:'杭州'})).status,200);
  assert.equal((await(await fetch(url+'/api/me/context-preferences',{headers:{'x-user':'b'}})).json()).saved,null);
  assert.equal((await post('/api/me/context-preferences',{timeZone:'invalid',city:'x'})).status,400);
  assert.equal((await post('/api/attention/settings',{...f.config,sourceIds:['kb'],workspaceId:'wb'})).status,400);
  assert.equal((await post('/api/attention/settings',f.config)).status,200);
  const result=await(await fetch(url+'/api/attention')).json();assert.doesNotMatch(JSON.stringify(result),/private-a|private-b|deviceId|installationId|seen/);
  assert.equal('contextPreferences' in publicUser(f.db.users[0]),false);
});
