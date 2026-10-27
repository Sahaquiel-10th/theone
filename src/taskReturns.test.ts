import test from 'node:test';
import assert from 'node:assert/strict';
import {newAutomaticReceiptIds,visibleTransfers,presentationTransfers,transferFeedbackLabel,type Transfer} from './TaskTransferRail';
import {taskCategory,taskUiOutcome,taskEntrySelection} from './taskAttention';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskTransferRail,dismissibleReceiptIds} from './TaskTransferRail';
test('closing a task captures all displayed older receipts, not unrelated, active or future results',()=>{
 const cards:Transfer[]=[{id:'old',taskId:'one',title:'方案',state:'failed'},{id:'last',taskId:'one',title:'方案',state:'cancelled'},{id:'other',taskId:'two',title:'其他',state:'failed'},{id:'running',taskId:'one',title:'方案',state:'running',reportable:false}];
 const captured=dismissibleReceiptIds(cards,'one');assert.deepEqual(captured,['old','last']);
 cards.push({id:'future',taskId:'one',title:'方案',state:'returned'});assert.deepEqual(captured,['old','last']);
});
test('the sidebar offers a visible dismiss action and read-all disappears after review',()=>{
 const task:Transfer={id:'receipt',taskId:'one',title:'测试方案',state:'failed',read:false};
 const html=renderToStaticMarkup(createElement(TaskTransferRail,{tasks:[task],busy:false,onOpen:()=>{},onDismiss:async()=>{},onReadAll:async()=>{}}));
 assert.match(html,/收起测试方案的提醒/);assert.match(html,/全部标为已读/);
 assert.equal(renderToStaticMarkup(createElement(TaskTransferRail,{tasks:[{...task,read:true}],busy:false,onOpen:()=>{}})),'');
});
test('read or dismissed results leave the rail, without consuming a future round or active work',()=>{
 const task:Transfer={id:'old',taskId:'one',title:'方案',state:'failed',read:true,reported:false};
 assert.deepEqual(visibleTransfers([task]),[]);
 const next={...task,id:'new',read:false};assert.deepEqual(visibleTransfers([task,next]),[next]);
 const running={...task,id:'running',state:'running'};assert.deepEqual(visibleTransfers([task,running]),[running]);
 assert.deepEqual(newAutomaticReceiptIds([task]),['old'],'dismissal does not invent a coordinator report');
});
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

test('automatic save verification stays an active note instead of surfacing its older failure and retry action',()=>{
 const checking:Transfer={id:'work:one',taskId:'one',title:'保存核对',state:'reconciling',phase:'正在只读核对 Notion 保存结果，不会重复写入',reportable:false};
 const stale:Transfer={id:'old-failure',taskId:'one',title:'保存核对',state:'failed',outcome:'failed',reported:false};
 assert.deepEqual(visibleTransfers([checking,stale]),[checking]);
 assert.equal(taskCategory({active:true,outcome:'reconciling',isTask:true}),'active');
 const html=renderToStaticMarkup(createElement(TaskTransferRail,{tasks:[checking,stale],busy:false,onOpen:()=>{}}));
 assert.match(html,/正在只读核对 Notion 保存结果/);assert.doesNotMatch(html,/重试|未完成，查看原因|查看恢复方式/);
 const returned:Transfer={id:'verified-result',taskId:'one',title:'保存核对',state:'returned',reported:true};
 assert.deepEqual(visibleTransfers([returned]),[],'only server-confirmed final reporting withdraws the active check note');
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
 assert.equal(transferFeedbackLabel({...base,state:'completed',outcome:'cancelled'}),'已停止');
 assert.equal(transferFeedbackLabel({...base,state:'completed',outcome:'failed'}),'未完成，查看原因');
 assert.equal(transferFeedbackLabel({...base,state:'returned'}),'结果已返回，查看内容');
 assert.deepEqual(newAutomaticReceiptIds([{...base,state:'returned'},{...base,id:'b',state:'needs_input'},{...base,id:'c',state:'partial'}]),['a','b','c']);
});

test('a stale processing phase cannot hide a pause, permission request or final outcome',()=>{
 const base:Transfer={id:'round',taskId:'task',title:'整理资料',state:'running',phase:'正在查找资料'};
 for(const [state,label] of [
  ['paused','已暂停'],['prepared_local','等待确认本机执行'],['waiting','等待前一步完成'],
  ['needs_input','需要你补充信息'],['partial','已有部分结果，需要核对'],['failed','未完成，查看原因'],
  ['interrupted','结果待核对'],['cancelled','已停止'],['returned','结果已返回，查看内容'],['completed','已完成'],
 ])assert.equal(transferFeedbackLabel({...base,state}),label);
 assert.equal(transferFeedbackLabel({...base,state:'completed',outcome:'needs_input'}),'需要你补充信息');
 assert.equal(transferFeedbackLabel(base),'正在查找资料','a real active phase remains visible');
 const check={...base,state:'reconciling',phase:'正在只读核对 Notion 保存结果，不会重复写入'};
 assert.equal(transferFeedbackLabel(check),check.phase,'automatic verification remains distinct from ordinary processing');
 assert.equal(transferFeedbackLabel({...check,phase:undefined}),'正在核对保存结果');
});

test('rail heading counts tasks without repeating narration and failed outcomes offer review rather than pretend retry',()=>{
 const tasks:Transfer[]=[
  {id:'running',taskId:'one',title:'整理资料',state:'running'},
  {id:'failed',taskId:'two',title:'保存文档',state:'failed'},
  {id:'waiting',taskId:'three',title:'后续整理',state:'waiting'},
 ];
 const html=renderToStaticMarkup(createElement(TaskTransferRail,{tasks,busy:false,onOpen:()=>{},onStop:async()=>{},onDismiss:async()=>{}}));
 assert.match(html,/3 项任务/);
 assert.equal((html.match(/>正在处理</g)||[]).length,1);
 assert.doesNotMatch(html,/处理期间可以继续聊天|正在把结果带回主对话|>重试<|>忽略</);
 assert.match(html,/>查看并处理</);assert.match(html,/>收起提醒</);
 assert.match(html,/停止任务：后续整理/,'dependency-waiting work remains stoppable');
 assert.match(html,/未完成，查看原因/);assert.match(html,/等待前一步完成/);
});

test('task overview arrives at one useful detail without losing a remembered selection or mutating receipts',()=>{
 const items=[
  {id:'old',taskState:'history' as const,updatedAt:'2026-10-24',unread:false},
  {id:'result',taskState:'review' as const,updatedAt:'2026-10-24',unread:true},
  {id:'active',taskState:'active' as const,updatedAt:'2026-10-23',unread:false},
  {id:'archived',taskState:'active' as const,archived:true,updatedAt:'2026-10-25',unread:true},
 ];
 const before=structuredClone(items);
 assert.equal(taskEntrySelection(items),'active');
 assert.equal(taskEntrySelection(items,'result'),'result');
 assert.equal(taskEntrySelection(items,'archived'),'active');
 assert.equal(taskEntrySelection(items.filter(item=>item.id!=='active')),'result');
 assert.equal(taskEntrySelection([]),'');
 assert.deepEqual(items,before);
});
