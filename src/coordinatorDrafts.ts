import type {CoordinatorSubmission} from './useCoordinator';
import {parseCoordinatorFailure,type CoordinatorFailure} from './coordinatorRecovery';

type Rejection={failure:CoordinatorFailure;requestId?:string};
export type CoordinatorDraft=CoordinatorSubmission&{createdAt:string;state:'pending'|'failed'|'missing'|'review';rejection?:Rejection};
const MAX_AGE=7*24*60*60*1000;
const storageKey=(userId:string,workspaceId:string)=>`one.coordinator-drafts.v1:${JSON.stringify([userId,workspaceId])}`;
const memory=new Map<string,CoordinatorDraft[]>();
const ids=(value:unknown)=>Array.isArray(value)&&value.length<=100&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=300);

/** Copy only replay semantics and references, never files, tokens or arbitrary fields. */
export function coordinatorSubmissionPayload(input:CoordinatorSubmission):Omit<CoordinatorSubmission,'operationId'> {
  return {text:input.text,modelId:input.modelId,boundTaskId:input.boundTaskId,outputDestination:input.outputDestination,localExecution:input.localExecution,
    featureIds:input.featureIds?[...input.featureIds]:undefined,attachmentIds:input.attachmentIds?[...input.attachmentIds]:undefined,
    featureApprovals:input.featureApprovals?.map(({id,releaseId,version,multiplier})=>({id,releaseId,version,multiplier})),confirmedExternal:input.confirmedExternal,webSearch:input.webSearch};
}
function clean(value:unknown,now:number):CoordinatorDraft|undefined {
  if(!value||typeof value!=='object')return;
  const draft=value as CoordinatorDraft;
  if(typeof draft.createdAt!=='string')return;
  const age=now-Date.parse(draft.createdAt);
  if(typeof draft.operationId!=='string'||!draft.operationId||draft.operationId.length>300||typeof draft.text!=='string'||draft.text.length>200000||!Number.isFinite(age)||age<0||age>MAX_AGE||!['pending','failed','missing','review'].includes(draft.state))return;
  if(draft.attachmentIds!==undefined&&!ids(draft.attachmentIds)||draft.featureIds!==undefined&&!ids(draft.featureIds))return;
  if(['modelId','boundTaskId'].some(key=>draft[key as 'modelId']!==undefined&&typeof draft[key as 'modelId']!=='string'))return;
  if(draft.outputDestination!==undefined&&!['chat','notion','local'].includes(draft.outputDestination))return;
  if(['localExecution','confirmedExternal','webSearch'].some(key=>draft[key as 'localExecution']!==undefined&&typeof draft[key as 'localExecution']!=='boolean'))return;
  if(draft.featureApprovals!==undefined&&(!Array.isArray(draft.featureApprovals)||draft.featureApprovals.length>100||draft.featureApprovals.some(item=>!item||typeof item.id!=='string'||typeof item.releaseId!=='string'||!Number.isFinite(item.version)||!Number.isFinite(item.multiplier))))return;
  const failure=parseCoordinatorFailure(draft.rejection?.failure);
  const rejection=draft.state==='failed'&&failure?.outcome==='not_started'?{failure,...(typeof draft.rejection?.requestId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(draft.rejection.requestId)?{requestId:draft.rejection.requestId}:{})}:undefined;
  return{...coordinatorSubmissionPayload(draft),operationId:draft.operationId,createdAt:draft.createdAt,state:draft.state,...(rejection?{rejection}:{})};
}
export function coordinatorDrafts(userId:string,workspaceId:string,now=Date.now()):CoordinatorDraft[] {
  const key=storageKey(userId,workspaceId);let stored:unknown;
  try{stored=JSON.parse(sessionStorage.getItem(key)||'[]');}catch{}
  const values=[...new Map([...(Array.isArray(stored)?stored:[]),...(memory.get(key)??[])].map(value=>[(value as CoordinatorDraft)?.operationId,value])).values()];
  return values.map(value=>clean(value,now)).filter((draft):draft is CoordinatorDraft=>Boolean(draft)).slice(-20);
}
function write(userId:string,workspaceId:string,values:CoordinatorDraft[]){
  const key=storageKey(userId,workspaceId);memory.set(key,values);
  try{sessionStorage.setItem(key,JSON.stringify(values));}catch{/* This tab still retains its original submission. */}
}
export function saveCoordinatorDraft(userId:string,workspaceId:string,input:CoordinatorSubmission,state:CoordinatorDraft['state']='pending'){
  const values=coordinatorDrafts(userId,workspaceId),previous=values.find(draft=>draft.operationId===input.operationId);
  const draft=clean({...input,createdAt:previous?.createdAt??new Date().toISOString(),state},Date.now());
  if(draft)write(userId,workspaceId,[...values.filter(value=>value.operationId!==draft.operationId),draft].slice(-20));
}
export function forgetCoordinatorDraft(userId:string,workspaceId:string,operationId:string){write(userId,workspaceId,coordinatorDrafts(userId,workspaceId).filter(draft=>draft.operationId!==operationId));}
export function markCoordinatorDraft(userId:string,workspaceId:string,operationId:string,state:CoordinatorDraft['state'],rejection?:Rejection){
  const draft=coordinatorDrafts(userId,workspaceId).find(draft=>draft.operationId===operationId);
  if(draft)saveCoordinatorDraft(userId,workspaceId,rejection?{...draft,rejection}:draft,state);
}
