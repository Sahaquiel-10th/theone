import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {productMetrics} from './productMetrics.js';
import {installProductMetricsRoutes} from './productMetricsRoutes.js';
import type {Database} from './types.js';
import type {Store} from './db.js';
const now=Date.parse('2026-10-01T12:00:00Z');
function fixture(){
 const users=['a','b','admin','test'].map(id=>({id,username:id,role:id==='admin'?'admin':'user',enabled:true,defaultWorkspaceId:'w'+id,createdAt:'2026-09-01T00:00:00Z',registrationOrigin:id==='a'?'visitor':undefined,analyticsExcluded:id==='test'}));
 return {users,workspaceMembers:users.map(u=>({userId:u.id,workspaceId:u.defaultWorkspaceId})),auditLogs:[],executionTasks:[],chatOperations:[],publications:[],publicSessions:[],publicRuns:[],rechargeOrders:[],powerAccounts:[],modelUsageRecords:[],messages:[{content:'PRIVATE CHAT'}],models:[{apiKey:'SECRET'}]} as unknown as Database;
}
test('metrics count successful bound activity, not logins/failures/admin/test/cross-workspace content',()=>{
 const db=fixture();
 for(const [id,user,workspace,action,at] of [['one','a','wa','chat.completed','2026-09-30T16:00:00Z'],['duplicate','a','wa','chat.completed','2026-09-30T16:00:00Z'],['foreign','b','wa','chat.completed','2026-10-01T00:00:00Z'],['login','b','wb','login.completed','2026-10-01T00:00:00Z'],['fail','b','wb','chat.failed','2026-10-01T00:00:00Z'],['admin','admin','wadmin','chat.completed','2026-10-01T00:00:00Z'],['test','test','wtest','chat.completed','2026-10-01T00:00:00Z']]) db.auditLogs.push({id,actorUserId:user,workspaceId:workspace,action,createdAt:at,requestId:id==='duplicate'?'one':id} as any);
 const m=productMetrics(db,now);assert.equal(m.summary.accounts,2);assert.equal(m.summary.dau,1);assert.equal(m.summary.activated,1);assert.equal(m.daily.at(-1)!.date,'2026-10-01');assert.equal(m.summary.lowBalance,1);assert.equal(m.summary.neverActivated,1);
 assert.doesNotMatch(JSON.stringify(m),/PRIVATE CHAT|SECRET/);assert.deepEqual(m.excludedUserIds,['test']);
});
test('public visitors belong to their account, not publisher; anonymous traffic is not registrations',()=>{
 const db=fixture();db.publications=[{id:'p',workspaceId:'wa'}] as any;
 db.publicSessions=[{id:'s',publicationId:'p',workspaceId:'wa',accountUserId:'b',accountWorkspaceId:'wb'},{id:'anon',publicationId:'p',workspaceId:'wa'}] as any;
 db.publicRuns=['s','anon'].map(sessionId=>({id:sessionId,status:'completed',publicationId:'p',workspaceId:'wa',sessionId,completedAt:'2026-10-01T00:00:00Z'})) as any;
 const m=productMetrics(db,now);assert.equal(m.summary.accounts,2);assert.equal(m.summary.dau,1);assert.equal(m.users.find(u=>u.id==='a')!.state,'never');assert.equal(m.users.find(u=>u.id==='b')!.state,'active');assert.equal(m.summary.anonymousQuestions30,1);
 db.publicSessions![0].accountWorkspaceId='wa';assert.equal(productMetrics(db,now).summary.dau,0);
});
test('retention requires a complete observation day; only settled verified recharge and actual charges count',()=>{
 const db=fixture();db.users[0].createdAt='2026-09-29T00:00:00Z';db.users[1].createdAt='2026-09-30T00:00:00Z';
 db.auditLogs=[{id:'d1',actorUserId:'a',workspaceId:'wa',action:'chat.completed',createdAt:'2026-09-30T00:00:00Z'}] as any;
 const order={userId:'a',workspaceId:'wa',amountCny:5,status:'paid',paidAt:'2026-09-30T00:00:00Z',payment:{state:'paid',transactionId:'verified'}};
 db.rechargeOrders=[{...order,id:'1'},{...order,id:'2'},{...order,id:'pending',payment:{state:'pending'}},{...order,id:'wrong',workspaceId:'wb'}] as any;
 db.modelUsageRecords=[{status:'success',userId:'a',workspaceId:'wa',completedAt:'2026-09-30T00:00:00Z',chargedMicros:12,costMicros:3}] as any;
 const m=productMetrics(db,now);assert.deepEqual(m.summary.d1,{eligible:1,retained:1,rate:1});assert.equal(m.summary.d7.rate,null);assert.equal(m.summary.rechargeCny30,10);assert.equal(m.summary.repeatPayers,1);assert.equal(m.summary.consumedMicros30,12);
});
test('admin metrics endpoints enforce Key/role, paginate, export aggregates and audit reversible exclusions',async t=>{
 const db=fixture();for(let i=0;i<23;i++)db.users.push({...db.users[0],id:'extra'+i,username:'extra'+i});
 const store:Store={read:async()=>db,mutate:async fn=>fn(db)};const app=express();app.use(express.json());
 installProductMetricsRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}if(req.headers['x-role']!=='admin'){res.sendStatus(403);return;}req.user={id:'admin'} as any;next();}],store);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/admin/product-metrics`,headers={'x-key':'present','x-role':'admin','content-type':'application/json'};
 for(const [path,method] of [['','GET'],['/export','GET'],['/exclusions','POST']]){assert.equal((await fetch(url+path,{method})).status,428);assert.equal((await fetch(url+path,{method,headers:{...headers,'x-role':'user'}})).status,403);}
 const page=await(await fetch(url,{headers})).json();assert.equal(page.users.items.length,20);assert.equal(page.users.total,25);assert.equal((await(await fetch(url+'?page=2',{headers})).json()).users.items.length,5);
 const csv=await(await fetch(url+'/export',{headers})).text();assert.doesNotMatch(csv,/PRIVATE CHAT|SECRET|extra/);
 assert.equal((await fetch(url+'/exclusions',{method:'POST',headers,body:JSON.stringify({userId:'a',excluded:true,actorUserId:'forged',workspaceId:'wb'})})).status,200);
 assert.equal(db.auditLogs.at(-1)!.actorUserId,'admin');assert.equal(db.auditLogs.at(-1)!.workspaceId,'wa');assert.equal(db.users.length,27);assert.equal(productMetrics(db,now).summary.accounts,24);
});
