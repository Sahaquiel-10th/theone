import test from 'node:test';
import assert from 'node:assert/strict';
import {operationProgress,readAttempt,readFailureRecovery,transientReadFailure,validOperationEvidence,type OperationEvidence} from './operationRecovery.js';
const now=Date.parse('2026-11-03T00:00:00.000Z');
test('transport recovery accepts explicit transient facts and refuses authentication, input, cancellation and message heuristics',()=>{
 for(const status of [408,429,500,502,503,504])assert.ok(transientReadFailure({status}));
 for(const status of [400,401,402,403,404,409])assert.equal(transientReadFailure({status}),undefined);
 for(const code of ['ETIMEDOUT','ECONNRESET','UND_ERR_CONNECT_TIMEOUT'])assert.ok(transientReadFailure(Object.assign(new Error('PRIVATE'),{code})));
 for(const value of [new Error('timeout HTTP 502 Bearer PRIVATE'),{name:'AbortError'},{code:'invalid_input'},{status:'unavailable'},{status:'failed'},null])assert.equal(transientReadFailure(value),undefined);
 assert.equal(transientReadFailure({status:'failed',chunks:[],failures:[{code:'TIMEOUT',retryable:true,message:'PRIVATE'}]}),'timeout');
 assert.equal(transientReadFailure({status:'failed',chunks:[],failures:[{code:'TIMEOUT',retryable:true},{code:'AUTHORIZATION_REQUIRED',retryable:false}]}),undefined);
 assert.equal(transientReadFailure({status:'partial',chunks:[{content:'已取得素材'}],failures:[{code:'TIMEOUT',retryable:true}]}),undefined);
});
test('retry budget is durable, strictly bounded and cannot be extended by a provider response',()=>{
 const first=readAttempt(1,now),waiting=readFailureRecovery(first,'timeout',now);
 assert.equal(waiting.attempt,1);assert.equal(Date.parse(waiting.nextRetryAt)-now,2000);
 assert.throws(()=>readAttempt(2,now+1999,waiting));
 const second=readAttempt(2,now+2000,waiting),third=readAttempt(3,now+10000,readFailureRecovery(second,'busy',now+2000));
 const exhausted=readFailureRecovery(third,'unavailable',now+10000);
 assert.equal(exhausted.state,'exhausted');assert.throws(()=>readAttempt(4,now+20000,exhausted));
 assert.throws(()=>readAttempt(2,now+120000,waiting));
 for(const change of [{maxAttempts:9},{attempt:0},{attempt:4},{nextRetryAt:'bad'},{deadlineAt:new Date(now+121000).toISOString()},{secret:'private'}])assert.equal(validOperationEvidence({version:1,execution:'failed',verification:'not_required',recovery:{...waiting,...change}}),false);
});
test('execution, validation and public recovery are separate from bodies or provider-specific fields',()=>{
 const bodyRef='a'.repeat(64),complete:OperationEvidence={version:1,execution:'succeeded',verification:'verified',artifactRef:bodyRef};
 assert.equal(validOperationEvidence(complete),true);
 assert.deepEqual(operationProgress(complete),{execution:'succeeded',verification:'verified',resultAvailable:true});
 const pending:OperationEvidence={version:1,execution:'submitted',verification:'pending'};
 assert.deepEqual(operationProgress(pending),{execution:'submitted',verification:'pending',resultAvailable:false});
 const waiting:OperationEvidence={version:1,execution:'failed',verification:'not_required',recovery:readFailureRecovery(readAttempt(1,now),'timeout',now)};
 const view=operationProgress(waiting);assert.equal(view?.recovery?.state,'scheduled');assert.doesNotMatch(JSON.stringify(view),new RegExp(bodyRef));
 assert.equal(validOperationEvidence({...pending,artifactRef:bodyRef}),false);
 assert.equal(validOperationEvidence({...complete,execution:'failed'}),false);
});

test('a confirmed artifact remains available through independent background checks',()=>{
 const artifactRef='b'.repeat(64);
 for(const verification of ['pending','failed','verified','not_required'] as const){
  const evidence:OperationEvidence={version:1,execution:'succeeded',verification,artifactRef};
  assert.equal(validOperationEvidence(evidence),true);
  assert.deepEqual(operationProgress(evidence),{execution:'succeeded',verification,resultAvailable:true});
 }
 for(const execution of ['running','submitted','failed','unknown'] as const){
  assert.equal(validOperationEvidence({version:1,execution,verification:'pending',artifactRef}),false);
 }
});
