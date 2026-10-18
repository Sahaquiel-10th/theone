import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityHealth} from './capabilityHealth.js';
import type {Database} from './types.js';
import type {CapabilityCard} from './capabilityCatalog.js';
const stamp='2026-10-18T02:00:00.000Z',now=Date.parse(stamp)+60000;
const card={id:'executor:logic',kind:'executor',executorId:'logic',version:2,modelId:'model',available:true} as CapabilityCard;
function fixture(){return {chatOperations:[],conversations:[],attachments:[],modelUsageRecords:[]} as unknown as Database;}
function add(db:Database,id:string,state='completed',scope={workspaceId:'wa',userId:'a'}){
 const op={...scope,id,operationId:id,requestId:id,conversationId:id,status:state==='completed'?'completed':'failed',createdAt:stamp,updatedAt:stamp,workRun:{state,executorId:'logic',executorVersion:2,modelId:'model',skills:[],resultOutcome:state==='completed'?'completed':'failed',resultMessageId:'result',error:'PRIVATE_CONTENT apiKey',failureCode:'task_execution_failed'}} as any;
 db.chatOperations!.push(op);db.conversations.push({...scope,id,messages:[{id:'result',role:'assistant',content:'PRIVATE_CONTENT',createdAt:stamp}]} as any);
 db.modelUsageRecords.push({...scope,id:'usage-'+id,conversationId:id,requestId:id,status:state==='completed'?'success':'failed',durationMs:1200,createdAt:stamp} as any);return op;
}
test('health is a read-only, versioned, aggregate view with safe failures and honest sample size',()=>{
 const db=fixture();add(db,'one');let result=capabilityHealth(db,[card],now)[card.id];assert.equal(result.status,'unverified');assert.equal(result.deliveries,1);
 add(db,'two');add(db,'three');result=capabilityHealth(db,[card],now)[card.id];assert.equal(result.status,'observed');assert.equal(result.counts.completed,3);assert.equal(result.averageCallMs,1200);
 const bad=add(db,'bad','failed');bad.workRun.failureCode='__proto__';const stopped=add(db,'stop','cancelled');stopped.workRun.state='cancelled';const waiting=add(db,'wait','failed');waiting.workRun.resultOutcome='needs_input';
 const old=add(db,'old');old.workRun.executorVersion=1;const before=JSON.stringify(db);
 result=capabilityHealth(db,[card],now)[card.id];assert.equal(result.samples,6);assert.equal(result.counts.stopped,1);assert.equal(result.counts.blocked,1);assert.equal(result.counts.failed,1);assert.equal(result.status,'attention');assert.equal(result.commonIssues[0].label,'结果尚未交齐，原因待核对');assert.equal(JSON.stringify(db),before);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CONTENT|apiKey|conversationId|userId|workspaceId|requestId|__proto__/);
 for(const code of ['task_key_required','task_budget_required','task_authorization_required']){const blocked=add(db,code,'failed');blocked.workRun.failureCode=code;}const classified=capabilityHealth(db,[card],now)[card.id];assert.equal(classified.counts.failed,1);assert.equal(classified.counts.blocked,4);
});
test('retries merge by exact owner and root; completed reused stages do not invent model calls',()=>{
 const db=fixture(),first=add(db,'initial','failed'),retry=add(db,'retry');retry.workRun.retryOfOperationId=first.operationId;retry.updatedAt='2026-10-18T02:00:20.000Z';
 const foreign=add(db,'initial','failed',{workspaceId:'wb',userId:'b'});foreign.workRun.failureCode='task_empty_response';
 const result=capabilityHealth(db,[card],now,{workspaceId:'wa',userId:'a'})[card.id];assert.equal(result.samples,1);assert.equal(result.counts.completed,1);assert.equal(result.deliveries,1);assert.equal(result.calls.success,1);assert.equal(result.calls.failed,1);assert.equal(result.commonIssues.length,0);
 assert.equal(capabilityHealth(db,[card],now)[card.id].samples,2);
 db.modelUsageRecords=[];assert.equal(capabilityHealth(db,[card],now,{workspaceId:'wa',userId:'a'})[card.id].calls.success,0);
});
test('feature step success and final delivery remain separate; foreign usage and uncalled features are excluded',()=>{
 const db=fixture(),op=add(db,'feature','failed');op.workRun.skills=[{id:'html',version:3}];op.workRun.steps=[{namespace:'worker',tool:'feature_0',state:'completed',output:{status:'completed'}}];
 const feature={id:'feature:html',kind:'feature',featureId:'html',version:3,available:true} as CapabilityCard;
 db.modelUsageRecords[0].featurePriceSnapshot={id:'html',version:3} as any;
 const h=capabilityHealth(db,[feature],now)[feature.id];assert.equal(h.counts.completed,1);assert.equal(h.deliveries,0);assert.equal(h.calls.failed,1);
 db.modelUsageRecords[0].workspaceId='foreign';assert.equal(capabilityHealth(db,[feature],now)[feature.id].calls.failed,0);
 op.workRun.steps=[];assert.equal(capabilityHealth(db,[feature],now)[feature.id].samples,0);
});
