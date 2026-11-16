import type {ChatOperation} from './chatOperations.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {WorkflowContextInput} from './workflowContext.js';
import {createWorkflowRun} from './taskWorkflow.js';
import {taskStepKey} from './taskSteps.js';
import {reuseCompletedWorkflowReads,workflowSourceBindingsMatch} from './workflowRecovery.js';
import {attachmentPreparationDigest as stableDigest} from './attachmentPreparation.js';
import {parseTaskInputSourceReference} from './taskInputSource.js';
import {knowledgeRecallOptions} from './runtimeContext.js';

/** Server-owned references to existing private checkpoints. No retrieved body
 * is copied into the next run's stored configuration. */
export type WorkflowKnowledgeReference={
 originOperationId:string;runId:string;revision:number;stepId:string;checkpointKey:string;resultDigest:string;
};
export class WorkflowKnowledgeInputError extends Error{
 readonly code='WORKFLOW_KNOWLEDGE_INPUT_INVALID';
 constructor(){super('先前查到的资料暂时无法核对，这一步已停下。原要求和已有结果会保留，请核对本次问题记录后再继续。');this.name='WorkflowKnowledgeInputError';}
}
const maxReferences=12;
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const sameIds=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const sameOwnerTask=(a:ChatOperation,b:ChatOperation)=>a.workspaceId===b.workspaceId&&a.userId===b.userId&&Boolean(a.conversationId)&&a.conversationId===b.conversationId;
function selectedSources(run:WorkRun):string[]|undefined{
 const ids=run.contract?.knowledgeSourceIds??run.sources?.map(source=>source.id);
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id.trim()||!run.sources.some(source=>source.id===id))||new Set(ids).size!==ids.length)return;
 return ids;
}
function materialReferences(operation:ChatOperation){
 const run=operation.workRun!;
 const values=run.materialSources??(run.materialSource?[run.materialSource]:run.materialScope==='current'&&run.inputSource?[run.inputSource]:[]);
 if(!Array.isArray(values)||values.length>8)return;
 const references=values.map(parseTaskInputSourceReference);
 if(references.some(ref=>!ref||ref.workspaceId!==operation.workspaceId||ref.userId!==operation.userId||ref.taskId!==operation.conversationId)||new Set(references.map(ref=>ref!.inputMessageId)).size!==references.length)return;
 return references;
}
function compatible(current:ChatOperation,previous:ChatOperation):boolean{
 const next=current.workRun,prior=previous.workRun;
 if(!next||!prior||!sameOwnerTask(current,previous)||current.id===previous.id||current.executionCancelled||previous.executionCancelled||['cancelled','interrupted'].includes(prior.state)||!next.workflow||!prior.workflow)return false;
 if(next.workflow.binding.workspaceId!==current.workspaceId||next.workflow.binding.userId!==current.userId||next.workflow.binding.operationId!==current.id||prior.workflow.binding.workspaceId!==previous.workspaceId||prior.workflow.binding.userId!==previous.userId||prior.workflow.binding.operationId!==previous.id)return false;
 if(!workflowSourceBindingsMatch(prior.sources,next.sources))return false;
 const priorSources=selectedSources(prior),nextSources=selectedSources(next);
 if(!priorSources||!nextSources||!sameIds(priorSources,nextSources))return false;
 const oldMaterials=materialReferences(previous),newMaterials=materialReferences(current);
 if(!oldMaterials||!newMaterials||stableDigest(oldMaterials)!==stableDigest(newMaterials))return false;
 if(Boolean(prior.runtimeContext)!==Boolean(next.runtimeContext))return false;
 if(prior.runtimeContext&&next.runtimeContext&&stableDigest(knowledgeRecallOptions(prior.instruction,prior.runtimeContext))!==stableDigest(knowledgeRecallOptions(next.instruction,next.runtimeContext)))return false;
 return true;
}
function isEarlier(current:ChatOperation,candidate:ChatOperation,operations:readonly ChatOperation[]):boolean{
 const currentIndex=operations.findIndex(operation=>operation.id===current.id),candidateIndex=operations.indexOf(candidate);
 const currentAt=Date.parse(current.createdAt),candidateAt=Date.parse(candidate.createdAt);
 if(!Number.isFinite(currentAt)||!Number.isFinite(candidateAt)||candidateAt>currentAt)return false;
 return currentIndex>=0?candidateIndex>=0&&candidateIndex<currentIndex:candidateAt<currentAt;
}
function provenReferences(current:ChatOperation,previous:ChatOperation):WorkflowKnowledgeReference[]{
 if(!compatible(current,previous))return [];
 const prior=previous.workRun!,workflow=prior.workflow!;
 const reads=workflow.spec.steps.filter(step=>step.kind==='tool'&&step.tool==='knowledge_search'&&!step.inputs.length);
 if(!reads.length||reads.length>maxReferences)return [];
 // Reuse the runner's existing strict proof validator through a temporary run.
 // Neither this synthetic run nor the rebound checkpoints are persisted.
 const probe=createWorkflowRun({version:1,steps:reads},current.workRun!.workflow!.binding,current.workRun!.workflow!.revision);
 const imported=reuseCompletedWorkflowReads(prior,probe);
 return reads.flatMap(step=>{
  const reboundTool=`workflow:${probe.id}:${step.id}`,reboundKey=taskStepKey(`workflow:${probe.id}`,reboundTool,JSON.stringify({revision:probe.revision,instruction:step.instruction,inputs:step.inputs}));
  const rebound=imported.find(cp=>cp.key===reboundKey),result=object(object(rebound?.output)?.result);
  if(!result||!['used','partial'].includes(String(result.status))||!Array.isArray(result.chunks)||!result.chunks.some(chunk=>typeof object(chunk)?.content==='string'&&String(object(chunk)!.content).trim()))return [];
  const tool=`workflow:${workflow.id}:${step.id}`,checkpointKey=taskStepKey(`workflow:${workflow.id}`,tool,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));
  return [{originOperationId:previous.id,runId:workflow.id,revision:workflow.revision,stepId:step.id,checkpointKey,resultDigest:stableDigest(result)}];
 });
}

/** Call only after the coordinator has accepted an unchanged same-task
 * continuation and reauthorized the current sources/materials. Inheritance
 * follows the immediate prior revision's read or stored proof chain. An
 * unbound model-only revision cannot implicitly reopen an older search. */
export function selectWorkflowKnowledgeReferences(current:ChatOperation,candidates:readonly ChatOperation[],trustedContinuations:ReadonlySet<string>=new Set(),invalidProof:'empty'|'error'='empty'):WorkflowKnowledgeReference[]{
 try{
  const previous=candidates.filter(candidate=>sameOwnerTask(current,candidate)&&candidate.id!==current.id&&candidate.workRun&&isEarlier(current,candidate,candidates));
  for(const candidate of previous.reverse()){
   if(!compatible(current,candidate))return [];
   if(candidate.workRun!.workflow!.spec.steps.some(step=>step.kind==='tool'&&step.tool==='knowledge_search')){
    const references=provenReferences(current,candidate);
    if(!references.length&&invalidProof==='error')throw new WorkflowKnowledgeInputError();
    return references;
   }
   if(candidate.workRun!.knowledgeContext===undefined){if(trustedContinuations.has(candidate.id))continue;return [];}
   resolveWorkflowKnowledgeInputs(candidate,candidates,trustedContinuations);
   // Validate both edges of the chain. The current revision must independently
   // retain the same exact source/material/date scope as the original read.
   const inherited={...current,workRun:{...current.workRun!,knowledgeContext:candidate.workRun!.knowledgeContext}};
   resolveWorkflowKnowledgeInputs(inherited,candidates,trustedContinuations);
   return structuredClone(candidate.workRun!.knowledgeContext);
  }
 }catch{if(invalidProof==='error')throw new WorkflowKnowledgeInputError();}
 return [];
}
function parseReference(value:unknown):WorkflowKnowledgeReference|undefined{
 const ref=object(value);
 if(!ref||Object.keys(ref).sort().join()!=='checkpointKey,originOperationId,resultDigest,revision,runId,stepId'||!['originOperationId','runId','stepId','checkpointKey'].every(key=>typeof ref[key]==='string'&&String(ref[key]).trim()&&String(ref[key]).length<=240)||!Number.isSafeInteger(ref.revision)||Number(ref.revision)<1||typeof ref.resultDigest!=='string'||!/^[a-f0-9]{64}$/.test(ref.resultDigest))return;
 return {originOperationId:String(ref.originOperationId),runId:String(ref.runId),revision:Number(ref.revision),stepId:String(ref.stepId),checkpointKey:String(ref.checkpointKey),resultDigest:ref.resultDigest};
}
function contextInputs(current:ChatOperation,reference:WorkflowKnowledgeReference,index:number,result:Record<string,unknown>):WorkflowContextInput[]{
 const binding={workspaceId:current.workspaceId,userId:current.userId,operationId:current.id},prefix=`inherited_knowledge_${index}`;
 const chunks=(result.chunks as unknown[]).flatMap((raw,chunkIndex)=>{
  const chunk=object(raw);if(typeof chunk?.content!=='string'||!chunk.content.trim())return [];
  const metadata:Partial<WorkflowContextInput>={},date=object(chunk.dateEvidence);
  for(const field of ['title','sourceUrl','createdAt','updatedAt'] as const)if(typeof chunk[field]==='string')metadata[field]=chunk[field];
  if(typeof chunk.provider==='string')metadata.source=chunk.provider;
  if(date&&['basis','date','status'].every(field=>typeof date[field]==='string'))metadata.dateEvidence={basis:String(date.basis),date:String(date.date),status:String(date.status)};
  return [{...binding,id:`${prefix}_${chunkIndex}`,kind:'knowledge' as const,content:chunk.content,originOperationId:reference.originOperationId,ref:typeof chunk.id==='string'?chunk.id:`${reference.checkpointKey}:${chunkIndex}`,complete:false,truncated:chunk.truncated===true,...metadata}];
 });
 const coverage={status:result.status,coverage:result.coverage,failures:result.failures,temporal:result.temporal};
 return [...chunks,{...binding,id:`${prefix}_coverage`,kind:'tool_result',content:JSON.stringify(coverage),originOperationId:reference.originOperationId,ref:reference.checkpointKey,complete:false}];
}

/** Resolve only stored server-created references after current authorization.
 * Recheck on each paid-call boundary. Lost/changed proof is an explicit failure,
 * never an empty context that quietly sends the writer back to searching. */
export function resolveWorkflowKnowledgeInputs(current:ChatOperation,candidates:readonly ChatOperation[],trustedContinuations:ReadonlySet<string>=new Set()):WorkflowContextInput[]{
 const references=current.workRun?.knowledgeContext;
 if(references===undefined)return [];
 try{
  if(!Array.isArray(references)||references.length>maxReferences)throw new WorkflowKnowledgeInputError();
  const parsed=references.map(parseReference);
  if(parsed.some(ref=>!ref)||new Set(parsed.map(ref=>`${ref!.originOperationId}:${ref!.checkpointKey}`)).size!==parsed.length)throw new WorkflowKnowledgeInputError();
  if(!parsed.length)return [];
  const origin=parsed[0]!.originOperationId;
  if(parsed.some(ref=>ref!.originOperationId!==origin))throw new WorkflowKnowledgeInputError();
  const previous=candidates.filter(candidate=>sameOwnerTask(current,candidate)&&candidate.id!==current.id&&candidate.workRun&&isEarlier(current,candidate,candidates));
  let originReached=false;
  for(const candidate of previous.reverse()){
   if(!compatible(current,candidate))throw new WorkflowKnowledgeInputError();
   if(candidate.workRun!.workflow!.spec.steps.some(step=>step.kind==='tool'&&step.tool==='knowledge_search')){
    if(candidate.id!==origin)throw new WorkflowKnowledgeInputError();
    originReached=true;break;
   }
   const carried=candidate.workRun!.knowledgeContext;
   if(carried!==undefined){
    if(!Array.isArray(carried)||stableDigest(carried)!==stableDigest(parsed))throw new WorkflowKnowledgeInputError();
   }else if(!trustedContinuations.has(candidate.id))throw new WorkflowKnowledgeInputError();
  }
  if(!originReached)throw new WorkflowKnowledgeInputError();
  return parsed.flatMap((ref,index)=>{
   const reference=ref!,operations=candidates.filter(operation=>operation.id===reference.originOperationId);
   if(operations.length!==1||!isEarlier(current,operations[0],candidates))throw new WorkflowKnowledgeInputError();
   const previous=operations[0],proofs=provenReferences(current,previous);
   if(!proofs.some(proof=>stableDigest(proof)===stableDigest(reference)))throw new WorkflowKnowledgeInputError();
   const cp=previous.workRun!.steps!.find(cp=>cp.key===reference.checkpointKey)!,result=object(object(cp.output)?.result);
   if(!result||stableDigest(result)!==reference.resultDigest)throw new WorkflowKnowledgeInputError();
   return contextInputs(current,reference,index,result);
  });
 }catch(error){if(error instanceof WorkflowKnowledgeInputError)throw error;throw new WorkflowKnowledgeInputError();}
}
