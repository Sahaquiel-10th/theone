import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedNotionCompletion,notionDeliveryNote,notionRetryCheckpointPlan,notionRevisionRequested} from './notionCompletion.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {TaskStep} from './taskSteps.js';
const pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const receipt:NonNullable<WorkRun['notionReceipt']>={state:'verified',pageId,digest:'a'.repeat(64),expectedDigest:'a'.repeat(64),url:'https://untrusted.invalid/'};
const save:TaskStep={key:'save',namespace:'worker',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'completed',output:{state:'verified',pageId},updatedAt:'now'};
const run=(overrides:Partial<WorkRun>={})=>({notionReceipt:receipt,steps:[save],...overrides} as WorkRun);
test('new material discards the old save but retains its verified page as the revision target',()=>{
 const prior=run({steps:[save,{...save,key:'read',tool:'read_notion_document',effect:'read'}]});
 const plan=notionRetryCheckpointPlan(prior,{newWrite:true,scopeId:'new-attempt'});
 assert.equal(plan.blocked,false);assert.equal(plan.forceWrite,true);assert.equal(plan.pageId,pageId);
 assert.deepEqual(plan.steps,[]);assert.equal(plan.notionReceipt,undefined);
 assert.equal(prior.steps!.length,2,'the old attempt remains unchanged');
 const legacy=notionRetryCheckpointPlan(run({notionReceipt:undefined}),{newWrite:true});
 assert.equal(legacy.pageId,pageId,'a verified save result can locate the page, not count as a new write');
});
test('an unchanged verified retry can reuse only its matching proof and marks it as this explicit retry',()=>{
 const plan=notionRetryCheckpointPlan(run(),{newWrite:false,scopeId:'retry'});
 assert.equal(plan.forceWrite,false);assert.equal(plan.steps[0].scopeId,'retry');assert.deepEqual(plan.notionReceipt,receipt);
 assert.equal(save.scopeId,undefined);
 const inconsistent=notionRetryCheckpointPlan(run({notionReceipt:{...receipt,pageId:'c'.repeat(32)}}),{newWrite:false});
 assert.equal(inconsistent.steps.length,0);assert.equal(inconsistent.notionReceipt,undefined);
});
test('retrying a legacy partial manuscript cannot count the old draft save as this attempt completed writing',()=>{
 for(const resultOutcome of ['partial','needs_input'] as const){
  const plan=notionRetryCheckpointPlan(run({resultOutcome}),{newWrite:false,scopeId:'retry'});
  assert.equal(plan.forceWrite,true);assert.equal(plan.pageId,pageId);assert.equal(plan.steps.length,0);assert.equal(plan.notionReceipt,undefined);
 }
 const finalRun=run({resultOutcome:'partial',notionReceipt:{...receipt,final:true},steps:[{...save,output:{state:'verified',pageId,final:true}}]});
 assert.equal(notionRetryCheckpointPlan(finalRun,{newWrite:false,scopeId:'retry'}).forceWrite,false,'a verified explicit final document may be reused while another independent step resumes');
});
test('a save made before mandatory research cannot finish the revised article after research resumes',()=>{
 const contract={version:1,requiredFeatureIds:[],requiredTools:['knowledge_search'],execution:'model'} as WorkRun['contract'];
 const written={...save,updatedAt:'2026-10-25T09:00:00Z'};
 for(const knowledge of [undefined,{...save,key:'k',tool:'knowledge_search',effect:'read' as const,output:{status:'used'},updatedAt:'2026-10-25T09:01:00Z'}]){
  const plan=notionRetryCheckpointPlan(run({contract,steps:[written,...(knowledge?[knowledge]:[])]}),{newWrite:false});
  assert.equal(plan.forceWrite,true);assert.ok(!plan.steps.some(s=>s.tool==='save_notion_draft'));assert.equal(plan.notionReceipt,undefined);
 }
 const earlier={...written,key:'k',tool:'knowledge_search',effect:'read' as const,output:{status:'used'},updatedAt:'2026-10-25T08:59:00Z'};
 assert.equal(notionRetryCheckpointPlan(run({contract,steps:[earlier,written]}),{newWrite:false}).forceWrite,false);
});
test('unknown external writes require reconciliation even when a new revision is requested',()=>{
 for(const state of ['pending','uncertain'] as const){
  const plan=notionRetryCheckpointPlan(run({notionReceipt:{...receipt,state,delivery:'unknown'}}),{newWrite:true});
  assert.equal(plan.blocked,true);assert.match(plan.message!,/核对原页面/);
 }
 const started={...save,state:'started' as const};
 assert.equal(notionRetryCheckpointPlan(run({notionReceipt:undefined,steps:[started]}),{newWrite:true}).blocked,true);
 for(const delivery of ['not_sent','rejected'] as const){
  const plan=notionRetryCheckpointPlan(run({notionReceipt:{state:'uncertain',delivery},steps:[started]}),{newWrite:true});
  assert.equal(plan.blocked,false);assert.equal(plan.steps.length,0);
 }
});
test('only explicit revision language requests a new document write',()=>{
 for(const request of ['把开头改成这段','根据补充材料完善原文','继续修改这篇文章','补料：昨天的想法如下','把结尾替换为新句子'])assert.equal(notionRevisionRequested(request),true,request);
 for(const request of ['只读这篇文章，不要修改或保存','看看文章说了什么','继续核对结果','不用重写，告诉我保存位置'])assert.equal(notionRevisionRequested(request),false,request);
});
test('verified completion requires this attempt save and source research before writing, including existing-page revisions',()=>{
 const finalReceipt={...receipt,final:true};
 const written={...save,output:{state:'verified',pageId,final:true,digest:receipt.digest,expectedDigest:receipt.expectedDigest},scopeId:'revision',updatedAt:'2026-10-25T09:00:00Z'};
 const knowledge={...save,key:'k',tool:'knowledge_search',effect:'read' as const,output:{status:'used'},updatedAt:'2026-10-25T08:59:00Z'};
 assert.ok(verifiedNotionCompletion(finalReceipt,[knowledge,written],['knowledge_search','save_notion_draft'],{scopeId:'revision'}));
 assert.equal(verifiedNotionCompletion(finalReceipt,[knowledge,{...written,scopeId:'old'}],['knowledge_search'],{scopeId:'revision'}),undefined);
 assert.equal(verifiedNotionCompletion(finalReceipt,[{...knowledge,updatedAt:'2026-10-25T09:01:00Z'},written],['knowledge_search'],{scopeId:'revision'}),undefined);
 assert.equal(verifiedNotionCompletion(finalReceipt,[written],['knowledge_search'],{scopeId:'revision'}),undefined);
 assert.equal(verifiedNotionCompletion(finalReceipt,[knowledge,written],['web_search'],{scopeId:'revision'}),undefined);
 const oldFailure={...knowledge,key:'older',state:'failed' as const,output:{status:'failed'},updatedAt:'2026-10-25T08:50:00Z'};
 assert.ok(verifiedNotionCompletion(finalReceipt,[oldFailure,knowledge,written],['knowledge_search'],{scopeId:'revision'}),'a completed retry supersedes historical failed research');
 assert.equal(verifiedNotionCompletion(finalReceipt,[knowledge,written,{...oldFailure,state:'started'}],[],{scopeId:'revision'}),undefined,'ongoing work is not dismissed as complete');
 assert.equal(verifiedNotionCompletion(receipt,[knowledge,written],[],{scopeId:'revision'}),undefined,'a draft cannot finish an article');
 assert.equal(verifiedNotionCompletion({...finalReceipt,digest:'b'.repeat(64)},[knowledge,written],[],{scopeId:'revision'}),undefined,'an older final save does not prove the latest page body');
});
test('read-only follow-up links its existing document without claiming a new save or warning that it was not saved',()=>{
 assert.equal(notionDeliveryNote(undefined,pageId),`\n\n[打开 Notion 原文](https://www.notion.so/${pageId})`);
 assert.match(notionDeliveryNote(receipt),/已保存到 Notion · 已回读核对/);
 assert.doesNotMatch(notionDeliveryNote(receipt),/untrusted/);
 assert.match(notionDeliveryNote({...receipt,state:'uncertain'}),/尚未确认/);
 assert.doesNotMatch(notionDeliveryNote(undefined,'bad'),/https:/);
});
test('verified document fallback uses exact readback and completed required steps, not a provider URL',()=>{
 const result=verifiedNotionCompletion(receipt,[save],['save_notion_draft']);assert.ok(result);assert.match(result,/www.notion.so/);assert.doesNotMatch(result,/untrusted|可发布|质量合格/);
 assert.ok(verifiedNotionCompletion({...receipt,digest:'b'.repeat(64)},[save],['save_notion_draft']),'server-verified normalized readback can have a different raw digest');
 assert.equal(verifiedNotionCompletion(receipt,[save],['knowledge_search']),undefined);
 for(const state of ['pending','uncertain'] as const)assert.equal(verifiedNotionCompletion({...receipt,state},[save],[]),undefined);
 for(const variant of [{...receipt,pageId:'bad'},{...receipt,pageId:'z'.repeat(32)},{...receipt,digest:'changed'},{...receipt,expectedDigest:undefined}])assert.equal(verifiedNotionCompletion(variant,[save],[]),undefined);
 for(const variant of [{...save,state:'started' as const},{...save,effect:'read' as const},{...save,output:{state:'verified',pageId:'foreign'}},{...save,namespace:'feature:x'},{...save,output:{state:'uncertain',pageId}}])assert.equal(verifiedNotionCompletion(receipt,[variant],[]),undefined);
 assert.equal(verifiedNotionCompletion(receipt,[save,{...save,key:'other',tool:'oneHtml',effect:'artifact',state:'started'}],[]),undefined);
 assert.equal(verifiedNotionCompletion(receipt,[],[]),undefined);
});
