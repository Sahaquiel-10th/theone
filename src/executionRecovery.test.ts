import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCanContinue,executionContinuationRequest,executionCancellationRequest,executionForHandoff,executionRecovery,executionResumeInstruction} from './executionRecovery';

test('settled stopped work has a next action without claiming it is still running',()=>{
  const task={id:'selected-task',status:'cancelled'};
  const recovery=executionRecovery(task)!;
  assert.equal(recovery.canContinue,true);
  assert.match(recovery.title,/已停止/);
  assert.match(recovery.message,/已有结果|文件/);
  assert.match(recovery.message,/继续这件事/);
  assert.doesNotMatch(recovery.message,/仍在运行|自动重跑|已经完成/);
});

test('unknown ending and pending stop do not offer an execution action',()=>{
  for(const status of ['failed','cancelled','completed']){
    for(const protection of [{requiresExecutionCheck:true},{resultDeliveryPending:true}]){
      const task={id:'held',status,...protection};
      assert.equal(executionCanContinue(task),false);
      assert.equal(executionRecovery(task)?.canContinue,false);
      assert.equal(executionContinuationRequest(task,'op','继续'),undefined);
    }
  }
  assert.match(executionRecovery({id:'stop',status:'cancelled',resultDeliveryPending:true})!.title,/正在等本机确认/);
});

test('human stop causes are retained while machine diagnostics never become the only instruction',()=>{
  const human=executionRecovery({id:'failed',status:'failed',lastError:'目标文件夹暂时无法访问。'})!;
  assert.match(human.message,/目标文件夹暂时无法访问/);
  const machine=executionRecovery({id:'failed',status:'failed',lastError:'execution_unconfirmed'})!;
  assert.doesNotMatch(machine.message,/execution_unconfirmed/);
  assert.match(machine.message,/继续这件事/);
});

test('explicit continuation addresses its selected task and reuses its original target',()=>{
  const request=executionContinuationRequest({id:'own-task',status:'cancelled'},'new-round',executionResumeInstruction)!;
  assert.equal(request.path,'/api/executions/own-task/messages');
  assert.equal(request.body.operationId,'new-round');
  assert.match(request.body.content,/沿用这件事原来的工作文件夹/);
  assert.match(request.body.content,/只继续原任务未完成/);
  assert.deepEqual(Object.keys(request.body).sort(),['content','operationId']);
  assert.notEqual(request.path,executionContinuationRequest({id:'other-task',status:'failed'},'other-round','继续')!.path);
  for(const status of ['queued','selecting_target','running'])assert.equal(executionContinuationRequest({id:'active',status},'op','继续'),undefined);
  assert.equal(executionContinuationRequest({id:'done',status:'completed'},'op','  '),undefined);
});

test('successful complete work does not acquire a failure notice',()=>{
  assert.equal(executionRecovery({id:'done',status:'completed',finalResponse:'已经完成并核对。'}),undefined);
  assert.equal(executionRecovery({id:'working',status:'running'}),undefined);
  assert.equal(executionRecovery(null),undefined);
});

test('stop is bound to the displayed round even after another tab continues the same execution',()=>{
  const previous={id:'same-task',status:'cancelled',reportRound:2,resultDeliveryPending:true};
  const stoppedRequest=executionCancellationRequest(previous)!;
  const next={...previous,status:'running',reportRound:3,resultDeliveryPending:false};
  const newRequest=executionCancellationRequest(next)!;
  assert.equal(stoppedRequest.path,newRequest.path);
  assert.deepEqual(stoppedRequest.body,{expectedRound:2});
  assert.deepEqual(newRequest.body,{expectedRound:3});
  assert.deepEqual(executionCancellationRequest({id:'legacy',status:'running'})?.body,{expectedRound:0});
  for(const reportRound of [-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.equal(executionCancellationRequest({...previous,reportRound}),undefined);
});

const handoffTask=(id:string,sourceMessageId:string,status:string,createdAt:string,updatedAt=createdAt)=>({
  id,conversationId:'own',sourceMessageId,status,createdAt,updatedAt,
});

test('latest handoff selection ignores a newer diagnostic on an older source',()=>{
  const old=handoffTask('old','old-input','cancelled','2026-10-20','2026-10-26');
  const current=handoffTask('current','latest-input','running','2026-10-25');
  const snapshots=[old,current];
  assert.equal(executionForHandoff(snapshots,'own','latest-input'),current);
  assert.equal(executionForHandoff(snapshots,'own','old-input'),old,'an explicitly supplied historical anchor is still local to itself');
  assert.deepEqual(snapshots,[old,current],'selection does not reorder caller state');
});

test('a saved handoff never falls back to a different source or unanchored legacy task',()=>{
  const old=handoffTask('old','old-input','cancelled','2026-10-26');
  const other={...handoffTask('foreign','latest-input','running','2026-10-26'),conversationId:'other'};
  assert.equal(executionForHandoff([old,other],'own','latest-input'),null);
  assert.equal(executionForHandoff([old],'own'),null);
  assert.equal(executionForHandoff([old],'own',''),null);
  assert.equal(executionForHandoff([],'own','latest-input'),null);
});

test('matching running work precedes terminal history and terminal order uses stable creation time',()=>{
  const old=handoffTask('old','input','cancelled','2026-10-20','2026-10-28');
  const fresh=handoffTask('fresh','input','completed','2026-10-25','2026-10-25');
  const running=handoffTask('active','input','running','2026-10-24','2026-10-24');
  assert.equal(executionForHandoff([old,fresh,running],'own','input'),running);
  assert.equal(executionForHandoff([old,fresh],'own','input'),fresh);
});
