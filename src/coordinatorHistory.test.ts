import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCoordinatorLinks,mergeCoordinatorMessages} from './coordinatorHistory';
test('polling cannot discard loaded history or duplicate repeated messages and task links',()=>{
 const all=Array.from({length:100},(_,i)=>({id:`m${i}`,role:'user' as const,content:String(i),createdAt:String(i).padStart(5,'0')}));
 let loaded=mergeCoordinatorMessages(all.slice(20,60),all.slice(60));assert.equal(loaded.length,80);
 loaded=mergeCoordinatorMessages(loaded,[...all.slice(61),{id:'m100',role:'assistant',content:'new result',createdAt:'00100'}]);assert.equal(loaded.length,81);assert.equal(loaded[0].id,'m20');assert.equal(loaded.at(-1)!.id,'m100');
 const links=[{messageId:'m21',taskId:'t1'}];assert.equal(mergeCoordinatorLinks(links,[...links,{messageId:'m99',taskId:'t2'}]).length,2);
});
