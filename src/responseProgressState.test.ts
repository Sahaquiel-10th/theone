import test from 'node:test';import assert from 'node:assert/strict';
import {waitingProgress,receiptMayBeMissing} from './responseProgressState';
test('estimated waiting fill advances monotonically, varies speed, and never claims completion',()=>{
 let previous=0;for(let ms=0;ms<3600000;ms+=400){const next=waitingProgress(ms,previous);assert.ok(next>=previous&&next<100);previous=next;}
 assert.ok(waitingProgress(10000)-waitingProgress(0)>waitingProgress(120000)-waitingProgress(110000));
 assert.equal(waitingProgress(0,60),60);
});
test('sending and server-acknowledged operations cannot be classified as missing receipts',()=>{
 assert.equal(receiptMayBeMissing(true,undefined,'op'),false);
 assert.equal(receiptMayBeMissing(false,'op','op'),false);
 assert.equal(receiptMayBeMissing(false,undefined,'op'),true);
 assert.equal(receiptMayBeMissing(false,'other','op'),true);
});
