import {createHash} from 'node:crypto';
import type {Store} from './db.js';
import type {Message} from './types.js';
import {featureMember} from './featureRuns.js';
import {publicAttachmentSummary,selectConversationAttachments} from './conversationAttachments.js';
import {coordinatorRecoveryCopy,parseCoordinatorFailure,type CoordinatorFailure} from '../src/coordinatorRecovery.js';

/** Record a known refusal without claiming a chat operation, a worker or usage.
 * Only the authenticated owner's validated original input and reviewed copy
 * survive; raw diagnostics and request-supplied failure metadata never do. */
export async function recordCoordinatorRejection(store:Store,scope:{workspaceId:string;userId:string},body:unknown,failure:CoordinatorFailure,requestId?:string):Promise<boolean>{
 const safe=parseCoordinatorFailure(failure),input=body as {operationId?:unknown;text?:unknown;attachmentIds?:unknown;modelId?:unknown;boundTaskId?:unknown};
 if(!safe||safe.outcome!=='not_started'||!input||typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(input.operationId)
   ||typeof input.text!=='string'||!input.text.trim()||input.text.length>8000)return false;
 const ids=input.attachmentIds??[];
 if(!Array.isArray(ids)||ids.length>5||ids.some(id=>typeof id!=='string'||!id||id.length>100))return false;
 const operationId=input.operationId,text=input.text.trim(),owned=(x:{workspaceId:string;userId:string})=>x.workspaceId===scope.workspaceId&&x.userId===scope.userId;
 const digest=createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId,operationId])).digest('hex'),userId=`msg_refused_${digest}_u`,answerId=`msg_refused_${digest}_a`;
 return store.mutate(db=>{
  featureMember(db,scope);
  // Recheck inside the same transaction: a late accepted result always wins.
  if(db.chatOperations?.some(o=>owned(o)&&o.operationId===operationId))return false;
  if(input.boundTaskId!==undefined&&!db.conversations.some(c=>owned(c)&&c.id===input.boundTaskId&&!c.archived))return false;
  let main=db.conversations.find(c=>owned(c)&&c.coordinatorMain);
  const existing=db.messages.find(m=>owned(m)&&m.id===userId);
  if(existing)return existing.content===text&&JSON.stringify(existing.attachmentIds??[])===JSON.stringify([...new Set(ids)]);
  const files=selectConversationAttachments(db,{...scope,conversationId:main?.id},ids as string[],{maxFiles:5,maxImages:5}).current;
  const timestamp=new Date().toISOString();
  if(!main){
   const model=db.models.find(m=>m.enabled&&m.kind==='chat'&&(input.modelId===undefined||m.id===input.modelId));
   if(!model)return false;
   main={id:`cnv_refused_${digest}`, ...scope,coordinatorMain:true,title:'与 ONE 的持续对话',modelId:model.id,archived:false,messages:[],createdAt:timestamp,updatedAt:timestamp,taskResultReportSince:timestamp};
   db.conversations.push(main);
  }
  // Preserve embedded legacy messages before relational history becomes canonical.
  for(const message of main.messages)if(message.id&&!db.messages.some(m=>owned(m)&&m.id===message.id&&m.conversationId===main!.id))db.messages.push({...message,id:message.id,...scope,conversationId:main.id,attachmentIds:message.attachments?.map(a=>a.id)});
  const metadata={operationId,failure:safe,...(typeof requestId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(requestId)?{requestId}:{})};
  const messages:Message[]=[{id:userId,role:'user',content:text,attachments:files.map(publicAttachmentSummary),rejectedSubmission:metadata,createdAt:timestamp},
   {id:answerId,role:'assistant',content:coordinatorRecoveryCopy(safe),rejectedSubmission:metadata,createdAt:new Date(Date.parse(timestamp)+1).toISOString()}];
  for(const message of messages){main.messages.push(message);db.messages.push({...message,id:message.id!,...scope,conversationId:main.id,attachmentIds:message.attachments?.map(a=>a.id)});}
  for(const file of files)if(!file.conversationId){file.conversationId=main.id;file.messageId=userId;}
  main.updatedAt=messages[1].createdAt;
  return true;
 });
}
