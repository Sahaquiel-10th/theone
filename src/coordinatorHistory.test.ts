import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCoordinatorLinks,mergeCoordinatorMessages,mergeCoordinatorReceipt,seedCoordinatorReceipt,coordinatorHistoryCursor} from './coordinatorHistory';
import type {Conversation} from '../server/types';
test('polling cannot discard loaded history or duplicate repeated messages and task links',()=>{
 const all=Array.from({length:100},(_,i)=>({id:`m${i}`,role:'user' as const,content:String(i),createdAt:String(i).padStart(5,'0')}));
 let loaded=mergeCoordinatorMessages(all.slice(20,60),all.slice(60));assert.equal(loaded.length,80);
 loaded=mergeCoordinatorMessages(loaded,[...all.slice(61),{id:'m100',role:'assistant',content:'new result',createdAt:'00100'}]);assert.equal(loaded.length,81);assert.equal(loaded[0].id,'m20');assert.equal(loaded.at(-1)!.id,'m100');
 const links=[{messageId:'m21',taskId:'t1'}];assert.equal(mergeCoordinatorLinks(links,[...links,{messageId:'m99',taskId:'t2'}]).length,2);
});

const conversation=(messages:Conversation['messages'],updatedAt='2026-10-25T01:00:00Z'):Conversation=>({id:'main',workspaceId:'workspace-a',userId:'user-a',modelId:'model',archived:false,title:'ONE',messages,createdAt:'2026-10-25T00:00:00Z',updatedAt});
const message=(id:string,content=id):Conversation['messages'][number]=>({id,role:'assistant',content,createdAt:`2026-10-25T01:00:${id.padStart(2,'0')}Z`});

test('a completed receipt directly supplies the saved reply and clears its stale snapshot pending flag',()=>{
 const previous=message('01'),result=message('02','结果已保存在原任务');
 const old={conversation:conversation([previous]),pendingOperationId:'original',links:[{messageId:'01',taskId:'other'}],tasks:['retained']};
 const receipt={status:'completed',conversation:conversation([previous,result]),message:result,taskIds:['task-a','task-b','task-a']};
 const next=mergeCoordinatorReceipt(old,'original',receipt);
 assert.equal(next.pendingOperationId,undefined);assert.deepEqual(next.conversation?.messages,[previous,result]);assert.deepEqual(next.tasks,['retained']);
 assert.deepEqual(next.links,[{messageId:'01',taskId:'other'},{messageId:'02',taskId:'task-a'},{messageId:'02',taskId:'task-b'}]);
 assert.deepEqual(mergeCoordinatorReceipt(next,'original',receipt),next,'polling the original receipt is idempotent');
 assert.equal(old.pendingOperationId,'original','previous state is immutable');
});

test('an older receipt cannot erase a newer operation, task result report or loaded history',()=>{
 const early=message('00'),oldReply=message('01','old text'),newReply=message('01','newly merged task report');
 const snapshot={conversation:conversation([early,newReply,message('03')],'2026-10-25T01:10:00Z'),pendingOperationId:'new-operation',links:[]};
 const next=mergeCoordinatorReceipt(snapshot,'old-operation',{status:'completed',conversation:conversation([oldReply]),message:oldReply});
 assert.equal(next.pendingOperationId,'new-operation');assert.equal(next.conversation?.updatedAt,snapshot.conversation.updatedAt);
 assert.deepEqual(next.conversation?.messages,snapshot.conversation.messages);
});

test('receipt recovery keeps lazy history bounded and cannot import a different conversation',()=>{
 const history=Array.from({length:100},(_,i)=>message(String(i)));
 const next=mergeCoordinatorReceipt({conversation:conversation([])},'operation',{status:'completed',conversation:conversation(history),message:history.at(-1)});
 assert.equal(next.conversation?.messages.length,40);
 const unrelated={conversation:conversation([message('01')]),pendingOperationId:'operation'};
 const result=mergeCoordinatorReceipt(unrelated,'operation',{status:'completed',conversation:{...conversation([message('02')]),id:'different'}});
 assert.deepEqual(result.conversation,unrelated.conversation);
 assert.equal(result.pendingOperationId,undefined);
});

test('an authorized completed receipt seeds a visible first reply when the initial snapshot never returns',()=>{
 const reply=message('01','已经找到原来的真实结果');
 const seed=seedCoordinatorReceipt('user-a','original-operation',{status:'completed',conversation:conversation([reply]),message:reply,taskIds:['task']});
 assert.equal(seed?.enabled,true);assert.equal(seed?.clientScope,'user-a');assert.deepEqual(seed?.conversation?.messages,[reply]);assert.deepEqual(seed?.links,[{messageId:'01',taskId:'task'}]);
 assert.equal(seedCoordinatorReceipt('user-a','original-operation',{status:'pending'}),null);
 const explicitlyEmpty={conversation:null,pendingOperationId:'original-operation'};
 assert.equal(mergeCoordinatorReceipt(explicitlyEmpty,'original-operation',{status:'completed',conversation:conversation([reply]),message:reply}).conversation,null,'a later explicit empty snapshot cannot resurrect a removed conversation');
});

test('a long-suspended window exposes a cursor to fill the gap rather than silently hiding older messages',()=>{
 const old=Array.from({length:10},(_,i)=>message(String(i)));
 const recent=Array.from({length:40},(_,i)=>message(String(i+50)));
 assert.deepEqual(coordinatorHistoryCursor(old,recent,{hasMore:false,before:'0',total:10},{hasMore:true,before:'50',total:90}),{hasMore:true,before:'50',total:90});
 const loaded=Array.from({length:50},(_,i)=>message(String(i+10)));
 assert.deepEqual(coordinatorHistoryCursor(loaded,recent,{hasMore:true,before:'10',total:60},{hasMore:true,before:'50',total:90}),{hasMore:true,before:'10',total:90},'overlapping polls preserve already loaded history');
});
