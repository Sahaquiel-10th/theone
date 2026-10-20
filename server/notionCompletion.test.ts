import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedNotionCompletion,notionDeliveryNote} from './notionCompletion.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {TaskStep} from './taskSteps.js';
const pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const receipt:NonNullable<WorkRun['notionReceipt']>={state:'verified',pageId,digest:'a'.repeat(64),expectedDigest:'a'.repeat(64),url:'https://untrusted.invalid/'};
const save:TaskStep={key:'save',namespace:'worker',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'completed',output:{state:'verified',pageId},updatedAt:'now'};
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
