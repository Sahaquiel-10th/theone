import type {Message as StoredMessage} from '../server/types';
import type {Message} from './preview/dispatchPreviewState';
import type {CoordinatorDraft} from './coordinatorDrafts';
import {coordinatorMessage} from './coordinatorMessage';
import {coordinatorRecoveryCopy,parseCoordinatorFailure} from './coordinatorRecovery';

type Outgoing={id:string;text:string;createdAt?:string;priorIds:string[];failed?:boolean;notStarted?:boolean};
type FailureReply={scope:string;operationId:string;text:string;createdAt?:string};
export type RejectedSubmission={operationId:string;failure:unknown;requestId?:string};
export function rejectedSubmission(message:StoredMessage):RejectedSubmission|undefined{
 const value=(message as StoredMessage&{rejectedSubmission?:RejectedSubmission}).rejectedSubmission;
 return value&&typeof value.operationId==='string'&&value.operationId&&parseCoordinatorFailure(value.failure)?.outcome==='not_started'?value:undefined;
}
/** Unaccepted turns are history, not task receipts. Keep their original and a
 * safe reply across another send/reload; a durable server turn replaces the
 * local fallback by exact operation ID, never by coincidentally equal text. */
export function coordinatorDialogue(input:{userId:string;messages:StoredMessage[];links?:{messageId:string;taskId:string}[];drafts:CoordinatorDraft[];outgoing:Outgoing|null;failureReply:FailureReply|null}):Message[]{
 const {messages,outgoing,failureReply}=input;
 const persisted=new Set(messages.flatMap(message=>{const rejection=rejectedSubmission(message);return rejection?[rejection.operationId]:[];}));
 const rows:{createdAt:string;index:number;message:Message}[]=messages.map((message,index)=>({createdAt:message.createdAt,index,message:{...coordinatorMessage(message),
  ...(rejectedSubmission(message)&&message.role==='user'?{status:'failed' as const,featureName:'尚未开始 · 原话保留'}:{}),
  taskId:input.links?.find(link=>link.messageId===message.id)?.taskId,
  taskIds:[...new Set(input.links?.filter(link=>link.messageId===message.id).map(link=>link.taskId)??[])],
 }}));
 const local=new Set<string>();
 for(const draft of input.drafts){
  const failure=parseCoordinatorFailure(draft.rejection?.failure);
  if(draft.state!=='failed'||failure?.outcome!=='not_started'||persisted.has(draft.operationId))continue;
  local.add(draft.operationId);
  const text=`${coordinatorRecoveryCopy(failure)}${draft.rejection?.requestId?` · 编号 ${draft.rejection.requestId}`:''}`;
  rows.push({createdAt:draft.createdAt,index:rows.length,message:{id:`outgoing_${draft.operationId}`,createdAt:draft.createdAt,role:'user',text:draft.text,status:'failed',featureName:'尚未开始 · 原话保留'}});
  rows.push({createdAt:draft.createdAt,index:rows.length,message:{id:`feedback_${draft.operationId}`,createdAt:draft.createdAt,role:'assistant',text}});
 }
 const dialogue:Message[]=rows.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.index-b.index).map(row=>row.message);
 const savedOutgoing=outgoing?[...messages].reverse().find(message=>message.role==='user'&&!outgoing.priorIds.includes(message.id!)&&message.content===outgoing.text&&(!rejectedSubmission(message)||rejectedSubmission(message)?.operationId===outgoing.id)):undefined;
 if(outgoing?.failed&&savedOutgoing){const message=dialogue.find(item=>item.id===savedOutgoing.id);if(message)message.status='failed';}
 if(outgoing&&!savedOutgoing&&!local.has(outgoing.id)&&!persisted.has(outgoing.id))dialogue.push({id:`outgoing_${outgoing.id}`,createdAt:outgoing.createdAt,role:'user',text:outgoing.text,status:outgoing.failed?'failed':undefined,featureName:outgoing.failed?outgoing.notStarted?'尚未开始 · 原话保留':'发送状态待确认 · 原话保留':'发送中'});
 if(failureReply?.scope===input.userId&&!local.has(failureReply.operationId)&&!persisted.has(failureReply.operationId))dialogue.push({id:`feedback_${failureReply.operationId}`,createdAt:failureReply.createdAt,role:'assistant',text:failureReply.text});
 return dialogue;
}
