import assert from "node:assert/strict";
import test from "node:test";
import type { Database, ExecutionTask, MessageRecord } from "./types.js";
import { appendExecutionEvent, buildExecutionCompilerMessages, executionHandoffs, saveExecutionInput, messagesThrough, publicExecutionTask, taskEvents, executionTrace, type ExecutionHandoff } from "./executionService.js";
import { saveExecutionReceipt, executionReceipts, assertLocalExecutionAvailable, executionDeliveryPending, executionBlocksDevice,
  executionHasCurrentTerminal, localExecutionBlocker, requestExecutionCancellation } from './executionService.js';

test('unacknowledged disconnected rounds block repeat work only for their exact owner and device', () => {
  const scope = {workspaceId:'a', userId:'u', deviceId:'d', installationId:'i'};
  const task = {...scope,id:'t',status:'failed',reportRound:1,
    deliveryAttempt:{id:'attempt',round:1,issuedAt:'now'},
    transportInterruption:{attemptId:'attempt',round:1,reason:'socket_close',at:'now'}} as ExecutionTask;
  const db = {executionTasks:[task]} as Database;
  assert.equal(executionDeliveryPending(task),true);
  assert.equal(executionBlocksDevice(task,scope),true);
  assert.throws(() => assertLocalExecutionAvailable(db,scope), /避免重复操作/);
  for (const foreign of [{...scope,workspaceId:'b'},{...scope,userId:'v'},{...scope,deviceId:'e'},{...scope,installationId:'j'}]){
    assert.doesNotThrow(() => assertLocalExecutionAvailable(db,foreign));
    assert.equal(executionBlocksDevice(task,foreign),false,'another Key or computer must not get a false blocking UI');
  }
  task.status='cancelled'; assert.equal(executionDeliveryPending(task),true);
  task.terminalReceipt={id:'receipt',hash:'h',attemptId:'attempt',round:1,outcome:'cancelled',disposition:'supplemental',receivedAt:'now'};
  assert.equal(executionDeliveryPending(task),false);
  assert.equal(executionBlocksDevice(task,scope),false);
  assert.doesNotThrow(() => assertLocalExecutionAvailable(db,scope));
});

test('an uncertain launcher process blocks its exact device even after a terminal receipt without suggesting a false stop', () => {
  const scope = { workspaceId:'a', userId:'u', deviceId:'d', installationId:'i' };
  for (const status of ['completed','failed','cancelled'] as const) {
    const task = { ...scope, id:'held', status, reportRound:1, executionSafetyHold:'launcher_interrupted',
      deliveryAttempt:{id:'attempt',round:1,issuedAt:'now'},
      terminalReceipt:{id:'receipt',hash:'hash',attemptId:'attempt',round:1,outcome:'failed',disposition:'accepted',receivedAt:'now'} } as ExecutionTask;
    const db = { executionTasks:[task] } as Database;
    assert.equal(executionDeliveryPending(task), true);
    assert.throws(() => assertLocalExecutionAvailable(db,scope), error => {
      assert.ok(error instanceof Error); assert.match(error.message,/核对文件与执行工具/);
      assert.doesNotMatch(error.message,/先停止|停止上一轮|再安排新任务/); return true;
    });
    for (const foreign of [{...scope,workspaceId:'b'},{...scope,userId:'v'},{...scope,deviceId:'e'},
      {...scope,installationId:'j'},{...scope,installationId:undefined}])
      assert.doesNotThrow(() => assertLocalExecutionAvailable(db,foreign));
  }
});

test('ordinary terminal tasks with no process safety hold allow new local work', () => {
  const scope = { workspaceId:'a', userId:'u', deviceId:'d', installationId:'i' };
  for (const status of ['completed','failed','cancelled'] as const) {
    const task = { ...scope, id:'settled', status } as ExecutionTask;
    assert.equal(executionDeliveryPending(task), false);
    assert.doesNotThrow(() => assertLocalExecutionAvailable({executionTasks:[task]} as Database,scope));
  }
});

test('the browser blocker and admission share active and unresolved states, not unfinished goal history', () => {
  const scope = { workspaceId:'a', userId:'u', deviceId:'d', installationId:'i' };
  for (const status of ['queued', 'selecting_target', 'running'] as const) {
    const active = { ...scope, id:'active', status } as ExecutionTask;
    const db = { executionTasks:[{ ...active, id:'old-incomplete', status:'failed' }, active] } as Database;
    assert.equal(executionBlocksDevice(active, scope), true);
    assert.equal(localExecutionBlocker(db, scope)?.id, 'active');
    assert.throws(() => assertLocalExecutionAvailable(db, scope), /正在执行/);
    for (const foreign of [{...scope,workspaceId:'other'}, {...scope,userId:'other'}, {...scope,deviceId:'other'}, {...scope,installationId:'other'}]) {
      assert.equal(executionBlocksDevice(active, foreign), false);
      assert.equal(localExecutionBlocker(db, foreign), undefined);
    }
  }
});

test('stopping an unanswered round remains resendable, then its exact terminal frees independent work without replay', () => {
  const scope = { workspaceId:'a', userId:'u', deviceId:'d', installationId:'i' };
  const task = { ...scope, id:'old', conversationId:'old-conversation', status:'failed', reportRound:2,
    deliveryAttempt:{id:'original-attempt',round:2,issuedAt:'first'},
    transportInterruption:{attemptId:'original-attempt',round:2,reason:'socket_close',at:'first'} } as ExecutionTask;
  const db = { executionTasks:[task], conversations:[] } as unknown as Database;
  assert.deepEqual(requestExecutionCancellation(db, task, 'stop-1'), {attemptId:'original-attempt',round:2});
  assert.equal(task.status, 'cancelled');
  assert.match(task.lastError!, /等本机确认/);
  assert.deepEqual(requestExecutionCancellation(db, task, 'stop-2'), {attemptId:'original-attempt',round:2});
  assert.equal(task.reportRound, 2); assert.equal(task.deliveryAttempt!.id, 'original-attempt');
  assert.throws(() => assertLocalExecutionAvailable(db, scope), /停止请求还在等本机确认/);
  task.terminalReceipt = {id:'terminal',hash:'h',attemptId:'different',round:2,outcome:'cancelled',receivedAt:'now',disposition:'supplemental'};
  assert.equal(executionHasCurrentTerminal(task), false);
  assert.throws(() => assertLocalExecutionAvailable(db, scope));
  task.terminalReceipt.attemptId = 'original-attempt';
  task.terminalReceipt.round = 1;
  assert.equal(executionHasCurrentTerminal(task), false);
  task.terminalReceipt.round = 2;
  assert.equal(executionHasCurrentTerminal(task), true);
  assert.equal(executionBlocksDevice(task, scope), false);
  assert.doesNotThrow(() => assertLocalExecutionAvailable(db, scope));
  assert.equal(requestExecutionCancellation(db, task, 'stop-3'), undefined);
  assert.equal(task.status, 'cancelled'); assert.equal(task.reportRound, 2);
});

test('repeated stop never clears an unknown-process hold even with a delivered terminal', () => {
  const scope = { workspaceId:'a', userId:'u', deviceId:'d', installationId:'i' };
  for (const hold of ['launcher_interrupted', 'command_unconfirmed'] as const) {
    const task = { ...scope, id:'held', status:'failed', reportRound:0, executionSafetyHold:hold,
      deliveryAttempt:{id:'attempt',round:0,issuedAt:'first'},
      terminalReceipt:{id:'terminal',hash:'h',attemptId:'attempt',round:0,outcome:'failed',receivedAt:'now',disposition:'accepted'} } as ExecutionTask;
    const db = { executionTasks:[task], conversations:[] } as unknown as Database;
    assert.deepEqual(requestExecutionCancellation(db, task, 'again'), {attemptId:'attempt',round:0});
    assert.equal(task.executionSafetyHold, hold);
    assert.equal(executionDeliveryPending(task), true);
    assert.throws(() => assertLocalExecutionAvailable(db, scope), /没确认结束/);
  }
});

test('an old cancel round cannot change a resumed task and malformed supplied rounds fail closed', () => {
  const task = {id:'t',workspaceId:'a',userId:'u',deviceId:'d',installationId:'i',status:'running',reportRound:2,
    deliveryAttempt:{id:'new-attempt',round:2,issuedAt:'now'}} as ExecutionTask;
  const db = {executionTasks:[task],conversations:[]} as unknown as Database;
  const before = JSON.stringify(db);
  assert.throws(() => requestExecutionCancellation(db, task, 'stop', 1), /已进入新一轮/);
  for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null] as any[])
    assert.throws(() => requestExecutionCancellation(db, task, 'stop', bad), /轮次无效/);
  assert.equal(JSON.stringify(db), before);
  assert.deepEqual(requestExecutionCancellation(db, task, 'stop', 2), {attemptId:'new-attempt',round:2});
});

test('request-scoped snapshots keep device blocking explicit for list, detail and stream projections', () => {
  const scope = {workspaceId:'a',userId:'u',deviceId:'d',installationId:'i'};
  const task = {...scope,id:'t',status:'running'} as ExecutionTask;
  assert.equal(publicExecutionTask(task, scope).blocksCurrentDevice, true);
  for (const foreign of [{...scope,workspaceId:'b'}, {...scope,userId:'v'}, {...scope,deviceId:'e'}, {...scope,installationId:'j'}])
    assert.equal(publicExecutionTask(task, foreign).blocksCurrentDevice, false);
  assert.equal('blocksCurrentDevice' in publicExecutionTask(task), false, 'non-request callers must not guess a device');
  task.status = 'cancelled';
  assert.equal(publicExecutionTask(task, scope).blocksCurrentDevice, false);
});

test('public process-check flags are explicit booleans without leaking the private hold or attempt', () => {
  const task = { id:'held', instruction:'private-instruction', deviceId:'private-device', status:'failed', reportRound:1,
    deliveryAttempt:{id:'private-attempt',round:1,issuedAt:'now'},
    terminalReceipt:{id:'private-receipt',hash:'private-hash',attemptId:'private-attempt',round:1,outcome:'failed',disposition:'accepted',receivedAt:'now'} } as ExecutionTask;
  for (const held of [false,true]) {
    const snapshot = publicExecutionTask({...task,executionSafetyHold:held ? 'launcher_interrupted' : undefined});
    assert.equal(snapshot.requiresExecutionCheck,held); assert.equal(typeof snapshot.requiresExecutionCheck,'boolean');
    assert.equal(snapshot.resultDeliveryPending,held);
    assert.doesNotMatch(JSON.stringify(snapshot),/launcher_interrupted|executionSafetyHold|private-attempt|deliveryAttempt|private-receipt|private-hash|terminalReceipt|private-instruction|private-device/);
  }
});

test('public execution snapshots omit private receipt and transport bindings', () => {
  const task = {id:'t',instruction:'private',deviceId:'d',status:'failed',deliveryAttempt:{id:'secret-attempt',round:0,issuedAt:'now'},
    transportInterruption:{attemptId:'secret-attempt',round:0,reason:'socket_error',at:'now'},
    terminalReceipt:{id:'private-receipt',hash:'private-hash'}} as ExecutionTask;
  const json=JSON.stringify(publicExecutionTask(task));
  assert.doesNotMatch(json,/secret-attempt|private-receipt|private-hash|socket_error|deliveryAttempt|transportInterruption|terminalReceipt/);
  assert.match(json,/resultDeliveryPending/);
});

test('execution receipts retain source and round, deduplicate and isolate workspace and owner', () => {
  const task = { id:'t', workspaceId:'a', userId:'u', conversationId:'c', provider:'codex', status:'completed', finalResponse:'创建 /QA/result.txt，回读 ONE_QA_OK', targetName:'/QA', updatedAt:'2026-10-07' } as ExecutionTask;
  const db = { conversations:[{id:'c',workspaceId:'a',userId:'u',messages:[]}], messages:[] } as unknown as Database;
  saveExecutionReceipt(db,task); saveExecutionReceipt(db,task);
  assert.equal(db.messages.length,1); assert.match(db.messages[0].content,/第 1 轮/); assert.match(db.messages[0].content,/回读 ONE_QA_OK/);
  assert.equal(executionReceipts(db,'b','u').length,0); assert.equal(executionReceipts(db,'a','v').length,0);
  saveExecutionReceipt(db,{...task,reportRound:1,status:'cancelled',lastError:'停止'});
  assert.equal(db.messages.length,2); assert.match(db.messages[1].content,/取消/);
  saveExecutionReceipt(db,{...task,workspaceId:'b',reportRound:2}); assert.equal(db.messages.length,2);
  for (let reportRound=2;reportRound<8;reportRound++) saveExecutionReceipt(db,{...task,reportRound});
  assert.equal(executionReceipts(db,'a','u','c').length,3);
});

test('the first cancellation receipt does not claim an unanswered stop already ended the process', () => {
  const task = {id:'t',workspaceId:'a',userId:'u',conversationId:'c',provider:'codex',status:'cancelled',reportRound:0,
    deliveryAttempt:{id:'attempt',round:0,issuedAt:'now'},transportInterruption:{attemptId:'attempt',round:0,reason:'cancellation_pending',at:'now'},
    updatedAt:'now'} as ExecutionTask;
  const db = {conversations:[{id:'c',workspaceId:'a',userId:'u',messages:[]}],messages:[]} as unknown as Database;
  saveExecutionReceipt(db, task);
  assert.match(db.messages[0].content, /停止请求已提交，但本机尚未确认原操作结束/);
  assert.doesNotMatch(db.messages[0].content, /执行已取消/);
});

test('failed receipts retain the actual answer once and keep the failure notice', () => {
  const answer = '创建 /QA/result.txt，回读 ONE_QA_OK';
  const task = { id:'t', workspaceId:'a', userId:'u', conversationId:'c', provider:'codex', status:'failed', finalResponse:answer, lastError:`${answer}\n本轮有工具执行失败，不会自动重跑`, updatedAt:'2026-10-10' } as ExecutionTask;
  const db = { conversations:[{id:'c',workspaceId:'a',userId:'u',messages:[]}], messages:[] } as unknown as Database;
  saveExecutionReceipt(db,task);
  assert.equal(db.messages[0].content.split(answer).length - 1, 1);
  assert.match(db.messages[0].content,/工具执行失败/);
  assert.match(db.messages[0].content,/执行未完成/);
  saveExecutionReceipt(db,{...task,reportRound:1,lastError:'连接中断'});
  assert.match(db.messages[1].content,/连接中断/);
  assert.match(db.messages[1].content,/回读 ONE_QA_OK/);
  assert.equal(executionReceipts(db,'b','u').length,0);
  assert.equal(executionReceipts(db,'a','other').length,0);
});

test('normal exit with tool errors describes review, not verified success, and remains owned and idempotent', () => {
  const answer = '回读结果：/QA/index.html 标题匹配';
  const task = {id:'review',workspaceId:'a',userId:'u',conversationId:'c',provider:'codex',status:'failed',finalResponse:answer,lastError:`${answer}\n\n本轮有工具执行失败，完成情况需检查，不会自动重跑。`,updatedAt:'2026-10-10'} as ExecutionTask;
  const db = {conversations:[{id:'c',workspaceId:'a',userId:'u',messages:[]}],messages:[]} as unknown as Database;
  saveExecutionReceipt(db,task); saveExecutionReceipt(db,task);
  assert.equal(db.messages.length,1);
  assert.match(db.messages[0].content,/执行器已结束，过程中有工具报错/);
  assert.match(db.messages[0].content,/最终结果需核对/);
  assert.equal(task.status,'failed');
  assert.equal(executionReceipts(db,'other','u').length,0);
  assert.equal(executionReceipts(db,'a','other').length,0);
});

test("execution trace cannot expose another workspace or user's instruction", () => {
  const database = { executionTasks: [{ id: "t", workspaceId: "a", userId: "u", instruction: "private" }], messages: [] } as unknown as Database;
  assert.equal(executionTrace(database, "t", "b", "u"), undefined);
  assert.equal(executionTrace(database, "t", "a", "other"), undefined);
});

const records: MessageRecord[] = [
  { id: "m1", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", role: "user", content: "先分析登录问题", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "m2", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", role: "assistant", content: "建议检查 session", createdAt: "2026-01-01T00:00:01.000Z" },
  { id: "m3", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", role: "user", content: "不要改数据库", createdAt: "2026-01-01T00:00:02.000Z" },
  { id: "foreign", workspaceId: "workspace-b", userId: "user-b", conversationId: "c1", role: "user", content: "别人的内容", createdAt: "2026-01-01T00:00:00.500Z" }
];

const handoffFor = (record: MessageRecord, instruction: string): ExecutionHandoff => ({
  workspaceId: record.workspaceId, userId: record.userId, conversationId: record.conversationId,
  messageId: record.id, instruction,
});

test('long execution histories retain the original goal and latest handoff beside the recent context',()=>{
 const long=[{...records[0],content:'创建说明.md；只写荷叶饼好吃，一个5块，不加其他文字'},...Array.from({length:60},(_,i)=>({...records[1],id:`long-${i}`,content:'讨论细节'.repeat(200),createdAt:`2026-01-01T00:01:${String(i).padStart(2,'0')}.000Z`})),{...records[2],content:'OK，开搞',createdAt:'2026-01-01T00:02:00.000Z'}];
 const result=buildExecutionCompilerMessages(long,'m3',undefined,[handoffFor(long[0],'创建说明.md；只写荷叶饼好吃，一个5块；文档标题改成荷叶饼；保持原文和禁止事项')])[0].content;
 assert.match(result,/只写荷叶饼好吃，一个5块/);assert.match(result,/文档标题改成荷叶饼/);assert.match(result,/中间部分因长度未全部提供/);assert.match(result,/OK，开搞/);
});

test("execution handoff stops at the selected message and stays in the workspace", () => {
  const prefix = messagesThrough(records, "c1", "workspace-a", "m2");
  assert.deepEqual(prefix.map((item) => item.id), ["m1", "m2"]);
  const compiler = buildExecutionCompilerMessages(prefix, "m2")[0].content;
  assert.match(compiler, /建议检查 session/);
  assert.doesNotMatch(compiler, /不要改数据库/);
  assert.doesNotMatch(compiler, /别人的内容/);
});

test("public execution task never exposes the compiled instruction or device id", () => {
  const task = { id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", sourceMessageId: "m2", provider: "codex", status: "queued", instruction: "secret handoff", deviceId: "device-a", createdAt: "2026-01-01", updatedAt: "2026-01-01" } satisfies ExecutionTask;
  assert.equal("instruction" in publicExecutionTask(task), false);
  assert.equal("deviceId" in publicExecutionTask(task), false);
});

test("confirmation retains the saved dispatch brief but excludes foreign and later handoffs", () => {
  const owned = records.filter(record => record.workspaceId === "workspace-a").map(record =>
    record.id === "m1" ? { ...record, content: "画荷叶饼图片，再创建文档" }
      : record.id === "m2" ? { ...record, role: 'user' as const, content: "OK，开搞" } : record);
  const prefix = messagesThrough(owned, "c1", "workspace-a", "m2");
  const operation = { workspaceId: "workspace-a", userId: "user-a", conversationId: "c1",
    workRun: { inputMessageId: "m1", instruction: "创建 .md 文档，内容只有：荷叶饼好吃，一个 5 块" } };
  const database = { chatOperations: [operation,
    { ...operation, workspaceId: "workspace-b", workRun: { ...operation.workRun, instruction: "其他空间秘密" } },
    { ...operation, userId: "user-b", workRun: { ...operation.workRun, instruction: "其他用户秘密" } },
    { ...operation, conversationId: "c2", workRun: { ...operation.workRun, instruction: "其他事情秘密" } },
    { ...operation, workRun: { inputMessageId: "m3", instruction: "未来修改" } }
  ] } as unknown as Database;
  const handoffs = executionHandoffs(database, prefix, "workspace-a", "user-a");
  assert.equal(handoffs.length, 1);
  for (const prompt of [undefined, "按配置指令整理"]) {
    const compiled = buildExecutionCompilerMessages(prefix, "m2", prompt, handoffs)[0].content;
    assert.match(compiled, /OK，开搞/);
    assert.match(compiled, /荷叶饼好吃，一个 5 块/);
    assert.match(compiled, /不是额外授权/);
    assert.doesNotMatch(compiled, /画荷叶饼图片/);
    assert.doesNotMatch(compiled, /秘密|未来修改/);
  }
});

test('local compiler only receives scoped current and earlier work turns while keeping raw history unchanged', () => {
  const owned = records.filter(record => record.workspaceId === 'workspace-a').map(record =>
    record.id === 'm1' ? { ...record, content: 'OLD_IMAGE_SIBLING：生成图片；另在本地创建 hello.md' }
      : record.id === 'm3' ? { ...record, content: 'CURRENT_WRITING_SIBLING：撰写文章；另将 hello.md 标题改为 ONE' } : record);
  const before = structuredClone(owned);
  const handoffs = [handoffFor(owned[0], '仅在授权目录创建 hello.md，内容为 hello'),
    handoffFor(owned[2], '只把 hello.md 标题改为 ONE；保留其余内容并回读')];
  for (const prompt of [undefined, '按配置指令整理']) {
    const compiled = buildExecutionCompilerMessages(owned, 'm3', prompt, handoffs)[0].content;
    assert.match(compiled, /服务端确定的本轮执行目标/);
    assert.match(compiled, /只把 hello.md 标题改为 ONE/);
    assert.match(compiled, /仅在授权目录创建 hello.md/);
    assert.match(compiled, /建议检查 session/);
    assert.doesNotMatch(compiled, /OLD_IMAGE_SIBLING|CURRENT_WRITING_SIBLING|生成图片|撰写文章/);
  }
  assert.deepEqual(owned, before);
});

test('compiler rejects unbound and foreign handoffs and excludes later records even in truncated goal anchors', () => {
  const first = { ...records[0], content: 'HISTORICAL_SIBLING：作图；另汇总本地订单' };
  const focus = { ...records[2], content: 'FOCUS_SIBLING：写文章；另把订单总额写入 total.md' };
  const long = [first, ...Array.from({length:60}, (_, i) => ({ ...records[1], id:`filler-${i}`,
    content:'讨论订单字段'.repeat(200), createdAt:`2026-01-01T00:00:01.${String(i).padStart(3,'0')}Z` })), focus,
    { ...focus, id:'future', content:'FUTURE_RAW', createdAt:'2026-01-01T00:00:03.000Z' },
    { ...focus, id:'foreign-raw', workspaceId:'workspace-b', content:'FOREIGN_RAW', createdAt:'2026-01-01T00:00:01.500Z' },
    { ...focus, id:'other-user-raw', userId:'user-b', content:'OTHER_USER_RAW', createdAt:'2026-01-01T00:00:01.500Z' },
    { ...focus, id:'other-task-raw', conversationId:'other-task', content:'OTHER_TASK_RAW', createdAt:'2026-01-01T00:00:01.500Z' }];
  const eligible = handoffFor(focus, '只汇总本地订单，并将实际总额写入 total.md');
  const handoffs = [handoffFor(first, '仅读取订单，不改源文件'),
    { ...eligible, workspaceId:'workspace-b', instruction:'FOREIGN_HANDOFF' },
    { ...eligible, userId:'user-b', instruction:'OTHER_USER_HANDOFF' },
    { ...eligible, conversationId:'other-task', instruction:'OTHER_TASK_HANDOFF' },
    { ...eligible, messageId:'missing', instruction:'UNBOUND_HANDOFF' },
    handoffFor(long.find(record=>record.id==='future')!, 'FUTURE_HANDOFF'), eligible];
  const compiled = buildExecutionCompilerMessages(long, focus.id, undefined, handoffs)[0].content;
  assert.match(compiled, /中间部分因长度未全部提供/);
  assert.match(compiled, /仅读取订单，不改源文件/);
  assert.match(compiled, /只汇总本地订单/);
  assert.doesNotMatch(compiled, /SIBLING|FOREIGN_|OTHER_USER_|OTHER_TASK_|UNBOUND_|FUTURE_/);
});

test('ordinary local discussion and short confirmation preserve the original goal without a dispatch handoff', () => {
  const discussion = records.filter(record => record.workspaceId === 'workspace-a').map(record =>
    record.id === 'm1' ? { ...record, content:'创建 hello.md，正文只有你好；已有文件不得覆盖' }
      : record.id === 'm2' ? { ...record, content:'确认将写入已授权的 test 目录，并回读内容' }
      : { ...record, content:'OK，开搞' });
  const compiled = buildExecutionCompilerMessages(discussion, 'm3')[0].content;
  assert.match(compiled, /正文只有你好/);
  assert.match(compiled, /已有文件不得覆盖/);
  assert.match(compiled, /已授权的 test 目录/);
  assert.match(compiled, /【执行焦点】用户：OK，开搞/);
});

test("task events are isolated by workspace and user", () => {
  const task = { id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "c1", sourceMessageId: "m2", provider: "codex", status: "queued", instruction: "x", deviceId: "device-a", createdAt: "2026-01-01", updatedAt: "2026-01-01" } satisfies ExecutionTask;
  const database = { executionEvents: [] } as unknown as Database;
  appendExecutionEvent(database, { id: "event-a", workspaceId: "workspace-a", userId: "user-a", taskId: task.id, kind: "message", text: "visible", createdAt: "2026-01-01" });
  appendExecutionEvent(database, { id: "event-b", workspaceId: "workspace-b", userId: "user-b", taskId: task.id, kind: "message", text: "hidden", createdAt: "2026-01-02" });
  assert.deepEqual(taskEvents(database, task).map((item) => item.text), ["visible"]);
});

test('direct execution saves the draft once, preserves legacy context and rejects foreign ownership', () => {
  const db = { messages: [], conversations: [{ id:'c',workspaceId:'a',userId:'u',messages:[{role:'user',content:'创建文档，保留标题',createdAt:'2026-01-01'}] }] } as unknown as Database;
  const id = saveExecutionInput(db,'a','u','c','operation_input_1234','标题改成荷叶饼，开工','2026-01-02');
  assert.equal(saveExecutionInput(db,'a','u','c','operation_input_1234','标题改成荷叶饼，开工','2026-01-03'),id);
  assert.equal(db.messages.length,2); assert.ok(id.length<96);
  assert.match(buildExecutionCompilerMessages(messagesThrough(db.messages,'c','a',id),id)[0].content,/创建文档，保留标题/);
  assert.throws(()=>saveExecutionInput(db,'b','u','c','operation_input_1234','x','now'),/不存在/);
  assert.throws(()=>saveExecutionInput(db,'a','other','c','operation_input_1234','x','now'),/不存在/);
  assert.throws(()=>saveExecutionInput(db,'a','u','c','operation_input_1234','改变内容','now'),/不能修改/);
  assert.throws(()=>saveExecutionInput(db,'a','u','c','operation_input_other','x'.repeat(8001),'now'),/8000/);
});
