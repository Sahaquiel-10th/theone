import {useFollowLatest} from '../useFollowLatest';
import type {Message,Task} from './dispatchPreviewState';
import {OneWaitingCopy} from '../OnePersonality';
import {Lightbulb} from 'lucide-react';
import {MessageMarkdown, ImagePreview, hasInlineImage} from '../MessageMarkdown';
import {ResponseProgress} from '../ResponseProgress';
import {privateImageUrl} from '../coordinatorMessage';
import {useEffect,useRef,useState} from 'react';

/** Local presentation prototype: a single assistant conversation, not another task dashboard. */
export function CoordinatorConversation({messages,tasks,pending,onOpen,visible=true,progress,onStop,onRestore,completed=false}:{messages:Message[];tasks:Task[];pending:boolean;onOpen:(id:string)=>void;visible?:boolean;progress?:{phase:string;startedAt:string}|null;onStop?:()=>Promise<void>;onRestore?:(text:string)=>void;completed?:boolean}) {
 const [retainProgress,setRetainProgress]=useState(pending),lastProgress=useRef(progress);
 if(pending&&progress)lastProgress.current=progress;
 useEffect(()=>{if(pending){setRetainProgress(true);return;}if(!completed){setRetainProgress(false);return;}const timer=setTimeout(()=>setRetainProgress(false),350);return()=>clearTimeout(timer);},[pending,completed]);
 const {scroll,newMessages,onScroll,showLatest}=useFollowLatest('coordinator',visible);
 const latestAssistantId=messages.filter(message=>message.role==='assistant').at(-1)?.id;
 return <div className="coordinator-conversation">
  <div ref={scroll} className="coordinator-messages" aria-label="与 ONE 的持续对话" role="log" aria-live="polite" onScroll={onScroll}>
   {messages.map(message=><article key={message.id} className={`coordinator-message ${message.role}`} data-message-kind={message.kind||'conversation'} data-task-return-anchor={message.role==='assistant'&&message.id===latestAssistantId?'':undefined}>
    {message.featureName?<span className="coordinator-feature-label">{message.featureName}</span>:null}{message.role==='assistant'?<MessageMarkdown>{message.text}</MessageMarkdown>:<p>{message.text}</p>}
    {privateImageUrl(message.imageUrl)&&!hasInlineImage(message.text,message.imageUrl!)?<><ImagePreview src={message.imageUrl!} alt="ONE 生成的图片"/><a className="coordinator-task-link" href={message.imageUrl} download>下载图片</a></>:null}
    {message.files?.map(file=><small key={file.id}>📎 {file.originalName}</small>)}
    {message.status==='failed'&&onRestore?<button type="button" className="coordinator-task-link" disabled={pending} onClick={()=>onRestore(message.text)}>放回输入框</button>:null}
    {(message.taskIds?.length ? message.taskIds : message.taskId ? [message.taskId] : []).map(id=><button key={id} type="button" className="coordinator-task-link" aria-label={`打开任务：${tasks.find(task=>task.id===id)?.title || '查看事情'}`} onClick={()=>onOpen(id)}><Lightbulb size={13}/>{tasks.find(task=>task.id===id)?.title || '查看事情'} <span aria-hidden="true">↗</span></button>)}
   </article>)}
   {pending||retainProgress?<div data-task-dispatch-anchor="" data-task-progress-anchor="">{onStop?<ResponseProgress key={(progress||lastProgress.current)?.startedAt} {...(progress||lastProgress.current)} completed={!pending&&completed} onStop={onStop}/>:pending?<OneWaitingCopy/>:null}</div>:null}
  </div>
  {newMessages?<button className="coordinator-new-message" type="button" onClick={showLatest}>有新消息 ↓</button>:null}
 </div>;
}
