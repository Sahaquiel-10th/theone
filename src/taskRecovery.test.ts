import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRecovery,notionReceiptForReview,unstartedLocalInput} from './taskRecovery';

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
