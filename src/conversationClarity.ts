import {internalTaskId} from './taskLink';

type LinkedMessage={id:string;role:string;text:string;taskId?:string;taskIds?:string[]};
export const messageTaskIds=(message:Pick<LinkedMessage,'taskId'|'taskIds'>)=>[...new Set([...(message.taskIds??[]),...(message.taskId?[message.taskId]:[])])];

const reportLabels:Record<string,string>={
 '已完成':'已完成','已返回结果，待你查看':'有新结果','未完成':'未完成',
 '部分结果已返回，需要核对':'部分完成','需要你确认':'需要你处理','已停止':'已停止','结果尚未确认':'结果待核对',
};
export type ConversationTaskReport={title:string;status:string;summary:string;taskId:string;notionUrl?:string};

/** Only the deterministic, server-owned result-report format becomes a status
 * card. An ordinary AI paragraph or a quoted status never changes presentation.
 * The original message remains untouched and is available in the disclosure. */
export function conversationTaskReport(message:LinkedMessage,base='https://one.invalid/'):{items:ConversationTaskReport[]}|undefined{
 if(message.role!=='assistant'||!message.id.startsWith('report_'))return;
 const linked=new Set(messageTaskIds(message));if(!linked.size)return;
 const blocks=message.text.trim().split(/\n\s*\n/),items:ConversationTaskReport[]=[];
 for(const block of blocks){
  const lines=block.split('\n'),navigation=lines.pop()?.trim();
  // This is the existing server serializer's exact line, not a Markdown parser.
  // Generic AI Markdown is handled by its real link renderer instead.
  const link=navigation?.match(/^\[查看这件事\]\((\/\?task=[^\s)]+)\)(?: · \[打开 Notion\]\((https:\/\/[^\s)]+)\))?$/);
  const taskId=link&&internalTaskId(link[1],base);if(!taskId||!linked.has(taskId))return;
  const content=lines.join('\n'),heading=content.match(/^([^\n]+?)：(已完成|已返回结果，待你查看|未完成|部分结果已返回，需要核对|需要你确认|已停止|结果尚未确认)。([\s\S]*)$/);
  if(!heading)return;
  const summary=heading[3].replace(/^\s*`?goal_?unfinished`?\s*$/gim,'').trim();
  items.push({title:heading[1],status:reportLabels[heading[2]],summary:summary||'还有要求未完成，请先查看已有结果。',taskId,...(link?.[2]?{notionUrl:link[2]}:{})});
 }
 return items.length?{items}:undefined;
}
