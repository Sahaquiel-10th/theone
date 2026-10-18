import type {Attachment,Database} from './types.js';
import {resolveWorkDependency} from './workDependencies.js';
type Scope={workspaceId:string;userId:string};
/** Resolve actual images from explicit, still-readable prerequisite receipts only. */
export function visualPrerequisiteImage(db:Database,scope:Scope,operationIds:string[]):Attachment|undefined{
 for(const operationId of operationIds){
  const parent=resolveWorkDependency(db,scope,operationId);
  if(parent?.workRun?.state!=='completed')throw new Error('前面的结果还不能使用，请先核对原任务');
  const message=db.conversations.find(c=>c.id===parent.conversationId&&c.workspaceId===scope.workspaceId&&c.userId===scope.userId)?.messages.find(m=>m.id===parent.workRun!.resultMessageId);
  const image=db.attachments.find(a=>a.workspaceId===scope.workspaceId&&a.userId===scope.userId&&a.conversationId===parent.conversationId&&a.kind==='image'&&(message?.imageUrl===`/api/attachments/${a.id}/content`||message?.attachments?.some(file=>file.id===a.id)));
  if(!image){if(parent.workRun.kind==='image'||parent.workRun.expectedOutput==='image')throw new Error('前面的图片暂时找不到，先核对原结果；不会重新画图');continue;}
  if(image.status!=='ready'||!/^image\/(png|jpeg|webp)$/.test(image.mimeType)||image.size>25*1024*1024)throw new Error('前面的配图暂时不可用');
  return image;
 }
}
/** Re-rendering/export must keep the same server-owned job binding as saving.
 * This also recovers already-saved HTML; no new generation or billing needed. */
export function visualArtifactPrerequisites(db:Database,scope:Scope,file:Attachment):string[]{
 const job=db.chatOperations?.find(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.conversationId===file.conversationId&&o.workRun&&(
  file.messageId&&o.workRun.resultMessageId===file.messageId||o.workRun.steps?.some(step=>step.state==='completed'&&step.effect==='artifact'&&['oneHtml','oneFlowchart'].includes(step.tool)&&(step.output as {file?:{id?:string}})?.file?.id===file.id)
 ));
 return job?.workRun?.dependsOnOperationIds??[];
}
