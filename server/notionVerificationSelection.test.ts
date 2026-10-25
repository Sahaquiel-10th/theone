import test from 'node:test';
import assert from 'node:assert/strict';
import type {ChatOperation} from './chatOperations.js';
import {selectedNotionVerification} from './notionVerificationSelection.js';

test('manual selection binds one failed attempt, exact write and target, and never authorizes a cancelled or replaced version',()=>{
 const op={id:'op',status:'failed',workRun:{state:'failed',notionTarget:{connectionId:'connection',grantId:'grant',parentId:'parent'},notionReceipt:{state:'uncertain',pageId:'page',expectedDigest:'digest',checkpointKey:'step',verification:{state:'scheduled',version:7}},notionVerificationSelection:{operationId:'op',expectedDigest:'digest',checkpointKey:'step',pageId:'page',version:7,connectionId:'connection',grantId:'grant',parentId:'parent'}}} as unknown as ChatOperation;
 assert.equal(selectedNotionVerification(op),true);
 const changes=[(o:ChatOperation)=>{o.id='different-op';},(o:ChatOperation)=>{o.workRun!.notionReceipt!.expectedDigest='new-digest';},(o:ChatOperation)=>{o.workRun!.notionReceipt!.pageId='new-page';},(o:ChatOperation)=>{o.workRun!.notionReceipt!.checkpointKey='new-step';},(o:ChatOperation)=>{o.workRun!.notionReceipt!.verification!.version=8;},(o:ChatOperation)=>{o.workRun!.notionTarget!.grantId='new-grant';},(o:ChatOperation)=>{o.workRun!.notionTarget!.connectionId='new-connection';},(o:ChatOperation)=>{o.workRun!.notionTarget!.parentId='new-parent';},(o:ChatOperation)=>{o.workRun!.state='cancelled';},(o:ChatOperation)=>{o.status='interrupted';}];
 for(const change of changes){const replaced=structuredClone(op);change(replaced);assert.equal(selectedNotionVerification(replaced),false);}
 const proven=structuredClone(op);proven.workRun!.notionReceipt!.state='verified';proven.workRun!.notionReceipt!.verification=undefined;assert.equal(selectedNotionVerification(proven),true,'a successful read removes verification but retains the exact manual selection until lifecycle finalization');
 const async=structuredClone(op);async.workRun!.notionVerificationSelection!.pageId=undefined;async.workRun!.notionVerificationSelection!.asyncTaskId='async-task';async.workRun!.notionReceipt!.asyncTaskId='async-task';async.workRun!.notionReceipt!.pageId='resolved-page';assert.equal(selectedNotionVerification(async),true);async.workRun!.notionReceipt!.asyncTaskId='other-async';assert.equal(selectedNotionVerification(async),false);
});
