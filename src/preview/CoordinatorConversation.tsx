import {useFollowLatest} from '../useFollowLatest';
import type {Message,Task} from './dispatchPreviewState';
import {OneWaitingCopy} from '../OnePersonality';
import {Lightbulb} from 'lucide-react';
import {MessageMarkdown, ImagePreview, hasInlineImage} from '../MessageMarkdown';
import {ResponseProgress} from '../ResponseProgress';
import {privateImageUrl} from '../coordinatorMessage';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {MessageSources} from '../MessageSources';
import {MessageAttachments} from '../MessageAttachments';

/** Local presentation prototype: a single assistant conversation, not another task dashboard. */
export function CoordinatorConversation({messages,tasks,pending,onOpen,visible=true,progress,onStop,onRestore,completed=false,hasEarlierHistory=false,loadingHistory=false,onLoadHistory,renderAssistantActions,onContinue}:{messages:Message[];tasks:Task[];pending:boolean;onOpen:(id:string)=>void;visible?:boolean;progress?:{phase:string;startedAt:string}|null;onStop?:()=>Promise<void>;onRestore?:(text:string)=>void;completed?:boolean;hasEarlierHistory?:boolean;loadingHistory?:boolean;onLoadHistory?:()=>Promise<void>;renderAssistantActions?:(message:Message)=>ReactNode;onContinue?:(message:Message)=>void}) {
 const [retainProgress,setRetainProgress]=useState(pending),lastProgress=useRef(progress);
 if(pending&&progress)lastProgress.current=progress;
 useEffect(()=>{if(pending){setRetainProgress(true);return;}if(!completed){setRetainProgress(false);return;}const timer=setTimeout(()=>setRetainProgress(false),350);return()=>clearTimeout(timer);},[pending,completed]);
 const {scroll,newMessages,onScroll,showLatest}=useFollowLatest('coordinator',visible);
 const latestAssistantId=messages.filter(message=>message.role==='assistant').at(-1)?.id;
 return <div className="coordinator-conversation">
  <div ref={scroll} className="coordinator-messages" aria-label="与 ONE 的持续对话" role="log" aria-live="polite" onScroll={onScroll}>
   {hasEarlierHistory&&onLoadHistory?<button className="coordinator-history-button" type="button" disabled={loadingHistory} onClick={async()=>{const node=scroll.current;if(!node)return;const height=node.scrollHeight,top=node.scrollTop;await onLoadHistory();requestAnimationFrame(()=>{node.scrollTop=top+node.scrollHeight-height;});}}>{loadingHistory?'正在翻更早的记录…':'查看更早的聊天记录 ↑'}</button>:null}
   {messages.map(message=><article key={message.id} className={`coordinator-message ${message.role}${message.role==='assistant'?' markdown-body':''}`} aria-label={message.role==='assistant'?'ONE 的回复':'你的消息'} data-message-kind={message.kind||'conversation'} data-task-return-anchor={message.role==='assistant'&&message.id===latestAssistantId?'':undefined}>
    {message.featureName?<span className="coordinator-feature-label">{message.featureName}</span>:null}{message.role==='assistant'?<MessageMarkdown privateImagesOnly codeTools>{message.text}</MessageMarkdown>:<p className="coordinator-user-text">{message.text}</p>}
    {privateImageUrl(message.imageUrl)?<>{!hasInlineImage(message.text,message.imageUrl!)?<ImagePreview src={message.imageUrl!} alt="ONE 生成的图片"/>:null}<a className="coordinator-task-link" href={message.imageUrl} download>下载图片</a></>:null}
    <MessageAttachments files={message.files}/>
    {message.role==='assistant'?<MessageSources message={message}/>:null}
    {message.role==='assistant'&&message.finishReason==='length'?<div className="coordinator-completion-notice" role="status"><span>本次回答达到长度上限，尚未写完。</span>{message.id===latestAssistantId&&onContinue?<button type="button" disabled={pending} onClick={()=>onContinue(message)}>继续生成</button>:null}</div>:message.role==='assistant'&&message.finishReason==='filtered'?<p className="coordinator-completion-notice" role="status">模型服务未完整返回这次回答，请调整问题后再试。</p>:null}
    {message.status==='failed'&&onRestore?<button type="button" className="coordinator-task-link" disabled={pending} onClick={()=>onRestore(message.text)}>放回输入框</button>:null}
    {(message.taskIds?.length ? message.taskIds : message.taskId ? [message.taskId] : []).map(id=><button key={id} type="button" className="coordinator-task-link" aria-label={`打开任务：${tasks.find(task=>task.id===id)?.title || '查看事情'}`} onClick={()=>onOpen(id)}><Lightbulb size={13}/>{tasks.find(task=>task.id===id)?.title || '查看事情'} <span aria-hidden="true">↗</span></button>)}
    {message.role==='assistant'&&renderAssistantActions?<div className="coordinator-answer-actions">{renderAssistantActions(message)}</div>:null}
   </article>)}
   {pending||retainProgress?<div data-task-dispatch-anchor="" data-task-progress-anchor="">{onStop?<ResponseProgress key={(progress||lastProgress.current)?.startedAt} {...(progress||lastProgress.current)} completed={!pending&&completed} onStop={onStop}/>:pending?<OneWaitingCopy/>:null}</div>:null}
  </div>
  {newMessages?<button className="coordinator-new-message" type="button" onClick={showLatest}>有新消息 ↓</button>:null}
 </div>;
}
