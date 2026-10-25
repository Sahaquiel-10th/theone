import type { Conversation } from '../server/types';
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
  taskId?: string;
  taskIds?: string[];
  progress?: {phase: string; startedAt: string};
  conversation?: Conversation;
  message?: Conversation['messages'][number];
};

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
