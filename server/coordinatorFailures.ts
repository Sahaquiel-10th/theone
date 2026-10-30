import type {CoordinatorFailure,CoordinatorFailureCode,CoordinatorFailureStage} from '../src/coordinatorRecovery.js';
import {ModelRequestError} from './modelGateway.js';
import {orchestrationFailureCode,OrchestrationInputError} from './taskOrchestrator.js';
import {OneKeyPresenceError} from './oneKeyPresence.js';
import {CoordinatorError} from './executorProfiles.js';
import {FeatureConfigError} from './officialFeatures.js';
import {ChatOperationError} from './chatOperations.js';
import {BillingReviewRequiredError,ModelBillingError} from './modelBilling.js';
import {PowerAvailabilityError} from './powerBilling.js';

type FailureContext={stage?:CoordinatorFailureStage;outcome?:CoordinatorFailure['outcome']};
const orchestrationCodes:Record<string,CoordinatorFailureCode>={
  task_step_limit:'step_limit',task_tool_call_limit:'tool_limit',task_empty_response:'model_empty',
  task_invalid_response:'model_invalid_response',task_response_filtered:'model_filtered',
  task_tool_instruction_incomplete:'tool_incomplete',task_result_limit:'step_limit',task_budget_limit:'budget_exceeded',
};
/** Only reviewed classifications are public; raw messages never enter a receipt. */
export function classifyCoordinatorFailure(error:unknown,context:FailureContext={}):CoordinatorFailure {
  const make=(code:CoordinatorFailureCode,stage:CoordinatorFailureStage=context.stage??'planning'):CoordinatorFailure=>({code,stage,outcome:context.outcome??'unknown'});
  if(error instanceof ModelRequestError){
    const code=error.status===408||error.status===504?'model_timeout':error.status===401||error.status===403?'model_auth':error.status===429?'model_rate_limited':error.status>=400&&error.status<500?'model_request_rejected':'model_unavailable';
    return make(code,'model');
  }
  if(error instanceof OneKeyPresenceError)return make('key_required',context.stage??'accepting');
  if(error instanceof BillingReviewRequiredError||error instanceof ModelBillingError)return make('billing_unavailable','billing');
  if(error instanceof PowerAvailabilityError)return make(error.code==='POWER_INSUFFICIENT'?'power_insufficient':'billing_unavailable','billing');
  const orchestration=orchestrationFailureCode(error);
  if(orchestration&&Object.hasOwn(orchestrationCodes,orchestration))return make(orchestrationCodes[orchestration],orchestration==='task_budget_limit'?'billing':/^task_(?:empty|invalid|response)/.test(orchestration)?'model':context.stage??'planning');
  if(error instanceof ChatOperationError){
    const code:CoordinatorFailureCode=error.code==='CHAT_CONVERSATION_BUSY'||error.code==='CHAT_OPERATION_PENDING'?'conversation_busy':error.code==='CHAT_OPERATION_FORBIDDEN'?'account_unavailable':error.code==='CHAT_OPERATION_INVALID'||error.code==='CHAT_OPERATION_CONFLICT'?'submission_invalid':error.code==='CHAT_RESULT_UNAVAILABLE'?'storage_unavailable':error.code==='CHAT_OPERATION_INTERRUPTED'?'stopped':error.code==='CHAT_OPERATION_NOT_FOUND'?'task_not_found':'internal_error';
    return make(code,context.stage??'accepting');
  }
  const legacy:Record<string,CoordinatorFailureCode>={
    '电力不足，请先充值':'power_insufficient','额度不足，请升级会员或等待下月额度更新':'power_insufficient',
    '电力账户不存在':'billing_unavailable','本次调用超过公司为你设置的累计电力额度':'budget_exceeded',
    '账号或个人空间不可用':'account_unavailable','模型已停用，请重新选择':'model_unconfigured','调度回答未完整返回':'model_incomplete',
  };
  if(error instanceof Error&&Object.hasOwn(legacy,error.message))return make(legacy[error.message],/电力|额度|计费/.test(error.message)?'billing':context.stage??'planning');
  if(error instanceof CoordinatorError||error instanceof FeatureConfigError||error instanceof OrchestrationInputError){
    const reason=error.message;
    if(/之前(?:保存的)?(?:图片|成果文件|成果|文件).*(?:找不到|打不开)/.test(reason))return make('storage_unavailable','saving');
    if(/本轮设置的调度上限|预算/.test(reason))return make('budget_exceeded','billing');
    if(/(?:电力|额度).{0,16}(?:不足|不够|用尽|耗尽)|(?:没有|缺少).{0,8}电力/.test(reason))return make('power_insufficient','billing');
    if(/知识授权|来源授权|知识.*绑定.*变化/.test(reason))return make('source_authorization','tool');
    if(/Notion/i.test(reason))return make(/授权|权限|连接.*(?:过期|失效)|重新连接/.test(reason)?'notion_authorization':'notion_unconfirmed','saving');
    if(/知识来源|知识库|知识读取|得到大脑|得到笔记|资料来源/.test(reason))return make('source_unavailable','tool');
    if(/本机执行尚未开始|本机.*(?:连接|工作区|文件夹)|电脑.*(?:连接|工作区|文件夹)|启动器/.test(reason))return make('local_unavailable','tool');
    if(/ONE[ _-]*Key/.test(reason))return make('key_required','accepting');
    if(/账号或空间不可用|账号或个人空间不可用|账号或工作区不可用/.test(reason))return make('account_unavailable','accepting');
    if(/没有可用.*模型|执行器模型不可用|模型.*(?:未配置|已停用)|持续对话执行尚未启用|调度已停用/.test(reason))return make('model_unconfigured');
    if(/待处理任务已满|待办.*已满/.test(reason))return make('queue_full');
    if(/事情不存在|任务不存在|主对话已移除|主对话不存在/.test(reason))return make('task_not_found');
    if(/功能未开放|已下架|版本已变更|发布版本不可用|图片生成尚未配置|能力.*不可用|能力尚未配置|执行器未授权|执行器已停用|工具未授权/.test(reason))return make('feature_unavailable');
    if(error instanceof OrchestrationInputError||/executorId|执行模型目录|当前授权目录|请明确选择|任务功能选择|参数|漏掉.*能力/.test(reason))return make('tool_invalid');
    if(/未完成分派|没有实际分派/.test(reason))return make('dispatch_not_started');
    if(/消息标识无效|事情标识无效|提交|请确认所选功能|附件/.test(reason)&&error instanceof CoordinatorError&&error.status===400)return make('submission_invalid','accepting');
    if(/本轮已停止|本轮已取消/.test(reason))return make('stopped');
  }
  return make(context.stage==='billing'?'billing_unavailable':context.stage==='saving'?'storage_unavailable':context.stage==='receipt'?'transport_unknown':'internal_error');
}
