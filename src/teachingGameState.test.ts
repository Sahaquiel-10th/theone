import test from 'node:test';
import assert from 'node:assert/strict';
import {gameAttemptResolution} from './teachingGameState';
test('a lost response accepted before another tab resets the game unlocks the new round without reissuing',()=>{
 const attempt={operationId:'original',gameRevision:1};
 assert.equal(gameAttemptResolution(attempt,2,[]),'lookup');
 assert.equal(gameAttemptResolution(attempt,2,[],{operationId:'original',gameRevision:1}),'previous_round');
 assert.equal(gameAttemptResolution(attempt,2,[],null),'not_sent');
});
test('unknown receipts retain the original attempt and only exact IDs reconcile',()=>{
 const attempt={operationId:'original',gameRevision:1};
 assert.equal(gameAttemptResolution(attempt,1,[]),'pending');
 assert.equal(gameAttemptResolution(attempt,2,[],{operationId:'different',gameRevision:1}),'lookup');
 assert.equal(gameAttemptResolution(attempt,2,['original']),'accepted');
});
