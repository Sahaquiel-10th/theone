import {createHash} from 'node:crypto';

export type WorkflowTool='knowledge_search'|'web_search'|'read_notion_document';
export type WorkflowStep={id:string;title:string;kind:'model'|'feature'|'tool'|'notion';instruction:string;inputs:string[];required?:boolean;featureId?:string;executorId?:string;tool?:WorkflowTool;historyCount?:number};
export type WorkflowSpec={version:1;steps:WorkflowStep[]};
export type WorkflowBinding={workspaceId:string;userId:string;operationId:string};
export type WorkflowStepStatus='queued'|'running'|'completed'|'waiting'|'needs_input'|'failed'|'skipped';
export type WorkflowPhase='queued'|'running'|'completed'|'waiting'|'needs_input'|'failed'|'partial';
export type WorkflowStepState={id:string;state:WorkflowStepStatus;checkpointKey?:string;summary?:string;waitingFor?:'inputs'|'result'};
export type WorkflowRun={version:1;id:string;revision:number;binding:WorkflowBinding;spec:WorkflowSpec;steps:WorkflowStepState[];sequence:number;phase:WorkflowPhase};
export type WorkflowStepResult={state:'completed';checkpointKey:string;summary?:string}|{state:'waiting'|'needs_input'|'failed'|'skipped';summary?:string};
export type WorkflowProgress={status:WorkflowPhase;steps:{title:string;status:WorkflowStepStatus;summary:string}[];next:string;summary:string};
export type WorkflowRunner={
 binding:WorkflowBinding;run:WorkflowRun;
 /** The owning operation must atomically compare binding/revision/sequence.
  * false means another event or cancellation won; never execute after it. */
 persist:(next:WorkflowRun,expectedSequence:number)=>Promise<boolean>;
 /** Fresh owner authorization/cancellation check, not a model judgment. */
 verify:()=>Promise<void>;
 /** The owner validates a real, scoped checkpoint before returning completed.
  * Bodies remain in their existing checkpoint/artifact store, never here. */
 execute:(step:WorkflowStep,inputCheckpointKeys:readonly string[])=>Promise<WorkflowStepResult>;
 /** Read-only recovery of the SAME attempt. Undefined retains the unknown
  * state. It is never permission to issue the execution again. */
 recover?:(step:WorkflowStep,state:WorkflowStepState)=>Promise<WorkflowStepResult|undefined>;
};
export class TaskWorkflowError extends Error{
 constructor(readonly code:'WORKFLOW_INVALID'|'WORKFLOW_BINDING_INVALID'|'WORKFLOW_CHANGED'|'WORKFLOW_VERIFY_FAILED'|'WORKFLOW_PERSIST_FAILED',message:string){super(message);this.name='TaskWorkflowError';}
}
const tools:WorkflowTool[]=['knowledge_search','web_search','read_notion_document'];
const statuses:WorkflowStepStatus[]=['queued','running','completed','waiting','needs_input','failed','skipped'];
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/;
const checkpointPattern=/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,239}$/;
const invalid=()=>new TaskWorkflowError('WORKFLOW_INVALID','任务步骤格式无效，请先整理清楚要完成的内容。');
function record(value:unknown,keys:readonly string[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();
 return value as Record<string,unknown>;
}
function text(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max)throw invalid();return value.trim();}
function identifier(value:unknown){const id=text(value,100);if(!idPattern.test(id))throw invalid();return id;}

/** Untrusted main-dispatch function arguments contain no owner IDs, run IDs,
 * revisions, credentials, raw tool parameters or executable code fields. */
export const workflowSpecSchema={type:'object',additionalProperties:false,properties:{version:{type:'integer',enum:[1]},steps:{type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,properties:{id:{type:'string',minLength:1,maxLength:100},title:{type:'string',minLength:1,maxLength:80},kind:{type:'string',enum:['model','feature','tool','notion']},instruction:{type:'string',minLength:1,maxLength:4000},inputs:{type:'array',maxItems:11,uniqueItems:true,items:{type:'string',minLength:1,maxLength:100},description:'仅引用本列表中已经列出的步骤编号；后一步只读取这些步骤的真实成果。'},required:{type:'boolean',default:true},featureId:{type:'string',minLength:1,maxLength:100,description:'仅 feature 步骤填写已发现且获准使用的功能编号。'},executorId:{type:'string',minLength:1,maxLength:100,description:'仅 model 步骤可指定执行器；留空由服务端选择。'},tool:{type:'string',enum:tools,description:'仅 tool 步骤填写。'},historyCount:{type:'integer',minimum:0,maximum:20,default:0}},required:['id','title','kind','instruction','inputs']}}},required:['version','steps']};

export function validateWorkflowSpec(raw:unknown):WorkflowSpec{
 const value=record(raw,['version','steps']);
 if(value.version!==1||!Array.isArray(value.steps)||value.steps.length<1||value.steps.length>12)throw invalid();
 const prior=new Set<string>();
 const steps=value.steps.map(raw=>{
  const v=record(raw,['id','title','kind','instruction','inputs','required','featureId','executorId','tool','historyCount']);
  const id=identifier(v.id),title=text(v.title,80),instruction=text(v.instruction,4000);
  if(prior.has(id)||typeof v.kind!=='string'||!['model','feature','tool','notion'].includes(v.kind)||!Array.isArray(v.inputs)||v.inputs.length>11||v.inputs.some(input=>typeof input!=='string'||!prior.has(input))||new Set(v.inputs).size!==v.inputs.length)throw invalid();
  if(v.required!==undefined&&typeof v.required!=='boolean'||v.historyCount!==undefined&&(!Number.isInteger(v.historyCount)||Number(v.historyCount)<0||Number(v.historyCount)>20))throw invalid();
  const kind=v.kind as WorkflowStep['kind'];
  if(v.featureId!==undefined&&kind!=='feature'||v.executorId!==undefined&&kind!=='model'||v.tool!==undefined&&kind!=='tool')throw invalid();
  if(kind==='feature'&&v.featureId===undefined||kind==='tool'&&!tools.includes(v.tool as WorkflowTool))throw invalid();
  const step:WorkflowStep={id,title,kind,instruction,inputs:[...v.inputs] as string[],required:v.required===undefined?true:v.required,historyCount:v.historyCount===undefined?0:Number(v.historyCount)};
  if(kind==='feature')step.featureId=identifier(v.featureId);
  if(kind==='model'&&v.executorId!==undefined)step.executorId=identifier(v.executorId);
  if(kind==='tool')step.tool=v.tool as WorkflowTool;
  prior.add(id);return step;
 });
 return {version:1,steps};
}
function binding(raw:unknown):WorkflowBinding{
 try{const v=record(raw,['workspaceId','userId','operationId']);return {workspaceId:identifier(v.workspaceId),userId:identifier(v.userId),operationId:identifier(v.operationId)};}
 catch{throw new TaskWorkflowError('WORKFLOW_BINDING_INVALID','任务所属空间或原要求无法确认，尚未执行。');}
}
function runId(owner:WorkflowBinding,revision:number){return `wfl_${createHash('sha256').update(JSON.stringify([owner.workspaceId,owner.userId,owner.operationId,revision])).digest('hex').slice(0,40)}`;}
export function createWorkflowRun(spec:WorkflowSpec,owner:WorkflowBinding,revision=1):WorkflowRun{
 const resolved=binding(owner),validated=validateWorkflowSpec(spec);
 if(!Number.isSafeInteger(revision)||revision<1)throw invalid();
 return {version:1,id:runId(resolved,revision),revision,binding:resolved,spec:validated,steps:validated.steps.map(step=>({id:step.id,state:'queued'})),sequence:0,phase:'queued'};
}
export function workflowPhase(spec:WorkflowSpec,steps:WorkflowStepState[]):WorkflowPhase{
 const required=steps.filter((_,index)=>spec.steps[index].required!==false);
 if(steps.some(step=>step.state==='running'))return 'running';
 if(required.some(step=>step.state==='failed'))return 'failed';
 if(required.some(step=>step.state==='needs_input'))return 'needs_input';
 if(steps.some(step=>step.state==='waiting'))return 'waiting';
 if(steps.some(step=>step.state==='queued'))return 'queued';
 return steps.every(step=>step.state==='completed')?'completed':'partial';
}
function assertRun(raw:WorkflowRun,owner:WorkflowBinding):WorkflowRun{
 const run=record(raw,['version','id','revision','binding','spec','steps','sequence','phase']),bound=binding(run.binding),expected=binding(owner);
 if(JSON.stringify(bound)!==JSON.stringify(expected)||!Number.isSafeInteger(run.revision)||Number(run.revision)<1||run.id!==runId(expected,Number(run.revision)))throw new TaskWorkflowError('WORKFLOW_BINDING_INVALID','任务所属空间或原要求已经变化，尚未执行。');
 const spec=validateWorkflowSpec(run.spec);
 if(run.version!==1||!Number.isSafeInteger(run.sequence)||Number(run.sequence)<0||!Array.isArray(run.steps)||run.steps.length!==spec.steps.length)throw invalid();
 const steps=run.steps.map((raw,index)=>{
  const v=record(raw,['id','state','checkpointKey','summary','waitingFor']);
  if(v.id!==spec.steps[index].id||!statuses.includes(v.state as WorkflowStepStatus)||v.checkpointKey!==undefined&&(typeof v.checkpointKey!=='string'||!checkpointPattern.test(v.checkpointKey))||v.summary!==undefined&&(typeof v.summary!=='string'||v.summary.length>240)||v.waitingFor!==undefined&&!['inputs','result'].includes(String(v.waitingFor)))throw invalid();
  if(v.state==='completed'&&!v.checkpointKey||v.state==='skipped'&&spec.steps[index].required!==false||v.waitingFor!==undefined&&v.state!=='waiting')throw invalid();
  return structuredClone(v) as WorkflowStepState;
 });
 if(run.phase!==workflowPhase(spec,steps)||steps.some((step,index)=>step.state==='completed'&&spec.steps[index].inputs.some(id=>steps.find(input=>input.id===id)?.state!=='completed')))throw invalid();
 return {version:1,id:String(run.id),revision:Number(run.revision),binding:bound,spec,steps,sequence:Number(run.sequence),phase:run.phase as WorkflowPhase};
}
const unsafeText=/(?:\b(?:Bearer|authorization|api[_ -]?key|password|secret|credentials?|MCP|HTTP|JSON|ECONN\w*|ETIMEDOUT|stack|traceback)\b|https?:\/\/|feature_\d+|knowledge_search|web_search|read_notion_document|[{}<>])/i;
function safeSummary(raw:unknown,fallback:string){return typeof raw==='string'&&raw.trim()&&raw.length<=240&&!unsafeText.test(raw)?raw.replace(/[\u0000-\u001f]/g,' ').trim():fallback;}
function result(raw:unknown,step:WorkflowStep):WorkflowStepResult{
 const v=record(raw,['state','checkpointKey','summary']);
 if(typeof v.state!=='string'||!['completed','waiting','needs_input','failed','skipped'].includes(v.state)||v.summary!==undefined&&typeof v.summary!=='string'||v.state==='skipped'&&step.required!==false)throw invalid();
 const summary=safeSummary(v.summary,v.state==='completed'?'这一步已取得可用成果。':v.state==='needs_input'?'还缺一些必要资料。':v.state==='waiting'?'正在核对这一步的原结果。':v.state==='skipped'?'这项可选内容暂不处理。':'这一步尚未完成，已有内容会保留。');
 if(v.state==='completed'){
  if(typeof v.checkpointKey!=='string'||!checkpointPattern.test(v.checkpointKey))throw invalid();
  return {state:'completed',checkpointKey:v.checkpointKey,summary};
 }
 if(v.checkpointKey!==undefined)throw invalid();
 return {state:v.state as 'waiting'|'needs_input'|'failed'|'skipped',summary};
}

/** Bounded, sequential and event-driven. No timers, model calls or automatic
 * retries live here. A persisted running step is unknown until its owning
 * checkpoint is recovered; completed steps can never execute again. */
export async function runTaskWorkflow(input:WorkflowRunner):Promise<WorkflowRun>{
 let current=assertRun(input.run,input.binding);
 const verify=async()=>{try{await input.verify();}catch{throw new TaskWorkflowError('WORKFLOW_VERIFY_FAILED','任务状态或授权已经变化，先核对后再继续。');}};
 const commit=async(index:number,next:WorkflowStepState)=>{
  await verify();const expected=current.sequence,candidate=structuredClone(current);candidate.steps[index]=next;candidate.sequence=expected+1;candidate.phase=workflowPhase(candidate.spec,candidate.steps);
  let saved:boolean;try{saved=await input.persist(structuredClone(candidate),expected);}catch{throw new TaskWorkflowError('WORKFLOW_PERSIST_FAILED','这一步的进度尚未确认保存；先核对原结果，不会重复执行。');}
  if(saved!==true)throw new TaskWorkflowError('WORKFLOW_CHANGED','任务已有新进展，请读取最新状态；这次没有重复执行。');
  current=candidate;
 };
 await verify();
 for(let index=0;index<current.spec.steps.length;index++){
  const step=current.spec.steps[index];let state=current.steps[index];
  if(state.state==='completed'||state.state==='skipped')continue;
  if(state.state==='failed')continue;
  const inputs=step.inputs.map(id=>current.steps.find(saved=>saved.id===id)!);
  if(inputs.some(saved=>saved.state!=='completed'||!saved.checkpointKey)){
   if(step.required===false&&inputs.some(saved=>['failed','skipped'].includes(saved.state))){await commit(index,{id:step.id,state:'skipped',summary:'前面的可选内容没有完成，这一步暂不处理。'});continue;}
   if(state.state==='queued'||state.state==='waiting'&&state.waitingFor==='inputs'){
    if(state.state!=='waiting')await commit(index,{id:step.id,state:'waiting',waitingFor:'inputs',summary:'先等前面步骤拿到可用结果。'});
   }
   continue;
  }
  let response:WorkflowStepResult|undefined;
  if(state.state==='queued'||state.state==='waiting'&&state.waitingFor==='inputs'){
   await commit(index,{id:step.id,state:'running',summary:'正在处理这一步。'});state=current.steps[index];
   try{await verify();response=result(await input.execute(structuredClone(step),inputs.map(saved=>saved.checkpointKey!)),step);}
   catch(error){
    if(error instanceof TaskWorkflowError&&['WORKFLOW_VERIFY_FAILED','WORKFLOW_CHANGED','WORKFLOW_PERSIST_FAILED'].includes(error.code))throw error;
    // An exception cannot prove the absence of a paid call or external write.
    await commit(index,{id:step.id,state:'waiting',waitingFor:'result',summary:'这一步还没拿到确认结果，先核对原结果；不会重复执行。'});return current;
   }
  }else if(input.recover){
   try{await verify();const recovered=await input.recover(structuredClone(step),structuredClone(state));response=recovered===undefined?undefined:result(recovered,step);}
   catch(error){if(error instanceof TaskWorkflowError&&['WORKFLOW_VERIFY_FAILED','WORKFLOW_CHANGED','WORKFLOW_PERSIST_FAILED'].includes(error.code))throw error;return current;}
  }
  if(response){await commit(index,{id:step.id,state:response.state,...(response.state==='completed'?{checkpointKey:response.checkpointKey}:{}),summary:response.summary,...(response.state==='waiting'?{waitingFor:'result' as const}:{})});}
 }
 return current;
}

/** Explicit projection, not a spread of the private spec or checkpoint state.
 * The caller still authorizes the owner before returning this DTO. */
export function workflowProgress(run:WorkflowRun):WorkflowProgress{
 const current=assertRun(run,run.binding),status=current.phase;
 const privateRefs=[current.id,...Object.values(current.binding),...current.spec.steps.flatMap(step=>[step.featureId,step.executorId,step.tool]),...current.steps.map(step=>step.checkpointKey)].filter((ref):ref is string=>!!ref);
 const publicSummary=(raw:unknown,fallback:string)=>safeSummary(typeof raw==='string'&&privateRefs.some(ref=>raw.includes(ref))?undefined:raw,fallback);
 const copy:Record<WorkflowProgress['status'],{summary:string;next:string}>={completed:{summary:'这件事的步骤已完成。',next:'可以查看已经交回的成果。'},partial:{summary:'主要内容已完成，部分可选内容没有做成。',next:'已有成果会保留，可再决定是否补上可选部分。'},failed:{summary:'有必需的步骤没完成，已有内容会保留。',next:'先核对卡住的步骤，再继续未完成的部分。'},needs_input:{summary:'还缺完成任务需要的资料。',next:'把需要补充的资料发来，就能接着处理。'},waiting:{summary:'正在等前面的成果或核对原结果。',next:'确认原结果后再接着做，不会重复执行。'},running:{summary:'这件事还在处理中。',next:'有结果或需要补充时会继续告诉你。'},queued:{summary:'步骤已安排，尚有内容等待处理。',next:'前面的成果就绪后，会接着处理。'}};
 return {status,...copy[status],steps:current.steps.map((step,index)=>({title:publicSummary(current.spec.steps[index].title,'处理这一步'),status:step.state,summary:publicSummary(step.summary,step.state==='completed'?'这一步已取得可用成果。':'这一步尚未完成。')}))};
}
