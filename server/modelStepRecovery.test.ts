import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelRequestError,ModelResponseError,type ToolChatResult} from './modelGateway.js';
import {runRecoverableTextModel,TextModelRecoveryError,type TextModelAttempt} from './modelStepRecovery.js';
const digest='a'.repeat(64);
const answer=(extra:Partial<ToolChatResult>={}):ToolChatResult=>({content:'逐字保留的成果',toolCalls:[],finishReason:'stop',...extra});
const unexpectedTools=()=>answer({content:'准备开始处理。',finishReason:'tool_calls',toolCalls:[{id:'private-call',type:'function',function:{name:'private-tool-name',arguments:'{"private":"never-persist-this"}'}}]});
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
test('a real unexpected tool response receives one text correction without uncertain billing',async()=>{
 const f=fixture();const corrections:(string|undefined)[]=[],retryReasons:(string|undefined)[]=[];let calls=0;
 const result=await runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},onRetry:async reason=>{retryReasons.push(reason);},call:async(attempt,correction)=>{
  calls++;corrections.push(correction);f.reserve(attempt,120);
  assert.equal(f.value()!.uncertainMicros,0);
  return calls===1?unexpectedTools():answer();
 }});
 assert.equal(result.content,'逐字保留的成果');assert.equal(calls,2);
 assert.deepEqual(corrections,[undefined,'unexpected_tools']);assert.deepEqual(retryReasons,['unexpected_tools']);
 assert.deepEqual(f.value(),{version:1,digest,attempt:2,state:'completed',reservedMicros:0,uncertainMicros:0,retryReason:'unexpected_tools',responseDiagnostic:{attempt:1,toolCallCount:1,contentChars:7,finishReason:'tool_calls'}});
 assert.doesNotMatch(JSON.stringify(f.value()),/private-tool|private-call|never-persist|准备开始/);
});
test('tool calls with a stop reason and tool finish without calls both receive bounded correction',async()=>{
 for(const response of [answer({toolCalls:unexpectedTools().toolCalls}),answer({finishReason:'tool_calls',toolCalls:[]})]){
  const f=fixture();let calls=0;
  await runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},call:async(attempt,correction)=>{
   calls++;f.reserve(attempt);if(calls===1)return response;
   assert.equal(correction,'unexpected_tools');return answer();
  }});
  assert.equal(calls,2);assert.equal(f.value()!.responseDiagnostic!.toolCallCount,response.toolCalls.length);
 }
});
test('repeated unexpected tool responses return the last response after two paid attempts',async()=>{
 const f=fixture();let calls=0;
 const result=await runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},call:async attempt=>{calls++;f.reserve(attempt);return unexpectedTools();}});
 assert.equal(result.finishReason,'tool_calls');assert.equal(calls,2);assert.equal(f.value()!.state,'exhausted');assert.equal(f.value()!.uncertainMicros,0);assert.equal(f.value()!.responseDiagnostic!.attempt,2);
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},call:async()=>{calls++;return answer();}}),TextModelRecoveryError);assert.equal(calls,2);
});
test('a network retry followed by tools consumes the same two-attempt ceiling',async()=>{
 const f=fixture();let calls=0;const reasons:(string|undefined)[]=[];
 const result=await runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},onRetry:async reason=>{reasons.push(reason);},call:async(attempt,correction)=>{
  calls++;f.reserve(attempt);assert.equal(correction,undefined);if(calls===1)throw new ModelRequestError(502,'safe');return unexpectedTools();
 }});
 assert.equal(result.finishReason,'tool_calls');assert.equal(calls,2);assert.deepEqual(reasons,[undefined]);assert.equal(f.value()!.state,'exhausted');assert.equal(f.value()!.uncertainMicros,100);
});
test('a correction followed by network failure retains only the second uncertain reservation',async()=>{
 const f=fixture();let calls=0;
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},call:async attempt=>{
  calls++;f.reserve(attempt);if(calls===1)return unexpectedTools();throw new ModelRequestError(503,'safe');
 }}),ModelRequestError);
 assert.equal(calls,2);assert.equal(f.value()!.state,'exhausted');assert.equal(f.value()!.uncertainMicros,100);assert.equal(f.value()!.responseDiagnostic!.attempt,1);
});
test('durable correction intent survives a restart before the next purchase',async()=>{
 const f=fixture();let calls=0;
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},onRetry:async()=>{throw Error('interrupted after checkpoint');},call:async attempt=>{calls++;f.reserve(attempt);return unexpectedTools();}}),/interrupted after checkpoint/);
 assert.equal(f.value()!.state,'retryable');assert.equal(f.value()!.retryReason,'unexpected_tools');
 await runRecoverableTextModel({digest,...f,verify:async()=>{},call:async(attempt,correction)=>{calls++;assert.equal(attempt,2);assert.equal(correction,'unexpected_tools');f.reserve(attempt);return answer();}});
 assert.equal(calls,2);assert.equal(f.value()!.state,'completed');
});
test('legacy retry checkpoints remain readable without a correction reason',async()=>{
 const f=fixture();f.set({version:1,digest,attempt:1,state:'retryable',reservedMicros:0,uncertainMicros:100});
 await runRecoverableTextModel({digest,...f,verify:async()=>{},call:async(attempt,correction)=>{assert.equal(attempt,2);assert.equal(correction,undefined);f.reserve(attempt);return answer();}});
 assert.equal(f.value()!.state,'completed');assert.equal(f.value()!.uncertainMicros,100);
});
test('cancellation during correction notification prevents another purchase',async()=>{
 const f=fixture();let cancelled=false,calls=0;
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{if(cancelled)throw Error('cancelled');},wait:async()=>{},onRetry:async()=>{cancelled=true;},call:async attempt=>{calls++;f.reserve(attempt);return unexpectedTools();}}),/cancelled/);
 assert.equal(calls,1);assert.equal(f.value()!.state,'retryable');
});
test('remaining budget can stop a correction before another reservation',async()=>{
 const f=fixture();let purchases=0,charged=0;
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{},call:async attempt=>{
  if(charged+100>100)throw Error('budget exhausted');f.reserve(attempt);purchases++;charged+=100;return unexpectedTools();
 }}),/budget exhausted/);
 assert.equal(purchases,1);assert.equal(f.value()!.state,'exhausted');assert.equal(f.value()!.uncertainMicros,0);assert.equal(f.value()!.responseDiagnostic!.attempt,1);
});
test('simultaneous recovery wakes share the final correction claim',async()=>{
 const f=fixture();let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const first=runRecoverableTextModel({digest,...f,verify:async()=>{},wait:async()=>{await gate;},call:async attempt=>{calls++;f.reserve(attempt);return unexpectedTools();}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.value()!.state,'retryable');
 const second=await runRecoverableTextModel({digest,...f,verify:async()=>{},call:async(attempt,correction)=>{calls++;assert.equal(correction,'unexpected_tools');f.reserve(attempt);return answer();}});
 assert.equal(second.content,'逐字保留的成果');release();await assert.rejects(()=>first,TextModelRecoveryError);assert.equal(calls,2);
});
test('filtered responses keep their terminal contract even with contradictory tool metadata',async()=>{
 const f=fixture();let calls=0;
 const result=await runRecoverableTextModel({digest,...f,verify:async()=>{},call:async attempt=>{calls++;f.reserve(attempt);return {...unexpectedTools(),finishReason:'filtered'};}});
 assert.equal(calls,1);assert.equal(result.finishReason,'filtered');assert.equal(f.value()!.state,'completed');
});
test('malformed persisted correction diagnostics never start another call',async()=>{
 const f=fixture();f.set({version:1,digest,attempt:1,state:'retryable',reservedMicros:0,uncertainMicros:0,retryReason:'unexpected_tools',responseDiagnostic:{attempt:1,toolCallCount:-1,contentChars:100}});
 await assert.rejects(()=>runRecoverableTextModel({digest,...f,verify:async()=>{},call:async()=>{throw Error('must not call');}}),TextModelRecoveryError);
});
