import {coordinatorTaskIntent,discussionOnly} from './executionIntent.js';
import {taskStatusQuestion} from './taskContinuation.js';
import type {CoordinatorFailureCode} from '../src/coordinatorRecovery.js';
import type {LocalDeviceReadiness} from '../src/localDeviceReadiness.js';
import type {Database} from './types.js';

export type CoordinatorLocalFailureCode=Extract<CoordinatorFailureCode,
  'local_device_offline'|'local_folder_missing'|'local_folder_denied'|'local_folder_unavailable'|
  'local_executor_unready'|'local_busy'|'local_attachments_unsupported'|'local_tool_unavailable'|
  'local_readiness_unknown'|'local_tool_invalid'|'local_binding_changed'|'local_execution_unconfirmed'|'local_workflow_unsupported'|'dispatch_not_started'>;
/** Reviewed metadata only. Never put a path, launcher exception or tool arguments in this error. */
export class CoordinatorLocalError extends Error {
  constructor(readonly code:CoordinatorLocalFailureCode,readonly status=428){super(code);}
}
function requestText(text:string){
  return text.split(/(?:正文|原文|引用|示例|材料|附件内容)(?:如下|内容)?\s*[:：]/u)[0]
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g,'').trim();
}
const positiveRequest=(request:string)=>request.replace(/(?:不要|不用|不必|不需要|别|禁止|不(?=(?:再|重新)?(?:执行|创建|写|修改|保存|操作|生成|导出|做|处理)))(?:再|重新)?[^，,。；;\n]{0,60}/gu,'');
/** A saved destination is a preference, not a command. Explicit restrictions,
 * explanations and status questions never acquire local write authority. */
export function localActionRequested(text:string,boundTaskId?:string){
  const original=requestText(text);
  // A completion report is not an explanation request, but it also supplies
  // no execution authority. Remove only this terminal reporting segment,
  // then require an actionable request under the unchanged explanation rules.
  const request=original.replace(/(?:^|[，,。；;\n]|并|然后|再)\s*(?:(?:完成|修改|保存|处理|执行)(?:后|完)|改完|做完|最后|然后|并|再|请|在主对话|在这里|\s)*(?:告诉我|向我汇报|给我汇报)(?:本次|这次|实际|最终)?(?:结果|进展|完成情况)[。!！\s]*$/u,'').trim();
  if(!request||coordinatorTaskIntent(original,boundTaskId).answerOnly||discussionOnly(original)||taskStatusQuestion(original)
    ||/(?:^|[，,。；;\n])\s*(?:(?:请|本轮|现在|这次|先|暂时)\s*)*(?:禁止|不准|不允许|不要|别|不)(?:实际)?执行(?:(?:任何|新的?)?(?:本机)?(?:操作|任务))?\s*(?:$|[，,。；;\n])/u.test(original))return false;
  if(/告诉我|说明一下|解释|教我|(?:请|帮我)(?:先)?(?:说明|介绍)/u.test(request))return false;
  if(/\b(?:do not|don't|never)\s+(?:create|write|save|edit|modify|run|execute)\b|\b(?:explain|describe|tutorial)\b|\b(?:how (?:to|does|do)|what (?:is|does)|why)\b/iu.test(request))return false;
  const positive=positiveRequest(request);
  const action=/(?:写|做|制作|生成|交付|保存|存到|存入|导出|创建|新建|修改|改成|改为|更新|编辑|填写|填入|整理|编写|搭建|搭个|搭一个|执行|处理|安排|继续|接着|开工)|\b(?:make|create|build|generate|save|write|edit|continue|resume)\b/iu;
  if(request!==original&&!positive.split(/[，,。；;\n]/u).some(clause=>action.test(clause)&&!/(?:分析|评估|讨论|总结)/u.test(clause)))return false;
  const artifact=/(?:文件|文档|文章|报告|方案|表格|这张表|工作簿|网站|网页|项目|目录|文件夹|图片|Excel|Word|PPT|HTML|\.\w{1,6}\b)/iu;
  // “Can you help me make this spreadsheet?” is an action; “Does local
  // execution support spreadsheets?” is a capability question. Politeness is
  // not uncertainty when a concrete requested artifact/action is present.
  const politeAction=/(?:帮我|请|麻烦)/u.test(positive)&&action.test(positive)&&artifact.test(positive)
    &&!/(?:解释|教我|为什么|为啥|啥叫|什么意思)/u.test(positive);
  if(/先讨论|先不做|先别做|如果|假设|举例/u.test(request))return false;
  if(!politeAction&&/解释|说明一下|教我|为什么|为啥|啥叫|什么意思|是什么|(?:是|能)?干什么(?:用)?|怎么|如何|能不能|可不可以|是否可以|(?:支持|进度|状态|结果).{0,14}[吗么呢？?]/u.test(request))return false;
  return politeAction||action.test(positive);
}

const localConfirmation=/^(?:对(?:的)?|是(?:的)?|没错|好(?:的)?|可以|确认)(?:[，,\s]*(?:就是(?:它|他|这个|那个)|就(?:是)?(?:它|他|这个|那个)|按这个(?:做)?))?[。！!？?\s]*$/u;
const localRetry=/^(?:请|那就|麻烦)?\s*(?:再(?:来|试)(?:一次|一下)?|重试(?:一次|一下)?|继续(?:处理)?(?:刚才(?:那件事|的任务))?)(?:吧)?[。！!？?\s]*$/u;
const ownedFolderQuestion=/(?:当前|已(?:经)?(?:选(?:择)?|授权))(?:的)?(?:本机)?工作(?:文件夹|目录)[^。！？?\n]{0,120}[吗么][？?]|已授权(?:的)?(?:目录|文件夹)[^。！？?\n]{0,120}[吗么][？?]/u;
export type ConfirmedLocalFollowup={sourceMessageId:string;sourceText:string;confirmationMessageId:string};
/** A short answer is only authority for the immediately preceding, owned
 * clarification. A retry can cross reviewed NOT_STARTED failures, never a
 * dispatched operation, an unknown write, an unrelated turn or user stop. */
export function confirmedLocalFollowup(db:Pick<Database,'conversations'|'chatOperations'>,scope:{workspaceId:string;userId:string},text:string):ConfirmedLocalFollowup|undefined{
 const latest=text.trim(),isConfirmation=localConfirmation.test(latest),isRetry=localRetry.test(latest);
 if(!isConfirmation&&!isRetry)return;
 const mains=db.conversations.filter(c=>c.workspaceId===scope.workspaceId&&c.userId===scope.userId&&c.coordinatorMain&&!c.archived);
 if(mains.length!==1)return;
 const messages=mains[0].messages;
 let reply=text;
 for(let offset=0;offset<4;offset++){
  const assistant=messages.at(-1-offset*2),source=messages.at(-2-offset*2);
  if(assistant?.role!=='assistant'||source?.role!=='user'||!source.id||!assistant.id)return;
  const operations=(db.chatOperations??[]).filter(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.conversationId===mains[0].id&&o.assistantMessageId===assistant.id);
  if(operations.length!==1)return;
  const operation=operations[0];
  if(operation.status!=='completed'||operation.executionCancelled||operation.dispatchedTaskId||operation.dispatchedTaskIds?.length||(db.chatOperations??[]).some(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.workRun?.parentOperationId===operation.operationId))return;
  if(localRetry.test(reply)){
   if(operation.failure?.code!=='local_tool_invalid'||operation.failure.outcome!=='not_started')return;
   if(localConfirmation.test(source.content)||localRetry.test(source.content)){reply=source.content;continue;}
   // A failed original explicit local request also remains retryable, while
   // ordinary cloud operations never acquire local authority from "retry".
   if(!naturalLocalActionRequested(source.content))return;
   return {sourceMessageId:source.id,sourceText:source.content,confirmationMessageId:assistant.id};
  }
  if(operation.failure||!localConfirmation.test(reply)||!ownedFolderQuestion.test(assistant.content))return;
  if(!localActionRequested(source.content)||/(?:不要|不用|无需|禁止|别|不)(?:再|实际)?(?:操作|使用|执行|修改|创建|保存)?(?:本机|本地|电脑)|保存[^。\n]{0,30}Notion/iu.test(source.content))return;
  return {sourceMessageId:source.id,sourceText:source.content,confirmationMessageId:assistant.id};
 }
}
export function naturalLocalActionRequested(text:string,boundTaskId?:string){
  const request=requestText(text);
  // A cloud action and a declined local target cannot combine into a local
  // request. Use the same positive clauses for both action and destination.
  return localActionRequested(request,boundTaskId)&&/(?:本机|本地|电脑|桌面|工作文件夹|工作目录|已授权(?:的)?(?:目录|文件夹)|\/Users\/|[A-Za-z]:\\)/u.test(positiveRequest(request));
}
/** An unselected folder is the one supported first-run exception: the native
 * picker grants its scope at execution, not a model-invented absolute path. */
export function localReadinessCanStart(value:LocalDeviceReadiness|undefined){
  return Boolean(value?.connected&&value.executor.state==='ready'&&['ready','unselected'].includes(value.folder.state));
}
export function localReadinessFailure(value:LocalDeviceReadiness|undefined):CoordinatorLocalFailureCode {
  if(!value)return'local_readiness_unknown';
  if(!value.connected)return'local_device_offline';
  if(value.executor.state==='busy')return'local_busy';
  if(value.folder.state==='denied')return'local_folder_denied';
  if(value.folder.state==='unavailable')return'local_folder_unavailable';
  if(value.folder.state==='unselected'&&value.executor.state==='ready')return'local_folder_missing';
  if(value.executor.state==='unprepared'||value.executor.state==='unavailable')return'local_executor_unready';
  return'local_readiness_unknown';
}
