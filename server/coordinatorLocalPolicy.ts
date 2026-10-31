import {coordinatorTaskIntent,discussionOnly} from './executionIntent.js';
import {taskStatusQuestion} from './taskContinuation.js';
import type {CoordinatorFailureCode} from '../src/coordinatorRecovery.js';
import type {LocalDeviceReadiness} from '../src/localDeviceReadiness.js';

export type CoordinatorLocalFailureCode=Extract<CoordinatorFailureCode,
  'local_device_offline'|'local_folder_missing'|'local_folder_denied'|'local_folder_unavailable'|
  'local_executor_unready'|'local_busy'|'local_attachments_unsupported'|'local_tool_unavailable'|
  'local_readiness_unknown'|'local_tool_invalid'|'dispatch_not_started'>;
/** Reviewed metadata only. Never put a path, launcher exception or tool arguments in this error. */
export class CoordinatorLocalError extends Error {
  constructor(readonly code:CoordinatorLocalFailureCode,readonly status=428){super(code);}
}
function requestText(text:string){
  return text.split(/(?:正文|原文|引用|示例|材料|附件内容)(?:如下|内容)?\s*[:：]/u)[0]
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g,'').trim();
}
/** A saved destination is a preference, not a command. Explicit restrictions,
 * explanations and status questions never acquire local write authority. */
export function localActionRequested(text:string,boundTaskId?:string){
  const request=requestText(text);
  if(!request||coordinatorTaskIntent(request,boundTaskId).answerOnly||discussionOnly(request)||taskStatusQuestion(request))return false;
  if(/告诉我|说明一下|解释|教我|(?:请|帮我)(?:先)?(?:说明|介绍)/u.test(request))return false;
  if(/\b(?:do not|don't|never)\s+(?:create|write|save|edit|modify|run|execute)\b|\b(?:explain|describe|tutorial)\b|\b(?:how (?:to|does|do)|what (?:is|does)|why)\b/iu.test(request))return false;
  const positive=request.replace(/(?:不要|不用|不必|不需要|别|禁止|不(?=(?:再|重新)?(?:执行|创建|写|修改|保存|操作|生成|导出|做|处理)))(?:再|重新)?[^，,。；;\n]{0,60}/gu,'');
  const action=/(?:写|做|制作|生成|交付|保存|存到|存入|导出|创建|新建|修改|更新|编辑|填写|填入|整理|编写|搭建|搭个|搭一个|执行|处理|安排|继续|接着|开工)|\b(?:make|create|build|generate|save|write|edit|continue|resume)\b/iu;
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
export function naturalLocalActionRequested(text:string,boundTaskId?:string){
  const request=requestText(text);
  return localActionRequested(request,boundTaskId)&&/(?:本机|本地|电脑|桌面|工作文件夹|工作目录|已授权(?:的)?(?:目录|文件夹)|\/Users\/|[A-Za-z]:\\)/u.test(request);
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
