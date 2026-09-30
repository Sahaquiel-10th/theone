import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { availableFeature, executeFeatureRun, featureRunResult, releaseFeature, startFeatureRun } from "./featureRuns.js";
import { installFeatureRunRoutes } from "./featureRunRoutes.js";
import { installOfficialFeatureRoutes } from "./officialFeatureRoutes.js";
import { requireRole } from "./middleware.js";
import { updateOfficialFeature } from "./officialFeatures.js";
import { reconcileInterruptedChatOperations } from "./chatOperations.js";
import type { Database } from "./types.js";
import type { Store } from "./db.js";

const usage={inputTokens:10,outputTokens:5,totalTokens:15,source:'provider' as const};
const done={content:'本人资料结果',toolCalls:[],usage,finishReason:'stop' as const};
function fixture(){
  const values={name:'研究助手',author:'ONE',description:'使用个人资料',instructions:'根据工具结果回答',limitations:'只读',integration:'question_answer' as const,modelId:'model',knowledgeMode:'optional' as const,tools:[]};
  let db={users:[{id:'a',username:'甲',role:'user',enabled:true},{id:'b',username:'乙',role:'admin',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],models:[{id:'model',name:'测试模型',kind:'chat',enabled:true,apiKey:'synthetic',systemPrompt:'safe',inputPowerPerMillion:2,outputPowerPerMillion:4,costInputPowerPerMillion:1,costOutputPowerPerMillion:2}],knowledgeConnections:[{id:'ka',workspaceId:'wa',provider:'notion',status:'connected',providerUserId:'remote-a'},{id:'kb',workspaceId:'wb',provider:'notion',status:'connected',providerUserId:'remote-b'}],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'pa',workspaceId:'wa',userId:'a',balanceMicros:1000000},{id:'pb',workspaceId:'wb',userId:'b',balanceMicros:1000000}],conversations:[],messages:[],contextTraces:[],chatOperations:[],auditLogs:[],settings:{safetyRules:'safe',officialFeatures:[{id:'research',revision:1,status:'approved',draft:values,current:{version:1,values,evidence:'test',approvedBy:'b',approvedAt:'t'},history:[{version:1,values,evidence:'test',approvedBy:'b',approvedAt:'t'}]}]}} as unknown as Database;
  let queue:Promise<unknown>=Promise.resolve();
  const store:Store={read:async()=>db,mutate:fn=>{const p=queue.then(()=>{const before=structuredClone(db);try{return fn(db);}catch(e){db=before;throw e;}});queue=p.catch(()=>undefined);return p;}};
  releaseFeature(db,'research',{action:'publish',revision:1,version:1,userIds:['a'],confirmed:true},'b');
  return {store,db:()=>db,scope:{workspaceId:'wa',userId:'a'},body:{releaseId:db.settings.officialFeatures![0].release!.id,prompt:'查我的资料',sourceIds:['ka'],budget:.1,confirmed:true,operationId:'operation_1234567890'}};
}
const noKnowledge={recallWithDiagnostics:async()=>{assert.fail('unexpected knowledge access');}};
test('publication requires approval/admin; immutable released version survives drafts; pause does not auto-resume',()=>{
  const f=fixture(),record=f.db().settings.officialFeatures![0];
  assert.throws(()=>availableFeature(f.db(),{workspaceId:'wb',userId:'b'},'research'));
  assert.throws(()=>releaseFeature(f.db(),'research',{action:'publish',revision:record.revision,version:1,userIds:['a'],confirmed:true},'a'));
  updateOfficialFeature(f.db().settings,'research',{action:'save',revision:record.revision,values:{...record.draft,instructions:'changed'}},'b','t');
  assert.equal(availableFeature(f.db(),f.scope,'research').version.values.instructions,'根据工具结果回答');
  updateOfficialFeature(f.db().settings,'research',{action:'pause',revision:f.db().settings.officialFeatures![0].revision},'b','t');
  assert.throws(()=>availableFeature(f.db(),f.scope,'research'));
  assert.equal(f.db().settings.officialFeatures![0].release,undefined);
});
test('own selected knowledge, trace, payer and result; stable receipt does not execute twice',async()=>{
  const f=fixture();let calls=0,reads=0;
  const start=await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});assert.equal(start.created,true);
  assert.equal((await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{})).created,false);
  await assert.rejects(startFeatureRun(f.store,f.scope,'research',{...f.body,prompt:'different'},async()=>{}),/同一提交标识/);
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{}, {recallWithDiagnostics:async(w,q,k,ids)=>{reads++;assert.equal(w,'wa');assert.deepEqual(ids,['ka']);return {chunks:[{title:'我的资料',content:'仅甲可见'}],failures:[],status:'used'};}}, {modelCall:async(_m,messages,tools)=>{
    calls++;assert.equal(tools[0].function.name,'knowledge_search');
    if(calls===1)return {...done,content:'',toolCalls:[{id:'k',type:'function',function:{name:'knowledge_search',arguments:'{"query":"相关资料"}'}}]};
    assert.match(JSON.stringify(messages),/仅甲可见/);return done;
  }});
  const result=featureRunResult(f.db(),f.scope,f.body.operationId);assert.equal(result.status,'completed');assert.equal(result.trace?.length,1);assert.equal(result.charges?.length,2);assert.equal(reads,1);
  assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);assert.equal(f.db().modelUsageRecords.every(u=>u.userId==='a'&&u.workspaceId==='wa'),true);
  assert.throws(()=>featureRunResult(f.db(),{workspaceId:'wb',userId:'b'},f.body.operationId));
  assert.throws(()=>featureRunResult(f.db(),{workspaceId:'wb',userId:'a'},f.body.operationId));
  assert.equal((await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{})).created,false);assert.equal(calls,2);
  assert.doesNotMatch(JSON.stringify(f.db().settings),/仅甲可见|remote-a|查我的资料/);
  assert.doesNotMatch(JSON.stringify(f.db().auditLogs),/仅甲可见|查我的资料/);
});
test('no implicit knowledge, foreign source rejection, budget and Key denial before calls',async()=>{
  let f=fixture();await assert.rejects(startFeatureRun(f.store,f.scope,'research',{...f.body,sourceIds:['kb']},async()=>{}),/不属于你/);
  await assert.rejects(startFeatureRun(f.store,f.scope,'research',f.body,async()=>{throw new Error('Key absent');}));assert.equal(f.db().chatOperations!.length,0);
  await startFeatureRun(f.store,f.scope,'research',{...f.body,sourceIds:[],budget:.001},async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>{assert.fail('budget bypass');}});
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'failed');assert.equal(f.db().modelUsageRecords.length,0);
  f=fixture();await startFeatureRun(f.store,f.scope,'research',{...f.body,sourceIds:[]},async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async(_m,_messages,tools)=>{assert.equal(tools.length,0);return done;}});
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'completed');
});
test('revocation, republish, unpublish, account switch and Key removal stop subsequent calls',async()=>{
  for(const change of ['revoked','switch','unpublish','republish','key']){
    const f=fixture();let calls=0,key=true;
    await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});
    await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{if(!key)throw new Error('Key absent');},noKnowledge,{modelCall:async()=>{
      calls++;await f.store.mutate(db=>{
        if(change==='revoked')db.knowledgeConnections[0].status='revoked';
        if(change==='switch')db.knowledgeConnections[0].providerUserId='other';
        const r=db.settings.officialFeatures![0];
        if(change==='unpublish')releaseFeature(db,'research',{action:'unpublish',revision:r.revision},'b');
        if(change==='republish')releaseFeature(db,'research',{action:'publish',revision:r.revision,version:1,userIds:['a'],confirmed:true},'b');
        if(change==='key')key=false;
      });return {...done,content:'',toolCalls:[{id:'k',type:'function',function:{name:'knowledge_search',arguments:'{"query":"相关资料"}'}}]};
    }});
    assert.equal(calls,1);assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'failed');assert.equal(f.db().modelUsageRecords.length,1);
  }
});
test('concurrent distinct requests have one claimant; restart interrupts without auto replay',async()=>{
  const f=fixture();const attempts=await Promise.allSettled([startFeatureRun(f.store,f.scope,'research',f.body,async()=>{}),startFeatureRun(f.store,f.scope,'research',{...f.body,operationId:'operation_9876543210'},async()=>{})]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  reconcileInterruptedChatOperations(f.db());
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'interrupted');
  assert.equal((await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{})).created,false);
});
test('HTTP consumer routes require Key, separate recipients and hide definitions; async receipt survives refresh',async t=>{
  const f=fixture();const app=express();app.use(express.json());
  installFeatureRunRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}const b=req.headers['x-account']==='b';req.user={id:b?'b':'a'} as any;req.workspaceId=b?'wb':'wa';next();}],f.store,async()=>{},noKnowledge,{modelCall:async()=>done});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/features`,headers={'x-key':'present','content-type':'application/json'};
  for(const path of ['', '/runs','/research','/runs/'+f.body.operationId])assert.equal((await fetch(url+path)).status,428);
  const list=await(await fetch(url,{headers})).json();assert.equal(list.items.length,1);assert.equal(list.items[0].instructions,undefined);assert.equal(list.items[0].userIds,undefined);
  assert.equal((await(await fetch(url,{headers:{...headers,'x-account':'b'}})).json()).items.length,0);
  assert.equal((await fetch(url+'/research',{headers:{...headers,'x-account':'b'}})).status,403);
  const body=JSON.stringify({...f.body,sourceIds:[],workspaceId:'wb',userId:'b'});
  assert.equal((await fetch(url+'/research/runs',{method:'POST',body,headers})).status,202);
  for(let i=0;i<30;i++){const r=await(await fetch(url+'/runs/'+f.body.operationId,{headers})).json();if(r.status!=='pending')break;await new Promise(resolve=>setTimeout(resolve,5));}
  const own=await fetch(url+'/runs/'+f.body.operationId,{headers});assert.equal(own.headers.get('cache-control'),'no-store');assert.equal((await own.json()).status,'completed');
  assert.equal((await fetch(url+'/runs/'+f.body.operationId,{headers:{...headers,'x-account':'b'}})).status,404);
  assert.equal((await(await fetch(url+'/runs?page=2',{headers})).json()).items.length,0);
  assert.equal((await fetch(url+'/research/runs',{method:'POST',body,headers})).status,200);
  assert.equal(f.db().modelUsageRecords.length,1);
});

test('HTTP publishing requires admin and fresh revision; recipients paginate without exposing credentials',async t=>{
  const f=fixture();const app=express();app.use(express.json());
  await f.store.mutate(db=>{for(let i=0;i<12;i++)db.users.push({id:`extra-${i}`,username:`内测${i}`,role:'user',enabled:true,passwordHash:'not-for-browser'} as any);});
  installOfficialFeatureRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}const admin=req.headers['x-account']==='b';req.user={id:admin?'b':'a',role:admin?'admin':'user'} as any;req.workspaceId=admin?'wb':'wa';next();},requireRole('admin')],f.store);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/admin/official-features`,headers={'x-key':'present','x-account':'b','content-type':'application/json'};
  assert.equal((await fetch(url+'/research/release',{method:'POST'})).status,428);
  assert.equal((await fetch(url+'/research/release',{method:'POST',headers:{...headers,'x-account':'a'},body:'{}'})).status,403);
  const recipients=await(await fetch(url+'/recipients?q='+encodeURIComponent('内测')+'&page=2',{headers})).json();assert.equal(recipients.total,12);assert.equal(recipients.items.length,2);assert.doesNotMatch(JSON.stringify(recipients),/password|not-for-browser/);
  const body=JSON.stringify({action:'unpublish',revision:f.db().settings.officialFeatures![0].revision});
  assert.equal((await fetch(url+'/research/release',{method:'POST',headers,body})).status,200);
  assert.equal((await fetch(url+'/research/release',{method:'POST',headers,body})).status,409);
  assert.equal(f.db().settings.officialFeatures![0].release,undefined);
});
