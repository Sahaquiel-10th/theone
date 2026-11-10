import type {ChatOperation} from './chatOperations.js';
import type {Conversation} from './types.js';
import type {WorkRun} from './coordinatorTypes.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {pendingWorkflowRecovery} from './workflowExecution.js';
import {validOperationEvidence} from './operationRecovery.js';
import {workflowProgress,workflowPhase,type WorkflowStep} from './taskWorkflow.js';
import {notionDeliveryCheckpoint,notionWriteAcknowledged} from './notionCompletion.js';

const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);

/** SQL JSON can reorder object keys; source order and every binding still
 * remain exact. Extra/missing fields are not an equivalent authorization. */
export function workflowSourceBindingsMatch(previous:WorkRun['sources'],next:WorkRun['sources']):boolean{
 return Array.isArray(previous)&&Array.isArray(next)&&previous.length===next.length&&previous.every((source,index)=>{
  const current=next[index];return Boolean(source&&current&&Object.keys(source).sort().join()==='binding,id'&&Object.keys(current).sort().join()==='binding,id'&&typeof source.id==='string'&&typeof source.binding==='string'&&source.id===current.id&&source.binding===current.binding);
 });
}

/** Startup metadata check only. The caller still excludes local-execution
 * holds, then requires a fresh Key and the normal operation authorization on
 * resume. This never creates a revision, reads a document, or retries a call. */
export function canResumeWorkflowAfterRestart(operation:ChatOperation,task:Conversation):boolean{
 try{
  const job=operation.workRun,run=job?.workflow;
  if(operation.status!=='pending'||/^task_(?:(?:key|authorization|budget)_required|budget_limit)$/.test(job?.failureCode??'')||operation.executionCancelled||!job||!['running','queued'].includes(job.state)||!run||!task||task.archived||task.coordinatorMain||task.workPauseReason==='user_stopped'||operation.conversationId!==task.id||operation.workspaceId!==task.workspaceId||operation.userId!==task.userId||run.binding.workspaceId!==operation.workspaceId||run.binding.userId!==operation.userId||run.binding.operationId!==operation.id)return false;
  // Reuses the strict persisted-run validator, including the deterministic
  // owner/revision ID, dependency states and derived phase invariant.
  workflowProgress(run);
  const namespace=`workflow:${run.id}`,steps=job.steps??[],allowedStarted=new Set<string>();
  const expected=(step:WorkflowStep)=>{
   const tool=`workflow:${run.id}:${step.id}`;
   return {tool,key:taskStepKey(namespace,tool,JSON.stringify({revision:run.revision,instruction:step.instruction,inputs:step.inputs}))};
  };
  const checkpoint=(step:WorkflowStep)=>{
   const expectedStep=expected(step),matching=steps.filter(cp=>cp.key===expectedStep.key);
   if(matching.length!==1)return undefined;
   const cp=matching[0],v=object(cp.output),marker=object(v?.workflow);
   if(cp.namespace!==namespace||cp.scopeId!==operation.id||cp.tool!==expectedStep.tool||!['read','model','artifact','external_write'].includes(cp.effect)||!['started','completed','failed'].includes(cp.state)||!Number.isFinite(Date.parse(cp.updatedAt))||!marker||Object.keys(marker).sort().join()!=='revision,runId,stepId,version'||marker.version!==1||marker.runId!==run.id||marker.revision!==run.revision||marker.stepId!==step.id)return undefined;
   if(step.kind==='model'&&cp.effect!=='model'||step.kind==='tool'&&cp.effect!=='read'||step.kind==='notion'&&cp.effect!=='external_write')return undefined;
   if(cp.operation&&(!validOperationEvidence(cp.operation)||cp.operation.artifactRef!==undefined&&cp.operation.artifactRef!==cp.key||cp.state==='completed'&&(cp.operation.execution!=='succeeded'||!cp.operation.artifactRef||step.kind==='notion'&&!['pending','verified','failed'].includes(cp.operation.verification))))return undefined;
   return {cp,value:v!};
  };
  const notionDelivered=(step:WorkflowStep,cp:TaskStep,value:Record<string,unknown>)=>{
   const linkedKey=typeof value.notionCheckpointKey==='string'?value.notionCheckpointKey:undefined;
   const current=linkedKey===undefined||linkedKey===job.notionReceipt?.checkpointKey;
   const receipt=current?job.notionReceipt:value.notionDeliveryProof as WorkRun['notionReceipt'];
   const recoverableStage=cp.state==='started'&&value.outcome==='waiting'||cp.state==='completed'&&value.outcome==='completed';
   if(step.kind!=='notion'||!recoverableStage||!hash(value.expectedBodyDigest)||!receipt||!current&&(cp.state!=='completed'||!notionWriteAcknowledged(receipt,operation.id)))return false;
   if(receipt.checkpointKey===value.priorNotionCheckpointKey)return false;
   if(value.notionCheckpointKey!==undefined&&value.notionCheckpointKey!==receipt.checkpointKey)return false;
   const actual=notionDeliveryCheckpoint(receipt,steps,operation.id,linkedKey,value.expectedBodyDigest);
   if(!actual||!Number.isFinite(Date.parse(actual.updatedAt))||!current&&typeof object(actual.output)?.content!=='string')return false;
   if(actual.operation&&(!validOperationEvidence(actual.operation)||actual.operation.execution!=='succeeded'||actual.operation.artifactRef!==undefined&&actual.operation.artifactRef!==actual.key))return false;
   // The owner may have crashed after sending but before recording its new
   // exact receipt key in the workflow checkpoint. Time and the prior-key
   // exclusion are additional evidence, never substitutes for the body hash.
   if(value.notionCheckpointKey===undefined&&(receipt.checkpointKey===value.priorNotionCheckpointKey||!Number.isFinite(Date.parse(actual.updatedAt))||Date.parse(actual.updatedAt)<Date.parse(cp.updatedAt)))return false;
   allowedStarted.add(cp.key);return true;
  };
  for(let index=0;index<run.spec.steps.length;index++){
   const step=run.spec.steps[index],state=run.steps[index],found=checkpoint(step),hasAny=steps.some(cp=>cp.key===expected(step).key);
   if(state.state==='queued'||state.state==='skipped'||state.state==='waiting'&&state.waitingFor==='inputs'){
    if(hasAny&&!(state.state==='skipped'&&step.kind==='tool'&&step.required===false&&found?.cp.state==='failed'&&found.value.outcome==='skipped'))return false;continue;
   }
   if(!found)return false;
   const {cp,value}=found;
   // A later save may own the current receipt. Earlier ACK-only stages keep
   // their frozen exact delivery proof and full scoped manuscript worker.
   if(step.kind==='notion'&&cp.state==='completed'&&value.outcome==='completed'&&cp.operation?.verification!=='verified'&&!notionDelivered(step,cp,value))return false;
   if(state.state==='completed'){
    if(state.checkpointKey!==cp.key||cp.state!=='completed'||value.outcome!=='completed')return false;
   }else if(state.state==='failed'||state.state==='needs_input'){
    if(cp.state!=='failed'||!['failed','partial','needs_input'].includes(String(value.outcome))||state.state==='needs_input'&&value.outcome!=='needs_input')return false;
   }else if(!(cp.state==='completed'&&value.outcome==='completed')&&!notionDelivered(step,cp,value)&&!pendingWorkflowRecovery(run,steps,run.binding,step.id))return false;
  }
  // An unrelated or nested unfinished paid/artifact/write checkpoint remains a
  // safety hold even when an outer step says it finished. Read-only leftovers
  // grant no additional call here and are checked again by their owner.
  return !steps.some(cp=>cp.state==='started'&&['model','artifact','external_write'].includes(cp.effect)&&!allowedStarted.has(cp.key));
 }catch{return false;}
}

/** A new human supplement may revise a known failed workflow, never retry an
 * unknown old attempt. Proof is exact persisted stage evidence, not prose or
 * a blanket failed-state exception. Other owner/stop/budget gates still apply. */
export function canContinueKnownFailedWorkflow(operation:ChatOperation,task:Conversation):boolean{
 try{
  const job=operation.workRun,run=job?.workflow;
  if(job?.state!=='failed'||job.resultOutcome!=='failed'||operation.executionCancelled||!run||!Array.isArray(job.steps)||task.archived||task.coordinatorMain||operation.workspaceId!==task.workspaceId||operation.userId!==task.userId||operation.conversationId!==task.id||run.binding.workspaceId!==task.workspaceId||run.binding.userId!==task.userId||run.binding.operationId!==operation.id||task.workPauseReason==='user_stopped')return false;
  workflowProgress(run);
  if(job.notionReceipt&&!['not_sent','rejected'].includes(job.notionReceipt.delivery??''))return false;
  if(job.steps.some(cp=>['artifact','external_write'].includes(cp.effect)||cp.state==='started'&&cp.effect==='model'))return false;
  if(run.steps.some((state,index)=>state.state==='running'||state.state==='waiting'&&state.waitingFor==='result'||['feature','notion'].includes(run.spec.steps[index].kind)&&!['queued','waiting','skipped'].includes(state.state)))return false;
  return run.spec.steps.some((step,index)=>{
   if(run.steps[index].state!=='failed'||!['model','tool'].includes(step.kind))return false;
   const tool=`workflow:${run.id}:${step.id}`,key=taskStepKey(`workflow:${run.id}`,tool,JSON.stringify({revision:run.revision,instruction:step.instruction,inputs:step.inputs}));
   const matches=job.steps!.filter(cp=>cp.key===key),cp=matches[0],value=object(cp?.output),marker=object(value?.workflow);
   return matches.length===1&&cp.namespace===`workflow:${run.id}`&&cp.scopeId===operation.id&&cp.tool===tool&&cp.state==='failed'&&cp.effect===(step.kind==='model'?'model':'read')&&value?.outcome==='failed'&&marker?.version===1&&marker.runId===run.id&&marker.revision===run.revision&&marker.stepId===step.id&&Object.keys(marker).sort().join()==='revision,runId,stepId,version';
  });
 }catch{return false;}
}

/** Rebind exact completed knowledge reads to the new same-owner revision after
 * the caller reauthorizes the same sources. Web and current-document reads
 * retain their own freshness checks; no models, artifacts or writes import. */
export function reuseCompletedWorkflowReads(previous:WorkRun,next:import('./taskWorkflow.js').WorkflowRun):TaskStep[]{
 const old=previous.workflow;if(!old||old.binding.workspaceId!==next.binding.workspaceId||old.binding.userId!==next.binding.userId)return [];
 try{workflowProgress(old);workflowProgress(next);}catch{return [];}
 const imported:TaskStep[]=[];
 for(const step of next.spec.steps){
  if(step.kind!=='tool'||step.tool!=='knowledge_search'||step.inputs.length)continue;
  const sources=old.spec.steps.filter(saved=>saved.kind==='tool'&&saved.tool===step.tool&&saved.instruction===step.instruction&&!saved.inputs.length),source=sources[0];
  if(sources.length!==1)continue;
  const sourceIndex=old.spec.steps.indexOf(source),tool=`workflow:${old.id}:${source.id}`,sourceKey=taskStepKey(`workflow:${old.id}`,tool,JSON.stringify({revision:old.revision,instruction:source.instruction,inputs:source.inputs}));
  const matches=(previous.steps??[]).filter(cp=>cp.key===sourceKey),cp=matches[0],value=object(cp?.output),marker=object(value?.workflow);
  if(cp?.operation&&(!validOperationEvidence(cp.operation)||cp.operation.execution!=='succeeded'||cp.operation.verification!=='not_required'||cp.operation.artifactRef!==cp.key))continue;
  if(old.steps[sourceIndex].state!=='completed'||old.steps[sourceIndex].checkpointKey!==sourceKey||matches.length!==1||cp.state!=='completed'||cp.effect!=='read'||cp.namespace!==`workflow:${old.id}`||cp.scopeId!==old.binding.operationId||cp.tool!==tool||value?.outcome!=='completed'||marker?.version!==1||marker.runId!==old.id||marker.revision!==old.revision||marker.stepId!==source.id||Object.keys(marker).sort().join()!=='revision,runId,stepId,version')continue;
  const nextTool=`workflow:${next.id}:${step.id}`,key=taskStepKey(`workflow:${next.id}`,nextTool,JSON.stringify({revision:next.revision,instruction:step.instruction,inputs:step.inputs}));
  imported.push({...structuredClone(cp),key,namespace:`workflow:${next.id}`,scopeId:next.binding.operationId,tool:nextTool,operation:{version:1,execution:'succeeded',verification:'not_required',artifactRef:key},output:{...structuredClone(value),workflow:{version:1,runId:next.id,revision:next.revision,stepId:step.id}}});
  next.steps[next.spec.steps.indexOf(step)]={id:step.id,state:'completed',checkpointKey:key,summary:'沿用同一任务已经取得、且重新授权核对的资料。'};
 }
 next.phase=workflowPhase(next.spec,next.steps);
 return imported;
}
