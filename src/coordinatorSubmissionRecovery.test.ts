import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverCoordinatorSubmission,invalidCoordinatorReceipt,unacceptedCoordinatorFailure} from './coordinatorSubmissionRecovery';
import {isCoordinatorReceipt,type CoordinatorReceipt} from './coordinatorHistory';
import {ApiError} from './oneApi';
const reply={id:'reply',role:'assistant' as const,content:'saved result',createdAt:'2026-10-30T00:00:00Z'};
const completed=():CoordinatorReceipt=>({status:'completed',message:reply,conversation:{id:'main',userId:'user',workspaceId:'workspace',modelId:'model',title:'ONE',archived:false,createdAt:reply.createdAt,updatedAt:reply.createdAt,messages:[reply]}});

function fixture(){
  let known:CoordinatorReceipt|undefined,feedback:string|undefined;let reads=0,refreshes=0;
  const accept=(receipt:CoordinatorReceipt)=>{if(!isCoordinatorReceipt(receipt))throw invalidCoordinatorReceipt();if(known?.status==='completed')return;known=receipt;feedback=receipt.status==='failed'?receipt.error:receipt.status==='interrupted'?'stopped':undefined;};
  const input:Parameters<typeof recoverCoordinatorSubmission>[0]={isCurrent:()=>true,known:()=>known,refresh:async()=>{refreshes++;},read:async()=>{reads++;throw new TypeError('Failed to fetch');},accept,unknown:failure=>{feedback=failure.code;},error:new TypeError('Failed to fetch')};
  return{input,accept,get known(){return known;},get feedback(){return feedback;},get reads(){return reads;},get refreshes(){return refreshes;}};
}
test('a completion found during refresh wins even when the next receipt read would fail',async()=>{
  const f=fixture();f.input.refresh=async()=>{f.accept(completed());};
  assert.equal((await recoverCoordinatorSubmission(f.input))?.status,'completed');
  assert.equal(f.reads,0);assert.equal(f.feedback,undefined);
});
test('a concurrent completion wins over an independent failed read',async()=>{
  const f=fixture();f.input.read=async()=>{f.accept(completed());throw new Error('lost response');};
  assert.equal((await recoverCoordinatorSubmission(f.input))?.status,'completed');assert.equal(f.feedback,undefined);
});
test('a confirmed pending receipt stays pending without failure feedback',async()=>{
  const f=fixture();f.input.read=async()=>({status:'pending'});
  const receipt=await recoverCoordinatorSubmission(f.input);
  assert.equal(receipt?.status,'pending');assert.equal(f.feedback,undefined);
});
test('specific failed and interrupted receipts cannot be overwritten by the original transport error',async()=>{
  for(const receipt of [{status:'failed',error:'Notion needs reconnection'},{status:'interrupted'}]){
    const f=fixture();f.input.read=async()=>receipt;
    await recoverCoordinatorSubmission(f.input);
    assert.equal(f.known?.status,receipt.status);assert.equal(f.feedback,receipt.status==='failed'?receipt.error:'stopped');
  }
});
test('invalid successful payloads never settle, and retain the operation for another read',async()=>{
  for(const receipt of [{},null,[],{status:'queued'},{status:'failed',error:{}},{status:'completed'},{status:'completed',conversation:{messages:[]}}]){
    const f=fixture();f.input.read=async()=>receipt as CoordinatorReceipt;
    await recoverCoordinatorSubmission(f.input);
    assert.equal(f.known,undefined);assert.equal(f.feedback,'invalid_receipt');
    f.input.read=async()=>completed();
    await recoverCoordinatorSubmission(f.input);assert.equal((f.known as CoordinatorReceipt|undefined)?.status,'completed');assert.equal(f.feedback,undefined);
  }
});
test('unknown reads show a receipt-stage uncertainty and remain recoverable without replay',async()=>{
  const f=fixture();await recoverCoordinatorSubmission(f.input);
  assert.equal(f.known,undefined);assert.equal(f.feedback,'transport_unknown');
  f.input.read=async()=>completed();
  await recoverCoordinatorSubmission(f.input);assert.equal((f.known as CoordinatorReceipt|undefined)?.status,'completed');assert.equal(f.feedback,undefined);
});
test('an invalid JSON ApiError keeps its structured invalid-receipt cause',async()=>{
  const f=fixture();f.input.read=async()=>{throw new ApiError('invalid',undefined,200,'INVALID_RESPONSE',false,{code:'invalid_receipt',stage:'receipt',outcome:'unknown'});};
  await recoverCoordinatorSubmission(f.input);assert.equal(f.feedback,'invalid_receipt');
});
test('an account switch during refresh never reads or updates the replacement scope',async()=>{
  const f=fixture();let current=true;f.input.isCurrent=()=>current;f.input.refresh=async()=>{current=false;};
  await recoverCoordinatorSubmission(f.input);assert.equal(f.reads,0);assert.equal(f.feedback,undefined);
});

test('Key and account errors stay explicit while receipt outcome remains unknown',async()=>{
  for(const code of ['key_required','account_unavailable'] as const){
    const f=fixture();let failure:unknown;
    f.input.read=async()=>{throw new ApiError('blocked',undefined,428,'BLOCKED',false,{code,stage:'accepting',outcome:'not_started'});};
    f.input.unknown=value=>{failure=value;};await recoverCoordinatorSubmission(f.input);
    assert.deepEqual(failure,{code,stage:'receipt',outcome:'unknown'});assert.equal(f.known,undefined);
  }
});

test('only an explicit reviewed not-started rejection bypasses receipt recovery',()=>{
 const failure={code:'local_attachments_unsupported' as const,stage:'accepting' as const,outcome:'not_started' as const};
 assert.deepEqual(unacceptedCoordinatorFailure(new ApiError('rejected',undefined,428,'REJECTED',false,failure,false)),failure);
 for(const value of [new ApiError('unknown',undefined,428,'REJECTED',false,failure),new ApiError('unknown',undefined,409,'REJECTED',false,{...failure,outcome:'unknown'},false),new ApiError('unknown',undefined,502,'REJECTED',false,failure,false),new ApiError('unknown',undefined,400,'REJECTED',false,undefined,false),new Error('not started')])assert.equal(unacceptedCoordinatorFailure(value),undefined);
});
