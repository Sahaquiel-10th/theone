import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import {recordCoordinatorRejection} from './coordinatorRejectedHistory.js';
import {restoreConversationMessages} from './conversationAttachments.js';

const scope={workspaceId:'wa',userId:'ua'},failure={code:'local_device_offline' as const,stage:'accepting' as const,outcome:'not_started' as const};
function fixture(){
 const db={users:[{id:'ua',enabled:true},{id:'ub',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'ua',role:'owner'},{workspaceId:'wb',userId:'ub',role:'owner'}],conversations:[],messages:[],attachments:[],models:[{id:'model',enabled:true,kind:'chat'}],chatOperations:[],modelUsageRecords:[],powerLedger:[]} as unknown as Database;
 return{db,store:{read:async()=>db,mutate:async<T>(fn:(d:Database)=>T)=>fn(db)}};
}
test('unaccepted original and reviewed failure survive reload and later messages without task or usage',async()=>{
 const f=fixture(),input={operationId:'original_rejected_operation_01',text:'按图片创建 Excel',attachmentIds:[]};
 assert.equal(await recordCoordinatorRejection(f.store,scope,input,failure,'req_safe'),true);
 assert.equal(await recordCoordinatorRejection(f.store,scope,input,failure,'req_other'),true);
 assert.equal(f.db.messages.length,2);assert.equal(f.db.chatOperations!.length,0);assert.equal(f.db.modelUsageRecords.length,0);assert.equal(f.db.powerLedger.length,0);
 f.db.conversations[0].messages=[];
 const restored=restoreConversationMessages(f.db.conversations[0],f.db.messages,f.db.attachments);
 assert.equal(restored[0].content,input.text);assert.match(restored[1].content,/没连上当前电脑/);
 assert.equal(restored[0].rejectedSubmission?.operationId,input.operationId);
 assert.equal(await recordCoordinatorRejection(f.store,scope,{...input,operationId:'later_rejected_operation_02',text:'第二条'},failure),true);
 assert.equal(f.db.messages.length,4);assert.equal(f.db.messages[0].content,input.text);
});
test('late accepted operations win, and a changed payload never rewrites rejected history',async()=>{
 const f=fixture(),input={operationId:'original_rejected_operation_01',text:'原要求'};
 await recordCoordinatorRejection(f.store,scope,input,failure);
 assert.equal(await recordCoordinatorRejection(f.store,scope,{...input,text:'替换原要求'},failure),false);
 assert.equal(f.db.messages[0].content,'原要求');
 f.db.chatOperations!.push({...scope,operationId:'already_accepted_operation_02'} as any);
 assert.equal(await recordCoordinatorRejection(f.store,scope,{...input,operationId:'already_accepted_operation_02'},failure),false);
 assert.equal(f.db.messages.length,2);
});
test('attachment and bound task authorization is exact and no diagnostic fields persist',async()=>{
 const f=fixture(),input={operationId:'original_rejected_operation_01',text:'原要求'};
 f.db.attachments.push({id:'foreign',workspaceId:'wb',userId:'ub'} as any);
 await assert.rejects(()=>recordCoordinatorRejection(f.store,scope,{...input,attachmentIds:['foreign']},failure),/无权/);
 assert.equal(f.db.messages.length,0);
 assert.equal(await recordCoordinatorRejection(f.store,scope,{...input,boundTaskId:'foreign-task'},failure),false);
 assert.equal(await recordCoordinatorRejection(f.store,scope,input,{...failure,raw:'SECRET'} as any,'invalid/SECRET'),true);
 assert.doesNotMatch(JSON.stringify(f.db.messages),/SECRET/);
 assert.equal(f.db.messages[0].rejectedSubmission?.failure.code,'local_device_offline');
});
test('another owner cannot read or overwrite history with the same client operation ID',async()=>{
 const f=fixture(),input={operationId:'same_operation_id_across_users',text:'甲'};
 await recordCoordinatorRejection(f.store,scope,input,failure);
 await recordCoordinatorRejection(f.store,{workspaceId:'wb',userId:'ub'},{...input,text:'乙'},failure);
 assert.equal(f.db.conversations.length,2);
 const b=restoreConversationMessages(f.db.conversations[1],f.db.messages,f.db.attachments);
 assert.equal(b.length,2);assert.equal(b[0].content,'乙');assert.doesNotMatch(JSON.stringify(b),/"甲"/);
 await assert.rejects(()=>recordCoordinatorRejection(f.store,{workspaceId:'wb',userId:'ua'},input,failure),/不可用/);
});
test('unknown outcomes and invalid input do not manufacture unaccepted history',async()=>{
 const f=fixture();
 assert.equal(await recordCoordinatorRejection(f.store,scope,{operationId:'too_short',text:'原话'},failure),false);
 assert.equal(await recordCoordinatorRejection(f.store,scope,{operationId:'valid_operation_id_001',text:'原话'},{...failure,outcome:'unknown'}),false);
 assert.equal(f.db.messages.length,0);
});
