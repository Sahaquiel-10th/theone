import {createHash} from 'node:crypto';
import type {Database,Conversation} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import type {WorkRun} from './coordinatorTypes.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {workflowProgress,workflowPhase,type WorkflowRun,type WorkflowSpec} from './taskWorkflow.js';
import {workflowFeatureNoEffectInput} from './workflowExecution.js';

type Scope={workspaceId:string;userId:string};
const own=(item:Scope,s:Scope)=>item.workspaceId===s.workspaceId&&item.userId===s.userId;
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const key=(run:WorkflowRun,id:string)=>{const step=run.spec.steps.find(step=>step.id===id)!;return taskStepKey(`workflow:${run.id}`,`workflow:${run.id}:${id}`,JSON.stringify({revision:run.revision,instruction:step.instruction,inputs:step.inputs}));};
function completedSource(job:WorkRun,state:WorkflowRun['steps'][number]):TaskStep|undefined{
 const run=job.workflow!,step=run.spec.steps.find(step=>step.id===state.id)!;
 if(!['model','tool'].includes(step.kind)||state.state!=='completed'||state.checkpointKey!==key(run,state.id))return;
 if(step.inputs.some(id=>{const prior=run.steps.find(saved=>saved.id===id);return !prior||prior.state!=='completed'||prior.checkpointKey!==key(run,id);}))return;
 const matches=job.steps!.filter(cp=>cp.key===state.checkpointKey);if(matches.length!==1)return;
 const cp=matches[0],value=object(cp.output),marker=object(value?.workflow),result=object(value?.result);
 if(cp.namespace!==`workflow:${run.id}`||cp.scopeId!==run.binding.operationId||cp.tool!==`workflow:${run.id}:${state.id}`||cp.state!=='completed'||cp.effect!==(step.kind==='model'?'model':'read')||value?.outcome!=='completed'||!marker||Object.keys(marker).sort().join()!=='revision,runId,stepId,version'||marker.version!==1||marker.runId!==run.id||marker.revision!==run.revision||marker.stepId!==step.id)return;
 if(step.kind==='model'&&(!result||result.outcome!=='completed'||typeof result.content!=='string'||!result.content.trim()||['length','filtered'].includes(String(result.finishReason))))return;
 if(cp.operation&&(cp.operation.version!==1||cp.operation.execution!=='succeeded'||cp.operation.verification!=='not_required'||cp.operation.artifactRef!==cp.key))return;
 return cp;
}
export function templateMaterialReply(text:string){
 const value=text.replace(/[\s，,。！!：:、～~“”「」]/g,'');
 return /^(?:请)?(?:(?:这是|这个是)?模板(?:见附件|在这里|已上传|已经上传|补上了)?|补充模板|上传模板|模板发给你|用这个模板)?(?:请)?(?:按原要求继续|继续(?:处理|吧|做)?|接着处理)?$/.test(value)&&Boolean(value);
}
export type TemplateContinuationPlan={spec:WorkflowSpec;evidenceDigest:string;stepId:string};
/** A template reply is not a changed goal. Only the exact wrapper-certified
 * no-effect missing-template stage can admit this new material revision. */
export function templateContinuationPlan(db:Database,s:Scope,task:Conversation,operation:ChatOperation,attachmentIds:string[],text:string):TemplateContinuationPlan|undefined{
 const job=operation.workRun,run=job?.workflow;
 if(!own(task,s)||!own(operation,s)||operation.conversationId!==task.id||!job||!run||!Array.isArray(job.steps)||job.state!=='failed'||job.resultOutcome!=='needs_input'||operation.executionCancelled||task.archived||task.coordinatorMain||task.workPauseReason==='user_stopped'||job.localExecution||job.executionMode==='local'||job.notionReceipt||job.notionArticleSource||!templateMaterialReply(text)||attachmentIds.length!==1)return;
 if((db.chatOperations??[]).filter(op=>own(op,s)&&op.conversationId===task.id&&op.workRun).at(-1)?.id!==operation.id)return;
 const file=db.attachments.find(file=>own(file,s)&&file.id===attachmentIds[0]&&(!file.status||file.status==='ready')&&/\.xlsx$/i.test(file.originalName));if(!file)return;
 if((db.executionTasks??[]).some(local=>own(local,s)&&local.conversationId===task.id))return;
 try{
  workflowProgress(run);if(run.binding.workspaceId!==s.workspaceId||run.binding.userId!==s.userId||run.binding.operationId!==operation.id)return;
  const proof=workflowFeatureNoEffectInput(run,job.steps,{...s,operationId:operation.id});if(!proof)return;
  if(run.steps.some(state=>state.state==='completed'&&!completedSource(job,state)||state.id!==proof.stepId&&['running','failed','needs_input'].includes(state.state)||state.state==='waiting'&&state.waitingFor==='result'))return;
  if(job.steps.some(cp=>cp.state==='started'||['unknown','submitted','running'].includes(cp.operation?.execution??'')||cp.state==='completed'&&['artifact','external_write'].includes(cp.effect)))return;
  return {spec:structuredClone(run.spec),stepId:proof.stepId,evidenceDigest:digest({workflow:run,steps:job.steps,sources:job.sources,skills:job.skills,credentials:job.credentials,workflowModels:job.workflowModels})};
 }catch{return;}
}
/** Caller reauthorized the original configuration and exact material snapshot.
 * Rebind only completed read/model results; the failed feature itself is not
 * copied or treated as success. Original private checkpoints remain intact. */
export function reuseTemplateCompletedStages(previous:WorkRun,next:WorkflowRun):TaskStep[]{
 const old=previous.workflow;if(!old||old.binding.workspaceId!==next.binding.workspaceId||old.binding.userId!==next.binding.userId||digest(old.spec)!==digest(next.spec))throw Error('Template continuation evidence changed');
 const imported:TaskStep[]=[];
 for(const state of old.steps){
  if(state.state!=='completed')continue;
  const cp=completedSource(previous,state);if(!cp)throw Error('Template continuation evidence changed');
  const nextKey=key(next,state.id),value=object(cp.output)!;
  imported.push({...structuredClone(cp),key:nextKey,namespace:`workflow:${next.id}`,scopeId:next.binding.operationId,tool:`workflow:${next.id}:${state.id}`,operation:{version:1,execution:'succeeded',verification:'not_required',artifactRef:nextKey},output:{...structuredClone(value),workflow:{version:1,runId:next.id,revision:next.revision,stepId:state.id}}});
  next.steps[next.steps.findIndex(saved=>saved.id===state.id)]={...structuredClone(state),checkpointKey:nextKey};
 }
 next.phase=workflowPhase(next.spec,next.steps);return imported;
}
