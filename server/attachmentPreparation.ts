import {createHash} from 'node:crypto';
import type {Attachment} from './types.js';
import {prepareAttachmentContext,type AttachmentCoverageMode,type AttachmentSummaryBatch} from './attachmentRetrieval.js';
import {taskStepKey,type TaskStep,type TaskStepStore} from './taskSteps.js';
import type {ModelFinishReason} from './modelGateway.js';
import {validOperationEvidence} from './operationRecovery.js';

export type AttachmentPreparationScope={workspaceId:string;userId:string;conversationId:string;operationId:string};
export type AttachmentPreparationConfig={modelId:string;taskVersion:number;promptDigest:string};
export type AttachmentPreparationResult=string|{content:string;finishReason?:ModelFinishReason;toolCalls?:readonly unknown[]};
export const attachmentPreparationNamespace='attachment_preparation';
const tool='prepare_attachment_summary';
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])):v;
const encoded=(v:unknown)=>JSON.stringify(canonical(v));
export const attachmentPreparationDigest=(value:unknown)=>createHash('sha256').update(encoded(value)).digest('hex');
const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const exact=(value:unknown,keys:string[])=>{const v=record(value);return v&&Object.keys(v).sort().join()===keys.sort().join()?v:undefined;};
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validScope=(scope:unknown):scope is AttachmentPreparationScope=>Boolean(exact(scope,['workspaceId','userId','conversationId','operationId'])&&Object.values(scope as object).every(value=>typeof value==='string'&&value.length>0&&value.length<=240));
type Marker={version:1;scope:AttachmentPreparationScope;sourceDigest:string;goalDigest:string;configDigest:string;inputDigest:string;batch:{kind:'map'|'reduce';round:number;index:number}};
type Saved={attachmentPreparation:Marker;outcome:'completed';result:{content:string;finishReason:'stop'|'unknown'};resultDigest:string};
const checkpointKey=(marker:Marker)=>taskStepKey(attachmentPreparationNamespace,tool,encoded(marker));
function completed(step:TaskStep):Saved|undefined{
 const value=exact(step.output,['attachmentPreparation','outcome','result','resultDigest']),m=exact(value?.attachmentPreparation,['version','scope','sourceDigest','goalDigest','configDigest','inputDigest','batch']),batch=exact(m?.batch,['kind','round','index']),result=exact(value?.result,['content','finishReason']);
 if(!value||value.outcome!=='completed'||!m||m.version!==1||!validScope(m.scope)||!['sourceDigest','goalDigest','configDigest','inputDigest'].every(key=>hash(m[key]))||!batch||!['map','reduce'].includes(String(batch.kind))||!Number.isSafeInteger(batch.round)||Number(batch.round)<0||Number(batch.round)>5||!Number.isSafeInteger(batch.index)||Number(batch.index)<0||Number(batch.index)>1000||batch.kind==='map'&&batch.round!==0||batch.kind==='reduce'&&Number(batch.round)<1||!result||typeof result.content!=='string'||!result.content.trim()||result.content.length>200000||!['stop','unknown'].includes(String(result.finishReason))||!hash(value.resultDigest)||value.resultDigest!==attachmentPreparationDigest(result))return;
 const marker=m as unknown as Marker;
 if(step.namespace!==attachmentPreparationNamespace||step.tool!==tool||step.key!==checkpointKey(marker)||step.scopeId!==marker.scope.operationId||step.effect!=='model'||step.state!=='completed'||!Number.isFinite(Date.parse(step.updatedAt))||!validOperationEvidence(step.operation)||step.operation.execution!=='succeeded'||step.operation.verification!=='not_required'||step.operation.artifactRef!==step.key||step.operation.recovery)return;
 return value as unknown as Saved;
}
export class AttachmentPreparationError extends Error{
 constructor(readonly code:'binding_invalid'|'result_unknown'|'result_incomplete',message:string){super(message);this.name='AttachmentPreparationError';}
}
const active=new WeakMap<TaskStep[],Map<string,Promise<string>>>();

/** The owning service must serialize/authorize the job claim. These private
 * checkpoints deduplicate material batches, never global documents or users.
 * The supplied call owns the original budget, Key checks and finite retries. */
export async function prepareDurableAttachmentContext(input:{
 files:Attachment[];scope:AttachmentPreparationScope;query:string;maxChars:number;coverage:AttachmentCoverageMode;
 config:AttachmentPreparationConfig;checkpoints:TaskStepStore;verify:()=>Promise<void>;
 summarize:(text:string,batch:AttachmentSummaryBatch)=>Promise<AttachmentPreparationResult>;
}){
 const {scope,checkpoints,config}=input;
 if(!validScope(scope)||checkpoints.namespace!==attachmentPreparationNamespace||checkpoints.scopeId!==scope.operationId||!Array.isArray(checkpoints.steps)||!config||typeof config.modelId!=='string'||!config.modelId||!Number.isSafeInteger(config.taskVersion)||config.taskVersion<0||!hash(config.promptDigest)||typeof input.query!=='string')throw new AttachmentPreparationError('binding_invalid','附件处理的原任务或模型配置无法核对，尚未重新处理。');
 await input.verify();
 const goalDigest=attachmentPreparationDigest(input.query),configDigest=attachmentPreparationDigest(config);
 const summarize=async(text:string,batch?:AttachmentSummaryBatch)=>{
  if(!batch)throw new AttachmentPreparationError('binding_invalid','附件分批来源未能确认，尚未重新处理。');
  const marker:Marker={version:1,scope:{...scope},sourceDigest:batch.sourceDigest,goalDigest,configDigest,inputDigest:attachmentPreparationDigest(text),batch:{kind:batch.kind,round:batch.round,index:batch.index}},key=checkpointKey(marker);
  let pending=active.get(checkpoints.steps);if(!pending){pending=new Map();active.set(checkpoints.steps,pending);}
  const existing=pending.get(key);if(existing)return existing;
  const call=(async()=>{
   await input.verify();
   const records=checkpoints.steps.filter(step=>step.key===key);
   if(records.length){
    const saved=records.length===1?completed(records[0]):undefined;
    if(!saved||encoded(saved.attachmentPreparation)!==encoded(marker))throw new AttachmentPreparationError('result_unknown','这一批资料上次的处理结果还没确认，先保留已完成部分；不会自动再买一次。');
    await input.verify();checkpoints.onReuse?.(records[0].output);return saved.result.content;
   }
   const step:TaskStep={key,namespace:attachmentPreparationNamespace,scopeId:scope.operationId,tool,label:batch.kind==='map'?`读取资料第 ${batch.index+1} 批`:`整理资料第 ${batch.round} 轮`,effect:'model',state:'started',updatedAt:new Date().toISOString(),operation:{version:1,execution:'unknown',verification:'not_required'},output:{attachmentPreparation:marker,outcome:'waiting'}};
   // Persist before the billable attempt. Unknown failures retain this hold;
   // a restart cannot silently turn it back into an unattempted call.
   await checkpoints.save(step);await input.verify();
   const returned=await input.summarize(text,batch);await input.verify();
   const value=typeof returned==='string'?{content:returned,finishReason:'stop' as const}:returned;
   if(!value||typeof value.content!=='string'||!value.content.trim()||value.content.length>200000||value.toolCalls?.length||value.finishReason!==undefined&&!['stop','unknown'].includes(value.finishReason))throw new AttachmentPreparationError('result_incomplete','这一批资料没有完整整理好，已完成的其他批次会保留。');
   const result={content:value.content,finishReason:(value.finishReason??'unknown') as 'stop'|'unknown'};
   const output:Saved={attachmentPreparation:marker,outcome:'completed',result,resultDigest:attachmentPreparationDigest(result)};
   try{await checkpoints.save({...step,state:'completed',updatedAt:new Date().toISOString(),operation:{version:1,execution:'succeeded',verification:'not_required',artifactRef:key},output});}
   catch(error){
    // Some owning stores update their local projection before awaiting disk.
    // That projection is not durable proof when the commit throws.
    const at=checkpoints.steps.findIndex(saved=>saved.key===key);if(at>=0)checkpoints.steps[at]=structuredClone(step);
    throw error;
   }
   await input.verify();
   return result.content;
  })();
  pending.set(key,call);try{return await call;}finally{if(pending.get(key)===call)pending.delete(key);}
 };
 const result=await prepareAttachmentContext(input.files,scope,input.query,input.maxChars,summarize,{coverage:input.coverage});
 await input.verify();return result;
}

/** Only the caller's already-authorized same-task restore.steps may enter.
 * Never discard an unknown/failed batch while rebinding completed material:
 * the caller must reconcile its original attempt first, not rebuy it here. */
export function rebindAttachmentPreparationSteps(steps:readonly TaskStep[],source:AttachmentPreparationScope,target:AttachmentPreparationScope):TaskStep[]|undefined{
 if(!validScope(source)||!validScope(target)||source.workspaceId!==target.workspaceId||source.userId!==target.userId||source.conversationId!==target.conversationId)return;
 const records=steps.filter(step=>step.namespace===attachmentPreparationNamespace||step.tool===tool),seen=new Set<string>(),result:TaskStep[]=[];
 for(const step of records){
  const saved=completed(step);if(!saved||encoded(saved.attachmentPreparation.scope)!==encoded(source)||seen.has(step.key))return;
  seen.add(step.key);const marker={...structuredClone(saved.attachmentPreparation),scope:{...target}},key=checkpointKey(marker);
  result.push({...structuredClone(step),key,scopeId:target.operationId,operation:{version:1,execution:'succeeded',verification:'not_required',artifactRef:key},output:{...structuredClone(saved),attachmentPreparation:marker}});
 }
 return result;
}
