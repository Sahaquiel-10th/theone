import type {Database} from './types.js';
import type {WorkRun} from './coordinatorTypes.js';
import {parseTaskInputSourceReference,resolveTaskInputSource,TaskInputSourceError,type TaskInputSource,type TaskInputSourceReference} from './taskInputSource.js';

type Scope={workspaceId:string;userId:string};
type MaterialDatabase=Pick<Database,'messages'|'conversations'|'attachments'|'chatOperations'>;
type MaterialRun=Pick<WorkRun,'materialSources'|'materialSource'|'materialScope'|'inputSource'|'inputContentMode'|'inputMessageId'>;
export const maxTaskMaterialSources=8;
export const maxTaskMaterialChars=256000;
export class TaskMaterialLimitError extends Error{
 constructor(){super('这次选定的原文超过8份或256000字，尚未开始新的处理。请减少材料，或明确改为只使用本轮材料。');this.name='TaskMaterialLimitError';}
}
const own=(value:Scope,scope:Scope)=>value.workspaceId===scope.workspaceId&&value.userId===scope.userId;

/** A source reference cannot promote a scoped multi-goal brief to full material.
 * Recheck the code-owned originating run, not a model's selected source IDs. */
function eligible(db:MaterialDatabase,scope:Scope,taskId:string,reference:TaskInputSourceReference):boolean{
 const runs=(db.chatOperations??[]).filter(operation=>own(operation,scope)&&operation.conversationId===taskId&&operation.workRun?.inputMessageId===reference.inputMessageId);
 if(runs.length!==1)return false;
 const run=runs[0].workRun!,original=parseTaskInputSourceReference(run.inputSource);
 if(run.inputContentMode!=='material'||!original||JSON.stringify(original)!==JSON.stringify(reference))return false;
 return !run.parentOperationId||(db.chatOperations??[]).filter(operation=>own(operation,scope)&&operation.workRun?.parentOperationId===run.parentOperationId).length<=1;
}
function bounded(sources:TaskInputSource[]):TaskInputSource[]{
 if(sources.length>maxTaskMaterialSources||sources.reduce((sum,source)=>sum+source.content.length,0)>maxTaskMaterialChars)throw new TaskMaterialLimitError();
 return sources;
}

/** Undefined means a legacy job without an exact selected set. An explicit
 * array (including []) never falls back to reading the conversation history. */
export function resolveTaskMaterialLineage(db:MaterialDatabase,scope:Scope,taskId:string,run:MaterialRun):TaskInputSource[]|undefined{
 const explicit=run.materialSources!==undefined;
 const values:unknown=explicit?run.materialSources:run.materialScope==='current'?[run.materialSource??run.inputSource].filter(Boolean):undefined;
 if(values===undefined)return;
 if(!Array.isArray(values)||values.length>maxTaskMaterialSources)throw new TaskInputSourceError();
 const seen=new Set<string>(),sources:TaskInputSource[]=[];
 for(const value of values){
  const reference=parseTaskInputSourceReference(value);
  if(!reference||reference.taskId!==taskId||!own(reference,scope)||seen.has(reference.inputMessageId))throw new TaskInputSourceError();
  if(!eligible(db,scope,taskId,reference)){
   // Old scoped briefs had singular provenance, not a selected material set.
   if(!explicit)return;
   throw new TaskInputSourceError();
  }
  seen.add(reference.inputMessageId);
  sources.push(resolveTaskInputSource(db,scope,reference,{taskId,inputMessageId:reference.inputMessageId}));
 }
 return bounded(sources);
}

/** Only enqueue calls this after saving the current exact human input. New
 * material eligibility is a server fact; short control instructions do not
 * consume a lineage slot. A replacement never reads the superseded originals. */
export function nextTaskMaterialLineage(db:MaterialDatabase,scope:Scope,input:{taskId:string;previous?:MaterialRun;current:TaskInputSourceReference;contributes:boolean;replace:boolean;retry?:boolean}):TaskInputSourceReference[]|undefined{
 const previous=input.replace&&!input.retry?undefined:input.previous?resolveTaskMaterialLineage(db,scope,input.taskId,input.previous):undefined;
 if(!previous&&!input.contributes)return;
 let selected=previous??[];
 if(input.retry){
  selected=selected.map(source=>source.reference.inputMessageId===input.previous?.inputMessageId?resolveTaskInputSource(db,scope,input.current,{taskId:input.taskId,inputMessageId:input.current.inputMessageId}):source);
 }else if(input.contributes){
  const current=resolveTaskInputSource(db,scope,input.current,{taskId:input.taskId,inputMessageId:input.current.inputMessageId});
  if(!selected.some(source=>source.reference.inputMessageId===current.reference.inputMessageId))selected=[...selected,current];
 }
 return bounded(selected).map(source=>source.reference);
}
