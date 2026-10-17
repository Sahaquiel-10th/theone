import type {Database} from './types.js';
import type {ChatOperation} from './chatOperations.js';
import {canReadKnowledge,featureEntitled,featureRelease} from './enterprisePolicy.js';
import {sourceBinding} from './publicSharing.js';
import {verifyCredentialBindings} from './featureCredentials.js';
type Scope={workspaceId:string;userId:string};
function accessible(db:Database,s:Scope,op:ChatOperation){
  if(!db.conversations?.some(c=>c.id===op.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId&&!c.archived))return false;
  if((op.workRun?.sources??[]).some(saved=>!db.knowledgeConnections.some(c=>c.id===saved.id&&c.workspaceId===s.workspaceId&&['connected','error'].includes(c.status)&&canReadKnowledge(db,s,c.id)&&sourceBinding(c)===saved.binding)))return false;
  if((op.workRun?.skills??[]).some(saved=>!db.settings.officialFeatures?.some(f=>f.id===saved.id&&featureEntitled(db,s,f)&&featureRelease(db,s,f)?.id===saved.releaseId)))return false;
  try{if(op.workRun?.credentials?.length)verifyCredentialBindings(db,s,op.workRun.credentials);}catch{return false;}
  return true;
}
/** Only explicit retries of the same owner's same task may replace a prerequisite. */
export function resolveWorkDependency(db:Database,s:Scope,id:string):ChatOperation|undefined{
  const own=(o:ChatOperation)=>o.workspaceId===s.workspaceId&&o.userId===s.userId;
  let current=db.chatOperations?.find(o=>own(o)&&o.operationId===id&&o.workRun);
  const seen=new Set<string>();
  for(let n=0;current&&n<64;n++){
    if(seen.has(current.operationId))return undefined;
    seen.add(current.operationId);
    const next=db.chatOperations?.find(o=>own(o)&&o.conversationId===current!.conversationId&&o.workRun?.retryOfOperationId===current!.operationId);
    if(!next)return accessible(db,s,current)?current:undefined;
    current=next;
  }
  return undefined;
}
export function dependencyState(db:Database,s:Scope,ids:string[]=[]){
  const parents=ids.map(id=>resolveWorkDependency(db,s,id));
  if(parents.some(p=>p?.workRun?.state==='cancelled'))return 'cancelled';
  if(parents.every(p=>p?.workRun?.state==='completed'&&(!p.workRun.resultOutcome||['completed','returned'].includes(p.workRun.resultOutcome))))return 'ready';
  if(parents.some(p=>!p||['failed','interrupted'].includes(p.workRun?.state??'')||p.workRun?.resultOutcome&&['failed','partial','needs_input'].includes(p.workRun.resultOutcome)))return 'blocked';
  return 'waiting';
}
