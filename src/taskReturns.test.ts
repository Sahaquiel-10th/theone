import test from 'node:test';
import assert from 'node:assert/strict';
import {newAutomaticReceiptIds,type Transfer} from './TaskTransferRail';
test('automatic returns exclude prior rounds of the same running task and unrelated old work',()=>{
 const tasks:Transfer[]=[{id:'old',taskId:'ui',title:'UI',state:'completed'},{id:'new',taskId:'ui',title:'UI',state:'completed'},{id:'unrelated',taskId:'other',title:'Other',state:'failed'},{id:'running',taskId:'ui',title:'UI',state:'running'}];
 assert.deepEqual(newAutomaticReceiptIds(tasks,new Set(['old']),new Set(['ui'])),['new']);
 assert.deepEqual(newAutomaticReceiptIds(tasks,new Set(['old','new']),new Set(['ui'])),[]);
 assert.deepEqual(newAutomaticReceiptIds(tasks,new Set(),new Set()),[]);
});
