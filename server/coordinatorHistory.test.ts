import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorHistoryPage} from './coordinatorHistory.js';
import type {Conversation} from './types.js';
test('display history pages all stored messages, survives concurrent arrivals and rejects unknown cursors',()=>{
 const messages=Array.from({length:103},(_,i)=>({id:`m${i}`,role:i%2?'assistant' as const:'user' as const,content:`message ${i}`,createdAt:String(i).padStart(5,'0')}));
 const c={id:'main',messages} as Conversation;
 const newest=coordinatorHistoryPage(c);assert.equal(newest.messages.length,40);assert.equal(newest.messages[0].id,'m63');assert.equal(newest.history.total,103);
 c.messages.push({id:'new',role:'user',content:'new arrival',createdAt:'99999'});
 const older=coordinatorHistoryPage(c,newest.history.before);assert.equal(older.messages[0].id,'m23');assert.equal(older.messages.at(-1)!.id,'m62');
 const first=coordinatorHistoryPage(c,older.history.before);assert.equal(first.messages.length,23);assert.equal(first.history.hasMore,false);
 assert.equal(new Set([...first.messages,...older.messages,...newest.messages].map(m=>m.id)).size,103);
 assert.throws(()=>coordinatorHistoryPage(c,'foreign-message'),/位置已变化/);assert.throws(()=>coordinatorHistoryPage(c,[]),/位置不正确/);assert.equal(coordinatorHistoryPage(undefined).history.hasMore,false);
});
