import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelRequestError,ModelResponseError,type ToolChatResult} from './modelGateway.js';
import {runRecoverableTextModel,TextModelRecoveryError,type TextModelAttempt} from './modelStepRecovery.js';
const digest='a'.repeat(64);
const answer=(extra:Partial<ToolChatResult>={}):ToolChatResult=>({content:'逐字保留的成果',toolCalls:[],finishReason:'stop',...extra});
function fixture(){
 let value:TextModelAttempt|undefined;
 return {load:async()=>value?structuredClone(value):undefined,
 save:async(expected:TextModelAttempt|undefined,next:TextModelAttempt)=>{if(JSON.stringify(value)!==JSON.stringify(expected))return false;value=structuredClone(next);return true;},
 reserve:(attempt:number,micros=100)=>{assert.equal(value?.state,'running');assert.equal(value?.attempt,attempt);value!.reservedMicros=micros;},
 set:(v:TextModelAttempt)=>{value=structuredClone(v);},
 value:()=>value};
}
test('pure model retries once and keeps the unknown cost inside its original cap',async()=>{
 const f=fixture();let calls=0,verifications=0,retries=0;
 const result=await runRecoverableTextModel({digest,...f,verify:async()=>{verifications++;},wait:async()=>{},onRetry:async()=>{retries++;},call:async attempt=>{
  calls++;f.reserve(attempt,120);if(calls===1)throw new ModelRequestError(408,'timeout');
  assert.equal(f.value()!.uncertainMicros,120);return answer();
 }});
 assert.equal(result.content,'逐字保留的成果');assert.equal(calls,2);assert.equal(retries,1);assert.ok(verifications>=5);
 assert.deepEqual(f.value(),{version:1,digest,attempt:2,state:'completed',reservedMicros:0,uncertainMicros:120});
});
for(const status of [401,403,400,402,404])test(`pure model does not retry HTTP ${status}`,async()=>{
 const f=fixture();let calls=0;await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},call:async attempt=>{calls++;f.reserve(attempt);throw new ModelRequestError(status,'safe');}}),ModelRequestError);assert.equal(calls,1);
});
test('empty protocol responses retry at most once; failures retain both upper bounds',async()=>{
 const f=fixture();let calls=0;await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},call:async attempt=>{calls++;f.reserve(attempt);throw new ModelResponseError();}}),ModelResponseError);
 assert.equal(calls,2);assert.equal(f.value()!.uncertainMicros,200);assert.equal(f.value()!.state,'exhausted');
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},call:async()=>{calls++;return answer();}}),TextModelRecoveryError);assert.equal(calls,2);
});
for(const finishReason of ['length','filtered'] as const)test(`${finishReason} keeps returned text without repurchasing a generation`,async()=>{
 const f=fixture();let calls=0;const result=await runRecoverableTextModel({digest,...f,verify:async()=>{},call:async attempt=>{calls++;f.reserve(attempt);return answer({finishReason});}});assert.equal(calls,1);assert.equal(result.content,'逐字保留的成果');assert.equal(result.finishReason,finishReason);
});
test('a later reservation cannot exceed the remaining cap after an uncertain first call',async()=>{
 const f=fixture();let purchased=0;await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},call:async attempt=>{
  if(f.value()!.uncertainMicros+100>100)throw new Error('budget exhausted');
  f.reserve(attempt);purchased++;throw new ModelRequestError(503,'safe');
 }}),/budget exhausted/);assert.equal(purchased,1);assert.equal(f.value()!.uncertainMicros,100);
});
test('cancellation after the first failure prevents the second call',async()=>{
 const f=fixture();let stopped=false,calls=0;await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{if(stopped)throw Error('cancelled');},wait:async()=>{},call:async attempt=>{calls++;f.reserve(attempt);stopped=true;throw new ModelRequestError(502,'safe');}}),/cancelled/);assert.equal(calls,1);
});
test('simultaneous wakes cannot claim the same pure model stage twice',async()=>{
 const f=fixture();let calls=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const options={digest,...f,verify:async()=>{},call:async(attempt:number)=>{calls++;f.reserve(attempt);await gate;return answer();}};
 const first=runRecoverableTextModel(options);await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(()=>runRecoverableTextModel(options),TextModelRecoveryError);release();await first;assert.equal(calls,1);
});
test('stale claims and different input digests never restart a model silently',async()=>{
 for(const state of ['running','completed','exhausted'] as const){const f=fixture();f.set({version:1,digest,attempt:1,state,reservedMicros:100,uncertainMicros:0});await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},call:async()=>{throw Error('must not run');}}),TextModelRecoveryError);}
 const f=fixture();f.set({version:1,digest:'b'.repeat(64),attempt:1,state:'retryable',reservedMicros:0,uncertainMicros:100});await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},call:async()=>{throw Error('must not run');}}),TextModelRecoveryError);
});
