import type {Database,Conversation} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import {discussionOnly} from './executionIntent.js';
import {knowledgeNames} from './taskContract.js';

type Scope={workspaceId:string;userId:string};
const own=(item:Scope,scope:Scope)=>item.workspaceId===scope.workspaceId&&item.userId===scope.userId;
/** A new message may continue a known incomplete goal, not release an unknown
 * write, local safety hold, user stop, or failed admission. No old job is retried. */
export function taskContinuation(db:Database,scope:Scope,task:Conversation){
  const jobs=(db.chatOperations??[]).filter(op=>own(op,scope)&&op.conversationId===task.id&&op.workRun);
  const relevant=jobs.filter(op=>op.workRun!.failureCode!=='task_superseded');
  const prior=relevant.filter(op=>op.workRun!.state!=='queued').at(-1);
  const localHeld=(db.executionTasks??[]).some(execution=>own(execution,scope)&&execution.conversationId===task.id&&(
    execution.executionSafetyHold||['queued','selecting_target','running'].includes(execution.status)||execution.status!=='completed'&&!execution.terminalReceipt
  ));
  const unknownEffect=relevant.some(op=>{
    const run=op.workRun!;
    if(run.state==='running')return false; // A supplement waits for this round; it never interrupts it.
    const notWritten=['not_sent','rejected'].includes(run.notionReceipt?.delivery??'');
    if(run.notionTarget&&run.notionReceipt?.state!=='verified'&&!notWritten&&(!Array.isArray(run.steps)||run.steps.some(step=>step.tool==='save_notion_draft'&&step.effect==='external_write')))return true;
    return run.notionReceipt&&run.notionReceipt.state!=='verified'&&!notWritten||run.steps?.some(step=>step.state==='started'&&['artifact','external_write'].includes(step.effect)&&!(step.tool==='save_notion_draft'&&notWritten));
  });
  const stopped=task.workPauseReason==='user_stopped'||prior&&['cancelled','interrupted','prepared'].includes(prior.workRun!.state);
  const protectedFailure=prior&&/^task_(?:(?:key|authorization|budget)_required|budget_limit)$/.test(prior.workRun!.failureCode??'');
  const incomplete=prior?.workRun!.state==='failed'&&['needs_input','partial'].includes(prior.workRun!.resultOutcome??'');
  const safe=!localHeld&&!unknownEffect&&!stopped&&!protectedFailure;
  return {jobs,prior,queued:jobs.filter(op=>op.status==='pending'&&op.workRun!.state==='queued'),
    canResumeQueued:safe&&jobs.some(op=>op.status==='pending'&&op.workRun!.state==='queued'),
    canResume:safe&&Boolean(incomplete)&&task.workPauseReason!=='user_stopped',
    canAcceptSupplement:safe&&Boolean(incomplete||prior?.workRun!.state==='running'),
  };
}

/** Questions keep their answer path, but cannot turn a paused task into a
 * repeat execution. A material reply without a question is a valid supplement. */
export function actionableTaskSupplement(value:string){
  if(discussionOnly(value))return false;
  const request=value.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').trim();
  if(taskStatusQuestion(request))return false;
  const continuation=/(?:继续|接着|开工|开始|按.{0,12}(?:写|做)|补充|素材|材料|改成|修改|写成|整理|生成|完成|执行)|\b(?:continue|resume|proceed)\b/i.test(request);
  const question=/(?:现在|目前|刚才|到底|怎么|什么|如何|是否|能不能|有没有|进度|状态).{0,14}(?:了|样|回事|完成|处理|进展|情况|吗|么|呢|\?|？)|[?？]\s*$/.test(request);
  return continuation||!question;
}
export function taskStatusQuestion(value:string){
  return /^(?:现在|目前|刚才|这件事|任务|之前|你)?\s*(?:怎么了|怎么样了?|到哪(?:一步)?了?|什么(?:进度|情况)|(?:完成|做好|开始|继续|执行|处理)(?:了)?[吗么]|有结果(?:了)?[吗么])\s*[?？。]*$/.test(value.trim());
}
export function plainTaskContinuation(value:string){
  return /^(?:ok[～~，,、。!！\s]*|好的?[～~，,、。!！\s]*|那就[，,\s]*)?(?:请)?(?:继续(?:干|做|写|吧|处理|完成)?|接着(?:干|做|写|处理|完成)|按原要求继续)[～~，,、。!！\s]*$/i.test(value.trim());
}

export function supersedeQueuedSupplements(queued:ChatOperation[],timestamp:string){
  for(const op of queued){op.workRun!.state='cancelled';op.workRun!.failureCode='task_superseded';op.workRun!.unread=false;op.status='interrupted';op.updatedAt=timestamp;}
}

/** Naming the material's connected platform is a retrieval request even if
 * the user says “it has the material, use it” rather than the word “search”. */
export function supplementKnowledgeRequest(value:string){
  if(!actionableTaskSupplement(value)||/(?:不要|不用|不必|无需|别)(?:再)?(?:用|读|查|搜|检索)/.test(value))return '';
  if(!/(?:按|用|参考)[^。？?\n]{0,24}(?:写|做|整理|生成|完成)/.test(value))return '';
  const names=Object.entries(knowledgeNames).filter(([id,name])=>new RegExp(`(?:${id}|${name})[^。？?\\n]{0,80}(?:有|素材|材料|内容)`, 'i').test(value)).map(([,name])=>name);
  return names.length?`请从${names.join('、')}查找本次补充的材料。`:'';
}
