import test from 'node:test';import assert from 'node:assert/strict';import {ExecutionPreparationStops,assertPreparedLocalExecutionActive} from './executionPreparation.js';
test('stop-before-start fences exact workspace, user and operation',()=>{const f=new ExecutionPreparationStops(),s={workspaceId:'a',userId:'u',operationId:'operation_123456789'};f.cancel(s);f.cancel(s);assert.throws(()=>f.assertActive(s),/已停止/);f.assertActive({...s,workspaceId:'b'});f.assertActive({...s,userId:'v'});f.assertActive({...s,operationId:'operation_987654321'});assert.throws(()=>f.cancel({...s,operationId:'bad'}),/编号/);});
test('late preparation completion cannot dispatch after stop',async()=>{const f=new ExecutionPreparationStops(),s={workspaceId:'a',userId:'u',operationId:'operation_123456789'};let release!:()=>void,dispatched=false;const pending=(async()=>{f.assertActive(s);await new Promise<void>(resolve=>{release=resolve;});f.assertActive(s);dispatched=true;})();f.cancel(s);release();await assert.rejects(pending,/已停止/);assert.equal(dispatched,false);});
test('execution commit rejects only the exact failed or cancelled prepared handoff',()=>{
 const scope={workspaceId:'qa-space',userId:'qa-user',conversationId:'qa-task',sourceMessageId:'qa-input'};
 const operation={workspaceId:scope.workspaceId,userId:scope.userId,conversationId:scope.conversationId,workRun:{state:'failed',inputMessageId:scope.sourceMessageId,failureCode:'task_local_not_started'}};
 const db:any={chatOperations:[operation]};
 assert.throws(()=>assertPreparedLocalExecutionActive(db,scope),/本机准入未通过/);
 for(const changed of [{workspaceId:'foreign-space'},{userId:'foreign-user'},{conversationId:'other-task'},{sourceMessageId:'other-input'}])assert.doesNotThrow(()=>assertPreparedLocalExecutionActive(db,{...scope,...changed}));
 operation.workRun.failureCode='other_failure';assert.doesNotThrow(()=>assertPreparedLocalExecutionActive(db,scope));
 operation.workRun.state='cancelled';assert.throws(()=>assertPreparedLocalExecutionActive(db,scope),/已停止/);
 operation.workRun.state='prepared';assert.doesNotThrow(()=>assertPreparedLocalExecutionActive(db,scope));
});
test('a local-not-started mark while compilation is in flight prevents the later execution insert',async()=>{
 const scope={workspaceId:'qa-space',userId:'qa-user',conversationId:'qa-task',sourceMessageId:'qa-input'};
 const operation={workspaceId:scope.workspaceId,userId:scope.userId,conversationId:scope.conversationId,workRun:{state:'prepared',inputMessageId:scope.sourceMessageId,failureCode:undefined as string|undefined}};
 const db:any={chatOperations:[operation],executionTasks:[]};let release!:()=>void;
 const pending=(async()=>{await new Promise<void>(resolve=>{release=resolve;});assertPreparedLocalExecutionActive(db,scope);db.executionTasks.push({id:'must-not-be-inserted'});})();
 operation.workRun.state='failed';operation.workRun.failureCode='task_local_not_started';release();
 await assert.rejects(pending,/本机准入未通过/);assert.equal(db.executionTasks.length,0);
});
