import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment, Conversation, Database, ExecutionTask } from './types.js';
import type { ChatOperation } from './chatOperations.js';
import type { WorkRun } from './coordinatorTypes.js';
import { CoordinatorService } from './coordinatorService.js';
import { acknowledgeTaskResults, acknowledgeAllTaskResults, appendTaskResultReport, markTaskResultsReported, pendingTaskResults, unreviewedTaskResults, taskResultIdsReportedInMessage, taskResultConversationContext, captureTaskResults, capturedTaskResultsForReport, initializeTaskResultReporting } from './taskResultInbox.js';
import { saveExecutionReceipt } from './executionService.js';
import {latestTaskResults,pendingConversationTaskResults} from './taskResultInbox.js';

test('unconfirmed stop is reported as waiting for the original computer, never a completed stop',()=>{
 const db=fixture(),task=local(db,'pending-stop');
 task.status='cancelled';task.reportRound=0;
 task.deliveryAttempt={id:'original-attempt',round:0,issuedAt:timestamp};
 task.transportInterruption={attemptId:'original-attempt',round:0,reason:'cancellation_pending',at:timestamp};
 task.finalResponse='已经停下了';
 const receipt=pendingTaskResults(db,a)[0];
 assert.equal(receipt.outcome,'interrupted');assert.match(receipt.summary,/还没有确认原操作结束/);
 const report=appendTaskResultReport(db,a);
 const message=db.conversations.find(c=>c.id==='main-a')!.messages.at(-1)!;
 assert.equal(report.results.length,1);assert.match(message.content,/停止请求已发出/);
 assert.doesNotMatch(message.content,/已经停下了|本轮已停止|已停止。/);
 assert.equal(db.conversations.find(c=>c.id==='main-b')!.messages.length,0);
});

test('a confirmed terminal stop can be reported as stopped but process holds cannot',()=>{
 for(const hold of [undefined,'launcher_interrupted','command_unconfirmed'] as const){
  const db=fixture(),task=local(db,`stop-${hold??'settled'}`);task.status='cancelled';task.executionSafetyHold=hold;
  const receipt=pendingTaskResults(db,a)[0];
  assert.equal(receipt.outcome,hold?'interrupted':'cancelled');
  assert.equal(/已经停下了/.test(receipt.brief??''),!hold);
 }
});

test('a completed result uses its brief once instead of echoing the longer saved-body acknowledgement',()=>{
 const db=fixture(),{operation}=cloud(db,'complete-brief-once',a,{state:'completed',outcome:'completed',text:'文章已保存到 Notion，正文也回读核对过了。'});
 operation.workRun!.userReport='文章已保存，正文已回读核对。';
 const report=appendTaskResultReport(db,a);
 assert.equal(report.results[0].brief,'文章已保存，正文已回读核对。');
 assert.doesNotMatch(db.conversations.find(c=>c.id==='main-a')!.messages.at(-1)!.content,/正文也回读核对过了/);
});

test('scheduled and checking Notion saves are not terminal results in any automatic or manual inbox path',()=>{
 for(const state of ['scheduled','checking'] as const){
  const db=fixture(),{operation}=cloud(db,`notion-${state}`,a,{state:'failed',text:'保存可能已写入'});
  operation.workRun!.notionReceipt={state:'uncertain',pageId:'a'.repeat(32),verification:{state,version:1,attempt:1,nextCheckAt:timestamp,deadlineAt:timestamp}};
  assert.deepEqual(pendingTaskResults(db,a),[]);assert.deepEqual(pendingConversationTaskResults(db,a),[]);assert.deepEqual(captureTaskResults(db,a,[operation.id]),[]);
  const appended=appendTaskResultReport(db,a,{ids:[operation.id]});assert.equal(appended.results.length,0);assert.equal(db.conversations.find(c=>c.id==='main-a')!.messages.length,0);
 }
});

test('readback proof committed before deterministic finalization cannot announce a false failed result or consume its success report',()=>{
 const db=fixture(),{operation}=cloud(db,'notion-proof-before-finalize',a,{state:'failed',text:'之前保存未确认'});
 operation.status='pending';operation.workRun!.failureCode='notion_verification_pending';operation.workRun!.notionReceipt={state:'verified',pageId:'a'.repeat(32)};
 assert.deepEqual(pendingConversationTaskResults(db,a),[]);assert.equal(appendTaskResultReport(db,a).results.length,0);assert.equal(operation.workRun!.reportedToCoordinatorAt,undefined);
 operation.status='completed';operation.workRun!.state='completed';operation.workRun!.resultOutcome='completed';operation.workRun!.failureCode=undefined;
 assert.equal(appendTaskResultReport(db,a).results.length,1);assert.equal(appendTaskResultReport(db,a).results.length,0);
});

test('automatic conversation reporting includes every latest outcome even after viewing the detail, never stale successes behind failure',()=>{
 const db=fixture(),good=local(db,'good'),old=local(db,'old'),bad=local(db,'bad');
 bad.conversationId=old.conversationId;bad.updatedAt='2026-10-16T12:00:00Z';bad.status='failed';bad.finalResponse='尚未创建文件';
 const read=local(db,'read');read.noticeReadRound=0;
 const stopped=local(db,'stop');stopped.status='cancelled';
 const uncertain=local(db,'uncertain');uncertain.finalResponse='停止操作。无法确认内容，未完成回读';
 local(db,'other-owner',b);
 assert.deepEqual(pendingConversationTaskResults(db,a).map(r=>r.sourceId).sort(),[good.id,read.id,stopped.id,uncertain.id,bad.id].sort());
 assert.equal(unreviewedTaskResults(db,a,{count:50}).some(r=>r.sourceId===bad.id),true);
 assert.equal(pendingConversationTaskResults(db,b).length,1);
});

test('verified Notion saving does not promote an unfinished article, and idle multi-window refresh briefs it once', async () => {
  const db = fixture(), { operation } = cloud(db, 'yesterday-column', a, {state: 'completed', outcome: 'needs_input', text: `## 情况说明\n昨天（2026-10-24，上海时间）的思考和碎碎念，我在你的笔记和 Notion 里没有找到能确认属于这一天的内容。翻到的都是更早的记录，日期都对不上，我不拿它们拼一篇冒充昨天。\n已经把这份说明存进 Notion 草稿了，正文还没有写成。\n## 需要你给我的一步\n- 昨天随口说过的话，原样发来就好\n- 或给几个关键词`});
  operation.workRun!.notionReceipt = {state: 'verified', pageId: 'owned-page', url: 'https://www.notion.so/owned-page'} as any;
  operation.workRun!.unread = false; // Looking at task details must not swallow its main-chat return.
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'needs_input');
  const coordinator = service(db);
  const snapshots = await Promise.all([coordinator.state(a), coordinator.state(a), coordinator.state(a)]);
  const main = db.conversations.find(c => c.id === 'main-a')!;
  assert.equal(main.messages.length, 1);
  assert.match(main.messages[0].content, /所需日期的素材/);
  assert.match(main.messages[0].content, /正文还没写成/);
  assert.match(main.messages[0].content, /几句原话或相关记录/);
  assert.match(main.messages[0].content, /打开 Notion/);
  assert.doesNotMatch(main.messages[0].content, /已完成|已交代|已有任务不会重复安排|翻到的都是/);
  assert.equal(pendingTaskResults(db, a).length, 0);
  assert.equal(db.chatOperations!.filter(o => o.requestId === 'result_notice').length, 1);
  assert.ok(snapshots.every(snapshot => snapshot.recentReportedReceiptIds.includes(operation.id)));
  assert.equal(db.conversations.find(c => c.id === 'main-b')!.messages.length, 0);
});

test('automatic technical failures use a plain next step rather than diagnostics, and a busy dispatcher defers delivery', async () => {
  const db = fixture(), { operation } = cloud(db, 'connection-failure', a, {state: 'failed'});
  operation.workRun!.error = 'stream disconnected before completion: response.completed; Authorization Bearer PRIVATE_SECRET';
  const busy = {...a, id: 'busy', operationId: 'busy', requestId: 'coord_busy', status: 'pending', payloadHash: '', createdAt: timestamp, updatedAt: timestamp} as ChatOperation;
  db.chatOperations!.push(busy);
  const coordinator = service(db);
  assert.equal((await coordinator.state(a)).conversation!.messages.length, 0);
  assert.equal(pendingTaskResults(db, a).length, 1);
  busy.status = 'completed';
  await coordinator.state(a);
  const report = db.conversations.find(c => c.id === 'main-a')!.messages[0];
  assert.match(report.content, /连接中断/);
  assert.match(report.content, /核对已有内容后继续未完成部分/);
  assert.doesNotMatch(report.content, /PRIVATE_SECRET|Authorization|Bearer|response\.completed|stream disconnected/);
  assert.equal(pendingTaskResults(db, b).length, 0);
});

test('unfinished launcher codes never become a conversation brief or model-facing feedback and do not alter saved evidence',()=>{
 for(const code of ['goal_unfinished','goalunfinished','错误码：goal_unfinished']){
  const db=fixture(),task=local(db,'unfinished-code');task.status='failed';task.lastError=code;task.finalResponse='文稿已经保存，结尾还没有完成。请补充结尾实例。';
  local(db,'foreign',b).finalResponse='其他空间的内容';
  saveExecutionReceipt(db,task);
  const conversation=db.conversations.find(c=>c.id===task.conversationId)!,original=conversation.messages.at(-1)!.content;
  assert.match(original,/goal_?unfinished/);
  const receipt=pendingTaskResults(db,a)[0];assert.equal(receipt.outcome,'failed');
  assert.doesNotMatch(receipt.brief!,/goal_?unfinished/);assert.match(receipt.brief!,/结尾还没有完成/);assert.match(receipt.brief!,/请补充结尾实例/);
  assert.doesNotMatch(taskResultConversationContext([receipt])[0].summary,/goal_?unfinished/);
  const first=appendTaskResultReport(db,a),second=appendTaskResultReport(db,a);
  assert.equal(first.results.length,1);assert.equal(second.results.length,0);
  const message=db.conversations.find(c=>c.id==='main-a')!.messages.at(-1)!;
  assert.doesNotMatch(message.content,/goal_?unfinished|其他空间/);assert.match(message.content,/未完成/);
  assert.equal(task.lastError,code);assert.equal(conversation.messages.at(-1)!.content,original);
  assert.equal(db.conversations.find(c=>c.id==='main-b')!.messages.length,0);
 }
});

test('ordinary missing materials outrank a generic progress fallback in the main conversation without dated rules',async()=>{
 const db=fixture(),{operation}=cloud(db,'missing-launcher-material',a,{state:'failed',outcome:'needs_input',text:'还缺启动器的素材。请直接补充一两句素材，我接着写。'});
 operation.workRun!.userReport='这次还没做成，原来的要求还在。剩下的内容还没做好。可以接着处理，不用重做已经完成的部分。';
 const receipt=pendingTaskResults(db,a)[0];
 assert.match(receipt.brief!,/还缺启动器的素材/);assert.match(receipt.brief!,/请直接补充一两句素材/);
 assert.doesNotMatch(receipt.brief!,/剩下的内容|原来的要求还在|先核对已有内容|任务里|点继续/);
 await service(db).state(a);
 const reply=db.conversations.find(c=>c.id==='main-a')!.messages[0].content;
 assert.match(reply,/还缺启动器的素材.*请直接补充一两句素材/);
 assert.doesNotMatch(reply,/剩下的内容|先核对已有内容|任务里|点继续/);
 assert.equal(db.conversations.find(c=>c.id==='main-b')!.messages.length,0);
});

test('partial article bodies keep their concise progress report ahead of the article content',()=>{
 const db=fixture(),{operation}=cloud(db,'partial-article-order',a,{state:'failed',outcome:'partial',text:'文章的第一段正文。这一段不应该变成主对话进展。'});
 operation.workRun!.userReport='正文已写到第二节，第三节还没有完成。请补充结尾的实例。';
 const brief=pendingTaskResults(db,a)[0].brief!;
 assert.match(brief,/^正文已写到第二节/);assert.match(brief,/请补充结尾的实例/);
});

test('a dispatcher claimed between the idle read and report transaction takes priority, without losing the result', async () => {
  const db=fixture();cloud(db,'racing-result',a,{state:'failed',outcome:'needs_input',text:'还缺活动日期。请补充活动是哪一天。'});
  let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>enter=resolve), gate=new Promise<void>(resolve=>release=resolve);
  let held=false;
  const coordinator=new CoordinatorService({read:async()=>db,mutate:async fn=>{if(!held){held=true;enter();await gate;}return fn(db);}},
    {recallWithDiagnostics:async()=>({status:'no_match',chunks:[],failures:[]})});
  const snapshot=coordinator.state(a);await entered;
  const busy={...a,id:'racing-dispatch',operationId:'racing-dispatch',requestId:'coord_racing',status:'pending',payloadHash:'',createdAt:timestamp,updatedAt:timestamp} as ChatOperation;
  db.chatOperations!.push(busy);release();
  assert.equal((await snapshot).conversation!.messages.length,0);
  assert.equal(pendingTaskResults(db,a).length,1);
  assert.equal(db.chatOperations!.filter(o=>o.requestId==='result_notice').length,0);
  busy.status='completed';await coordinator.state(a);
  assert.equal(db.conversations.find(c=>c.id==='main-a')!.messages.length,1);
  assert.match(db.conversations.find(c=>c.id==='main-a')!.messages[0].content,/还缺活动日期.*请补充活动是哪一天/);
  assert.equal(pendingTaskResults(db,a).length,0);
});

test('one task briefing keeps only its newest result, without erasing history or other owners',()=>{
  const db=fixture();const first=local(db,'first'),last=local(db,'last');last.conversationId=first.conversationId;
  first.updatedAt='2026-10-14T01:00:00Z';last.updatedAt='2026-10-14T02:00:00Z';last.status='cancelled';
  local(db,'foreign',b);const pending=pendingTaskResults(db,a);
  const brief=latestTaskResults(pending);assert.equal(brief.length,1);assert.equal(brief[0].sourceId,'last');assert.equal(brief[0].outcome,'cancelled');
  assert.equal(pending.length,2);assert.equal(pendingTaskResults(db,b).length,1);
});

test('an already-reported newer success cannot be replaced by an older unreported failure during another task briefing',()=>{
  const db=fixture(),old=cloud(db,'stale-failure',a,{state:'failed',text:'旧失败'}),fresh=cloud(db,'new-success',a,{outcome:'completed',text:'新成果'});
  fresh.operation.conversationId=old.task.id;fresh.operation.createdAt='2026-10-24T01:00:00Z';fresh.operation.updatedAt='2026-10-24T02:00:00Z';fresh.operation.workRun!.reportedToCoordinatorAt='2026-10-24T02:00:01Z';
  old.operation.updatedAt='2026-10-25T01:00:00Z';
  cloud(db,'another-task',a,{outcome:'completed',text:'另一个成果'});
  assert.deepEqual(pendingConversationTaskResults(db,a).map(r=>r.sourceId),['another-task']);
  assert.deepEqual(appendTaskResultReport(db,a).results.map(r=>r.sourceId),['another-task']);
  assert.doesNotMatch(db.conversations.find(c=>c.id==='main-a')!.messages[0].content,/旧失败|stale-failure/);
  assert.equal(appendTaskResultReport(db,a).results.length,0);
});

for(const state of ['queued','running','prepared'] as const)test(`a newer ${state} attempt suppresses an older terminal notice even if the old attempt updates late`,()=>{
  const db=fixture(),old=cloud(db,'old-failed',a,{state:'failed',text:'旧失败'}),active=cloud(db,'active-attempt',a,{state});
  active.operation.conversationId=old.task.id;active.operation.createdAt='2026-10-24T01:00:00Z';active.operation.updatedAt='2026-10-24T01:00:00Z';
  old.operation.updatedAt='2026-10-25T01:00:00Z';
  assert.equal(pendingConversationTaskResults(db,a).length,0);assert.equal(appendTaskResultReport(db,a).results.length,0);
  assert.equal(pendingTaskResults(db,a).length,1,'the historical failure remains available in its original task');
});

test('automatic grouping happens before bounding, so many old attempts cannot starve a fresh task',()=>{
  const db=fixture();let taskId='';
  for(let i=0;i<70;i++){
    const {operation}=cloud(db,`old-attempt-${i}`,a,{state:'failed',text:'旧失败'});taskId||=operation.conversationId!;
    operation.conversationId=taskId;operation.createdAt=`2026-10-14T01:${String(i%60).padStart(2,'0')}:00Z`;
  }
  const active=cloud(db,'active-replacement',a,{state:'running'});active.operation.conversationId=taskId;active.operation.createdAt='2026-10-24T01:00:00Z';
  cloud(db,'fresh-independent',a,{outcome:'completed',text:'真实新成果'});
  assert.deepEqual(pendingConversationTaskResults(db,a,{count:1}).map(r=>r.sourceId),['fresh-independent']);
  assert.deepEqual(appendTaskResultReport(db,a).results.map(r=>r.sourceId),['fresh-independent']);
});
test('current results are prioritized ahead of a backlog of unrelated historical terminal work',()=>{
  const db=fixture();for(let i=0;i<70;i++)cloud(db,`historical-${i}`,a,{state:'failed',text:'旧记录'});
  const fresh=cloud(db,'latest-real-task',a,{outcome:'needs_input',text:'请补充昨天的素材。'});fresh.operation.createdAt=fresh.operation.updatedAt='2026-10-25T01:00:00Z';
  assert.deepEqual(pendingConversationTaskResults(db,a,{count:1}).map(r=>r.id),[fresh.operation.id]);
  const report=appendTaskResultReport(db,a);assert.equal(report.results[0].id,fresh.operation.id);assert.equal(report.results.length,10);
  assert.equal(pendingTaskResults(db,a,{count:50}).length,50,'older historical records are not silently migrated or marked reported');
});

test('a new local continuation round is ordered by its round input, not original execution creation or a late terminal timestamp',()=>{
  const db=fixture(),first=cloud(db,'prior-cloud',a,{state:'failed',text:'先前失败'}),execution=local(db,'continued-local');
  execution.conversationId=first.task.id;execution.reportRound=1;execution.status='running';execution.finalResponse=undefined;
  first.operation.createdAt='2026-10-24T01:00:00Z';first.operation.updatedAt='2026-10-25T02:00:00Z';
  db.executionEvents=[{...a,id:'round-input',taskId:execution.id,kind:'user_message',text:'新一轮要求',round:1,createdAt:'2026-10-25T01:00:00Z'}];
  assert.equal(pendingConversationTaskResults(db,a).length,0);
  execution.status='completed';execution.finalResponse='新一轮正确结果';execution.completedAt='2026-10-25T03:00:00Z';
  assert.deepEqual(pendingConversationTaskResults(db,a).map(r=>r.sourceId),[execution.id]);
});

function recoverReceipt(db: Database, task: ExecutionTask) {
  const id=`execution_receipt_${task.id}_0_recovery_${'a'.repeat(24)}`;
  const message={...a,id,conversationId:task.conversationId,role:'assistant' as const,content:'连接恢复后，已补回本轮真实回答：/QA/result.md 回读正确',createdAt:'2026-10-14T02:00:00.000Z'};
  db.messages.push(message);db.conversations.find(c=>c.id===task.conversationId)!.messages.push(message);
  task.terminalReceipt={id:'receipt',hash:'hash',attemptId:'attempt',round:0,outcome:'completed',disposition:'accepted',receivedAt:message.createdAt,receiptMessageId:id};
  task.status='completed';task.finalResponse=message.content;task.lastError=undefined;task.updatedAt=task.completedAt=message.createdAt;
  task.reportedToCoordinatorAt=task.reportMessageId=undefined;task.reportedRound=task.noticeReadRound=undefined;
  return id;
}

test('recovered answers remain new evidence after the disconnect notice was reported and read',()=>{
  const db=fixture(),task=local(db,'recover');task.status='failed';task.finalResponse=undefined;task.lastError='本机连接中断，结果尚未确认';
  saveExecutionReceipt(db,task);
  const old=pendingTaskResults(db,a)[0];appendTaskResultReport(db,a);acknowledgeTaskResults(db,a,[old.id]);
  const recoveredMessage=recoverReceipt(db,task),fresh=pendingTaskResults(db,a)[0];
  assert.notEqual(fresh.id,old.id);assert.equal(fresh.resultMessageId,recoveredMessage);assert.match(fresh.summary,/回读正确/);
  assert.equal(unreviewedTaskResults(db,a).length,1);assert.equal(pendingTaskResults(db,b).length,0);
  assert.throws(()=>acknowledgeTaskResults(db,a,[old.id]),/不存在/);
  appendTaskResultReport(db,a);assert.equal(pendingTaskResults(db,a).length,0);
  assert.equal(db.messages.filter(m=>m.id===recoveredMessage).length,1);
  acknowledgeTaskResults(db,a,[fresh.id]);assert.equal(unreviewedTaskResults(db,a).length,0);
});

test('a dispatcher reply that saw the old disconnect notice cannot consume a same-round recovered answer',()=>{
  const db=fixture(),task=local(db,'in-flight');task.status='failed';task.finalResponse=undefined;task.lastError='连接中断';saveExecutionReceipt(db,task);
  const old=pendingTaskResults(db,a)[0],captures=captureTaskResults(db,a,[old.id]);
  recoverReceipt(db,task);const fresh=pendingTaskResults(db,a)[0];
  assert.deepEqual(capturedTaskResultsForReport(db,a,captures).map(r=>r.id),[old.id]);
  db.conversations.find(c=>c.id==='main-a')!.messages.push({id:'reply',role:'assistant',content:'我看到这一轮断线了',createdAt:timestamp});
  markTaskResultsReported(db,a,{ids:[old.id],assistantMessageId:'reply',captures});
  assert.equal(task.reportedRound,undefined);assert.equal(task.reportMessageId,undefined);
  assert.deepEqual(pendingTaskResults(db,a).map(r=>r.id),[fresh.id]);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,'reply'),[old.id]);
  const tampered=structuredClone(captures);tampered[0].result.summary='编造结果';
  assert.equal(capturedTaskResultsForReport(db,a,tampered).length,0);
});

test('cancellation remains explicit even when an earlier disconnect receipt exists',()=>{
  const db=fixture(),task=local(db,'cancel-offline');task.status='failed';task.finalResponse=undefined;task.lastError='连接中断';saveExecutionReceipt(db,task);
  task.status='cancelled';task.lastError='停止请求已提交';
  assert.equal(pendingTaskResults(db,a)[0].outcome,'cancelled');assert.match(pendingTaskResults(db,a)[0].summary,/本轮已停止/);
});

const a = { workspaceId: 'wa', userId: 'a' }, b = { workspaceId: 'wb', userId: 'b' };
const timestamp = '2026-10-14T01:00:00.000Z';
test('welcome guide is successful only with an owned ready image and its server snapshot; reports carry the private card',()=>{
  const db=fixture(),{task,operation}=cloud(db,'guide',a,{kind:'image',text:'使用说明做好了'});
  const facts={version:1 as const,nickname:'小张',purposes:[],platforms:[],features:[],localReady:false};
  operation.workRun!.welcomeGuide=facts;
  const file={...a,id:'guide-image',conversationId:task.id,originalName:'小张的 ONE 使用说明.png',kind:'image',mimeType:'image/png',size:42,status:'ready',welcomeGuide:facts,storagePath:'/private/test.png',extractedText:'',createdAt:timestamp} as Attachment;
  db.attachments.push(file);task.messages[0].attachments=[{id:file.id,originalName:file.originalName,kind:'image',mimeType:'image/png',size:42,status:'ready',welcomeGuide:true}];
  assert.equal(pendingTaskResults(db,a)[0].outcome,'completed');assert.equal(pendingTaskResults(db,a)[0].imageUrl,undefined);
  assert.equal(pendingTaskResults(db,b).length,0);
  file.status='failed';assert.equal(pendingTaskResults(db,a)[0].outcome,'failed');file.status='ready';
  appendTaskResultReport(db,a);
  const reply=db.conversations.find(c=>c.id==='main-a')!.messages.at(-1)!;
  assert.equal(reply.attachments?.[0].welcomeGuide,true);assert.equal(reply.imageUrl,undefined);
  assert.equal('nickname' in reply.attachments![0],false);
});
function conversation(id: string, scope = a, main = false): Conversation {
  return { ...scope, id, modelId: 'worker', title: id, coordinatorMain: main, ...(main?{taskResultReportSince:timestamp}:{}), archived: false, messages: [], createdAt: timestamp, updatedAt: timestamp };
}
function fixture() {
  return { users: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }],
    workspaceMembers: [{ ...a }, { ...b }], conversations: [conversation('main-a', a, true), conversation('main-b', b, true)],
    chatOperations: [], executionTasks: [], messages: [], attachments: [], settings: {} } as unknown as Database;
}
function cloud(db: Database, id: string, scope = a, input: { state?: WorkRun['state']; text?: string; outcome?: WorkRun['resultOutcome']; kind?: 'image' } = {}) {
  const task = conversation(`task-${id}`, scope), resultMessageId = `result-${id}`;
  if (input.text !== undefined) task.messages.push({ id: resultMessageId, role: 'assistant', content: input.text, createdAt: timestamp });
  db.conversations.push(task);
  const operation = { ...scope, id, conversationId: task.id, operationId: `operation_${id}`, requestId: `work_${id}`, payloadHash: id, status: 'completed', createdAt: timestamp, updatedAt: timestamp,
    workRun: { state: input.state ?? 'completed', kind: input.kind, inputMessageId: 'input', instruction: 'do not leak full handoff', resultMessageId,
      resultOutcome: input.outcome, unread: true } } as ChatOperation;
  db.chatOperations!.push(operation);
  return { task, operation };
}
function local(db: Database, id: string, scope = a): ExecutionTask {
  db.conversations.push(conversation(`task-${id}`, scope));
  const task: ExecutionTask = { ...scope, id, conversationId: `task-${id}`, sourceMessageId: 'input', provider: 'codex', status: 'completed',
    instruction: 'private compiled instructions', deviceId: 'private-key', finalResponse: '创建了 /QA/result.md，回读内容匹配', targetName: '/QA', createdAt: timestamp, updatedAt: timestamp };
  db.executionTasks.push(task); return task;
}

test('durable grouped delivery survives refresh and reports once without clearing user review', () => {
  const db = fixture(); cloud(db, 'one', a, { text: '合作方案实际正文' }); local(db, 'two'); cloud(db, 'foreign', b, { text: 'other workspace secret' });
  const pending = pendingTaskResults(db, a);
  assert.deepEqual(pending.map(r => r.id), ['one', 'two']);
  assert.equal(pending[0].outcome, 'returned', 'model answer alone is not proof of the deliverable');
  const report = appendTaskResultReport(db, a, { ids: pending.map(r => r.id) });
  assert.equal(report.deferred, false); assert.equal(report.results.length, 2);
  const main = db.conversations.find(c => c.id === 'main-a')!;
  assert.equal(main.messages.length, 1); assert.match(main.messages[0].content, /合作方案实际正文/); assert.match(main.messages[0].content, /\/QA\/result.md/);
  assert.doesNotMatch(main.messages[0].content, /other workspace secret|private compiled|private-key/);
  assert.deepEqual(db.chatOperations!.filter(o => o.requestId === 'result_notice').map(o => o.assistantMessageId), [main.messages[0].id, main.messages[0].id]);
  const refreshed = JSON.parse(JSON.stringify(db)) as Database;
  assert.equal(pendingTaskResults(refreshed, a).length, 0);
  assert.equal(appendTaskResultReport(refreshed, a).results.length, 0);
  assert.equal(refreshed.conversations.find(c => c.id === 'main-a')!.messages.length, 1);
  assert.equal(unreviewedTaskResults(refreshed, a).length, 2);
  assert.ok(unreviewedTaskResults(refreshed, a).every(r => r.reported));
  assert.equal(refreshed.chatOperations!.find(o => o.id === 'one')!.workRun!.unread, true);
  acknowledgeTaskResults(refreshed, a, ['one']); assert.deepEqual(unreviewedTaskResults(refreshed, a).map(r => r.id), ['two']);
  assert.equal(pendingTaskResults(refreshed, b).length, 1);
});

test('viewing an owned result is independent of dispatcher reporting and rejects all foreign IDs atomically', () => {
  const db = fixture(); const { operation } = cloud(db, 'own', a, { text: 'own result' }); cloud(db, 'foreign', b, { text: 'secret' });
  assert.throws(() => acknowledgeTaskResults(db, a, ['own', 'foreign']), /不存在/);
  assert.equal(operation.workRun!.unread, true);
  acknowledgeTaskResults(db, a, ['own']);
  assert.equal(unreviewedTaskResults(db, a).length, 0); assert.equal(pendingTaskResults(db, a).length, 1);
  assert.equal(operation.workRun!.reportedToCoordinatorAt, undefined);
  db.workspaceMembers[0].status = 'disabled';
  assert.throws(() => pendingTaskResults(db, a), /不可用/);
});

test('legacy notice markers suppress old result replay without crossing scope', () => {
  const db = fixture(); const own = cloud(db, 'already-shown', a, { text: 'old answer' }); const fresh = cloud(db, 'fresh', a, { text: 'new answer' });
  own.operation.workRun!.unread = false;
  db.chatOperations!.push({ ...a, id: 'notice_already-shown', operationId: 'notice_already-shown', requestId: 'result_notice', status: 'completed', payloadHash: '', createdAt: timestamp, updatedAt: timestamp });
  db.chatOperations!.push({ ...b, id: 'notice_fresh', operationId: 'notice_fresh', requestId: 'result_notice', status: 'completed', payloadHash: '', createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual(pendingTaskResults(db, a).map(r => r.id), ['fresh']);
  appendTaskResultReport(db, a);
  assert.ok(fresh.operation.workRun!.reportedToCoordinatorAt); assert.equal(unreviewedTaskResults(db, a).length, 1);
});

test('pending dispatcher reply defers automatic reports and explicit snapshot marks never swallow new results', () => {
  const db = fixture(); cloud(db, 'before', a, { text: 'first result' });
  const snapshot = pendingTaskResults(db, a);
  db.chatOperations!.push({ ...a, id: 'pending-router', operationId: 'pending-router', requestId: 'coord_wait', status: 'pending', payloadHash: '', createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual(appendTaskResultReport(db, a), { deferred: true, results: [], messageId: undefined });
  assert.equal(db.conversations.find(c => c.id === 'main-a')!.messages.length, 0);
  assert.throws(() => markTaskResultsReported(db, a, { ids: snapshot.map(r => r.id), assistantMessageId: 'answer' }), /尚未保存/);
  cloud(db, 'after', a, { text: 'later result' });
  db.conversations.find(c => c.id === 'main-a')!.messages.push({ id: 'answer', role: 'assistant', content: 'Respond to user and mention first result', createdAt: timestamp });
  markTaskResultsReported(db, a, { ids: snapshot.map(r => r.id), assistantMessageId: 'answer' });
  assert.deepEqual(pendingTaskResults(db, a).map(r => r.id), ['after']);
  markTaskResultsReported(db, a, { ids: snapshot.map(r => r.id), assistantMessageId: 'answer' });
  assert.equal(db.chatOperations!.filter(o => o.id === 'notice_before').length, 1);
});

test('local review and reports are per round and old snapshots cannot acknowledge a later round', () => {
  const db = fixture(), task = local(db, 'same-task');
  const initial = pendingTaskResults(db, a);
  appendTaskResultReport(db, a); acknowledgeTaskResults(db, a, initial.map(r => r.id));
  assert.equal(task.reportedRound, 0); assert.equal(task.noticeReadRound, 0);
  task.reportRound = 1; task.finalResponse = '第二轮改了标题并回读';
  assert.deepEqual(pendingTaskResults(db, a).map(r => r.id), ['same-task_1']);
  assert.deepEqual(unreviewedTaskResults(db, a).map(r => r.id), ['same-task_1']);
  markTaskResultsReported(db, a, { ids: initial.map(r => r.id), assistantMessageId: db.conversations.find(c => c.id === 'main-a')!.messages[0].id! });
  assert.equal(pendingTaskResults(db, a).length, 1);
  assert.throws(() => acknowledgeTaskResults(db, a, initial.map(r => r.id)), /不存在/);
  appendTaskResultReport(db, a); assert.equal(pendingTaskResults(db, a).length, 0); assert.equal(task.reportedRound, 1);
});

test('image completion requires actual owned private image and report shares access only to owned main chat', () => {
  const db = fixture(), { task, operation } = cloud(db, 'image', a, { text: 'cannot draw here', kind: 'image' });
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'failed');
  assert.match(pendingTaskResults(db, a)[0].summary, /没有返回可确认的图片/);
  const image: Attachment = { ...a, id: 'own-image', conversationId: task.id, originalName: 'result.png', mimeType: 'image/png', kind: 'image', size: 25, storagePath: '/private/not-for-api', extractedText: '', createdAt: timestamp };
  db.attachments.push(image);
  task.messages[0].imageUrl = '/api/attachments/own-image/content'; task.messages[0].attachments = [{ id: image.id, kind: image.kind, originalName: image.originalName, mimeType: image.mimeType, size: image.size }];
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'completed');
  const report = appendTaskResultReport(db, a);
  assert.equal(db.conversations.find(c => c.id === 'main-a')!.messages[0].imageUrl, '/api/attachments/own-image/content');
  assert.deepEqual(image.sharedConversationIds, ['main-a']); assert.equal(operation.workRun!.unread, true);
  assert.doesNotMatch(JSON.stringify(report), /private\/not-for-api/);
  const other = cloud(db, 'foreign-image', a, { text: 'image', kind: 'image' });
  db.attachments.push({ ...image, ...b, id: 'other-image', conversationId: other.task.id });
  other.task.messages[0].imageUrl = '/api/attachments/other-image/content';
  assert.equal(pendingTaskResults(db, a)[0].outcome, 'failed');
});

test('failed partial, no-result and needs-input receipts remain truthful and bounded', () => {
  const db = fixture(); const failed = cloud(db, 'failed', a, { state: 'failed', text: '部分正文', outcome: 'partial' });
  failed.operation.workRun!.resultOutcome = 'partial';
  cloud(db, 'empty', a); cloud(db, 'needs-input', a, { text: '请确认标题', outcome: 'needs_input' });
  cloud(db, 'long', a, { text: 'long result '.repeat(1000), outcome: 'completed' });
  const localFailed = local(db, 'local-partial'); localFailed.status = 'failed'; localFailed.lastError = '写入第二个文件失败';
  const outcomes = new Map(pendingTaskResults(db, a).map(r => [r.id, r.outcome]));
  assert.equal(outcomes.get('failed'), 'partial'); assert.equal(outcomes.get('empty'), 'needs_input');
  assert.equal(outcomes.get('needs-input'), 'needs_input'); assert.equal(outcomes.get('local-partial'), 'failed');
  assert.equal(outcomes.get('long'), 'completed');
  const bounded = pendingTaskResults(db, a, { count: 2, summaryChars: 100, totalChars: 150 });
  assert.equal(bounded.length, 2); assert.ok(bounded.reduce((n, r) => n + r.summary.length, 0) <= 150);
  assert.equal(db.chatOperations!.find(o => o.id === 'long')!.workRun!.reportedToCoordinatorAt, undefined);
});

function service(db: Database) {
  return new CoordinatorService({ read: async () => db, mutate: async fn => fn(db) },
    { recallWithDiagnostics: async () => ({ chunks: [], failures: [], status: 'no_match' }) });
}
test('legacy auto-report origin excludes the observed 32-task history flood, retains the latest real handoff and is persisted once',async()=>{
  const db=fixture(),main=db.conversations.find(c=>c.id==='main-a')!;delete main.taskResultReportSince;
  main.messages.push({id:'latest-real-request',role:'user',content:'用昨天素材写专栏',createdAt:'2026-10-25T01:00:00Z'});
  for(let i=0;i<32;i++){
    const item=cloud(db,`legacy-qa-${i}`,a,{state:'failed',text:'旧QA失败'});
    item.operation.createdAt=item.operation.updatedAt='2026-10-01T01:00:00Z';item.operation.workRun!.unread=i%2===0;
  }
  const column=cloud(db,'latest-column',a,{state:'failed',outcome:'needs_input',text:'还缺昨天素材，正文还没写成。请补充几句原话。'});
  column.operation.createdAt='2026-10-25T01:00:01Z';column.operation.updatedAt='2026-10-25T01:05:00Z';
  const coordinator=service(db);await Promise.all([coordinator.state(a),coordinator.state(a),coordinator.state(a)]);
  assert.equal(main.taskResultReportSince,'2026-10-25T01:00:00Z');
  assert.equal(main.messages.filter(m=>m.role==='assistant').length,1);
  assert.match(main.messages.at(-1)!.content,/latest-column.*需要你确认/);assert.doesNotMatch(main.messages.at(-1)!.content,/legacy-qa|旧QA/);
  for(let i=0;i<6;i++){
    const snapshot=await coordinator.state(a);
    assert.ok(snapshot.notices.every(notice=>!notice.id.startsWith('legacy-qa-')),'excluded history must not linger in notification bubbles');
  }
  assert.equal(main.messages.filter(m=>m.role==='assistant').length,1,'ordinary polls cannot drain the older history into chat');
  const old=db.chatOperations!.filter(o=>o.id.startsWith('legacy-qa-'));
  assert.equal(old.length,32);assert.ok(old.every(o=>!o.workRun!.reportedToCoordinatorAt));
  assert.equal(pendingTaskResults(db,a,{count:50}).length,32,'history remains real, unreported and available for explicit inspection');
  assert.equal(db.conversations.find(c=>c.id==='main-b')!.messages.length,0);
});

test('the fixed origin never advances: early-started parallel work and results before a later message still return days later',async()=>{
  const db=fixture(),main=db.conversations.find(c=>c.id==='main-a')!;delete main.taskResultReportSince;
  main.messages.push({id:'start',role:'user',content:'本轮工作',createdAt:'2026-10-25T01:00:00Z'});
  initializeTaskResultReporting(db,a,'2026-10-25T01:00:01Z');
  const parallel=cloud(db,'early-parallel',a,{state:'running'});parallel.operation.createdAt='2026-10-01T01:00:00Z';
  parallel.operation.workRun!.state='completed';parallel.operation.workRun!.resultOutcome='completed';parallel.operation.updatedAt='2026-10-26T01:00:00Z';
  parallel.task.messages.push({id:parallel.operation.workRun!.resultMessageId!,role:'assistant',content:'较早开始的任务刚做完',createdAt:'2026-10-26T01:00:00Z'});
  main.messages.push({id:'later-user',role:'user',content:'继续聊新话题',createdAt:'2026-10-26T01:00:01Z'});
  initializeTaskResultReporting(db,a,'2026-10-28T01:00:00Z');
  assert.equal(main.taskResultReportSince,'2026-10-25T01:00:00Z');
  const report=appendTaskResultReport(db,a,{timestamp:'2026-10-28T01:00:00Z'});
  assert.deepEqual(report.results.map(r=>r.id),['early-parallel']);assert.match(main.messages.at(-1)!.content,/较早开始的任务刚做完/);
  assert.equal(appendTaskResultReport(db,a).results.length,0);
});

test('an empty main starts automatic reporting now while explicit history reporting stays available',()=>{
  const db=fixture(),main=db.conversations.find(c=>c.id==='main-a')!;delete main.taskResultReportSince;
  cloud(db,'older-unreported',a,{state:'failed',text:'历史问题'});
  initializeTaskResultReporting(db,a,'2026-10-25T01:00:00Z');
  assert.equal(pendingConversationTaskResults(db,a).length,0);assert.equal(appendTaskResultReport(db,a).results.length,0);
  assert.deepEqual(appendTaskResultReport(db,a,{ids:['older-unreported']}).results.map(r=>r.id),['older-unreported']);
});

test('local shell temporary-file failures get a short saving next step, not raw command diagnostics',()=>{
  const db=fixture(),execution=local(db,'shell-failed');execution.status='failed';
  execution.lastError='首次写入命令因系统拒绝创建 here-document 临时文件而失败；/bin/zsh -lc ...';execution.finalResponse='目标已存在，未读取。';
  const report=appendTaskResultReport(db,a);
  assert.match(report.results[0].brief!,/本机保存这一步没成功.*先核对目标文件/);
  assert.doesNotMatch(db.conversations.find(c=>c.id==='main-a')!.messages[0].content,/here-document|临时文件|\/bin\/zsh|首次写入命令/);
});

test('partial status paragraphs are not copied back as requested materials or repeated after a clipped reason',()=>{
  const db=fixture();
  const paragraph='本轮已完成资料整理，但报告还没有全部写完。已保存的提纲和正文会保留。你可以在任务里点“开始处理最新要求”继续。';
  const {operation}=cloud(db,'partial-paragraph',a,{state:'failed',outcome:'partial',text:paragraph});
  operation.workRun!.userReport=paragraph;
  const report=appendTaskResultReport(db,a),brief=report.results[0].brief!;
  assert.equal(brief.split('本轮已完成资料整理').length-1,1);
  assert.equal(brief.split('已保存的提纲和正文会保留').length-1,1);
  assert.doesNotMatch(brief,/你可以先补充|任务里|开始处理最新要求|点击|按钮/);
  assert.match(brief,/还没有全部写完/);
});

test('a next-step paragraph containing its own reason reports each sentence only once',()=>{
  const db=fixture(),reason='活动方案还缺举办日期。';
  cloud(db,'overlapping-next-step',a,{state:'failed',outcome:'needs_input',text:`${reason}\n## 下一步\n${reason}请补充活动是哪一天。\n${reason}`});
  const brief=appendTaskResultReport(db,a).results[0].brief!;
  assert.equal(brief.split(reason).length-1,1);
  assert.equal(brief.split('请补充活动是哪一天').length-1,1);
  assert.doesNotMatch(brief,/你可以先补充/);
});

test('deduplication preserves a real request after a repeated status prefix in the same sentence',()=>{
  const db=fixture(),{operation}=cloud(db,'inline-material-action',a,{state:'failed',outcome:'partial',text:'正文还没有全部写完，请补充活动的原始记录。'});
  operation.workRun!.userReport='正文还没有全部写完。';
  const brief=appendTaskResultReport(db,a).results[0].brief!;
  assert.equal(brief.split('正文还没有全部写完').length-1,1);
  assert.equal(brief.split('请补充活动的原始记录').length-1,1);
});

test('a real material heading with terse fields remains a concrete request rather than generic continuation',()=>{
  const db=fixture();
  cloud(db,'material-fields',a,{state:'failed',outcome:'needs_input',text:'方案还缺必要信息。\n## 需要你补充\n- 活动日期\n- 参与人数'});
  const brief=appendTaskResultReport(db,a).results[0].brief!;
  assert.match(brief,/请补充：活动日期、参与人数。/);
  assert.equal(brief.split('活动日期').length-1,1);assert.equal(brief.split('参与人数').length-1,1);
});

test('an inline material heading becomes one request instead of repeating its label and content',()=>{
  const db=fixture();
  cloud(db,'inline-material-heading',a,{state:'failed',outcome:'needs_input',text:'还缺活动安排。\n需要你补充：活动日期与参与人数'});
  const brief=appendTaskResultReport(db,a).results[0].brief!;
  assert.equal(brief.split('活动日期与参与人数').length-1,1);
  assert.match(brief,/请补充：活动日期与参与人数。/);
});

test('uncertain saving keeps the real safety check and never disguises it as missing material or a start button',()=>{
  const db=fixture();
  cloud(db,'uncertain-save-action',a,{state:'failed',outcome:'partial',text:'本轮写入的保存结果尚未确认。请先核对 Notion 原页面是否已有草稿；确认后再继续，不要重复新建。\n你可以在任务里点继续。'});
  const brief=appendTaskResultReport(db,a).results[0].brief!;
  assert.match(brief,/保存结果尚未确认/);assert.match(brief,/核对 Notion 原页面/);assert.match(brief,/不要重复新建/);
  assert.doesNotMatch(brief,/你可以先补充|任务里|点继续/);
});

test('budget recovery actions are not labeled as requested content',()=>{
  const db=fixture();
  cloud(db,'budget-action',a,{state:'failed',text:'这次超过本轮预算。你可以先调整本次预算，再告诉我继续。'});
  const brief=appendTaskResultReport(db,a).results[0].brief!;
  assert.match(brief,/可用电力或本次使用上限/);assert.match(brief,/调整本次预算/);
  assert.doesNotMatch(brief,/你可以先补充|开始处理最新要求/);
});
test('coordinator snapshot keeps reported but unreviewed results, correct badge count and all batch links', async () => {
  const db = fixture(), own = cloud(db, 'one', a, { text: '第一任务结果' }), second = cloud(db, 'two', a, { text: '第二任务结果' });
  cloud(db, 'other', b, { text: 'foreign secret' });
  db.chatOperations!.push({ ...a, id: 'batch-accept', operationId: 'batch-accept', payloadHash: '', requestId: 'coord_batch', status: 'completed',
    assistantMessageId: 'accepted', conversationId: 'main-a', dispatchedTaskId: own.task.id, dispatchedTaskIds: [own.task.id, second.task.id, 'foreign-task'], createdAt: timestamp, updatedAt: timestamp });
  const coordinator = service(db);
  assert.equal((await coordinator.state(a)).notices.length, 2);
  await coordinator.report(a, ['one', 'two'], async () => {});
  const state = await coordinator.state(a);
  assert.equal(state.notices.length, 2); assert.ok(state.notices.every(n => n.reported && !n.read));
  assert.ok(state.tasks.every(t => t.unreadCount === 1));
  assert.deepEqual(state.links.filter(l => l.messageId === 'accepted').map(l => l.taskId).sort(), [own.task.id, second.task.id].sort());
  await coordinator.acknowledge(a, ['one']);
  assert.deepEqual((await coordinator.state(a)).notices.map(n => n.id), ['two']);
  await coordinator.report(b, ['two'], async () => {});
  assert.equal(db.conversations.find(c => c.id === 'main-b')!.messages.length, 0);
});
test('coordinator report defers for active reply and task transfers survive pagination with local and dependencies', async () => {
  const db = fixture(); cloud(db, 'result', a, { text: '实际结果' });
  const dependency = cloud(db, 'dependency', a, { state: 'running' }), waiting = cloud(db, 'waiting', a, { state: 'queued' });
  waiting.operation.workRun!.dependsOnOperationIds = [dependency.operation.operationId];
  const prepared = cloud(db, 'prepared', a, { state: 'prepared' });
  const execution = local(db, 'local'); execution.status = 'selecting_target';
  db.chatOperations!.push({ ...a, id: 'router', operationId: 'router', requestId: 'coord_wait', payloadHash: '', status: 'pending', createdAt: timestamp, updatedAt: timestamp });
  const coordinator = service(db), report = await coordinator.report(a, ['result'], async () => {});
  assert.equal(report.deferred, true); assert.equal(pendingTaskResults(db, a).length, 1);
  const state = await coordinator.state(a, 2);
  assert.equal(state.tasks.length, 0); assert.equal(state.transfers.length, 4);
  assert.equal(state.transfers.find(t => t.id === waiting.task.id)!.state, 'waiting');
  assert.equal(state.transfers.find(t => t.id === prepared.task.id)!.localPrepared, true);
  assert.equal(state.transfers.find(t => t.id === execution.conversationId)!.queued, 1);
});

test('an earlier local round finishing after a new prepared requirement cannot hide its pending execution card', async () => {
  const db = fixture(), { task, operation } = cloud(db, 'followup', a, { state: 'prepared' });
  operation.workRun!.inputMessageId = 'new-requirement';
  const oldExecution: ExecutionTask = { ...a, id: 'earlier-local-round', conversationId: task.id, sourceMessageId: 'old-requirement',
    provider: 'codex', status: 'completed', instruction: 'prior task', deviceId: 'fixture-key', finalResponse: '上一轮实际结果',
    createdAt: '2026-10-14T00:59:00.000Z', updatedAt: '2026-10-14T01:01:00.000Z' };
  db.executionTasks.push(oldExecution);
  const coordinator = service(db);
  let state = await coordinator.state(a);
  assert.equal(state.transfers.find(t => t.id === task.id)?.state, 'prepared_local');
  assert.equal(state.transfers.find(t => t.id === task.id)?.localPrepared, true);
  await coordinator.report(a, [oldExecution.id], async () => {});
  await coordinator.acknowledge(a, [oldExecution.id]);
  state = await coordinator.state(a);
  assert.equal(state.notices.length, 0);
  assert.equal(state.transfers.find(t => t.id === task.id)?.state, 'prepared_local', 'a reported and viewed earlier result does not consume the next requirement');
  db.executionTasks.push({ ...oldExecution, id: 'accepted-new-local', sourceMessageId: 'new-requirement', status: 'queued' });
  state = await coordinator.state(a);
  assert.equal(state.transfers.find(t => t.id === task.id)?.localPrepared, false);
  assert.equal(state.transfers.find(t => t.id === task.id)?.queued, 1);
});

test('read-all acknowledges every current owned terminal result without reporting or touching running and future rounds', () => {
  const db=fixture();
  for(let i=0;i<55;i++)cloud(db,`own-${i}`,a,{text:`实际成果${i}`});
  const failed=cloud(db,'failed',a,{state:'failed',text:'调用失败'});
  const foreign=cloud(db,'foreign',b,{text:'其他空间成果'});
  const running=cloud(db,'running',a,{state:'running'}),prepared=cloud(db,'prepared',a,{state:'prepared'});
  const execution=local(db,'local-round');
  const result=acknowledgeAllTaskResults(db,a);
  assert.equal(result.count,57);assert.equal(result.ids.length,57);
  assert.equal(unreviewedTaskResults(db,a).length,0);
  assert.equal(failed.operation.workRun!.unread,false);
  assert.equal(foreign.operation.workRun!.unread,true);
  assert.equal(running.operation.workRun!.state,'running');assert.equal(running.operation.workRun!.unread,true);
  assert.equal(prepared.operation.workRun!.state,'prepared');
  assert.equal(db.conversations.find(c=>c.id==='main-a')!.messages.length,0);
  assert.ok(db.chatOperations!.filter(o=>o.workRun).every(o=>!o.workRun!.reportedToCoordinatorAt));
  assert.equal(acknowledgeAllTaskResults(db,a).count,0);
  const refreshed=structuredClone(db);const next=refreshed.executionTasks.find(t=>t.id===execution.id)!;
  next.reportRound=1;next.status='running';
  assert.equal(acknowledgeAllTaskResults(refreshed,a).count,0);assert.equal(next.noticeReadRound,0);
  next.status='completed';next.finalResponse='新一轮回读匹配';
  assert.deepEqual(unreviewedTaskResults(refreshed,a).map(r=>r.id),['local-round_1']);
  cloud(refreshed,'later',a,{text:'之后才完成'});
  assert.deepEqual(unreviewedTaskResults(refreshed,a).map(r=>r.id),['later','local-round_1']);
  refreshed.workspaceMembers[0].status='disabled';assert.throws(()=>acknowledgeAllTaskResults(refreshed,a),/不可用/);
});

test('reported receipt identity remains available for the exact owned answer after user review', () => {
  const db=fixture();cloud(db,'first',a,{text:'真实正文'});const execution=local(db,'local-result');
  const report=appendTaskResultReport(db,a);
  acknowledgeAllTaskResults(db,a);
  assert.equal(unreviewedTaskResults(db,a).length,0);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,report.messageId),['first','local-result']);
  assert.deepEqual(taskResultIdsReportedInMessage(db,b,report.messageId),[]);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,'missing'),[]);
  execution.reportRound=1;execution.finalResponse='第二轮尚未汇报';
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,report.messageId),['first','local-result'],'an exact already-reported old round remains tied to its saved answer');
  assert.equal(pendingTaskResults(db,a)[0].id,'local-result_1');
});

test('friendly result context keeps actual failure and file evidence without quoting internal identifiers', () => {
  const db=fixture();const execution=local(db,'secret-operation');execution.status='failed';execution.lastError='第二个文件写入失败';
  const result=pendingTaskResults(db,a)[0];result.summary='【本机执行回执 · codex · 第 1 轮 · secret-operation】\n第二个文件写入失败；已创建 /QA/result.md';
  const projected=taskResultConversationContext([result]),context=JSON.stringify(projected);
  assert.doesNotMatch(context,/sourceId|resultMessageId/);
  assert.doesNotMatch(projected[0].summary,/secret-operation/);
  assert.match(context,/第二个文件写入失败/);assert.match(context,/\/QA\/result.md/);assert.match(context,/task=/);
  assert.equal(result.id,'secret-operation','source identity remains intact server-side');
  result.attachments=[{id:'att_owned',originalName:'说明.html',mimeType:'text/html',kind:'document',size:12,visualDocument:true}];
  assert.deepEqual(taskResultConversationContext([result])[0].attachments,[{name:'说明.html',kind:'document',openUrl:'/api/welcome-pages/att_owned/view',downloadUrl:'/api/attachments/att_owned/content'}]);
});

test('an owned captured old local round reports from immutable evidence without marking the current round', () => {
  const db=fixture(),task=local(db,'same-local'),other=local(db,'foreign-local',b);
  saveExecutionReceipt(db,task);saveExecutionReceipt(db,other);
  const captures=captureTaskResults(db,a,['same-local','foreign-local']);assert.equal(captures.length,1);
  task.reportRound=1;task.status='running';task.finalResponse=undefined;
  assert.deepEqual(capturedTaskResultsForReport(db,a,captures).map(result=>result.id),['same-local']);
  assert.deepEqual(capturedTaskResultsForReport(db,b,captures),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],workspaceId:'wb'}]),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],result:{...captures[0].result,taskId:'task-foreign-local'}}]),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],localEvidence:{...captures[0].localEvidence!,contentHash:'forged'}}]),[]);
  assert.deepEqual(capturedTaskResultsForReport(db,a,[{...captures[0],result:{...captures[0].result,summary:'另一件事的秘密'}}]),[]);
  const main=db.conversations.find(c=>c.id==='main-a')!;
  main.messages.push({id:'captured-answer',role:'assistant',content:'上一轮文件的实际结果已返回。',createdAt:timestamp});
  markTaskResultsReported(db,a,{ids:['same-local'],assistantMessageId:'captured-answer',captures});
  assert.equal(db.chatOperations!.filter(o=>o.id==='notice_same-local').length,1);
  assert.equal(task.reportedRound,undefined);assert.equal(task.reportedToCoordinatorAt,undefined);assert.equal(task.reportMessageId,undefined);
  assert.equal(task.status,'running');assert.equal(task.reportRound,1);
  assert.deepEqual(taskResultIdsReportedInMessage(db,a,'captured-answer'),['same-local']);
  markTaskResultsReported(db,a,{ids:['same-local'],assistantMessageId:'captured-answer',captures});
  assert.equal(db.chatOperations!.filter(o=>o.id==='notice_same-local').length,1);
  task.status='completed';task.finalResponse='新一轮文件已回读';saveExecutionReceipt(db,task);
  assert.deepEqual(pendingTaskResults(db,a).map(result=>result.id),['same-local_1']);
  assert.deepEqual(unreviewedTaskResults(db,a).map(result=>result.id),['same-local_1']);
  assert.equal(other.reportedToCoordinatorAt,undefined);
});
