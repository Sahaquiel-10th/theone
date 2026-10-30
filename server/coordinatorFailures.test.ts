import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCoordinatorFailure} from './coordinatorFailures.js';
import {coordinatorRecoveryCopy} from '../src/coordinatorRecovery.js';
import {ModelRequestError} from './modelGateway.js';
import {OneKeyPresenceError} from './oneKeyPresence.js';
import {CoordinatorError} from './executorProfiles.js';
import {FeatureConfigError} from './officialFeatures.js';
import {ChatOperationError} from './chatOperations.js';
import {ModelBillingError,BillingReviewRequiredError} from './modelBilling.js';
import {PowerAvailabilityError} from './powerBilling.js';
import {OrchestrationResponseError} from './taskOrchestrator.js';

test('all provider failure statuses stay model problems and never expose provider diagnostics',()=>{
 for(const status of [400,401,403,408,429,500,502,503,504]){
  const failure=classifyCoordinatorFailure(new ModelRequestError(status,'api_key=SECRET 电力不足 Notion provider-private'));
  assert.equal(failure.stage,'model');assert.match(failure.code,/^model_/);
  assert.doesNotMatch(coordinatorRecoveryCopy(failure),/SECRET|api_key|Notion|电力|provider-private|看看刚才/);
 }
 assert.equal(classifyCoordinatorFailure(new ModelRequestError(401,'x')).code,'model_auth');
 assert.equal(classifyCoordinatorFailure(new ModelRequestError(429,'x')).code,'model_rate_limited');
 assert.equal(classifyCoordinatorFailure(new ModelRequestError(504,'x')).code,'model_timeout');
});

test('wallet, budget, Key, knowledge grants, feature and account failures remain distinguishable',()=>{
 const cases=[
  [new PowerAvailabilityError('电力不足，请先充值','POWER_INSUFFICIENT'),'power_insufficient'],
  [new Error('电力不足，请先充值'),'power_insufficient'],
  [new Error('额度不足，请升级会员或等待下月额度更新'),'power_insufficient'],
  [new ModelBillingError(),'billing_unavailable'],[new BillingReviewRequiredError(),'billing_unavailable'],
  [new OneKeyPresenceError('arbitrary secret'),'key_required'],
  [new CoordinatorError('知识授权已变化，本轮已停止',403),'source_authorization'],
  [new CoordinatorError('本轮设置的调度上限不足',402),'budget_exceeded'],
  [new FeatureConfigError('发布版本不可用',409),'feature_unavailable'],
  [new FeatureConfigError('账号或空间不可用',403),'account_unavailable'],
  [new CoordinatorError('执行器模型不可用'),'model_unconfigured'],
  [new CoordinatorError('待处理任务已满'),'queue_full'],
  [new CoordinatorError('未完成分派，请明确任务'),'dispatch_not_started'],
  [new CoordinatorError('Notion 授权已撤销',403),'notion_authorization'],
  [new CoordinatorError('Notion 保存未确认'),'notion_unconfirmed'],
  [new CoordinatorError('之前保存的图片暂时找不到，请先核对原结果；不会自动重新画图或扣图片电力。'),'storage_unavailable'],
  [new ChatOperationError('CHAT_CONVERSATION_BUSY','anything'),'conversation_busy'],
 ] as const;
 for(const [error,code] of cases)assert.equal(classifyCoordinatorFailure(error).code,code,error.message);
});

test('response and local orchestration limits use reviewed codes, not a generic model outage',()=>{
 for(const [error,code] of [
  [new OrchestrationResponseError('task_empty_response','x'),'model_empty'],
  [new OrchestrationResponseError('task_invalid_response','x'),'model_invalid_response'],
  [new OrchestrationResponseError('task_response_filtered','x'),'model_filtered'],
  [new OrchestrationResponseError('task_tool_instruction_incomplete','x'),'tool_incomplete'],
  [new Error('已达到调度步骤上限，未完成任务；请缩小问题范围'),'step_limit'],
  [new Error('调度模型返回了过多或重复的工具调用，已停止'),'tool_limit'],
 ] as const)assert.equal(classifyCoordinatorFailure(error).code,code);
});

test('unknown storage, billing, transport and internal exceptions expose only reviewed metadata',()=>{
 const error=Object.assign(new Error('password=SECRET https://credential.invalid/path'),{code:'private_provider'});
 for(const [stage,code] of [['saving','storage_unavailable'],['billing','billing_unavailable'],['receipt','transport_unknown'],['planning','internal_error']] as const){
  const failure=classifyCoordinatorFailure(error,{stage,outcome:'partial'});
  assert.deepEqual(failure,{code,stage,outcome:'partial'});
  assert.doesNotMatch(JSON.stringify(failure)+coordinatorRecoveryCopy(failure),/SECRET|credential|password|private_provider/);
 }
});
