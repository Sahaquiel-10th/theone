import test from "node:test";
import assert from "node:assert/strict";
import type { Store } from "./db.js";
import type { Database, ModelConfig } from "./types.js";
import { activePublication, beginPublicRun, checkRunBudget, createGuest, guest, ownedPublication, publish, sharingReady, usageFor } from "./publicSharing.js";
import { executePublicQuestion } from "./publicSharingRoutes.js";
import { runBilledModel } from "./modelBilling.js";

function fixture(){
  const model={id:"model",name:"test model",apiKey:"MODEL_SECRET",enabled:true,kind:"chat",protocol:"openai",systemPrompt:"",inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig;
  let db={users:[{id:"owner",enabled:true},{id:"other",enabled:true}],workspaces:[{id:"ws",status:"active"},{id:"other-ws",status:"active"}],workspaceMembers:[{workspaceId:"ws",userId:"owner",role:"owner"},{workspaceId:"other-ws",userId:"other",role:"owner"}],models:[model],settings:{safetyRules:"safe",rechargeCnyPerPower:7},agents:[],auditLogs:[],publications:[],publicSessions:[],publicRuns:[],attachments:[],messages:[{content:"OWNER_PRIVATE_CHAT"}],knowledgeConnections:[{id:"source",workspaceId:"ws",provider:"getnote",status:"connected",clientId:"cli",encryptedApiKey:"SOURCE_SECRET"},{id:"other-source",workspaceId:"other-ws",provider:"notion",status:"connected",clientId:"other-cli",encryptedApiKey:"OTHER_SECRET"}],modelUsageRecords:[],powerAccounts:[{id:"power",workspaceId:"ws",userId:"owner",balanceMicros:100e6,reservedMicros:0}],powerLedger:[]} as unknown as Database;
  const store:Store={read:async()=>db,mutate:async fn=>{const before=structuredClone(db);try{return fn(db);}catch(e){db=before;throw e;}}};
  const input={name:"Test",description:"description",prompt:"answer briefly",modelId:"model",sourceIds:["source"],attachments:true,budget:10,perRun:1,days:7,confirmed:true};
  return {store,get db(){return db;},input,model};
}
test("publication snapshots are explicit, owner-scoped and public source grants fail closed",()=>{
  const f=fixture();assert.equal(sharingReady(f.db),true);
  assert.throws(()=>publish(f.db,{workspaceId:"ws",userId:"other"},f.input));
  assert.throws(()=>publish(f.db,{workspaceId:"ws",userId:"owner"},{...f.input,sourceIds:["other-source"]}));
  assert.throws(()=>publish(f.db,{workspaceId:"ws",userId:"owner"},{...f.input,confirmed:false}));
  const p=publish(f.db,{workspaceId:"ws",userId:"owner"},f.input);
  assert.throws(()=>ownedPublication(f.db,"other-ws","other",p.id));
  f.input.prompt="changed";assert.equal(p.prompt,"answer briefly");
  assert.equal(p.attachments,true);assert.equal(p.sources.length,1);
  f.db.knowledgeConnections[0].encryptedApiKey="REPLACED_ACCOUNT";
  assert.throws(()=>activePublication(f.db,p.id),/授权已变更/);
  f.db.publications=undefined;assert.equal(sharingReady(f.db),false);
});
test("visitor tokens, task receipts, attachments and publications cannot cross sessions",()=>{
  const f=fixture(),p=publish(f.db,{workspaceId:"ws",userId:"owner"},f.input);
  const a=createGuest(f.db,p.id),b=createGuest(f.db,p.id);
  assert.doesNotMatch(JSON.stringify(f.db.publicSessions),new RegExp(a.token));
  assert.throws(()=>guest(f.db,p.slug,"wrong"));
  assert.equal(guest(f.db,p.slug,a.token).session.id,a.session.id);
  const payload={content:"QUESTION_PRIVATE",operationId:"operation_unique_01",attachmentIds:[]};
  const first=beginPublicRun(f.db,p,a.session,payload);assert.equal(first.created,true);
  assert.equal(beginPublicRun(f.db,p,a.session,payload).created,false);
  assert.throws(()=>beginPublicRun(f.db,p,a.session,{...payload,content:"changed"}),/更改/);
  f.db.attachments.push({id:"file",workspaceId:"ws",userId:a.session.id,status:"ready"} as any);
  assert.throws(()=>beginPublicRun(f.db,p,b.session,{...payload,attachmentIds:["file"]}),/无权/);
  const p2=publish(f.db,{workspaceId:"ws",userId:"owner"},f.input);
  assert.throws(()=>guest(f.db,p2.slug,a.token));
  assert.throws(()=>beginPublicRun(f.db,p2,a.session,payload));
});
test("public answer uses only selected sources and guest history; payer and receipt are durable",async()=>{
  const f=fixture(),p=publish(f.db,{workspaceId:"ws",userId:"owner"},f.input),a=createGuest(f.db,p.id);
  const {run}=beginPublicRun(f.db,p,a.session,{content:"question",operationId:"operation_unique_02",attachmentIds:[]});
  let called=0;
  await executePublicQuestion(f.store,{recallWithDiagnostics:async(ws,q,k,ids)=>{assert.equal(ws,"ws");assert.deepEqual(ids,["source"]);return {chunks:[{title:"Allowed",content:"allowed fact"}],failures:[],status:"used"};}},run.id,async(_model,messages)=>{
    called++;assert.match(JSON.stringify(messages),/allowed fact/);assert.doesNotMatch(JSON.stringify(messages),/OWNER_PRIVATE_CHAT|OTHER_SECRET|SOURCE_SECRET|MODEL_SECRET/);
    return {content:"answer",finishReason:"stop",usage:{inputTokens:10,outputTokens:20,totalTokens:30,source:"provider"}};
  });
  assert.equal(called,1);assert.equal(f.db.publicRuns![0].status,"completed");
  assert.equal(f.db.modelUsageRecords[0].userId,"owner");assert.equal(f.db.modelUsageRecords[0].conversationId,run.id);
  assert.equal(usageFor(f.db,p).spent,30);assert.equal(f.db.messages.length,1);
  // A retry of the same receipt never invokes the model again.
  await executePublicQuestion(f.store,{recallWithDiagnostics:async()=>{assert.fail();}},run.id,async()=>{assert.fail();});
});
test("revocation during retrieval stops before the paid call; guests never gain tool execution",async()=>{
  const f=fixture(),p=publish(f.db,{workspaceId:"ws",userId:"owner"},f.input),a=createGuest(f.db,p.id);
  const {run}=beginPublicRun(f.db,p,a.session,{content:"run command",operationId:"operation_unique_03",attachmentIds:[]});
  await executePublicQuestion(f.store,{recallWithDiagnostics:async()=>{f.db.knowledgeConnections[0].status="revoked";return {chunks:[],failures:[],status:"no_match"};}},run.id,async()=>{assert.fail("revoked source must prevent paid model call");});
  assert.equal(f.db.publicRuns![0].status,"failed");assert.equal(f.db.modelUsageRecords.length,0);
});
test("publication budget is checked in the same transaction as model reservation",async()=>{
  const f=fixture(),p=publish(f.db,{workspaceId:"ws",userId:"owner"},{...f.input,budget:.01,perRun:.01}),a=createGuest(f.db,p.id),b=createGuest(f.db,p.id);
  const r1=beginPublicRun(f.db,p,a.session,{content:"a",operationId:"operation_budget_1",attachmentIds:[]}).run;
  const r2=beginPublicRun(f.db,p,b.session,{content:"b",operationId:"operation_budget_2",attachmentIds:[]}).run;
  let release!:()=>void; const waiting=new Promise<void>(resolve=>{release=resolve;});
  const call=(r:typeof r1,input:unknown)=>runBilledModel(f.store,{workspaceId:"ws",userId:"owner",conversationId:r.id,model:f.model,input,activity:"public_answer",requestId:r.id,beforeReserve:(db,n)=>checkRunBudget(db,r.id,n)},async()=>{await waiting;return {usage:{inputTokens:5000,outputTokens:1000,totalTokens:6000,source:"provider"}};});
  const first=call(r1,{content:"x".repeat(3000)});await new Promise(resolve=>setImmediate(resolve));
  const held=usageFor(f.db,p).held;assert.ok(held>5000&&held<10000);
  await assert.rejects(call(r2,{content:"x".repeat(3000)}),/额度/);
  assert.equal(f.db.modelUsageRecords.length,1);release();await first;
  assert.equal(usageFor(f.db,p).held,0);assert.ok(usageFor(f.db,p).spent<=10000);
});
