/** Public, reviewed diagnostics only. Never attach raw provider errors or arguments. */
export const coordinatorFailureCodes = [
  'model_unavailable','model_timeout','model_rate_limited','model_auth','model_request_rejected',
  'model_empty','model_invalid_response','model_incomplete','model_filtered','tool_incomplete','step_limit','tool_limit','tool_invalid',
  'feature_unavailable','model_unconfigured','power_insufficient','budget_exceeded','billing_unavailable',
  'key_required','source_authorization','source_unavailable','notion_authorization','notion_unconfirmed',
  'local_unavailable','account_unavailable','submission_invalid','conversation_busy','task_not_found','queue_full',
  'local_device_offline','local_folder_missing','local_folder_denied','local_folder_unavailable','local_executor_unready',
  'local_busy','local_attachments_unsupported','local_tool_unavailable','local_readiness_unknown','local_tool_invalid',
  'dispatch_not_started','storage_unavailable','transport_unknown','invalid_receipt','receipt_not_found','stopped','internal_error',
] as const;
export type CoordinatorFailureCode = typeof coordinatorFailureCodes[number];
const stages = ['accepting','planning','model','tool','billing','saving','receipt'] as const;
export type CoordinatorFailureStage = typeof stages[number];
const outcomes = ['not_started','partial','unknown','failed'] as const;
export type CoordinatorFailure = {code:CoordinatorFailureCode;stage:CoordinatorFailureStage;outcome:typeof outcomes[number]};
export function isCoordinatorFailure(value:unknown):value is CoordinatorFailure {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return coordinatorFailureCodes.includes(v.code as CoordinatorFailureCode)&&stages.includes(v.stage as CoordinatorFailureStage)&&outcomes.includes(v.outcome as CoordinatorFailure['outcome']);
}
/** Project only allowlisted fields, including when reading legacy/untrusted JSON. */
export function parseCoordinatorFailure(value:unknown):CoordinatorFailure|undefined {
  return isCoordinatorFailure(value)?{code:value.code,stage:value.stage,outcome:value.outcome}:undefined;
}
const stageCopy:Record<CoordinatorFailureStage,string>={accepting:'接收要求',planning:'安排任务',model:'模型回复',tool:'调用功能',billing:'核对用量',saving:'保存结果',receipt:'核对处理结果'};
const failureCopy:Record<CoordinatorFailureCode,string>={
  model_unavailable:'模型开了个小差，这一步没拿到回复。稍等一会儿，再发这条要求试试吧。',
  model_timeout:'模型这次想得有点久，等到超时也没拿到完整回复。稍等一会儿再试试；已经交出去的任务请先查看状态，别重复开工。',
  model_rate_limited:'模型那边有点挤，这一步暂时没拿到回复。歇一小会儿，再发这条要求就好。',
  model_auth:'模型连接开了个小差，这一步没拿到回复。可以稍后再试；如果一直这样，请联系管理员检查模型连接。',
  model_request_rejected:'模型这次没接住请求。可以稍后再试一次；若还是不行，请联系管理员检查模型接口，别反复空等。',
  model_empty:'模型这次交了张白卷，没有返回可用正文。可以再问一次；如果有附件，先确认它还在输入框里。',
  model_invalid_response:'模型返回的内容格式不对，这一步没有拿到可用正文。可以再试一次；如果还是这样，请联系管理员检查模型接口。',
  model_incomplete:'这段还没写完，先把已经写出的部分给你。想接着写，直接说“从结尾接着写”，不用从头来。',
  model_filtered:'模型这次没有放行回复，过滤的内容不会展示。可以换个说法，或缩小问题范围再试。',
  tool_incomplete:'模型给功能的指令只写了一半，这一条没有执行。请重新说明要做哪一步；已经完成的内容先保留，不要整件重做。',
  step_limit:'这轮停在任务安排这一步，已经达到本轮步骤上限。请把接下来要做的一步单独交给我；有任务卡时，先打开看看已有进展。',
  tool_limit:'这轮停在调用功能这一步：模型一次给了过多或重复的指令，新的指令没有执行。请把下一步单独交给我，不用重做已有成果。',
  tool_invalid:'这一步的功能参数没接对，没能执行。请在“功能”里重新选择需要的功能；如果仍然这样，请联系管理员检查配置。',
  feature_unavailable:'这个功能还没就位，这一步暂时做不了。请在“功能”里换一个可用功能，或联系管理员检查发布和授权。',
  model_unconfigured:'这一步还没有可用的模型，暂时开不了工。请到设置里选择可用模型；如果没有可选项，请联系管理员配置。',
  power_insufficient:'电力不够接着做这一步了。请到“设置 → 会员与额度”查看可用电力和预留用量，补足后再继续未完成的部分。',
  budget_exceeded:'碰到这次设置的预算上限了，不一定是账户没电。请调整这次的预算，或把剩下的要求分成更小的一步。',
  billing_unavailable:'这一步卡在用量核对上了，先别重复生成。请到“设置 → 会员与额度”查看记录，并联系管理员核对这次用量。',
  key_required:'ONE Key 这会儿没连上，后面的操作停住了。确认 Key 插着，再双击盘里的 ONE 恢复连接；已有任务先查看状态，不要重复安排。',
  source_authorization:'读取资料时发现授权变了，这一步先停下。请到“设置 → 知识连接”检查对应来源的授权，恢复后再明确要查询的资料。',
  source_unavailable:'这一步没读到需要的资料。请到“设置 → 知识连接”检查对应来源；也可以把这次要用的材料直接发给我。',
  notion_authorization:'Notion 的连接或授权需要确认。请到“设置 → 知识连接”检查 Notion；已经写入的内容不会自动重写。',
  notion_unconfirmed:'Notion 的保存结果还没确认。先打开原页面核对，也可以在任务里点“核对保存结果”；不会重新写入。',
  local_unavailable:'这一步还没接上你的电脑。请到“设置 → 本机执行”检查连接和工作文件夹，准备好后再处理这一步。',
  local_device_offline:'这会儿没连上当前电脑，本机操作还没开始。工作文件夹不用重选；请确认 ONE Key 插着，再双击盘里的 ONE 恢复连接。',
  local_folder_missing:'还没选过工作文件夹。本机第一次开工时会弹出选择窗口，请选一个具体文件夹就好；之后会沿用它。',
  local_folder_denied:'电脑还连着，但这次没获准访问原工作文件夹。请允许 ONE 访问该文件夹，再检查状态；不用重装执行工具。',
  local_folder_unavailable:'原工作文件夹这次没能打开。请恢复原文件夹或在本机设置中明确更换位置；不用重新配置模型。',
  local_executor_unready:'工作文件夹的选择会保留，执行工具还没准备好。请到“设置 → 本机执行”准备工具，完成后再处理这一步。',
  local_busy:'电脑这边还有操作没结束或没确认，先不同时改文件。请在任务里核对上一轮的进展或停止结果；不用重选工作文件夹。',
  local_attachments_unsupported:'本机执行目前还不能直接接收这次新上传的附件，尚未开始操作电脑。文字和附件会保留；可以先选“对话中”生成可下载文件，或把资料放进已授权文件夹后再交给我。',
  local_tool_unavailable:'本机操作入口这轮没有开放，还没开始改文件。请启用本机执行功能或使用“本机执行”按钮；不用重新选择工作文件夹。',
  local_readiness_unknown:'这次没核对到电脑的完整状态，还不能开始操作。请到“设置 → 本机执行”重新检查状态；先别重选已经保存的工作文件夹。',
  local_tool_invalid:'我没把本机这一步安排对，电脑还没开始操作。要求已经保留；可以重新发送这一步，若仍卡住请联系管理员，不用反复配置文件夹。',
  account_unavailable:'当前账号或工作区暂时不可用，这一步还不能继续。请重新登录；如果还是这样，请联系管理员检查账号和工作区。',
  submission_invalid:'这条要求没能正确提交。请刷新页面，确认文字、附件和所选功能，再发送一次。',
  conversation_busy:'前一条要求还在处理中。先等它返回，或点“停止回复”结束等待，再发送新的要求。',
  task_not_found:'这件任务暂时找不到了。请到任务列表确认它是否还在；需要新做一件事时，直接说明新的要求就好。',
  queue_full:'手头待处理的任务有点多，暂时接不下新的一件。请先完成或停止一些任务，再把这条要求交给我。',
  dispatch_not_started:'我这轮没把任务交出去，还没有新的任务开始。不是让你重新配置电脑；可以重新发送要做的这一步，若仍卡住请联系管理员核对。',
  storage_unavailable:'这一步卡在保存结果上了，先别重复生成或写入。请刷新查看已有结果；若还没有，请联系管理员核对这次记录。',
  transport_unknown:'连接刚才晃了一下，还没核对到这次的处理结果。请检查网络，恢复后回到这里查看；先别重复提交，免得做两遍。',
  invalid_receipt:'进度消息这次没传完整，还不能据此判断任务失败。请刷新查看结果；已有任务先别重发，如果一直如此，请联系管理员检查连接。',
  receipt_not_found:'暂时没查到这条要求的接收记录。可以点“放回输入框”，确认后再发送；会沿用这次的提交编号核对，避免重复安排。',
  stopped:'嗯，回复停下来了。如果已经交出了任务，可以到任务区查看进展，或单独停止它。',
  internal_error:'这一步遇到了内部问题，暂时没拿到结果。请先刷新查看已有进展；如果仍然没有，请联系管理员，并带上这次的请求编号。',
};

/** Compatibility only for old records. New requests carry a reviewed code. Never echo reason. */
function legacyFailure(reason:string):CoordinatorFailure {
  const f=(code:CoordinatorFailureCode,stage:CoordinatorFailureStage='planning',outcome:CoordinatorFailure['outcome']='unknown'):CoordinatorFailure=>({code,stage,outcome});
  if(/本轮设置的调度上限|预算/.test(reason))return f('budget_exceeded','billing');
  if(/功能未开放|已下架|版本已变更|发布版本不可用|图片生成尚未配置|能力.*不可用|执行器未授权|执行器已停用|工具未授权|任务功能选择|工具.*就位|功能还没能正确接上/.test(reason))return f('feature_unavailable');
  if(/用量等待.*核对|结算|计费.*异常/.test(reason))return f('billing_unavailable','billing');
  if(/电力|额度|倍率/.test(reason))return f('power_insufficient','billing');
  if(/ONE[ _-]*Key|^Key(?:连接|已拔出|未插入)/i.test(reason))return f('key_required','accepting');
  if(/executorId|执行模型目录|当前授权目录|漏掉.{0,30}(?:文件|功能)能力|TOOL_INPUT_REPAIR/.test(reason))return f('tool_invalid');
  if(/Notion/i.test(reason))return f(/授权|权限|连接.*(?:失效|过期)|重新连接/.test(reason)?'notion_authorization':'notion_unconfirmed','saving');
  if(/知识授权/.test(reason))return f('source_authorization','tool');
  if(/知识来源|知识库|得到大脑|得到笔记|知识读取|资料来源/.test(reason))return f('source_unavailable','tool');
  if(reason.startsWith('本机执行尚未开始：调度没有实际分派任务'))return f('dispatch_not_started','planning');
  if(reason==='本机任务请使用 execute_local_task；仍需本机连接和目录授权。')return f('local_tool_invalid','planning');
  if(/^(?:本机执行未连接|本机连接已断开)/.test(reason))return f('local_device_offline','tool');
  if(/暂未找到接收记录/.test(reason))return f('receipt_not_found','receipt');
  if(/模型回复中断|模型.*(?:连接|超时)|无法连接模型/.test(reason))return f('model_unavailable','model');
  if(/Failed to fetch|NetworkError|进度暂时没连上|服务响应超时|连接暂时不可用/i.test(reason))return f('transport_unknown','receipt');
  return f('internal_error');
}
export function coordinatorRecoveryCopy(reason:string|CoordinatorFailure,interrupted=false){
  if(interrupted)return failureCopy.stopped;
  const failure=typeof reason==='string'?legacyFailure(reason):parseCoordinatorFailure(reason)??legacyFailure('');
  const copy=failureCopy[failure.code];
  if(['model_unavailable','model_timeout','model_rate_limited','model_auth','model_request_rejected','model_empty','model_invalid_response'].includes(failure.code)&&failure.outcome!=='not_started'){
    const cause=copy.split('。')[0]+'。';
    return cause+(failure.outcome==='partial'
      ?'已有内容先保留。请在这件任务里只补未完成的那一步，不要把整件事重发一遍；如果仍然失败，请联系管理员检查模型连接。'
      :'先打开原任务或刷新查看已有结果，不要把整件事重发一遍。若始终查不到，请联系管理员，并带上这次的请求编号。');
  }
  if(failure.code==='model_incomplete'&&failure.outcome!=='partial')return '模型的回复没写完整。若下方已有正文，可以说“从结尾接着写”；如果没有正文，请联系管理员核对这次的结果，先别重发整件事。';
  return failure.code==='internal_error'?`喵，停在“${stageCopy[failure.stage]}”这一步了。${copy}`:copy;
}

/** A promise of action is not a dispatch receipt. Questions and ordinary advice remain ordinary chat. */
export function dispatchCommitment(content:string){
  if(/[？?]\s*$/.test(content)||/(?:如果|等你|等到|下次|以后|需要时)/.test(content))return false;
  // A direct answer that already contains the requested text is not an empty
  // promise. Nor should an honest unavailable-tool reply force more execution.
  if(/(?:尚未|还没|没能)开始|工具[^。\n]{0,40}(?:不可用|没就位)|无法(?:执行|开始|生成)/.test(content))return false;
  if(!/(?:已经|已)(?:分派|安排|启动|排队|开工)/.test(content)&&/(?:如下|下面是|整理好了)[：:]|\n(?:#{1,6}\s|[-*]\s|\d+[.、]\s?)/.test(content))return false;
  return /(?:我(?:会|来|将|这就|现在就)[\s\S]{0,90}(?:制作|生成|绘制|画|做成|整理|安排|保存|交付|处理)|(?:已经|已)(?:分派|安排|启动|排队|开工)|开始(?:制作|生成|执行))/.test(content);
}
