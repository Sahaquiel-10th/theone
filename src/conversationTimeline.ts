import type {ReactNode} from 'react';
import type {Message} from './preview/dispatchPreviewState';

export type ConversationInlineEntry={id:string;createdAt:string;content:ReactNode};
export type ConversationTimelineEntry={kind:'message';message:Message}|{kind:'inline';entry:ConversationInlineEntry};
/** Presentation only. Introductory turns never enter ordinary model context. */
export function conversationTimeline(messages:Message[],inline:ConversationInlineEntry[]):ConversationTimelineEntry[]{
  const seen=new Set<string>();
  const rows:Array<{at:number;order:number;value:ConversationTimelineEntry}>=[];
  for(const [index,message] of messages.entries()){
    if(seen.has(`message:${message.id}`))continue;seen.add(`message:${message.id}`);
    const parsed=Date.parse(message.createdAt??'');
    const at=Number.isFinite(parsed)?parsed:/^(outgoing_|feedback_)/.test(message.id)?Number.POSITIVE_INFINITY:Number.NEGATIVE_INFINITY;
    rows.push({at,order:index,value:{kind:'message',message}});
  }
  for(const [index,entry] of inline.entries()){
    if(seen.has(`inline:${entry.id}`))continue;seen.add(`inline:${entry.id}`);
    const at=Date.parse(entry.createdAt);
    rows.push({at:Number.isFinite(at)?at:Number.POSITIVE_INFINITY,order:messages.length+index,value:{kind:'inline',entry}});
  }
  return rows.sort((a,b)=>(a.at===b.at?0:a.at<b.at?-1:1)||a.order-b.order).map(row=>row.value);
}
