import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchWithSafeRetries} from './providerRetry.js';
test('explicit rejection retries twice with backoff and returns only one accepted response',async()=>{
  let calls=0,checks=0;const delays:number[]=[],notices:number[]=[];
  const result=await fetchWithSafeRetries('https://example.test',{}, {fetch:async()=>new Response('',{status:++calls<3?429:200}),beforeRetry:async()=>{checks++;},wait:async ms=>{delays.push(ms);},onRetry:async n=>{notices.push(n.attempt);}});
  assert.equal(result.status,200);assert.equal(calls,3);assert.equal(checks,2);assert.deepEqual(delays,[2000,5000]);assert.deepEqual(notices,[1,2]);
});
test('ambiguous network errors, server errors and accepted streams are never replayed',async()=>{
  for(const status of [200,400,401,403,500,502,503,504]){let calls=0;await fetchWithSafeRetries('https://example.test',{}, {fetch:async()=>{calls++;return new Response('',{status});}});assert.equal(calls,1);}
  let calls=0;await assert.rejects(fetchWithSafeRetries('https://example.test',{}, {fetch:async()=>{calls++;throw new Error('network');}}));assert.equal(calls,1);
});
test('stop, revoked access and exhausted rate limits cannot cause an extra attempt',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(fetchWithSafeRetries('https://example.test',{signal:controller.signal},{fetch:async()=>{calls++;return new Response('',{status:429});},wait:async()=>controller.abort()}));assert.equal(calls,1);
  calls=0;await assert.rejects(fetchWithSafeRetries('https://example.test',{}, {fetch:async()=>{calls++;return new Response('',{status:429});},beforeRetry:async()=>{throw new Error('revoked');},wait:async()=>{}}));assert.equal(calls,1);
  calls=0;const last=await fetchWithSafeRetries('https://example.test',{}, {fetch:async()=>{calls++;return new Response('',{status:429});},wait:async()=>{}});assert.equal(calls,3);assert.equal(last.status,429);
});
test('long Retry-After does not retry early',async()=>{let calls=0;const response=await fetchWithSafeRetries('https://example.test',{}, {fetch:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'60'}});}});assert.equal(calls,1);assert.equal(response.status,429);});
