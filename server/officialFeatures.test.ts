import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { featureValues, updateOfficialFeature } from "./officialFeatures.js";
import { installOfficialFeatureRoutes } from "./officialFeatureRoutes.js";
import type { Database, SystemSettings } from "./types.js";
import type { Store } from "./db.js";
const values={name:"测试功能",description:"回答公开测试问题",author:"ONE",instructions:"仅根据用户提供的测试资料作答",limitations:"不做外部写入，不读取他人资料",integration:"question_answer"};
const evidence="公开测试集通过；仅认定配置，实际接口接入与运行验证仍需下一阶段完成。";
test("official versions are immutable; stale edits rejected; restore cannot re-enable paused features",()=>{
  const s:SystemSettings={safetyRules:"safe",rechargeCnyPerPower:7};
  updateOfficialFeature(s,"test-feature",{revision:0,action:"save",values},"admin","t1");
  assert.throws(()=>updateOfficialFeature(s,"test-feature",{revision:0,action:"approve",evidence,confirmed:true},"admin","t2"));
  updateOfficialFeature(s,"test-feature",{revision:1,action:"approve",evidence,confirmed:true},"admin","t2");
  updateOfficialFeature(s,"test-feature",{revision:2,action:"save",values:{...values,name:"新名称"}},"admin","t3");
  assert.equal(s.officialFeatures![0].current!.values.name,values.name);
  updateOfficialFeature(s,"test-feature",{revision:3,action:"pause"},"admin","t4");
  updateOfficialFeature(s,"test-feature",{revision:4,action:"restore",version:1},"admin","t5");
  assert.equal(s.officialFeatures![0].status,"paused");assert.equal(s.officialFeatures![0].draft.name,values.name);
  updateOfficialFeature(s,"test-feature",{revision:5,action:"approve",evidence,confirmed:true},"admin","t6");
  assert.equal(s.officialFeatures![0].current!.version,2);assert.equal(s.officialFeatures![0].history.length,2);
  assert.equal(s.safetyRules,"safe");
});
test("malformed input, uploaded script fields, unsupported integrations and unconfirmed approval fail closed",()=>{
  for(const bad of [null,[],{...values,script:"run"},{...values,apiKey:"secret"},{...values,integration:"shell"},{...values,name:""}])assert.throws(()=>featureValues(bad));
  const s:SystemSettings={safetyRules:"safe",rechargeCnyPerPower:7};
  for(const id of ["__proto__","constructor","../feature","a"])assert.throws(()=>updateOfficialFeature(s,id,{revision:0,action:"save",values},"a","t"));
  updateOfficialFeature(s,"valid-id",{revision:0,action:"save",values},"a","t");
  for(const body of [{evidence:"short",confirmed:true},{evidence,confirmed:false}])assert.throws(()=>updateOfficialFeature(s,"valid-id",{revision:1,action:"approve",...body},"a","t"));
  assert.equal(s.officialFeatures![0].revision,1);assert.equal(s.officialFeatures![0].current,undefined);
});
test("HTTP management requires admin and Key for every route; ignores forged tenant/actor and never exposes runtime",async t=>{
  let db={settings:{safetyRules:"safe",rechargeCnyPerPower:7},auditLogs:[]} as unknown as Database;
  const store:Store={read:async()=>db,mutate:async fn=>{const before=structuredClone(db);try{return fn(db);}catch(e){db=before;throw e;}}};
  const app=express();app.use(express.json());
  installOfficialFeatureRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}if(req.headers['x-role']!=='admin'){res.sendStatus(403);return;}req.user={id:'actual-admin'} as any;next();}],store);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/admin/official-features`, headers={'Content-Type':'application/json','x-key':'present','x-role':'admin'};
  for(const path of ['', '/test-feature'])for(const method of path?['GET','POST']:['GET']){
    assert.equal((await fetch(url+path,{method})).status,428);
    assert.equal((await fetch(url+path,{method,headers:{...headers,'x-role':'user','x-workspace':'other'}})).status,403);
  }
  assert.equal((await fetch(url+'/test-feature',{method:'POST',headers,body:JSON.stringify({revision:0,action:'save',values,actorId:'forged'})})).status,200);
  assert.equal(db.auditLogs[0].actorUserId,'actual-admin');
  const list=await(await fetch(url+'?q=测试&page=1',{headers})).json();assert.equal(list.total,1);assert.equal(list.runtimeEnabled,false);assert.equal(list.items[0].instructions,undefined);
  const approved=await fetch(url+'/test-feature',{method:'POST',headers,body:JSON.stringify({revision:1,action:'approve',evidence,confirmed:true})});assert.equal(approved.status,200);
  assert.equal((await fetch(url+'/test-feature',{method:'POST',headers,body:JSON.stringify({revision:1,action:'pause'})})).status,409);
  assert.equal((await(await fetch(url+'/test-feature?page=2',{headers})).json()).history.length,0);
  assert.equal((await fetch(url.replace('/admin','')+'/test-feature')).status,404);
});
