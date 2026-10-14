import test from 'node:test';
import assert from 'node:assert/strict';
import {newAutomaticReceiptIds,visibleTransfers,presentationTransfers,transferFeedbackLabel,type Transfer} from './TaskTransferRail';
import {taskCategory,taskUiOutcome} from './taskAttention';
test('unreported receipts survive refresh even without having observed the task running',()=>{
 const tasks:Transfer[]=[{id:'old',taskId:'ui',title:'UI',state:'completed',reported:true},{id:'new',taskId:'ui',title:'UI',state:'completed',reported:false},{id:'failed',taskId:'other',title:'Other',state:'failed',reported:false},{id:'running',taskId:'ui',title:'UI',state:'running',reportable:false}];
 assert.deepEqual(newAutomaticReceiptIds(tasks),['new','failed']);
 assert.deepEqual(newAutomaticReceiptIds(tasks.map(t=>({...t,reported:true}))),[]);
 assert.equal(visibleTransfers(tasks).find(t=>t.taskId==='ui')?.state,'running');
 assert.equal(visibleTransfers(tasks.filter(t=>t.reported)).length,0);
});
test('reporting a result does not make it read; unviewed completed work remains reviewable',()=>{
 assert.equal(taskCategory({unread:true,outcome:'completed',isTask:true}),'review');
 assert.equal(taskCategory({unread:false,outcome:'completed',isTask:true}),'ended');
 assert.equal(taskCategory({unread:true,active:true,isTask:true}),'active');
 assert.equal(taskCategory({paused:true,active:true,isTask:true}),'review');
 assert.equal(taskCategory({outcome:'partial',isTask:true}),'review');
 assert.equal(taskCategory({}),'history');
});
test('local process completion cannot override an unknown or needs-confirmation receipt',()=>{
 assert.equal(taskUiOutcome({localStatus:'completed',receiptOutcome:'needs_input'}),'needs_input');
 assert.equal(taskUiOutcome({localStatus:'completed',receiptOutcome:'returned'}),'returned');
 assert.equal(taskUiOutcome({localStatus:'completed'}),'returned');
 assert.equal(taskUiOutcome({localStatus:'running',receiptOutcome:'returned'}),'running');
 assert.equal(taskUiOutcome({paused:true,localStatus:'running'}),'paused');
});
test('acknowledged cards animate from a captured batch even after refreshed server flags hide them',()=>{
 const returning:Transfer={id:'fresh',taskId:'ui',title:'UI',state:'returned',reported:false};
 const unrelated:Transfer={id:'old',taskId:'other',title:'Old',state:'completed',reported:true};
 const refreshed=[{...returning,reported:true},unrelated];
 assert.deepEqual(presentationTransfers(refreshed,new Set(['fresh']),[returning]).map(t=>t.id),['fresh']);
 assert.deepEqual(presentationTransfers(refreshed,new Set(['fresh']),[]),[]);
 const next:Transfer={id:'next',taskId:'ui',title:'UI 下一轮',state:'running'};
 assert.deepEqual(presentationTransfers([...refreshed,next],new Set(['fresh']),[returning]).map(t=>t.id),['next']);
});
test('waiting, permission and unsuccessful results never imply success',()=>{
 const base={id:'a',taskId:'a',title:'任务'};
 assert.equal(transferFeedbackLabel({...base,state:'waiting'}),'等待前一步完成');
 assert.equal(transferFeedbackLabel({...base,state:'prepared_local'}),'等待确认本机执行');
 assert.equal(transferFeedbackLabel({...base,state:'completed',outcome:'needs_input'}),'需要你补充信息');
 assert.equal(transferFeedbackLabel({...base,state:'completed',outcome:'failed'}),'未完成，查看原因');
 assert.equal(transferFeedbackLabel({...base,state:'returned'}),'结果已返回，查看内容');
 assert.deepEqual(newAutomaticReceiptIds([{...base,state:'returned'},{...base,id:'b',state:'needs_input'},{...base,id:'c',state:'partial'}]),['a','b','c']);
});
