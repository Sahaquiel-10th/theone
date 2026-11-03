import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeGameDraft,gameAttemptResolution} from './teachingGameState';
test('a lost response accepted before another tab resets the game unlocks the new round without reissuing',()=>{
 const attempt={operationId:'original',gameRevision:1};
 assert.equal(gameAttemptResolution(attempt,2,[]),'lookup');
 assert.equal(gameAttemptResolution(attempt,2,[],{operationId:'original',gameRevision:1}),'previous_round');
 assert.equal(gameAttemptResolution(attempt,2,[],null),'not_sent');
});
test('unknown receipts retain the original attempt and only exact IDs reconcile',()=>{
 const attempt={operationId:'original',gameRevision:1};
 assert.equal(gameAttemptResolution(attempt,1,[]),'lookup');
 assert.equal(gameAttemptResolution(attempt,1,[],null),'pending');
 assert.equal(gameAttemptResolution(attempt,2,[],{operationId:'different',gameRevision:1}),'lookup');
 assert.equal(gameAttemptResolution(attempt,2,['original']),'accepted');
});
test('same-round lost receipts remain recoverable after other-tab turns push them out of the visible history window',()=>{
 const attempt={operationId:'accepted-before-refresh',gameRevision:3};
 const all=Array.from({length:35},(_,index)=>index===0?attempt.operationId:`later-turn-${index}`),visible=all.slice(-30);
 assert.equal(visible.includes(attempt.operationId),false);
 assert.equal(gameAttemptResolution(attempt,3,visible),'lookup');
 // Both an alias GET and an idempotent POST response can directly confirm the
 // exact accepted receipt; neither requires the visible history to contain it.
 const receipt={operationId:attempt.operationId,gameRevision:3};
 assert.equal(gameAttemptResolution(attempt,3,visible,receipt),'accepted');
 assert.equal(gameAttemptResolution(attempt,3,[],receipt),'accepted');
 // A missing alias leaves the original attempt for an explicit user retry.
 assert.equal(gameAttemptResolution(attempt,3,visible,null),'pending');
});
test('browser game drafts accept only bounded text and a valid exact request receipt',()=>{
 const valid={content:'尚未发送的文字',attempt:{operationId:'game_operation_123456',gameRevision:0,content:'已经发出的行动'}};
 assert.deepEqual(decodeGameDraft(JSON.stringify(valid)),valid);
 assert.deepEqual(decodeGameDraft(JSON.stringify({...valid,teacherPrompt:'not a saved field',attempt:{...valid.attempt,workspaceId:'other'}})),valid);
 assert.deepEqual(decodeGameDraft(JSON.stringify({content:''})),{content:''});
});
test('null, arrays, broken JSON and malformed browser game receipts cannot crash or lock the page',()=>{
 const valid={operationId:'game_operation_123456',gameRevision:0,content:'行动'};
 for(const raw of ['null','[]','42','{',JSON.stringify({content:[]}),JSON.stringify({content:'text',attempt:null}),JSON.stringify({attempt:[]}),JSON.stringify({attempt:{...valid,operationId:3}}),JSON.stringify({attempt:{...valid,content:''}}),JSON.stringify({attempt:{...valid,gameRevision:'1'}}),JSON.stringify({attempt:{...valid,gameRevision:1.5}}),'{"attempt":{"operationId":"game_operation_123456","content":"action","gameRevision":1e999}}'])assert.deepEqual(decodeGameDraft(raw),{});
});
