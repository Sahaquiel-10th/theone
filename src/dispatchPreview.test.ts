import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPreview, previewReducer as reduce, type PreviewState } from './preview/dispatchPreviewState';
test('multiple skills compose into one task, keep words and reuse independent of selection order',()=>{
 const features=[{id:'research',name:'资料研究'},{id:'writing',name:'周报整理'}];
 let s=reduce(initialPreview(),{type:'submit',text:'结合项目资料写周报',id:'multi',now:0,features:[...features,features[0]]});
 assert.equal(s.pending?.target,'feature:research+writing');
 assert.equal(s.dialogue.at(-1)?.text,'结合项目资料写周报');
 assert.equal(s.dialogue.at(-1)?.featureName,'资料研究 ＋ 周报整理');
 s=reduce(s,{type:'ack',id:'multi',now:1500});
 s=reduce(s,{type:'submit',text:'继续补一点',id:'again',now:2000,features:[...features].reverse()});
 assert.equal(s.tasks.filter(task=>task.id.startsWith('feature:')).length,1);
 assert.equal(s.pending?.target,'feature:research+writing');
});
function send(s: PreviewState, text: string, id: string, now = 0) { return reduce(reduce(s, { type: 'submit', text, id, now }), { type: 'ack', id, now: now + 1500 }); }
test('master waits for acknowledgement, not worker; duplicate submissions are ignored', () => {
 let s = reduce(initialPreview(), { type: 'submit', text: 'UI 改一下', id: '1', now: 0 });
 assert.equal(reduce(s, { type: 'submit', text: '露营', id: '2', now: 1 }), s);
 s = reduce(s, { type: 'ack', id: '1', now: 1500 });
 assert.equal(s.pending, null); assert.equal(s.tasks[0].status, 'running');
 assert.equal(reduce(s, { type: 'submit', text: 'UI 改一下', id: '1', now: 2 }), s);
 assert.ok(reduce(s, { type: 'submit', text: '露营', id: '2', now: 2 }).pending);
});
test('original words route to separate papers; follow-up uses last conversation rather than viewed paper', () => {
 let s = send(initialPreview(), 'UI 新灵感', '1');
 s = send(s, '明天去露营', '2');
 s = reduce(s, { type: 'select', taskId: 'ui' });
 s = send(s, '再加这一点', '3');
 assert.equal(s.tasks[0].messages.filter(m => m.role === 'user').at(-1)?.text, 'UI 新灵感');
 assert.deepEqual(s.tasks[1].messages.filter(m => m.role === 'user').map(m => m.text), ['明天去露营', '再加这一点']);
 assert.equal(s.tasks[0].status, 'running'); assert.equal(s.tasks[1].status, 'running');
});
test('same-task supplements queue and merge into next round without modifying active snapshot', () => {
 let s = send(initialPreview(), 'UI 用上一版', '1');
 s = send(s, 'UI 输入框大点', '2'); s = send(s, 'UI 按钮小点', '3');
 assert.deepEqual(s.tasks[0].active, ['1']); assert.deepEqual(s.tasks[0].queue, ['2', '3']);
 s = reduce(s, { type: 'finish', taskId: 'ui', now: 20000 });
 assert.deepEqual(s.tasks[0].active, ['2', '3']); assert.equal(s.tasks[0].round, 2);
 assert.equal(reduce(s, { type: 'finish', taskId: 'ui', round: 1, now: 20001 }), s);
 assert.ok(s.tasks[0].result.includes('UI 用上一版')); assert.ok(!s.tasks[0].result.includes('UI 按钮小点'));
});
test('held notes do not run, stop cancels pending work, failure retains requirements for retry', () => {
 let s = send(initialPreview(), 'UI 先记着别改', '1');
 assert.equal(s.tasks[0].status, 'idle'); assert.equal(s.tasks[0].messages.at(-1)?.status, 'held');
 s = send(s, 'UI 执行暂存', '2'); assert.deepEqual(s.tasks[0].active, ['1', '2']);
 s = reduce(s, { type: 'finish', taskId: 'ui', now: 5, failed: true });
 s = send(s, 'UI 追加要求', '3'); assert.equal(s.tasks[0].status, 'failed');
 s = reduce(s, { type: 'retry', taskId: 'ui', now: 6 }); assert.deepEqual(s.tasks[0].active, ['1', '2', '3']);
 s = send(s, 'UI 先停一下', '4'); assert.equal(s.tasks[0].status, 'stopped'); assert.equal(s.tasks[0].dueAt, null);
 assert.equal(reduce(s, { type: 'finish', taskId: 'ui', now: 7 }), s);
});
test('completion never changes draft or selected paper; reports do not consume drafts', () => {
 let s = send(initialPreview(), '露营', '1');
 s = reduce(s, { type: 'select', taskId: 'ui' }); s = reduce(s, { type: 'draft', text: '尚未发送' });
 s = reduce(s, { type: 'finish', taskId: 'camp', now: 20000 });
 assert.equal(s.selected, 'ui'); assert.equal(s.draft, '尚未发送'); assert.equal(reduce(s, { type: 'report' }), s);
 assert.equal(s.dialogue.some(m => m.text.includes('尚未发送')), false);
 assert.equal(reduce(s, { type: 'finish', taskId: 'camp', now: 21000 }), s);
});
test('completion stays outside the conversation until the task is opened', () => {
 let s = send(initialPreview(), '露营', '1');
 s = reduce(s, { type: 'submit', text: 'UI 新灵感', id: '2', now: 20000 });
 s = reduce(s, { type: 'finish', taskId: 'camp', now: 20001 });
 s = reduce(s, { type: 'ack', id: '2', now: 21500 }); assert.equal(s.notices.length, 1);
 s = send(s, 'UI 输入框', '3', 22000); assert.equal(s.notices.length, 1);
 assert.equal(s.dialogue.filter(m => m.id === 'report-camp-round-1').length, 0);
 s=reduce(s,{type:'select',taskId:'camp'});assert.equal(s.notices.length,0);
});
test('selected function applies once without replacing user words; later turns route normally',()=>{
 let s=reduce(initialPreview(),{type:'submit',text:'明天露营的资料帮我整理成周报',feature:{id:'writing',name:'周报整理'},id:'skill-1',now:0});
 assert.equal(s.pending?.target,'feature:writing');
 assert.equal(s.dialogue[0].featureName,'周报整理');
 assert.equal(s.dialogue[0].text,'明天露营的资料帮我整理成周报');
 s=reduce(s,{type:'ack',id:'skill-1',now:1500});
 assert.equal(s.tasks.find(task=>task.id==='feature:writing')?.status,'running');
 s=send(s,'明天露营带什么','normal');
 assert.equal(s.tasks.find(task=>task.id==='camp')?.status,'running');
 assert.equal(s.dialogue.find(message=>message.id==='normal')?.featureName,undefined);
});
test('unknown input is not assigned to a fake new task', () => {
 const s = send(initialPreview(), '查一下我的账单', '1');
 assert.equal(s.tasks.length, 2); assert.equal(s.tasks[0].status, 'idle'); assert.equal(s.tasks[1].messages.length, 0);
 assert.ok(s.dialogue.at(-1)?.text.includes('还没有接入'));
});
test('explicit binding wins over guessing, viewing alone does not bind, and unbinding restores routing', () => {
 let s = reduce(initialPreview(), {type:'bind',taskId:'ui'});
 s = reduce(s, {type:'select',taskId:'camp'});
 s = send(s, '明天去露营这个比喻可以加到文案里', 'bound');
 assert.equal(s.tasks[0].messages.at(-1)?.text, '明天去露营这个比喻可以加到文案里');
 assert.equal(s.tasks[1].messages.length, 0);
 s = send(s, '和之前关联的小补充', 'queued');
 assert.deepEqual(s.tasks[0].queue, ['queued']);
 s = reduce(s, {type:'bind',taskId:null});
 s = send(s, '明天去露营', 'auto');
 assert.equal(s.tasks[1].messages.at(-1)?.text, '明天去露营');
 assert.equal(reduce(s,{type:'bind',taskId:'missing'}),s);
});
test('handoff instructions are distinct from source text and direct task replies leave the coordinator alone',()=>{
 let s=send(initialPreview(),'帮我 UI 输入框保留', 'source');
 assert.equal(s.tasks[0].messages.at(-1)?.instruction,'任务要求：UI 输入框保留');
 assert.equal(s.dialogue[0].text,'帮我 UI 输入框保留');
 assert.equal(s.selected,null);
 s=reduce(s,{type:'submit',text:'露营',id:'pending',now:100});
 const before=s;
 s=reduce(s,{type:'task-send',taskId:'ui',text:'直接追加文案',id:'direct',now:101});
 assert.deepEqual(s.pending,before.pending);
 assert.deepEqual(s.dialogue,before.dialogue);
 assert.equal(s.tasks[0].messages.at(-1)?.instruction,'直接追加文案');
 assert.deepEqual(s.tasks[0].queue,['direct']);
 assert.equal(reduce(s,{type:'task-send',taskId:'ui',text:'直接追加文案',id:'direct',now:102}),s);
});
test('result messages stay in the assistant conversation exactly once, without opening tasks',()=>{
 let s=send(initialPreview(),'UI 输入框保留','first');
 s=reduce(s,{type:'finish',taskId:'ui',now:20000});
 s=reduce(s,{type:'report'});
 assert.equal(s.selected,null);
 assert.equal(s.notices.length,0);
 assert.equal(s.dialogue.at(-1)?.kind,'result');
 assert.equal(s.dialogue.at(-1)?.taskId,'ui');
 assert.match(s.dialogue.at(-1)!.text,/独立输入框/);
 assert.equal(reduce(s,{type:'report'}),s);
 const length=s.dialogue.length;
 s=reduce(s,{type:'select',taskId:'ui'});s=reduce(s,{type:'select',taskId:null});
 assert.equal(s.dialogue.length,length);
});
