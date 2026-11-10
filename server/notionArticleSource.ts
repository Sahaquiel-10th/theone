import {createHash} from 'node:crypto';
import type {Database} from './types.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {WorkScope} from './coordinatorService.js';
import {CoordinatorError} from './executorProfiles.js';
import {OrchestrationInputError} from './taskOrchestrator.js';
import {notionDeliveryNote} from './notionCompletion.js';

const own=(item:{workspaceId:string;userId:string},scope:WorkScope)=>item.workspaceId===scope.workspaceId&&item.userId===scope.userId;
const articleHash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Exact stored text, not a summary selected by another model. Only the known
 * server-appended delivery suffix is separated from the authored content. */
export function existingNotionArticle(db:Database,s:WorkScope,conversationId:string,source?:WorkRun['notionArticleSource'],selectedMessageId?:string):{source:NonNullable<WorkRun['notionArticleSource']>;content:string}|undefined{
  const conversation=db.conversations.find(c=>own(c,s)&&c.id===conversationId&&!c.archived);
  if(!conversation)throw new CoordinatorError('原文章不属于当前账号或已不可用，尚未保存。',403);
  const operations=(db.chatOperations??[]).filter(op=>own(op,s)&&op.conversationId===conversationId);
  const eligible=operations.filter(op=>!op.failure&&(
    op.workRun?.resultMessageId&&['completed','failed'].includes(op.workRun.state)&&['completed','partial','returned'].includes(op.workRun.resultOutcome??'')
    ||!op.workRun&&op.status==='completed'&&op.assistantMessageId&&!op.dispatchedTaskId&&!op.dispatchedTaskIds?.length));
  const selected=conversation.coordinatorMain?(selectedMessageId?eligible.filter(op=>op.assistantMessageId===selectedMessageId):eligible):eligible;
  if(!source&&conversation.coordinatorMain&&selected.length>1)throw new OrchestrationInputError('主对话中有多份已有回复，不能猜哪一份是要保存的文章。请先用 read_context 的 messageId 读取那条原文，再交接保存；不要复制最近的普通答复或用摘要代替。');
  const operation=source?operations.find(op=>op.id===source.operationId):selected.at(-1);
  if(!operation)return;
  if(operation.workRun?.notionArticleSource&&!source)return existingNotionArticle(db,s,operation.workRun.notionArticleSource.conversationId,operation.workRun.notionArticleSource);
  const messageId=operation.workRun?.resultMessageId??operation.assistantMessageId;
  const message=conversation.messages.find(message=>message.id===messageId&&message.role==='assistant'&&!message.imageUrl&&!message.attachments?.length&&message.finishReason!=='length'&&message.finishReason!=='filtered');
  if(!message?.content.trim()||message.content.length>50000)return;
  let content=message.content;
  if(operation.workRun?.notionTarget){
    // Delivery facts can advance after the message was persisted. Match only
    // finite server-owned suffixes for this exact page, then let an existing
    // source binding choose by its immutable original body hash.
    const pageId=operation.workRun.notionReceipt?.pageId??operation.workRun.notionTarget.pageId;
    const url=pageId&&/^[a-f0-9]{32}$/i.test(pageId.replaceAll('-',''))?`https://www.notion.so/${pageId.replaceAll('-','')}`:undefined;
    const suffixes=[notionDeliveryNote(operation.workRun.notionReceipt,operation.workRun.notionTarget.pageId),'\n\n本轮尚未确认保存到 Notion。',...(url?['已保存到 Notion · 已回读核对','已保存到 Notion','打开 Notion 原文'].map(label=>`\n\n[${label}](${url})`):[])];
    const candidates=[content];
    // Earlier workflow results could receive the same server link twice.
    // Bound the compatibility path to those two known append sites.
    for(let depth=0;depth<2;depth++)for(const candidate of [...candidates])for(const suffix of suffixes)if(candidate.endsWith(suffix)){
      const stripped=candidate.slice(0,-suffix.length);if(!candidates.includes(stripped))candidates.push(stripped);
    }
    if(source){const matches=candidates.filter(candidate=>articleHash(candidate)===source.digest);if(matches.length!==1)throw new CoordinatorError('原文章或来源已变化，尚未保存。请先核对最新原文。',409);content=matches[0];}
    else content=candidates.at(-1)!;
  }
  if(!content.trim())return;
  const binding={conversationId,operationId:operation.id,messageId:message.id!,messageDigest:articleHash(message.content),digest:articleHash(content)};
  if(source&&(Object.keys(binding) as (keyof typeof binding)[]).some(key=>binding[key]!==source[key]))throw new CoordinatorError('原文章或来源已变化，尚未保存。请先核对最新原文。',409);
  return {source:binding,content};
}
