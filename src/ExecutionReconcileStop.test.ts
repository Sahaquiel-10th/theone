import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExecutionReconcileStop,canManuallyReconcileStop,manualReconcileStopRequest,reconcileStopSnapshotCurrent} from './ExecutionReconcileStop';

const held={id:'exact-old-task',status:'cancelled',reportRound:2,updatedAt:'2026-10-26T10:00:00Z',requiresExecutionCheck:true};
test('manual ending is visible only to the support admin and a stopped unresolved round',()=>{
  for(const actorRole of ['user','company_admin','']){
    assert.equal(canManuallyReconcileStop(actorRole,held),false);
    assert.equal(renderToStaticMarkup(createElement(ExecutionReconcileStop,{actorRole,task:held,onReconcile:async()=>{throw Error('must not submit');}})),'');
  }
  for(const status of ['queued','selecting_target','running','failed','completed'])assert.equal(canManuallyReconcileStop('admin',{...held,status}),false);
  assert.equal(canManuallyReconcileStop('admin',{...held,requiresExecutionCheck:false}),false);
  assert.equal(canManuallyReconcileStop('admin',{...held,requiresExecutionCheck:false,resultDeliveryPending:true}),true);
  const html=renderToStaticMarkup(createElement(ExecutionReconcileStop,{actorRole:'admin',task:held,onReconcile:async()=>{throw Error('render cannot submit');}}));
  assert.match(html,/人工核对并结束旧占用/);assert.doesNotMatch(html,/dialog|<form|重新执行|重跑任务/);
});
test('manual reconciliation requires explicit proof and captures exact id round timestamp with a reason',()=>{
  const request=manualReconcileStopRequest(held,' 已核对原进程退出、目标文件保留。 ',true)!;
  assert.equal(request.path,'/api/executions/exact-old-task/reconcile-stop');
  assert.deepEqual(request.body,{expectedRound:2,expectedUpdatedAt:held.updatedAt,reason:'已核对原进程退出、目标文件保留。',confirmation:'manually_checked_original_execution_stopped'});
  assert.equal(manualReconcileStopRequest(held,'reason',false),undefined);
  assert.equal(manualReconcileStopRequest(held,'  ',true),undefined);
  assert.equal(manualReconcileStopRequest(held,'字'.repeat(2001),true),undefined);
  assert.equal(manualReconcileStopRequest({...held,updatedAt:''},'reason',true),undefined);
  for(const reportRound of [-1,0.5,NaN])assert.equal(manualReconcileStopRequest({...held,reportRound},'reason',true),undefined);
  assert.equal(manualReconcileStopRequest({...held,status:'running'},'reason',true),undefined);
});
test('a dialog snapshot cannot silently switch to another task round or newer diagnostic',()=>{
  assert.equal(reconcileStopSnapshotCurrent(held,{...held}),true);
  for(const changed of [{...held,id:'other-task'},{...held,reportRound:3},{...held,updatedAt:'2026-10-26T10:00:01Z'}])assert.equal(reconcileStopSnapshotCurrent(held,changed),false);
  const legacy={...held,reportRound:undefined};
  assert.equal(reconcileStopSnapshotCurrent(legacy,{...legacy,reportRound:0}),true);
});
