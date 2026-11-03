import type {WorkRun} from './coordinatorTypes.js';
import {taskStepKey} from './taskSteps.js';
import {workflowProgress,type WorkflowBinding} from './taskWorkflow.js';
import {operationProgress} from './operationRecovery.js';

/** One reviewed public projection for both the live rail and task details.
 * Checkpoint content, provider IDs, queries and recovery internals stay private. */
export function publicWorkflowProgress(job:WorkRun|undefined,binding:WorkflowBinding){
 const run=job?.workflow;if(!run||run.binding.workspaceId!==binding.workspaceId||run.binding.userId!==binding.userId||run.binding.operationId!==binding.operationId)return;
 try{
  const progress=workflowProgress(run);
  return {version:1 as const,phase:run.phase,steps:progress.steps.map((step,index)=>{
   const spec=run.spec.steps[index],state=run.steps[index],namespace=`workflow:${run.id}`,tool=`workflow:${run.id}:${spec.id}`;
   const key=taskStepKey(namespace,tool,JSON.stringify({revision:run.revision,instruction:spec.instruction,inputs:spec.inputs}));
   const matches=job!.steps?.filter(cp=>cp.key===key)??[],candidate=matches.length===1?matches[0]:undefined;
   const cp=candidate?.namespace===namespace&&candidate.scopeId===binding.operationId&&candidate.tool===tool?candidate:undefined,v=cp?.output as {outcome?:string;workflow?:{version?:number;runId?:string;revision?:number;stepId?:string}}|undefined;
   const marker=v?.workflow,effectValid=spec.kind==='model'?cp?.effect==='model':spec.kind==='tool'?cp?.effect==='read':spec.kind==='notion'?cp?.effect==='external_write':cp?.effect!==undefined;
   const markerValid=marker&&Object.keys(marker).sort().join()==='revision,runId,stepId,version'&&marker.version===1&&marker.runId===run.id&&marker.revision===run.revision&&marker.stepId===spec.id;
   const evidence=markerValid&&effectValid&&(!cp?.operation?.artifactRef||cp.operation.artifactRef===key)?operationProgress(cp?.operation):undefined;
   const resultAvailable=state.state==='completed'&&cp?.state==='completed'&&v?.outcome==='completed'&&state.checkpointKey===key&&['model','feature','notion'].includes(spec.kind)&&evidence?.resultAvailable===true&&(spec.kind!=='notion'||evidence.verification==='verified');
   return {id:String(index),title:step.title,state:step.status,summary:step.summary,...(state.state==='waiting'?{waitingFor:state.waitingFor}:{}),...(evidence?{execution:evidence.execution,verification:evidence.verification,...(evidence.recovery?{recovery:evidence.recovery}:{})}:{}),...(resultAvailable?{resultAvailable:true}:{})};
  }),next:progress.next};
 }catch{return;}
}

/** The owner route authorizes current sources/credentials before exposing
 * these already-authored bodies. This reads existing checkpoints, never a
 * second model call or a copied manuscript store. */
export function availableWorkflowResults(job:WorkRun|undefined,binding:WorkflowBinding){
 const view=publicWorkflowProgress(job,binding);if(!view||!job?.workflow)return;
 const results=view.steps.flatMap((step,index)=>{
  if(!step.resultAvailable||job.workflow!.spec.steps[index].kind!=='model')return [];
  const state=job.workflow!.steps[index],cp=job.steps?.find(cp=>cp.key===state.checkpointKey);
  const value=cp?.output as {result?:{outcome?:string;content?:unknown}}|undefined;
  const body=value?.result?.content;
  return ['completed','returned'].includes(value?.result?.outcome??'')&&typeof body==='string'&&body.trim()?[{stepId:step.id,title:step.title,content:body}]:[];
 });
 return results.length?results:undefined;
}
