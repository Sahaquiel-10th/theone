import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec=promisify(execFile);
test('commerce policy, visitor credentials, API hashes, paid principal and revenue survive a real restart',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-commerce-recovery-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const env={...process.env,DB_PROVIDER:'json',ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:'isolated-fixture-password',YYLX_API_KEY:'',NODE_ENV:'test'};
  const run=async(code:string)=>(await exec(process.execPath,['--import','tsx','--input-type=module','-e',code],{env})).stdout;
  const token=JSON.parse(await run(`
    const {store}=await import('./server/db.ts');const {registerVisitor}=await import('./server/visitorAccounts.ts');
    const {publish}=await import('./server/publicSharing.ts');const {issueApiGrant}=await import('./server/publicApi.ts');
    const {creditPower}=await import('./server/powerBilling.ts');const {reserveCommerce,settleCommerce}=await import('./server/commerceBilling.ts');
    const {encryptCredential}=await import('./server/knowledge/credentialCipher.ts');
    const value=await store.mutate(db=>{
      const u=registerVisitor(db,{username:'visitor',password:'fixture-visitor-password'});u.visitorAuthVersion=3;
      db.settings.publicCommercePolicy={revision:5,visitorPaymentsEnabled:true,publisherShareBps:7500};
      creditPower(db,{userId:u.id,workspaceId:u.defaultWorkspaceId,amountMicros:10000,type:'recharge',title:'Fixture'});
      db.models.push({id:'fixture',name:'Fixture',enabled:true,kind:'chat',apiKey:'fixture-only',encryptedApiKey:encryptCredential('fixture-only'),systemPrompt:'',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1});
      const owner=db.users[0],scope={userId:owner.id,workspaceId:owner.defaultWorkspaceId};
      const p=publish(db,scope,{name:'Fixture',description:'',prompt:'',modelId:'fixture',sourceIds:[],attachments:false,budget:1,perRun:1,days:1,confirmed:true,visitorPercent:120});
      const g=issueApiGrant(db,scope,p.id,{name:'Fixture',version:1,budget:1,perRun:1,days:1,confirmed:true});
      const snapshot={publicationId:p.id,publicationVersion:1,publisherUserId:owner.id,publisherWorkspaceId:owner.defaultWorkspaceId,payerUserId:u.id,payerWorkspaceId:u.defaultWorkspaceId,multiplier:1.2,publisherShareBps:7500,policyRevision:5};
      const row={id:'commerce-row',...scope,modelId:'fixture',status:'pending',createdAt:new Date().toISOString()};reserveCommerce(db,row,snapshot,2000);settleCommerce(db,row,1000);row.status='success';row.chargedMicros=1000;row.reservedMicros=0;db.modelUsageRecords.push(row);
      return g.token;
    });console.log(JSON.stringify(value));`));
  const restored=JSON.parse(await run(`const {store}=await import('./server/db.ts');const {authenticateApi}=await import('./server/publicApi.ts');const {loginVisitor}=await import('./server/visitorAccounts.ts');const d=await store.read();const u=loginVisitor(d,{username:'visitor',password:'fixture-visitor-password'});console.log(JSON.stringify({policy:d.settings.publicCommercePolicy,api:authenticateApi(d,${JSON.stringify(token)}).grant.id,visitorVersion:u.visitorAuthVersion,account:d.powerAccounts.find(a=>a.userId===u.id),commercial:d.modelUsageRecords.find(r=>r.id==='commerce-row').commercial}));`));
  assert.equal(restored.policy.revision,5);assert.equal(restored.policy.visitorPaymentsEnabled,true);assert.ok(restored.api);assert.equal(restored.visitorVersion,3);assert.equal(restored.account.paidBalanceMicros,8800);assert.equal(restored.account.reservedMicros,0);assert.equal(restored.commercial.publisherRevenueMicros,150);assert.equal(restored.commercial.status,'settled');
});
test("public records survive a real JSON-store restart and incomplete tasks are not retried",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"one-sharing-recovery-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const env={...process.env,DB_PROVIDER:"json",ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:"isolated-fixture-password",YYLX_API_KEY:"",NODE_ENV:"test"};
  const run=async(code:string)=>(await exec(process.execPath,["--import","tsx","--input-type=module","-e",code],{env})).stdout;
  await run(`const {store}=await import('./server/db.ts');await store.mutate(db=>{db.publications.push({id:'pub',workspaceId:db.workspaces[0].id,userId:db.users[0].id,status:'active'});db.publicSessions.push({id:'guest',workspaceId:db.workspaces[0].id,userId:'guest',publicationId:'pub',tokenHash:'not-a-token'});db.publicRuns.push({id:'run',workspaceId:db.workspaces[0].id,userId:'guest',sessionId:'guest',publicationId:'pub',status:'running',content:'PRIVATE_QUESTION',attachmentIds:[]});});`);
  const result=JSON.parse(await run(`const {store}=await import('./server/db.ts');const d=await store.read();console.log(JSON.stringify({publications:d.publications.length,sessions:d.publicSessions.length,run:d.publicRuns[0],calls:d.modelUsageRecords.length}));`));
  assert.equal(result.publications,1);assert.equal(result.sessions,1);assert.equal(result.run.status,"interrupted");assert.equal(result.calls,0);assert.equal(result.run.content,"PRIVATE_QUESTION");assert.ok(result.run.completedAt);
  await run(`const {store}=await import('./server/db.ts');const {updateOfficialFeature}=await import('./server/officialFeatures.ts');await store.mutate(db=>updateOfficialFeature(db.settings,'test-feature',{revision:0,action:'save',values:{name:'测试',description:'用途',author:'ONE',instructions:'公开测试指令',limitations:'只读',integration:'question_answer'}},'admin','t'));`);
  const restored=JSON.parse(await run(`const {store}=await import('./server/db.ts');const d=await store.read();console.log(JSON.stringify({feature:d.settings.officialFeatures[0],publications:d.publications.length}));`));
  assert.equal(restored.feature.id,'test-feature');assert.equal(restored.feature.revision,1);assert.equal(restored.publications,1);
});
