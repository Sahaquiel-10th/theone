import assert from "node:assert/strict";
import test from "node:test";
import type { Database, ExecutionTask, MessageRecord } from "./types.js";
import { appendExecutionEvent, buildExecutionCompilerMessages, executionHandoffs, saveExecutionInput, messagesThrough, publicExecutionTask, taskEvents, executionTrace } from "./executionService.js";
import { saveExecutionReceipt, executionReceipts } from './executionService.js';

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

test('long execution histories retain the original goal and latest handoff beside the recent context',()=>{
 const long=[{...records[0],content:'创建说明.md；只写荷叶饼好吃，一个5块，不加其他文字'},...Array.from({length:60},(_,i)=>({...records[1],id:`long-${i}`,content:'讨论细节'.repeat(200),createdAt:`2026-01-01T00:01:${String(i).padStart(2,'0')}.000Z`})),{...records[2],content:'OK，开搞'}];
 const result=buildExecutionCompilerMessages(long,'m3',undefined,[{messageId:'m3',instruction:'文档标题改成荷叶饼；保持原文和禁止事项'}])[0].content;
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
    record.id === "m1" ? { ...record, content: "OK，开搞" } : record);
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
    assert.doesNotMatch(compiled, /秘密|未来修改/);
  }
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
