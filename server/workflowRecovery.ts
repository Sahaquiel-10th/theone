import type {ChatOperation} from './chatOperations.js';
import type {Conversation} from './types.js';
import {taskStepKey,type TaskStep} from './taskSteps.js';
import {workflowProgress,type WorkflowStep} from './taskWorkflow.js';

const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);

/** Startup metadata check only. The caller still excludes local-execution
 * holds, then requires a fresh Key and the normal operation authorization on
 * resume. This never creates a revision, reads a document, or retries a call. */
export function canResumeWorkflowAfterRestart(operation:ChatOperation,task:Conversation):boolean{
 try{
  const job=operation.workRun,run=job?.workflow;
  if(operation.status!=='pending'||operation.executionCancelled||!job||!['running','queued'].includes(job.state)||!run||!task||task.archived||task.coordinatorMain||task.workPauseReason==='user_stopped'||operation.conversationId!==task.id||operation.workspaceId!==task.workspaceId||operation.userId!==task.userId||run.binding.workspaceId!==operation.workspaceId||run.binding.userId!==operation.userId||run.binding.operationId!==operation.id)return false;
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
   return {cp,value:v!};
  };
  const notionVerified=(step:WorkflowStep,cp:TaskStep,value:Record<string,unknown>)=>{
   const receipt=job.notionReceipt;
   if(step.kind!=='notion'||cp.state!=='started'||value.outcome!=='waiting'||!hash(value.expectedBodyDigest)||receipt?.state!=='verified'||receipt.verification||receipt.final!==true||!hash(receipt.digest)||receipt.expectedDigest!==value.expectedBodyDigest||!receipt.checkpointKey||!receipt.pageId||!/^[a-f0-9]{32}$/i.test(receipt.pageId.replaceAll('-','')))return false;
   if(value.notionCheckpointKey!==undefined&&value.notionCheckpointKey!==receipt.checkpointKey)return false;
   const matching=steps.filter(saved=>saved.key===receipt.checkpointKey);
   if(matching.length!==1)return false;
   const actual=matching[0],proof=object(actual.output);
   if(actual.namespace!=='worker'||actual.tool!=='save_notion_draft'||actual.scopeId!==operation.id||actual.effect!=='external_write'||actual.state!=='completed'||proof?.state!=='verified'||proof.pageId!==receipt.pageId||proof.digest!==receipt.digest||proof.expectedDigest!==receipt.expectedDigest||proof.final!==true)return false;
   // The owner may have crashed after sending but before recording its new
   // exact receipt key in the workflow checkpoint. Time and the prior-key
   // exclusion are additional evidence, never substitutes for the body hash.
   if(value.notionCheckpointKey===undefined&&(receipt.checkpointKey===value.priorNotionCheckpointKey||!Number.isFinite(Date.parse(actual.updatedAt))||Date.parse(actual.updatedAt)<Date.parse(cp.updatedAt)))return false;
   allowedStarted.add(cp.key);return true;
  };
  for(let index=0;index<run.spec.steps.length;index++){
   const step=run.spec.steps[index],state=run.steps[index],found=checkpoint(step),hasAny=steps.some(cp=>cp.key===expected(step).key);
   if(state.state==='queued'||state.state==='skipped'||state.state==='waiting'&&state.waitingFor==='inputs'){
    if(hasAny)return false;continue;
   }
   if(!found)return false;
   const {cp,value}=found;
   if(state.state==='completed'){
    if(state.checkpointKey!==cp.key||cp.state!=='completed'||value.outcome!=='completed')return false;
   }else if(state.state==='failed'||state.state==='needs_input'){
    if(cp.state!=='failed'||!['failed','partial','needs_input'].includes(String(value.outcome))||state.state==='needs_input'&&value.outcome!=='needs_input')return false;
   }else if(!(cp.state==='completed'&&value.outcome==='completed')&&!notionVerified(step,cp,value))return false;
  }
  // An unrelated or nested unfinished paid/artifact/write checkpoint remains a
  // safety hold even when an outer step says it finished. Read-only leftovers
  // grant no additional call here and are checked again by their owner.
  return !steps.some(cp=>cp.state==='started'&&['model','artifact','external_write'].includes(cp.effect)&&!allowedStarted.has(cp.key));
 }catch{return false;}
}
