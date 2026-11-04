import {CoordinatorInputTooLongError,CoordinatorInputError} from '../src/coordinatorInput.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCoordinatorFailure} from './coordinatorFailures.js';
import {coordinatorRecoveryCopy} from '../src/coordinatorRecovery.js';
import {ModelRequestError,ModelResponseError} from './modelGateway.js';
import {OneKeyPresenceError} from './oneKeyPresence.js';
import {CoordinatorError} from './executorProfiles.js';
import {FeatureConfigError} from './officialFeatures.js';
import {ChatOperationError} from './chatOperations.js';
import {ModelBillingError,BillingReviewRequiredError} from './modelBilling.js';
import {PowerAvailabilityError} from './powerBilling.js';
import {OrchestrationInputError,OrchestrationResponseError} from './taskOrchestrator.js';
import {TaskWorkflowError} from './taskWorkflow.js';
import {LocalExecutionNotStartedError} from './localExecutionAdmission.js';
import {ToolRecoveryError} from './toolRecovery.js';
import {TaskMaterialLimitError} from './taskMaterialLineage.js';
import {textModelRetryable} from './modelStepRecovery.js';

test('only the typed selected-material limit is an actionable planning refusal, never model repair or a generic failure',()=>{
 const error=new TaskMaterialLimitError();error.message='PRIVATE_SOURCE api_key=SECRET';
 for(const context of [{},{stage:'model' as const,outcome:'partial' as const},{stage:'receipt' as const,outcome:'unknown' as const}]){
  const failure=classifyCoordinatorFailure(error,context);
  assert.deepEqual(failure,{code:'material_limit',stage:'planning',outcome:'not_started'});
  const copy=coordinatorRecoveryCopy(failure);assert.match(copy,/8 份.*256,000 个字符.*原文.*保留.*减少材料.*只用本轮材料/);
  assert.doesNotMatch(copy,/PRIVATE_SOURCE|api_key|SECRET|32,000|模型|中断|重试/);
 }
 assert.equal(error instanceof OrchestrationInputError,false,'a material cap must not let argument repair silently switch to current');
 assert.equal(textModelRetryable(error),false);
 const forged=Object.assign(new Error('PRIVATE_SOURCE'),{name:'TaskMaterialLimitError',code:'material_limit'});
 assert.equal(classifyCoordinatorFailure(forged).code,'internal_error');assert.doesNotMatch(coordinatorRecoveryCopy(classifyCoordinatorFailure(forged)),/PRIVATE_SOURCE/);
});

test('native tool recovery distinguishes system work, actual missing input and unknown effects without raw fields',()=>{
 const cases=[
  [{version:1,kind:'system_parameters',code:'arguments_invalid',repair:'exhausted'},'tool_parameters_failed'],
  [{version:1,kind:'missing_input',code:'template_required',repair:'not_applicable',field:'template_file'},'input_template_required'],
  [{version:1,kind:'configuration',code:'storage_unconfigured',repair:'not_applicable'},'tool_configuration_unavailable'],
  [{version:1,kind:'effect_unknown',code:'effect_unconfirmed',repair:'not_applicable'},'tool_effect_unconfirmed'],
 ] as const;
 for(const [diagnostic,code] of cases){
  const failure=classifyCoordinatorFailure(new ToolRecoveryError(diagnostic),{outcome:'partial'});
  assert.deepEqual(failure,{code,stage:'tool',outcome:'partial'});
  assert.doesNotMatch(JSON.stringify(failure),/arguments|template_file|storage_unconfigured/);
 }
 const forged=Object.assign(new Error('private token=SECRET'),{diagnostic:cases[0][0]});
 assert.equal(classifyCoordinatorFailure(forged).code,'internal_error');
 assert.doesNotMatch(coordinatorRecoveryCopy(classifyCoordinatorFailure(forged)),/SECRET|token=/);
});

test('a proven local refusal retains only its reviewed cause, never raw fields or a generic routing failure',()=>{
 const failure=classifyCoordinatorFailure(new LocalExecutionNotStartedError({code:'power_insufficient',stage:'billing',outcome:'not_started',secret:'never-echo'} as any),{stage:'receipt',outcome:'unknown'});
 assert.deepEqual(failure,{code:'power_insufficient',stage:'billing',outcome:'not_started'});
 assert.doesNotMatch(JSON.stringify(failure)+coordinatorRecoveryCopy(failure),/secret|never-echo/);
 assert.equal(classifyCoordinatorFailure(Object.assign(new Error('power_insufficient'),{failure})).code,'internal_error','untyped message/object lookalikes do not attest admission');
});

test('local routing mistakes and an unstarted dispatch never claim the computer or folder is disconnected',()=>{
 for(const [error,code] of [
  [new OrchestrationInputError('本机任务请使用 execute_local_task；仍需本机连接和目录授权。'),'local_tool_invalid'],
  [new CoordinatorError('本机执行尚未开始：调度没有实际分派任务。你的原始要求已保留，请明确对应事情后再执行；不会自动重跑。',409),'dispatch_not_started'],
 ] as const){
  const failure=classifyCoordinatorFailure(error,{stage:'tool',outcome:'not_started'});
  assert.equal(failure.code,code);
  assert.doesNotMatch(coordinatorRecoveryCopy(failure),/没接上你的电脑|检查连接和工作文件夹|重新选择.*文件夹/);
 }
});

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


test('a reviewed workflow verification wrapper retains Key, budget and source authorization categories without leaking causes',()=>{
 const cases=[
  [new OneKeyPresenceError('PRIVATE_KEY_CAUSE'),'key_required'],
  [new CoordinatorError('本轮设置的预算不足 PRIVATE_BUDGET_CAUSE',402),'budget_exceeded'],
  [new CoordinatorError('知识授权已变化，本轮已停止 PRIVATE_SOURCE_CAUSE',403),'source_authorization'],
  [new CoordinatorError('Notion 授权已撤销 PRIVATE_NOTION_CAUSE',403),'notion_authorization'],
  [new PowerAvailabilityError('PRIVATE_POWER_CAUSE','POWER_INSUFFICIENT'),'power_insufficient'],
 ] as const;
 for(const [cause,code] of cases){
  const inner=new TaskWorkflowError('WORKFLOW_VERIFY_FAILED','任务状态或授权已经变化。',cause),wrapper=new TaskWorkflowError('WORKFLOW_VERIFY_FAILED','核对未通过。',inner);
  const result=classifyCoordinatorFailure(wrapper,{stage:'tool',outcome:'unknown'});assert.equal(result.code,code);assert.doesNotMatch(JSON.stringify(wrapper)+JSON.stringify(result)+coordinatorRecoveryCopy(result),/PRIVATE_|password|Bearer/);
 }
 const key=new OneKeyPresenceError('PRIVATE');assert.equal(classifyCoordinatorFailure(Object.assign(new Error('untrusted wrapper'),{cause:key})).code,'internal_error');
 const privateRaw=new Error('password=SECRET');assert.equal(classifyCoordinatorFailure(new TaskWorkflowError('WORKFLOW_VERIFY_FAILED','核对未通过。',privateRaw)).code,'internal_error');
 assert.equal(classifyCoordinatorFailure(new TaskWorkflowError('WORKFLOW_PERSIST_FAILED','保存未确认。',key)).code,'internal_error');
 const cycle=new TaskWorkflowError('WORKFLOW_VERIFY_FAILED','核对未通过。');Object.defineProperty(cycle,'cause',{value:cycle});assert.equal(classifyCoordinatorFailure(cycle).code,'internal_error');
});

test('typed input length and empty submission refusals never become internal/model failures or echo submitted data',()=>{
 assert.deepEqual(classifyCoordinatorFailure(new CoordinatorInputTooLongError(32001),{outcome:'not_started'}),{code:'input_too_long',stage:'accepting',outcome:'not_started'});
 assert.equal(classifyCoordinatorFailure(new CoordinatorInputError()).code,'submission_invalid');
 const forged=Object.assign(new Error('PRIVATE_SCRIPT'),{code:'COORDINATOR_INPUT_TOO_LONG',status:413,inputChars:32001});
 assert.equal(classifyCoordinatorFailure(forged).code,'internal_error');
 assert.doesNotMatch(coordinatorRecoveryCopy(classifyCoordinatorFailure(forged)),/PRIVATE_SCRIPT/);
});

test('a reviewed unusable provider response remains a model protocol failure',()=>{
 assert.deepEqual(classifyCoordinatorFailure(new ModelResponseError(),{outcome:'not_started'}),{code:'model_invalid_response',stage:'model',outcome:'not_started'});
 assert.equal(classifyCoordinatorFailure(new Error('Local Agent 模型响应格式不正确')).code,'internal_error','a matching arbitrary message is not protocol proof');
});
