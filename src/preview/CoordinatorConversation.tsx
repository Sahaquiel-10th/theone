import {useEffect,useRef,useState} from 'react';
import type {Message,Task} from './dispatchPreviewState';
import {OneWaitingCopy} from '../OnePersonality';
import {Lightbulb} from 'lucide-react';
import {MessageMarkdown} from '../MessageMarkdown';

/** Local presentation prototype: a single assistant conversation, not another task dashboard. */
export function CoordinatorConversation({messages,tasks,pending,onOpen}:{messages:Message[];tasks:Task[];pending:boolean;onOpen:(id:string)=>void}) {
 const scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
 const [newMessages,setNewMessages]=useState(false);
 useEffect(()=>{
  if(!scroll.current)return;
  if(follow.current)scroll.current.scrollTop=scroll.current.scrollHeight;
  else setNewMessages(true);
 },[messages.length,pending]);
 return <div className="coordinator-conversation">
  <div ref={scroll} className="coordinator-messages" aria-label="与 ONE 的持续对话" role="log" aria-live="polite" onScroll={()=>{const node=scroll.current!;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<60;if(follow.current)setNewMessages(false);}}>
   {messages.map(message=><article key={message.id} className={`coordinator-message ${message.role}`} data-message-kind={message.kind||'conversation'}>
    {message.featureName?<span className="coordinator-feature-label">{message.featureName}</span>:null}{message.role==='assistant'?<MessageMarkdown>{message.text}</MessageMarkdown>:<p>{message.text}</p>}
    {message.files?.map(file=><small key={file.id}>📎 {file.originalName}</small>)}
    {(message.taskIds?.length ? message.taskIds : message.taskId ? [message.taskId] : []).map(id=><button key={id} type="button" className="coordinator-task-link" aria-label={`打开任务：${tasks.find(task=>task.id===id)?.title || '查看事情'}`} onClick={()=>onOpen(id)}><Lightbulb size={13}/>{tasks.find(task=>task.id===id)?.title || '查看事情'} <span aria-hidden="true">↗</span></button>)}
   </article>)}
   {pending?<OneWaitingCopy/>:null}
  </div>
  {newMessages?<button className="coordinator-new-message" type="button" onClick={()=>{follow.current=true;scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'smooth'});setNewMessages(false);}}>有新消息 ↓</button>:null}
 </div>;
}
