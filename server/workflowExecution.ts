import type {WorkRun} from './coordinatorTypes.js';
import {parseTaskOutcome,type TaskOutcome} from './dispatchPlan.js';
import type {ModelToolMessage,ToolChatResult} from './modelGateway.js';
import type {OrchestrationTool} from './taskOrchestrator.js';
import {notionHash,legacyNotionNormalized} from './notionCanonical.js';
import {taskStepKey,type TaskStep,type TaskStepStore} from './taskSteps.js';
import {runTaskWorkflow,workflowProgress,workflowPhase,type WorkflowBinding,type WorkflowRun,type WorkflowStep,type WorkflowStepResult} from './taskWorkflow.js';
import {buildWorkflowStepContext,type WorkflowContextInput,type WorkflowHistoryMessage} from './workflowContext.js';

export type WorkflowExecutionInput={
 binding:WorkflowBinding;run:WorkflowRun;goal:string;modelSystemPrompt:string;
 modelPromptForStep?:(step:WorkflowStep)=>string;
 history:WorkflowHistoryMessage[];inputs:WorkflowContextInput[];
 /** Exact server-bound existing message, reauthorized by verify before a
  * write. Completeness means the message was read in full, not that an older
  * creative task was completed. Only the canonical save-only plan accepts it. */
 initialArtifact?:WorkflowContextInput;
 checkpoints:TaskStepStore;tools:OrchestrationTool[];featureTools:Record<string,string>;
 verify:()=>Promise<void>;persist:(next:WorkflowRun,expectedSequence:number)=>Promise<boolean>;
 callModel:(step:WorkflowStep,messages:ModelToolMessage[])=>Promise<ToolChatResult>;
 saveNotion:(step:WorkflowStep,body:string)=>Promise<unknown>;
 receipt:()=>Promise<WorkRun['notionReceipt']>;
};
export type WorkflowExecutionResult={run:WorkflowRun;content:string;summary:string;outcome:'completed'|'partial'|'needs_input'|'failed';waiting:boolean};
type StoredOutput={workflow:{version:1;runId:string;revision:number;stepId:string};outcome:'completed'|'partial'|'needs_input'|'failed'|'waiting';result?:unknown;notionCheckpointKey?:string;priorNotionCheckpointKey?:string;expectedBodyDigest?:string;sourceArtifact?:{id:string;ref:string;originOperationId:string;bodyDigest:string}};
type Classification={state:WorkflowStepResult['state'];outcome:StoredOutput['outcome'];summary:string;body?:string};
export class WorkflowExecutionError extends Error{constructor(){super('这一步的原结果或授权范围无法确认，先核对已有内容；不会重复执行。');this.name='WorkflowExecutionError';}}
const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** SQL JSON storage may reorder object keys. Evidence equality is exact by
 * field/value, not serialization order; missing or extra fields still fail. */
const sameEvidence=(value:unknown,expected:Record<string,string|number>|undefined)=>{
 if(expected===undefined)return value===undefined;
 const actual=object(value),keys=Object.keys(expected);
 return Boolean(actual&&Object.keys(actual).length===keys.length&&keys.every(key=>Object.hasOwn(actual,key)&&actual[key]===expected[key]));
};
function verifiedNotionCheckpoint(receipt:WorkRun['notionReceipt'],steps:TaskStep[],operationId:string,linkedKey?:string,expectedBodyDigest?:string){
 if(receipt?.state!=='verified'||receipt.verification||!receipt.checkpointKey||linkedKey&&linkedKey!==receipt.checkpointKey||!receipt.pageId||!receipt.digest||!receipt.expectedDigest||expectedBodyDigest&&expectedBodyDigest!==receipt.expectedDigest||receipt.final!==true)return undefined;
 const actual=steps.find(cp=>cp.key===receipt.checkpointKey&&cp.namespace==='worker'&&cp.scopeId===operationId&&cp.tool==='save_notion_draft'&&cp.effect==='external_write'&&cp.state==='completed'),value=object(actual?.output);
 return value?.state==='verified'&&value.pageId===receipt.pageId&&value.digest===receipt.digest&&value.expectedDigest===receipt.expectedDigest&&value.final===true?actual:undefined;
}
/** Read-only proof repair for the same saved attempt. This never executes a
 * workflow, starts its queued successors, or invents missing stage evidence. */
export function recoverVerifiedNotionWorkflow(job:Pick<WorkRun,'workflow'|'steps'|'notionReceipt'|'notionArticleSource'>,binding:WorkflowBinding):{workflow:WorkflowRun;steps:TaskStep[];complete:boolean;changed:boolean}|undefined{
 const workflow=job.workflow,receipt=job.notionReceipt,steps=job.steps;
 if(!workflow||!steps||!sameEvidence(workflow.binding,binding)||!verifiedNotionCheckpoint(receipt,steps,binding.operationId))return undefined;
 try{workflowProgress(workflow);}catch{return undefined;}
 const namespace=`workflow:${workflow.id}`;
 const key=(step:WorkflowStep)=>taskStepKey(namespace,`workflow:${workflow.id}:${step.id}`,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));
 const source=job.notionArticleSource;
 const expectedSource=source?{id:'existing_article',ref:source.messageId,originOperationId:source.operationId,bodyDigest:source.digest}:undefined;
 if(source&&(workflow.spec.steps.length!==1||workflow.spec.steps[0].id!=='save_existing'||workflow.spec.steps[0].kind!=='notion'||workflow.spec.steps[0].inputs.length!==0||!/^[a-f0-9]{64}$/i.test(source.digest)||source.digest!==receipt!.expectedRawDigest))return undefined;
 const checkpoint=(step:WorkflowStep)=>{
  const matches=steps.filter(cp=>cp.key===key(step)&&cp.namespace===namespace&&cp.scopeId===binding.operationId&&cp.tool===`workflow:${workflow.id}:${step.id}`);
  if(matches.length!==1)return undefined;
  const cp=matches[0],value=object(cp.output);
  if(!sameEvidence(value?.workflow,{version:1,runId:workflow.id,revision:workflow.revision,stepId:step.id})||!sameEvidence(value?.sourceArtifact,expectedSource))return undefined;
  return {cp,value:value as unknown as StoredOutput};
 };
 const completedCheckpoint=(step:WorkflowStep,saved:ReturnType<typeof checkpoint>)=>{const result=object(saved?.value.result);return Boolean(saved?.cp.state==='completed'&&saved.value.outcome==='completed'&&classify(step,saved.value.result).state==='completed'&&!['length','filtered'].includes(String(result?.finishReason??''))&&(step.kind!=='model'||saved.cp.effect==='model'&&result?.outcome==='completed'&&typeof result.content==='string'&&result.content.trim())&&(step.kind!=='tool'||saved.cp.effect==='read')&&(step.kind!=='notion'||saved.cp.effect==='external_write'));};
 const proven=(step:WorkflowStep,index:number)=>workflow.steps[index].state==='completed'&&workflow.steps[index].checkpointKey===key(step)&&completedCheckpoint(step,checkpoint(step));
 const candidates=workflow.spec.steps.flatMap((step,index)=>{
  if(step.kind!=='notion'||step.inputs.some(id=>{const at=workflow.spec.steps.findIndex(item=>item.id===id);return at<0||!proven(workflow.spec.steps[at],at);}))return [];
  const saved=checkpoint(step);if(!saved||saved.cp.effect!=='external_write')return [];
  // Older exhausted save_existing checkpoints lost the normalized body hash.
  // Their exact server-bound RAW source hash plus exact write link still prove
  // this one original body; no title lookup or guessed content is involved.
  const canonicalSource=workflow.spec.steps.length===1&&step.id==='save_existing'&&step.inputs.length===0&&source&&/^[a-f0-9]{64}$/i.test(source.digest)&&source.digest===receipt!.expectedRawDigest;
  const uniqueWorkerProof=steps.filter(cp=>cp.namespace==='worker'&&cp.scopeId===binding.operationId&&cp.tool==='save_notion_draft'&&cp.effect==='external_write'&&cp.state==='completed'&&object(cp.output)?.state==='verified').length===1;
  if(saved.value.notionCheckpointKey!==receipt!.checkpointKey&&!(saved.value.notionCheckpointKey===undefined&&canonicalSource&&uniqueWorkerProof))return [];
  if(saved.value.expectedBodyDigest!==receipt!.expectedDigest&&!(saved.value.expectedBodyDigest===undefined&&canonicalSource))return [];
  return [{step,index,...saved}];
 });
 if(candidates.length!==1)return undefined;
 const {step,index,cp,value}=candidates[0],next=structuredClone(workflow),updatedSteps=structuredClone(steps);
 const changed=next.steps[index].state!=='completed'||next.steps[index].checkpointKey!==key(step)||cp.state!=='completed'||value.outcome!=='completed';
 if(changed){
  const restored=updatedSteps.find(saved=>saved.key===cp.key&&saved.namespace===cp.namespace&&saved.scopeId===cp.scopeId)!;
  restored.state='completed';restored.output={...value,outcome:'completed',result:{state:'verified',pageId:receipt!.pageId,url:receipt!.url},notionCheckpointKey:receipt!.checkpointKey,expectedBodyDigest:receipt!.expectedDigest};
  next.steps[index]={id:step.id,state:'completed',checkpointKey:key(step),summary:'文章已保存到 Notion，正文也已回读核对。'};next.sequence++;next.phase=workflowPhase(next.spec,next.steps);
 }
 try{workflowProgress(next);}catch{return undefined;}
 const complete=next.phase==='completed'&&next.spec.steps.every((item,at)=>{const saved=updatedSteps.find(saved=>saved.key===key(item)&&saved.namespace===namespace&&saved.scopeId===binding.operationId&&saved.tool===`workflow:${workflow.id}:${item.id}`),value=object(saved?.output);return next.steps[at].state==='completed'&&next.steps[at].checkpointKey===key(item)&&saved&&value&&completedCheckpoint(item,{cp:saved,value:value as unknown as StoredOutput})&&sameEvidence(value.workflow,{version:1,runId:workflow.id,revision:workflow.revision,stepId:item.id})&&sameEvidence(value.sourceArtifact,expectedSource);});
 return {workflow:next,steps:updatedSteps,complete,changed};
}
const unsafePrompt=/(?:\b(?:Bearer|authorization|api[_ -]?key|password|secret|credentials?|HTTP|JSON|ECONN\w*|ETIMEDOUT|stack|traceback)\b|[{}<>])/i;
const safeQuestion=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()&&value.length<=2000&&!unsafePrompt.test(value)?value.trim():fallback;
const bodyOf=(value:unknown):string=>{
 if(typeof value==='string')return parseTaskOutcome(value).content;
 const v=object(value);return typeof v?.content==='string'?parseTaskOutcome(v.content).content:'';
};
function parsed(value:unknown):TaskOutcome|undefined{
 const v=object(value);if(v&&['completed','partial','needs_input','failed'].includes(String(v.outcome))&&typeof v.content==='string'&&typeof v.summary==='string')return parseTaskOutcome(JSON.stringify(v));
 const content=typeof value==='string'?value:typeof v?.content==='string'?v.content:undefined;return content?.trim()?parseTaskOutcome(content):undefined;
}
function classify(step:WorkflowStep,value:unknown):Classification{
 const v=object(value),answer=parsed(value),status=String(v?.status??v?.state??'');
 if(answer?.outcome==='needs_input'||status==='needs_input'){
  const question=safeQuestion(answer?.content??v?.message,'还缺完成这一步需要的资料，请补充后接着处理。');
  return {state:'needs_input',outcome:'needs_input',summary:question.length<=240?question:'还缺完成这一步需要的资料，请补充后接着处理。'};
 }
 if(['pending','uncertain'].includes(status))return {state:'waiting',outcome:'waiting',summary:'这一步的原结果还在核对，不会重复执行。'};
 if(status==='no_match'||step.kind==='tool'&&step.tool==='knowledge_search'&&(!Array.isArray(v?.chunks)||!v.chunks.some(chunk=>typeof object(chunk)?.content==='string'&&String(object(chunk)!.content).trim()))||step.kind==='tool'&&step.tool==='web_search'&&!(Array.isArray(value)?value.length:Array.isArray(v?.sources)&&v.sources.length))return {state:'needs_input',outcome:'needs_input',summary:'这次没有找到可用的相关资料，请补充线索或素材。'};
 if(status==='partial'&&step.kind==='tool'&&['knowledge_search','web_search'].includes(step.tool!))return {state:'completed',outcome:'completed',summary:'已取得部分可用参考资料，仍有来源没有查完。'};
 if(['failed','rejected','not_connected','unavailable','not_configured','partial','truncated'].includes(status)||['failed','partial'].includes(answer?.outcome??''))return {state:'failed',outcome:answer?.outcome==='partial'||status==='partial'?'partial':'failed',summary:'这一步还没完整做成，已有内容会保留。',body:answer?.content};
 if(step.kind==='tool'&&step.tool==='read_notion_document'&&(v?.complete!==true||!bodyOf(value).trim()))return {state:'failed',outcome:'failed',summary:'原文还没完整读到，不能当作已经核对。'};
 const artifact=v&&(typeof v.attachmentId==='string'||object(v.file)||Array.isArray(v.files)&&v.files.length||Array.isArray(v.artifacts)&&v.artifacts.length||typeof v.imageUrl==='string');
 if((step.kind==='model'||step.kind==='feature')&&!answer?.content.trim()&&!artifact)return {state:'failed',outcome:'failed',summary:'这一步还没有返回可直接使用的成果。'};
 return {state:'completed',outcome:'completed',summary:step.kind==='tool'?'已取得这一步的实际参考资料。':'这一步已有可用成果。',body:answer?.content};
}

/** The workflow runner owns sequencing. These adapters make one selected
 * operation, not another model/tool orchestration loop. Caller handlers retain
 * authorization, provider access, billing and Notion replacement ownership. */
export async function executeWorkflowStages(input:WorkflowExecutionInput):Promise<WorkflowExecutionResult>{
 const {binding,checkpoints}=input;
 const initialArtifact=input.initialArtifact?structuredClone(input.initialArtifact):undefined;
 if(initialArtifact&&(
  initialArtifact.workspaceId!==binding.workspaceId||initialArtifact.userId!==binding.userId||initialArtifact.operationId!==binding.operationId||initialArtifact.kind!=='artifact'||initialArtifact.complete!==true||initialArtifact.truncated===true||typeof initialArtifact.content!=='string'||!initialArtifact.content.trim()||typeof initialArtifact.id!=='string'||!initialArtifact.id.trim()||typeof initialArtifact.ref!=='string'||!initialArtifact.ref.trim()||typeof initialArtifact.originOperationId!=='string'||!initialArtifact.originOperationId.trim()
  ||input.run.spec.steps.length!==1||input.run.spec.steps[0].id!=='save_existing'||input.run.spec.steps[0].kind!=='notion'||input.run.spec.steps[0].inputs.length!==0
 ))throw new WorkflowExecutionError();
 const sourceArtifact=initialArtifact?{id:initialArtifact.id,ref:initialArtifact.ref!,originOperationId:initialArtifact.originOperationId!,bodyDigest:notionHash(initialArtifact.content)}:undefined;
 const marker=(step:WorkflowStep)=>({version:1 as const,runId:input.run.id,revision:input.run.revision,stepId:step.id});
 const name=(step:WorkflowStep)=>`workflow:${input.run.id}:${step.id}`;
 const key=(step:WorkflowStep)=>taskStepKey(checkpoints.namespace,name(step),JSON.stringify({revision:input.run.revision,instruction:step.instruction,inputs:step.inputs}));
 const stored=(step:WorkflowStep)=>{
  const found=checkpoints.steps.find(cp=>cp.key===key(step));
  if(found&&(found.namespace!==checkpoints.namespace||found.scopeId!==binding.operationId||found.tool!==name(step)))throw new WorkflowExecutionError();
  if(found?.output){const v=object(found.output);if(!sameEvidence(v?.workflow,marker(step))||!sameEvidence(v?.sourceArtifact,sourceArtifact))throw new WorkflowExecutionError();}
  return found;
 };
 const output=(checkpoint:TaskStep):StoredOutput=>{
  const value=object(checkpoint.output),meta=object(value?.workflow);
  if(!value||!meta||meta.runId!==input.run.id||meta.revision!==input.run.revision||!['completed','partial','needs_input','failed','waiting'].includes(String(value.outcome)))throw new WorkflowExecutionError();
  return value as unknown as StoredOutput;
 };
 const proof=(checkpointKey:string)=>{
  const cp=checkpoints.steps.find(cp=>cp.key===checkpointKey);
  if(!cp||cp.namespace!==checkpoints.namespace||cp.scopeId!==binding.operationId||cp.state!=='completed'||output(cp).outcome!=='completed')throw new WorkflowExecutionError();
  return cp;
 };
 const checkpointInputs=(ref:string):WorkflowContextInput[]=>{
  const cp=proof(ref),result=output(cp).result,v=object(result),source=input.run.spec.steps.find(step=>step.id===output(cp).workflow.stepId);
  if(source?.kind==='tool'&&source.tool==='knowledge_search'&&Array.isArray(v?.chunks)){
   const chunks:WorkflowContextInput[]=v.chunks.flatMap((raw,index)=>{
    const chunk=object(raw);if(typeof chunk?.content!=='string')return [];
    const date=object(chunk.dateEvidence),metadata:Partial<WorkflowContextInput>={};
    for(const field of ['title','sourceUrl','createdAt','updatedAt'] as const)if(typeof chunk[field]==='string')metadata[field]=chunk[field];
    if(typeof chunk.provider==='string')metadata.source=chunk.provider;
    if(date&&['basis','date','status'].every(field=>typeof date[field]==='string'))metadata.dateEvidence={basis:String(date.basis),date:String(date.date),status:String(date.status)};
    return [{...binding,id:`checkpoint_${cp.key}_${index}`,kind:'knowledge' as const,content:chunk.content,ref:typeof chunk.id==='string'?chunk.id:`${cp.key}:${index}`,complete:false,truncated:chunk.truncated===true,...metadata}];
   });
   return [...chunks,{...binding,id:`checkpoint_${cp.key}_coverage`,kind:'tool_result',content:JSON.stringify({status:v.status,coverage:v.coverage,failures:v.failures,temporal:v.temporal}),ref:cp.key,complete:false}];
  }
  return [{...binding,id:`checkpoint_${cp.key}`,kind:'tool_result',content:typeof result==='string'?result:JSON.stringify(result??null),ref:cp.key,complete:v?.status!=='partial'&&v?.complete!==false&&output(cp).outcome==='completed'}];
 };
 const context=(step:WorkflowStep,refs:readonly string[])=>buildWorkflowStepContext({scope:binding,modelSystemPrompt:input.modelPromptForStep?.(step)??input.modelSystemPrompt,goal:input.goal,constraints:[],step:{id:step.id,kind:step.kind,instruction:step.instruction,historyMessageIds:(step.historyCount?input.history.slice(-step.historyCount):[]).map(message=>message.id)},deferredSteps:input.run.spec.steps.slice(input.run.spec.steps.findIndex(candidate=>candidate.id===step.id)+1).map(({id,title,kind})=>({id,title,kind})),history:input.history,inputs:[...input.inputs,...refs.flatMap(checkpointInputs)],tools:[]});
 // Validate all caller-wrapped references, including unselected history, before
 // the first billable or external call. A wrong scope never degrades to empty.
 context(input.run.spec.steps[0],[]);
 if(new Set(input.tools.map(tool=>tool.name)).size!==input.tools.length)throw new WorkflowExecutionError();
 const verify=async()=>{
  await input.verify();
  for(const state of input.run.steps)if(state.state==='completed'){
   const step=input.run.spec.steps.find(step=>step.id===state.id);if(!step||state.checkpointKey!==key(step))throw new WorkflowExecutionError();proof(state.checkpointKey);
  }
 };
 const save=async(step:WorkflowStep,state:TaskStep['state'],value:StoredOutput)=>{
  await input.verify();const previous=stored(step);
  const tool=step.kind==='feature'?input.tools.find(tool=>tool.name===input.featureTools[step.featureId!]):undefined;
  const checkpoint:TaskStep={key:key(step),namespace:checkpoints.namespace,tool:name(step),label:step.title,effect:step.kind==='notion'?'external_write':step.kind==='model'?'model':tool?.effect??'read',state,scopeId:binding.operationId,updatedAt:previous?.updatedAt??new Date().toISOString(),output:{...value,...(sourceArtifact?{sourceArtifact}: {})}};
  await checkpoints.save(checkpoint);
 };
 const result=(step:WorkflowStep,value:Classification):WorkflowStepResult=>value.state==='completed'?{state:'completed',checkpointKey:key(step),summary:value.summary}:{state:value.state as 'failed'|'needs_input'|'waiting',summary:value.summary};
 const saveResult=async(step:WorkflowStep,value:unknown,classification:Classification,extra:Partial<StoredOutput>={})=>{
  await save(step,classification.state==='completed'?'completed':classification.state==='waiting'?'started':'failed',{workflow:marker(step),outcome:classification.outcome,result:value,...extra});return result(step,classification);
 };
 const notionProof=(receipt:WorkRun['notionReceipt'],linkedKey?:string,expectedBodyDigest?:string)=>{
  return verifiedNotionCheckpoint(receipt,checkpoints.steps,binding.operationId,linkedKey,expectedBodyDigest);
 };
 const recover=async(step:WorkflowStep):Promise<WorkflowStepResult|undefined>=>{
  await verify();const cp=stored(step);if(!cp)return undefined;
  const value=output(cp);
  if(step.kind==='notion'){
   const receipt=await input.receipt();await verify();
   const linked=value.notionCheckpointKey;
   // A crash before binding the returned receipt can recover a newly-started
   // exact save, but never an older verified save from this operation.
   const actual=value.expectedBodyDigest?notionProof(receipt,linked,value.expectedBodyDigest):undefined;
   if(actual&&(linked||receipt!.checkpointKey!==value.priorNotionCheckpointKey&&Date.parse(actual.updatedAt)>=Date.parse(cp.updatedAt))){
    return saveResult(step,{state:'verified',pageId:receipt!.pageId,url:receipt!.url}, {state:'completed',outcome:'completed',summary:'文章已保存到 Notion，正文也已回读核对。'},{notionCheckpointKey:receipt!.checkpointKey,expectedBodyDigest:value.expectedBodyDigest});
   }
   if(receipt?.verification?.state==='exhausted')return saveResult(step,undefined,{state:'failed',outcome:'failed',summary:'Notion 保存还没核对成功，请先查看原页面，再决定下一步。'},{notionCheckpointKey:linked,expectedBodyDigest:value.expectedBodyDigest,...(value.priorNotionCheckpointKey?{priorNotionCheckpointKey:value.priorNotionCheckpointKey}:{})});
   return undefined;
  }
  if(cp.state==='completed'&&value.outcome==='completed')return result(step,{state:'completed',outcome:'completed',summary:'已找回这一步的实际成果。'});
  if(cp.state==='failed')return result(step,classify(step,value.result));
  return undefined;
 };
 const execute=async(step:WorkflowStep,refs:readonly string[]):Promise<WorkflowStepResult>=>{
  await verify();const existing=stored(step);if(existing)return await recover(step)??{state:'waiting',summary:'正在核对这一步的原结果，不会重复执行。'};
  const selected=context(step,refs),priorReceipt=step.kind==='notion'?await input.receipt():undefined;
  await save(step,'started',{workflow:marker(step),outcome:'waiting',...(priorReceipt?.checkpointKey?{priorNotionCheckpointKey:priorReceipt.checkpointKey}:{})});
  let value:unknown;
  if(step.kind==='model'){
   const called=await input.callModel(structuredClone(step),selected.messages);await verify();
   const answer=parseTaskOutcome(called.content),invalid=called.toolCalls.length>0||called.finishReason==='filtered'||!called.content.trim();
   value={...answer,...(called.finishReason?{finishReason:called.finishReason}:{})};
   const classification=invalid?{state:'failed' as const,outcome:'failed' as const,summary:'这一步没有返回可直接使用的正文。'}:called.finishReason==='length'?{state:'failed' as const,outcome:'partial' as const,summary:'正文还没有完整返回，已返回的内容会保留。'}:classify(step,value);
   return saveResult(step,value,classification);
  }
  if(step.kind==='notion'){
   const source=[...input.run.spec.steps].reverse().find(source=>step.inputs.includes(source.id)&&['model','feature'].includes(source.kind)&&refs.some(ref=>ref===key(source)));
   const sourceValue=source?output(proof(key(source))):undefined,body=initialArtifact?.content??(sourceValue?bodyOf(sourceValue.result):'');
   if(!body.trim())return saveResult(step,undefined,{state:'needs_input',outcome:'needs_input',summary:'还没有可以保存的完整正文，先补齐内容再保存。'});
   const expectedBodyDigest=notionHash(legacyNotionNormalized(body));
   await save(step,'started',{workflow:marker(step),outcome:'waiting',expectedBodyDigest,...(priorReceipt?.checkpointKey?{priorNotionCheckpointKey:priorReceipt.checkpointKey}:{})});
   value=await input.saveNotion(structuredClone(step),body);await verify();const receipt=await input.receipt();await verify();
   const returned=classify(step,value),v=object(value),knownNotSent=!receipt||['not_sent','rejected'].includes(receipt.delivery??'');
   const actual=notionProof(receipt,undefined,expectedBodyDigest),classification:Classification=actual?{state:'completed',outcome:'completed',summary:'文章已保存到 Notion，正文也已回读核对。'}:knownNotSent&&(returned.state==='needs_input'||v?.saved===false||['failed','rejected','unavailable','not_configured'].includes(String(v?.status??v?.state??'')))?returned.state==='needs_input'?returned:{state:'failed',outcome:'failed',summary:'这次没有保存到 Notion，已有正文仍保留。'}:receipt&&['not_sent','rejected'].includes(receipt.delivery??'')?{state:'failed',outcome:'failed',summary:'这次没有保存到 Notion，已有正文仍保留。'}:{state:'waiting',outcome:'waiting',summary:'正在核对 Notion 的实际保存结果，不会重复写入。'};
   return saveResult(step,value,classification,{expectedBodyDigest,...(receipt?.checkpointKey?{notionCheckpointKey:receipt.checkpointKey}:{}),...(priorReceipt?.checkpointKey?{priorNotionCheckpointKey:priorReceipt.checkpointKey}:{})});
  }
  const tool=input.tools.find(tool=>tool.name===(step.kind==='feature'?input.featureTools[step.featureId!]:step.tool));
  if(!tool)return saveResult(step,undefined,{state:'failed',outcome:'failed',summary:'这一步需要的能力暂时没有就位，其他独立内容可以继续。'});
  if(step.kind==='feature')value=await tool.run(selected.messages.filter(message=>message.role==='user').map(message=>message.content??'').join('\n\n'));
  else if(step.tool==='read_notion_document'){
   if(!tool.structured)return saveResult(step,undefined,{state:'failed',outcome:'failed',summary:'原文读取还没有接好，不能当作已经核对。'});
   value=await tool.structured.run(tool.structured.validate({}));
  }else value=await tool.run(step.instruction);
  await verify();return saveResult(step,value,classify(step,value));
 };
 const run=await runTaskWorkflow({binding,run:input.run,persist:input.persist,verify,execute,recover});
 const candidates=run.spec.steps.flatMap(step=>{
  const cp=stored(step);if(!cp)return [];const value=output(cp),answer=parsed(value.result);
  return ['completed','partial'].includes(value.outcome)&&answer?.content.trim()&&answer.outcome!=='needs_input'&&answer.outcome!=='failed'?[answer.content]:[];
 });
 const requests=run.spec.steps.flatMap(step=>{const cp=stored(step);if(!cp)return [];const value=output(cp),answer=parsed(value.result),v=object(value.result);return value.outcome==='needs_input'?[safeQuestion(answer?.content??v?.message,run.steps.find(state=>state.id===step.id)?.summary??'还缺完成这一步需要的资料，请补充后接着处理。')]:[];});
 let content=candidates.at(-1)??'',wholeTaskSummary:string|undefined;
 const completedFeatures=run.spec.steps.filter((step,index)=>step.kind==='feature'&&run.steps[index].state==='completed');
 if(run.phase==='completed'&&completedFeatures.length>1){
  // A feature speaks only for its own stage (e.g. "I only made the diagram").
  // Never present the last child's scope disclaimer as the whole task result.
  // Compose the overview from durable step facts without buying another model
  // call; real files are attached by the owning task, not invented here.
  const primary=run.spec.steps.filter((step,index)=>step.kind==='model'&&run.steps[index].state==='completed').flatMap(step=>{const cp=stored(step);const answer=cp?parsed(output(cp).result):undefined;return answer?.content.trim()?[answer.content]:[];}).at(-1);
  const prose=completedFeatures.flatMap(step=>{const cp=stored(step),value=cp?output(cp).result:undefined,v=object(value),hasFile=v&&(v.file||v.attachmentId||v.imageUrl||Array.isArray(v.files)&&v.files.length||Array.isArray(v.artifacts)&&v.artifacts.length);const answer=parsed(value);return !hasFile&&answer?.content.trim()?[answer.content]:[];}).at(-1);
  wholeTaskSummary=`已完成：${workflowProgress(run).steps.filter((_,index)=>run.spec.steps[index].required!==false).map(step=>step.title).join('、')}。`;
  content=wholeTaskSummary;
  if(primary??prose)content+='\n\n'+(primary??prose);
 }
 const question=requests.at(-1);
 if(question)content=content&&content!==question?`${content}\n\n还需要你补充：\n${question}`:question;
 const receipt=await input.receipt();await input.verify();
 const verifiedNotion=run.spec.steps.some((step,index)=>{if(step.kind!=='notion'||run.steps[index].state!=='completed')return false;const value=output(proof(key(step)));return notionProof(receipt,value.notionCheckpointKey,value.expectedBodyDigest);});
 if(verifiedNotion&&receipt?.pageId&&/^[a-f0-9]{32}$/i.test(receipt.pageId.replaceAll('-','')))content+=(content?'\n\n':'')+`[已保存到 Notion · 已回读核对](https://www.notion.so/${receipt.pageId.replaceAll('-','')})`;
 const progress=workflowProgress(run),waiting=run.steps.some(step=>step.state==='running'||step.state==='waiting'&&step.waitingFor==='result');
 const outcome=run.phase==='completed'?'completed':run.phase==='needs_input'?'needs_input':run.phase==='failed'&&!content?'failed':'partial';
 return {run,content:content||progress.summary,summary:run.phase==='needs_input'?run.steps.filter(step=>step.state==='needs_input').at(-1)?.summary??progress.summary:wholeTaskSummary??progress.summary,outcome,waiting};
}
