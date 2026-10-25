import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRecovery,notionReceiptForReview,unstartedLocalInput,notionVerificationActive,notionVerificationPresentation,type NotionReceiptView} from './taskRecovery';

test('a saved local handoff has a first-start entry, never a blind replay of an existing execution',()=>{
 const messages=[{id:'input',role:'user'},{id:'result',role:'assistant'}];
 const job={state:'prepared',inputMessageId:'input'};
 assert.equal(unstartedLocalInput('own',[job],messages,[])?.id,'input');
 assert.equal(unstartedLocalInput('own',[job],messages,[{conversationId:'foreign',sourceMessageId:'input'}])?.id,'input');
 assert.equal(unstartedLocalInput('own',[job],messages,[{conversationId:'own',sourceMessageId:'older'}])?.id,'input');
 for(const state of ['queued','running','completed','failed','cancelled'])assert.equal(unstartedLocalInput('own',[{...job,state}],messages,[]),undefined);
 assert.equal(unstartedLocalInput('own',[job],messages,[{conversationId:'own',sourceMessageId:'input'}]),undefined);
 assert.equal(unstartedLocalInput('own',[{...job,dependencyBlocked:true}],messages,[]),undefined);
 assert.equal(unstartedLocalInput('own',[{...job,waitingFor:[{taskId:'before'}]}],messages,[]),undefined);
 assert.equal(unstartedLocalInput('own',[{...job,waitingFor:[{taskId:'before'}],dependenciesReady:true}],messages,[])?.id,'input');
 assert.equal(unstartedLocalInput('own',[{...job,dependenciesReady:false}],messages,[]),undefined);
 assert.equal(unstartedLocalInput('own',[{...job,inputMessageId:'result'}],messages,[]),undefined);
 assert.equal(unstartedLocalInput('own',[job,{state:'cancelled',inputMessageId:'later'}],messages,[]),undefined);
});

test('recovery offers safe actions for text, images, local execution and ongoing work',()=>{
  assert.equal(taskRecovery([{id:'text',state:'failed'}]).kind,'retry');
  assert.equal(taskRecovery([{id:'text',state:'interrupted'}]).kind,'retry');
  assert.equal(taskRecovery([{id:'img',state:'failed',kind:'image'}]).kind,'review_image');
  assert.equal(taskRecovery([{id:'img',state:'queued',kind:'image'}]).kind,'resume');
  assert.equal(taskRecovery([{id:'local',state:'prepared'}]).kind,'review_local');
  assert.equal(taskRecovery([{id:'active',state:'running'},{id:'later',state:'queued'}]).kind,'none');
  assert.equal(taskRecovery([{id:'done',state:'completed'}]).kind,'none');
});
test('a recorded first-turn truncation can retry Notion, but missing history and unknown effects cannot',()=>{
 const job={id:'first',state:'failed',notionTarget:{},failureCode:'task_tool_instruction_incomplete',steps:[]};
 assert.equal(taskRecovery([job]).kind,'retry');
 assert.equal(taskRecovery([{...job,steps:undefined}]).kind,'review_notion');
 assert.equal(taskRecovery([{...job,failureCode:'task_execution_failed'}]).kind,'review_notion');
 assert.equal(taskRecovery([{...job,steps:[{effect:'read',state:'completed'}]}]).kind,'review_notion');
 assert.equal(taskRecovery([{...job,notionReceipt:{state:'uncertain',delivery:'unknown'}}]).kind,'review_notion');
 assert.equal(taskRecovery([{id:'old',state:'failed',notionReceipt:{state:'uncertain',delivery:'unknown'}},job]).kind,'review_notion');
});
test('Notion Key admission failure can retry only with explicit empty effect history',()=>{
 const job={id:'key-failed',state:'failed',notionTarget:{},failureCode:'task_key_required',steps:[]};
 assert.equal(taskRecovery([job]).kind,'retry');
 assert.equal(taskRecovery([{...job,steps:undefined}]).kind,'review_notion');
 assert.equal(taskRecovery([{...job,steps:[{tool:'save_notion_draft',effect:'external_write',state:'started'}]}]).kind,'none');
 assert.equal(taskRecovery([{...job,notionReceipt:{state:'uncertain',delivery:'unknown'}}]).kind,'review_notion');
 assert.equal(taskRecovery([{id:'older',state:'failed',notionReceipt:{state:'uncertain'}},job]).kind,'review_notion');
 assert.equal(taskRecovery([{...job,state:'running'}]).kind,'none');
});
test('a scoped document read can retry its summary but never hides a write or unknown effect',()=>{
 const job={id:'read',state:'failed',notionTarget:{},steps:[{tool:'read_notion_document',effect:'read',state:'completed'}]};
 assert.equal(taskRecovery([job]).kind,'retry');
 assert.equal(taskRecovery([{...job,steps:[...job.steps,{tool:'save_notion_draft',effect:'external_write',state:'started'}]}]).kind,'none');
 assert.equal(taskRecovery([{...job,notionReceipt:{state:'uncertain'}}]).kind,'review_notion');
 assert.equal(taskRecovery([{id:'unknown',state:'failed',notionReceipt:{state:'uncertain'}},job]).kind,'review_notion');
});
test('welcome recovery explains which stage remains without exposing the plan',()=>{
 assert.equal(taskRecovery([{id:'w',state:'failed',kind:'image',welcomeManual:{}}]).welcomeStep,'manual');
 assert.equal(taskRecovery([{id:'w',state:'failed',kind:'image',welcomeManual:{document:{}}}]).welcomeStep,'image');
 assert.equal(taskRecovery([{id:'w',state:'failed',kind:'image',welcomeManual:{document:{}},welcomeImageAttachmentId:'saved'}]).welcomeStep,'page');
});
test('a stopped prerequisite does not leave a dead-end retry button on its cancelled successor',()=>{
  const result=taskRecovery([{id:'child',state:'cancelled',dependsOnOperationIds:['parent']}]);
  assert.equal(result.kind,'none');assert.match(result.message,/补充新的要求/);
});
test('an uncertain save asks for review instead of offering a blind retry',()=>{
  const result=taskRecovery([{id:'partial',state:'failed',steps:[{effect:'artifact',state:'started'}]}]);
  assert.equal(result.kind,'none');assert.match(result.message,/先看看已有成果/);
});
test('an uncertain Notion write keeps its dedicated readback entry even with an unresolved external-write checkpoint',()=>{
  const job={id:'notion',state:'failed',notionTarget:{},notionReceipt:{state:'uncertain'},steps:[{effect:'external_write',state:'started'}]};
  assert.equal(taskRecovery([job]).kind,'review_notion');
  assert.equal(taskRecovery([{...job,state:'running'}]).kind,'none');
  assert.equal(taskRecovery([{...job,notionReceipt:{state:'verified'}}]).kind,'none','verification must not silently clear another unresolved write');
});
test('only proven unsent or rejected Notion writes allow manual retry; legacy and other effects remain protected',()=>{
 const job={id:'notion',state:'failed',notionTarget:{},steps:[{tool:'save_notion_draft',effect:'external_write',state:'started'}]};
 for(const delivery of ['not_sent','rejected']){
  const safe={...job,notionReceipt:{state:'uncertain',delivery}};
  assert.equal(taskRecovery([safe]).kind,'retry');
  assert.equal(taskRecovery([{id:'old',state:'failed',notionReceipt:{state:'uncertain'}},safe]).kind,'review_notion');
  assert.equal(taskRecovery([{...safe,steps:[...safe.steps,{tool:'another_tool',effect:'artifact',state:'started'}]}]).kind,'none');
 }
 assert.equal(taskRecovery([{...job,notionReceipt:{state:'uncertain',delivery:'unknown'}}]).kind,'review_notion');
});

test('a verified receipt never hides an unresolved write from the task or composer review entry',()=>{
 const uncertain={id:'update',state:'failed',notionReceipt:{state:'uncertain',url:'https://notion.so/test'}};
 const verified={id:'create',state:'completed',notionReceipt:{state:'verified'}};
 for(const jobs of [[verified,uncertain],[uncertain,verified]]){
   assert.equal(taskRecovery(jobs).kind,'review_notion');
   assert.equal(notionReceiptForReview(jobs),uncertain);
 }
 assert.equal(notionReceiptForReview([verified]),verified);
 assert.equal(notionReceiptForReview([]),undefined);
});

test('scheduled and checking receipts offer only automatic readback, never write retry or manual continue',()=>{
 for(const state of ['scheduled','checking'] as const){
  const receipt:NotionReceiptView={state:'uncertain',delivery:'unknown',url:'https://www.notion.so/original',verification:{state,version:1,attempt:1}};
  assert.equal(notionVerificationActive(receipt),true);
  const view=notionVerificationPresentation(receipt);assert.equal(view.active,true);assert.equal(view.canVerify,false);
  assert.match(view.message,/核对|读取/);assert.match(view.message,/不会.*写/);assert.doesNotMatch(view.message,/确认继续|重新处理|重新新建|点击/);
  if(state==='scheduled')assert.match(view.message,/ONE Key 保持连接/);
  const recovery=taskRecovery([{id:'save',state:'failed',notionTarget:{},notionReceipt:receipt}]);
  assert.equal(recovery.kind,'reconciling');assert.equal(recovery.sourceJobId,undefined);
  const running=taskRecovery([{id:'save',state:'failed',notionReceipt:receipt},{id:'new-html',state:'running'}]);
  assert.equal(running.kind,'none');assert.match(running.message,/本轮仍在处理/,'an old save check must not replace a new HTML run');
 }
});

test('verified save awaiting coordinator finalization stays reconciling without a restart action',()=>{
 const pending={id:'save',state:'failed',failureCode:'notion_verification_pending',verificationPending:true,notionReceipt:{state:'verified'}};
 const recovery=taskRecovery([pending]);
 assert.equal(recovery.kind,'reconciling');assert.equal(recovery.sourceJobId,undefined);
 assert.equal(recovery.message,'保存已经核对，正在整理结果；不用再次开始。');
 assert.equal(taskRecovery([pending,{id:'new-html',state:'running'}]).kind,'none','actual running work still takes precedence');
 assert.equal(taskRecovery([{...pending,failureCode:undefined,verificationPending:false,state:'completed'}]).kind,'none','settled save no longer waits for finalization');
 assert.notEqual(taskRecovery([{...pending,verificationPending:false,state:'cancelled'}]).kind,'reconciling','a retained failure code cannot resurrect a cancelled check');
});

test('exhausted readback remains a read-only review with a concrete next step',()=>{
 for(const lastReason of ['read_failed','mismatch','incomplete','authorization','stale','no_page'] as const){
  const receipt:NotionReceiptView={state:'uncertain',url:'https://www.notion.so/original',verification:{state:'exhausted',version:3,attempt:3,lastReason}};
  assert.equal(notionVerificationActive(receipt),false);
  const view=notionVerificationPresentation(receipt);
  assert.equal(view.active,false);assert.match(view.message,/核对.*停下|自动核对已/);
  assert.equal(view.canVerify,!['authorization','stale','no_page'].includes(lastReason));
  assert.equal(taskRecovery([{id:'save',state:'failed',notionTarget:{},notionReceipt:receipt}]).kind,'review_notion');
 }
});

test('verified receipt ignores stale verification metadata and legacy unknown writes remain protected',()=>{
 const verified:NotionReceiptView={state:'verified',verification:{state:'checking',version:3,attempt:2}};
 assert.equal(notionVerificationActive(verified),false);assert.equal(notionVerificationPresentation(verified).canVerify,false);
 assert.equal(taskRecovery([{id:'done',state:'completed',notionReceipt:verified}]).kind,'none');
 assert.equal(taskRecovery([{id:'legacy',state:'failed',notionTarget:{},notionReceipt:{state:'uncertain',delivery:'unknown'}}]).kind,'review_notion');
 assert.equal(notionVerificationPresentation({state:'uncertain'}).canVerify,false);
});

test('proven unsent and rejected saves do not wait for readback or hide an older unknown write',()=>{
 const unknown={id:'unknown',state:'failed',notionReceipt:{state:'uncertain',delivery:'unknown',url:'https://www.notion.so/old'}};
 for(const delivery of ['not_sent','rejected']){
  const receipt:NotionReceiptView={state:'uncertain',delivery,url:'https://www.notion.so/new',verification:{state:'scheduled',version:2,attempt:0}};
  assert.equal(notionVerificationActive(receipt),false);const view=notionVerificationPresentation(receipt);
  assert.equal(view.canVerify,false);assert.equal(view.active,false);assert.match(view.message,delivery==='not_sent'?/还没有发出/:/没有接受/);
  assert.doesNotMatch(view.message,/正在.*核对|保存结果还.*核对/);
  const latest={id:'latest',state:'failed',notionTarget:{},notionReceipt:receipt};
  assert.equal(taskRecovery([latest]).kind,'retry');
  assert.equal(notionReceiptForReview([unknown,latest]),unknown);
  assert.equal(taskRecovery([unknown,latest]).kind,'review_notion');
 }
});
