import type {Database,Conversation} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import {plainTaskContinuation} from './taskContinuation.js';
import {taskStepKey} from './taskSteps.js';
import {workflowProgress,workflowPhase,type WorkflowRun} from './taskWorkflow.js';
import {canResumeWorkflowAfterRestart} from './workflowRecovery.js';
import {acknowledgedNotionWorkflowResumeProof} from './chatOperations.js';
import type {TaskStep} from './taskSteps.js';

type Scope={workspaceId:string;userId:string};
const own=(item:Scope,scope:Scope)=>item.workspaceId===scope.workspaceId&&item.userId===scope.userId;
export const connectionFailure=(operation?:ChatOperation)=>['task_key_required','task_authorization_required'].includes(operation?.workRun?.failureCode??'');
export function connectionResumeRequested(value:string){
 return plainTaskContinuation(value)||/^(?:(?:ONE\s*)?Key|连接|授权)(?:已经|已|都)?(?:恢复|连好|连接好|插好|搞定|好了)[了啦～~，,。\s]*(?:请)?继续(?:吧|做|处理)?[～~，,。！!\s]*$/i.test(value.trim());
}
export type ConnectionRecoverySelection={kind:'none'}|{kind:'ambiguous'}|{kind:'candidate';task:Conversation;operation:ChatOperation};
/** A human continuation selects one existing goal, never a model-proposed ID.
 * An explicit bound task still needs the same owner check as ordinary reads. */
export function selectConnectionRecovery(db:Database,scope:Scope,text:string,boundTaskId?:string):ConnectionRecoverySelection{
 if(!connectionResumeRequested(text))return {kind:'none'};
 const candidates=db.conversations.filter(task=>own(task,scope)&&!task.coordinatorMain&&!task.archived&&(!boundTaskId||task.id===boundTaskId)).flatMap(task=>{
  const operation=(db.chatOperations??[]).filter(op=>own(op,scope)&&op.conversationId===task.id&&op.workRun&&op.workRun.failureCode!=='task_superseded').at(-1);
  return operation&&(connectionFailure(operation)||operation.workRun!.connectionRecoveries?.length&&['queued','running'].includes(operation.workRun!.state))?[{task,operation}]:[];
 });
 return candidates.length===1?{kind:'candidate',...candidates[0]}:candidates.length>1?{kind:'ambiguous'}:{kind:'none'};
}
export type ConnectionRecoveryPlan={workflow:WorkflowRun;steps:TaskStep[]}|{blocked:string};
/** Pure evidence check only. This does not authorize a source, start a call or
 * retry a paid effect. The service rechecks every live binding before CAS. */
export function connectionRecoveryPlan(db:Database,scope:Scope,task:Conversation,operation:ChatOperation):ConnectionRecoveryPlan{
 const job=operation.workRun,run=job?.workflow;
 const blocked={blocked:'这次连接已经可以重新检查，但原步骤的结果还没确认。我先保留已有成果；请打开这件任务查看具体卡点，不会重新生成或重复保存。'};
 if(!own(task,scope)||!own(operation,scope)||operation.conversationId!==task.id||!job||!connectionFailure(operation)||operation.status!=='failed'||job.state!=='failed'||operation.executionCancelled||task.archived||task.coordinatorMain||task.workPauseReason==='user_stopped')return blocked;
 if(job.localExecution||job.executionMode==='local'||job.kind==='image'||job.directVisual||!run||!Array.isArray(job.steps))return blocked;
 if((db.executionTasks??[]).some(local=>own(local,scope)&&local.conversationId===task.id&&(local.executionSafetyHold||['queued','selecting_target','running'].includes(local.status)||local.status!=='completed'&&!local.terminalReceipt)))return blocked;
 const delivered=acknowledgedNotionWorkflowResumeProof(operation,task),steps=delivered?.steps??job.steps;
 if(job.notionReceipt&&job.notionReceipt.state!=='verified'&&!delivered&&!['not_sent','rejected'].includes(job.notionReceipt.delivery??''))return blocked;
 if(steps.some(cp=>cp.state==='started'&&['model','artifact','external_write'].includes(cp.effect)||cp.state==='failed'))return blocked;
 try{
  workflowProgress(run);
  const next=structuredClone(delivered?.workflow??run);let reset=false;
  for(const state of next.steps){
   if(state.state==='failed'||state.state==='needs_input')return blocked;
   if(state.state!=='running'&&!(state.state==='waiting'&&state.waitingFor==='result'))continue;
   const step=next.spec.steps.find(step=>step.id===state.id)!;
   const key=taskStepKey(`workflow:${next.id}`,`workflow:${next.id}:${step.id}`,JSON.stringify({revision:next.revision,instruction:step.instruction,inputs:step.inputs}));
   if(steps.some(cp=>cp.key===key))continue;
   // This runner checkpoints BEFORE every effect. A missing exact checkpoint
   // on a validated persisted run proves the stage was not sent. A legacy
   // missing checkpoint array, or any nested uncertain effect, is not proof.
   Object.assign(state,{state:'queued',summary:'连接已恢复，继续尚未开始的这一步。'});delete state.waitingFor;delete state.checkpointKey;reset=true;
  }
  if(reset)next.sequence++;
  next.phase=workflowPhase(next.spec,next.steps);
  const candidate={...operation,status:'pending' as const,workRun:{...job,state:'queued' as const,failureCode:undefined,workflow:next,steps}};
  if(!canResumeWorkflowAfterRestart(candidate,task))return blocked;
  return {workflow:next,steps:structuredClone(steps)};
 }catch{return blocked;}
}
