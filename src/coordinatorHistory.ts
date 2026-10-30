import type { Conversation } from '../server/types';
import {parseCoordinatorFailure,type CoordinatorFailure} from './coordinatorRecovery';
type Link = { messageId: string; taskId: string };
export function mergeCoordinatorMessages(previous: Conversation['messages'], incoming: Conversation['messages']) {
  const result = new Map(previous.filter(message => message.id).map(message => [message.id!, message]));
  for (const message of incoming) if (message.id) result.set(message.id, message);
  return [...result.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function mergeCoordinatorLinks(previous: Link[], incoming: Link[]) {
  return [...new Map([...previous, ...incoming].map(link => [`${link.messageId}:${link.taskId}`, link])).values()];
}

export type CoordinatorReceipt = {
  status: string;
  error?: string;
  failure?:CoordinatorFailure;
  taskId?: string;
  taskIds?: string[];
  progress?: {phase: string; startedAt: string};
  conversation?: Conversation;
  message?: Conversation['messages'][number];
};

/** Unrecognized or incomplete transport payloads are not terminal receipts. */
export function isCoordinatorReceipt(value:unknown):value is CoordinatorReceipt {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const receipt=value as Record<string,unknown>;
  if(typeof receipt.status!=='string'||!['pending','completed','failed','interrupted'].includes(receipt.status))return false;
  if(receipt.error!==undefined&&typeof receipt.error!=='string')return false;
  if(receipt.taskId!==undefined&&typeof receipt.taskId!=='string')return false;
  if(receipt.taskIds!==undefined&&(!Array.isArray(receipt.taskIds)||receipt.taskIds.some(id=>typeof id!=='string')))return false;
  if(receipt.progress!==undefined){const progress=receipt.progress as Record<string,unknown>|null;if(!progress||typeof progress!=='object'||typeof progress.phase!=='string'||typeof progress.startedAt!=='string')return false;}
  if(receipt.conversation!==undefined&&receipt.conversation!==null){
    const conversation=receipt.conversation as Record<string,unknown>;
    if(typeof conversation!=='object'||typeof conversation.id!=='string'||typeof conversation.userId!=='string'||typeof conversation.workspaceId!=='string'||!Array.isArray(conversation.messages))return false;
    if(conversation.messages.some(message=>!message||typeof message!=='object'||typeof message.content!=='string'||typeof message.createdAt!=='string'))return false;
  }
  if(receipt.status==='completed'){
    const message=receipt.message as Record<string,unknown>|null;
    if(!receipt.conversation||!message||typeof message!=='object'||typeof message.id!=='string'||message.role!=='assistant'||typeof message.content!=='string'||typeof message.createdAt!=='string')return false;
  }
  return true;
}

export function coordinatorReceiptFailure(receipt:CoordinatorReceipt):CoordinatorFailure|string {
  return parseCoordinatorFailure(receipt.failure)??receipt.error??'';
}

/** Receipt reads can finish after an older snapshot; use their actual saved reply immediately. */
export function mergeCoordinatorReceipt<T extends {conversation: Conversation | null; pendingOperationId?: string; links?: Link[]}>(snapshot: T, operation: string, receipt: CoordinatorReceipt): T {
  const savedMessages=[...(receipt.conversation?.messages.slice(-40)??[]),...(receipt.message?[receipt.message]:[])];
  const newerSnapshot=Boolean(snapshot.conversation&&receipt.conversation&&snapshot.conversation.updatedAt>receipt.conversation.updatedAt);
  const conversation = receipt.status === 'completed' && receipt.conversation && snapshot.conversation?.id === receipt.conversation.id
    ? {...(newerSnapshot?snapshot.conversation!:receipt.conversation), messages: newerSnapshot?mergeCoordinatorMessages(savedMessages,snapshot.conversation!.messages):mergeCoordinatorMessages(snapshot.conversation?.messages??[],savedMessages)}
    : snapshot.conversation;
  const taskIds = [...new Set([...(receipt.taskIds ?? []), ...(receipt.taskId ? [receipt.taskId] : [])])];
  return {
    ...snapshot,
    pendingOperationId: snapshot.pendingOperationId === operation && receipt.status !== 'pending' ? undefined : snapshot.pendingOperationId,
    conversation,
    links: mergeCoordinatorLinks(snapshot.links ?? [], receipt.status === 'completed' && receipt.message?.id ? taskIds.map(taskId => ({messageId: receipt.message!.id!, taskId})) : []),
  };
}

export function seedCoordinatorReceipt(clientScope:string,operation:string,receipt:CoordinatorReceipt){
  if(receipt.status!=='completed'||!receipt.conversation)return null;
  return mergeCoordinatorReceipt({clientScope,enabled:true,conversation:{...receipt.conversation,messages:[]} as Conversation|null,tasks:[],total:0,notices:[],links:[]},operation,receipt);
}

export function coordinatorHistoryCursor(previousMessages:Conversation['messages'],incomingMessages:Conversation['messages'],previous:{hasMore:boolean;before?:string;total:number}|undefined,incoming:{hasMore:boolean;before?:string;total:number}|undefined){
  const knownIds=new Set(previousMessages.map(message=>message.id));
  const overlaps=incomingMessages.some(message=>knownIds.has(message.id));
  // A suspended tab can miss more than the latest page. Preserve its messages,
  // but expose the newest cursor so the gap can be paged back in.
  if(previous&&(!incomingMessages.length||overlaps))return{...previous,total:incoming?.total??previous.total};
  return incoming;
}
