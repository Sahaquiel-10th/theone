import test from 'node:test';import assert from 'node:assert/strict';
import {responseElapsedSeconds,responseWaitLabel,receiptMayBeMissing,waitingProgress} from './responseProgressState';
test('decorative progress advances gently but never claims completion while pending',()=>{
 const timeline=[0,1000,10000,60000,300000,3600000,Number.MAX_SAFE_INTEGER].map(waitingProgress);
 assert.ok(timeline[0]>0);
 for(let i=0;i<timeline.length;i++){
  assert.ok(timeline[i]<1);
  if(i)assert.ok(timeline[i]>=timeline[i-1]);
 }
 assert.ok(timeline[3]>.5&&timeline[3]<.85);
 for(const bad of [NaN,Infinity,-1])assert.equal(waitingProgress(bad),waitingProgress(0));
});
test('reply waiting time comes only from a valid start timestamp and never estimates completion',()=>{
 const started='2026-10-28T00:00:00.000Z',time=Date.parse(started);
 assert.equal(responseElapsedSeconds(started,time+9999),9);
 assert.equal(responseElapsedSeconds(started,time+66000),66);
 assert.equal(responseElapsedSeconds(started,time-1000),0);
 assert.equal(responseElapsedSeconds(undefined,time),null);
 assert.equal(responseElapsedSeconds('not-a-time',time),null);
 assert.equal(responseElapsedSeconds(started,NaN),null);
});
test('a short wait has no extra copy while longer waits show elapsed seconds or minutes',()=>{
 for(const value of [null,0,9,-1,NaN,Infinity])assert.equal(responseWaitLabel(value),'');
 assert.equal(responseWaitLabel(10),'已等待 10 秒');
 assert.equal(responseWaitLabel(59.9),'已等待 59 秒');
 assert.equal(responseWaitLabel(60),'已等待 1 分 0 秒');
 assert.equal(responseWaitLabel(125),'已等待 2 分 5 秒');
});
test('sending and server-acknowledged operations cannot be classified as missing receipts',()=>{
 assert.equal(receiptMayBeMissing(true,undefined,'op'),false);
 assert.equal(receiptMayBeMissing(false,'op','op'),false);
 assert.equal(receiptMayBeMissing(false,undefined,'op'),true);
 assert.equal(receiptMayBeMissing(false,'other','op'),true);
});
