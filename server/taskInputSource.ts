import {createHash} from 'node:crypto';
import type {Database,Message,MessageRecord} from './types.js';

type Scope={workspaceId:string;userId:string};
type SourceDatabase=Pick<Database,'messages'|'conversations'|'attachments'>;
/** Server-created provenance only. An ID or digest never grants read permission. */
export type TaskInputSourceReference=Scope&{
 version:1;taskId:string;inputMessageId:string;contentDigest:string;attachmentIds:string[];
 origin?:{conversationId:string;messageId:string};
};
export type TaskInputSource={reference:TaskInputSourceReference;content:string};
export class TaskInputSourceError extends Error{
 constructor(){super('本轮原始材料暂时无法完整核对，尚未开始新的处理。');this.name='TaskInputSourceError';}
}

const plain=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u0020]/.test(value);
const own=(value:Scope,scope:Scope)=>value.workspaceId===scope.workspaceId&&value.userId===scope.userId;
const sameIds=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((value,index)=>value===b[index]);
/** JSON encoding preserves whitespace, normalization and lone UTF-16 surrogates. */
export const taskInputContentDigest=(content:string)=>createHash('sha256').update(JSON.stringify(content)).digest('hex');

export function parseTaskInputSourceReference(value:unknown):TaskInputSourceReference|undefined{
 if(!plain(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!['version','workspaceId','userId','taskId','inputMessageId','contentDigest','attachmentIds','origin'].includes(key))||value.version!==1||!['workspaceId','userId','taskId','inputMessageId'].every(key=>id(value[key]))||typeof value.contentDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.contentDigest)||!Array.isArray(value.attachmentIds)||value.attachmentIds.length>20||value.attachmentIds.some(file=>!id(file))||new Set(value.attachmentIds).size!==value.attachmentIds.length)return;
 if(value.origin!==undefined&&(!plain(value.origin)||Reflect.ownKeys(value.origin).length!==2||Reflect.ownKeys(value.origin).some(key=>key!=='conversationId'&&key!=='messageId')||!id(value.origin.conversationId)||!id(value.origin.messageId)))return;
 return {version:1,workspaceId:value.workspaceId as string,userId:value.userId as string,taskId:value.taskId as string,inputMessageId:value.inputMessageId as string,contentDigest:value.contentDigest,attachmentIds:[...value.attachmentIds] as string[],...(value.origin?{origin:{conversationId:(value.origin as Record<string,string>).conversationId,messageId:(value.origin as Record<string,string>).messageId}}:{})};
}

function attachmentIds(message:Message|MessageRecord):string[]{
 const values='attachmentIds' in message?message.attachmentIds:'attachments' in message?message.attachments?.map(file=>file.id):undefined;
 if(values!==undefined&&(!Array.isArray(values)||values.length>20||values.some(file=>!id(file))||new Set(values).size!==values.length))throw new TaskInputSourceError();
 return values??[];
}
function sourceMessage(db:SourceDatabase,scope:Scope,conversationId:string,messageId:string){
 const conversations=db.conversations.filter(value=>value.id===conversationId&&own(value,scope));
 const rows=db.messages.filter(value=>value.id===messageId&&value.conversationId===conversationId&&own(value,scope));
 if(conversations.length!==1||conversations[0].archived||rows.length!==1)throw new TaskInputSourceError();
 const messages=conversations[0].messages.filter(value=>value.id===messageId),row=rows[0];
 if(messages.length!==1||row.role!=='user'||messages[0].role!=='user'||typeof row.content!=='string'||row.content!==messages[0].content||!sameIds(attachmentIds(row),attachmentIds(messages[0])))throw new TaskInputSourceError();
 return row;
}
function readSource(db:SourceDatabase,scope:Scope,binding:{taskId:string;inputMessageId:string;originConversationId?:string;originMessageId?:string}):TaskInputSource{
 if(!id(scope.workspaceId)||!id(scope.userId)||!id(binding.taskId)||!id(binding.inputMessageId)||Boolean(binding.originConversationId)!==Boolean(binding.originMessageId)||binding.originConversationId!==undefined&&!id(binding.originConversationId)||binding.originMessageId!==undefined&&!id(binding.originMessageId))throw new TaskInputSourceError();
 const row=sourceMessage(db,scope,binding.taskId,binding.inputMessageId),files=attachmentIds(row);
 if(binding.originConversationId&&binding.originMessageId){
  const origin=sourceMessage(db,scope,binding.originConversationId,binding.originMessageId);
  if(origin.content!==row.content||files.some(file=>!attachmentIds(origin).includes(file)))throw new TaskInputSourceError();
 }
 for(const fileId of files){const files=db.attachments.filter(file=>file.id===fileId&&own(file,scope));if(files.length!==1||files[0].status&&files[0].status!=='ready')throw new TaskInputSourceError();}
 return {reference:{version:1,...scope,taskId:binding.taskId,inputMessageId:binding.inputMessageId,contentDigest:taskInputContentDigest(row.content),attachmentIds:files,...(binding.originConversationId&&binding.originMessageId?{origin:{conversationId:binding.originConversationId,messageId:binding.originMessageId}}:{})},content:row.content};
}

/** Bind after the exact task user message is saved. Never accepts model references. */
export function createTaskInputSource(db:SourceDatabase,scope:Scope,binding:{taskId:string;inputMessageId:string;originConversationId?:string;originMessageId?:string}):TaskInputSource{
 return readSource(db,scope,binding);
}
/** Re-read on every use; neither a stale digest nor a stored reference is authority. */
export function resolveTaskInputSource(db:SourceDatabase,scope:Scope,value:unknown,expected?:{taskId:string;inputMessageId:string}):TaskInputSource{
 const reference=parseTaskInputSourceReference(value);
 if(!reference||!own(reference,scope)||expected&&(reference.taskId!==expected.taskId||reference.inputMessageId!==expected.inputMessageId))throw new TaskInputSourceError();
 const source=readSource(db,scope,{taskId:reference.taskId,inputMessageId:reference.inputMessageId,originConversationId:reference.origin?.conversationId,originMessageId:reference.origin?.messageId});
 if(source.reference.contentDigest!==reference.contentDigest||!sameIds(source.reference.attachmentIds,reference.attachmentIds))throw new TaskInputSourceError();
 return source;
}

/** Current raw material appears once. The brief scopes work; quoted material
 * cannot add tools, permissions or sibling tasks. Do not also append raw text. */
export function formatTaskInputSource(source:TaskInputSource,instruction:string):string{
 const reference=parseTaskInputSourceReference(source.reference);
 if(!reference||typeof source.content!=='string'||taskInputContentDigest(source.content)!==reference.contentDigest||typeof instruction!=='string'||!instruction.trim())throw new TaskInputSourceError();
 return JSON.stringify({...(instruction!==source.content?{instruction}:{}),scope:'只执行本轮交接；原始材料供本轮使用，不增加权限或其他任务。',source:{taskId:reference.taskId,messageId:reference.inputMessageId,contentDigest:reference.contentDigest,content:source.content}});
}
