import {useFollowLatest} from '../useFollowLatest';
import type {Message,Task} from './dispatchPreviewState';
import {Lightbulb} from 'lucide-react';
import {MessageMarkdown, ImagePreview, hasInlineImage} from '../MessageMarkdown';
import {ResponseProgress} from '../ResponseProgress';
import {privateImageUrl} from '../coordinatorMessage';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {MessageSources} from '../MessageSources';
import {MessageAttachments} from '../MessageAttachments';
import {conversationTaskReport,messageTaskIds} from '../conversationClarity';

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
   {messages.map(message=>{const taskIds=messageTaskIds(message),report=conversationTaskReport(message,typeof window!=='undefined'?window.location.href:undefined);return <article key={message.id} className={`coordinator-message ${message.role}${message.role==='assistant'?' markdown-body':''}${report?' coordinator-system-report':''}`} aria-label={report?'任务更新':message.role==='assistant'?'ONE 的回复':'你的消息'} data-message-kind={message.kind||'conversation'} data-task-return-anchor={message.role==='assistant'&&message.id===latestAssistantId?'':undefined}>
    {message.featureName?<span className="coordinator-feature-label">{message.featureName}</span>:null}{report?<><div className="coordinator-report-items">{report.items.map(item=><section className="coordinator-report-item" key={item.taskId}><header><h3>{item.title}</h3><span>{item.status}</span></header><p>{item.summary}</p><div className="coordinator-report-actions"><button type="button" className="coordinator-task-link" aria-label={`打开任务：${item.title}`} onClick={()=>onOpen(item.taskId)}>查看任务 <span aria-hidden="true">↗</span></button>{item.notionUrl?<a href={item.notionUrl} target="_blank" rel="noopener noreferrer">打开 Notion ↗</a>:null}</div></section>)}</div><details className="coordinator-report-details"><summary>完整记录</summary><div className="coordinator-report-full-text"><MessageMarkdown privateImagesOnly codeTools taskLinkIds={taskIds} suppressTaskLinks>{message.text}</MessageMarkdown></div>{renderAssistantActions?<div className="coordinator-answer-actions">{renderAssistantActions(message)}</div>:null}</details></>:message.role==='assistant'?<MessageMarkdown privateImagesOnly codeTools taskLinkIds={taskIds}>{message.text}</MessageMarkdown>:<p className="coordinator-user-text">{message.text}</p>}
    {privateImageUrl(message.imageUrl)?<>{!hasInlineImage(message.text,message.imageUrl!)?<ImagePreview src={message.imageUrl!} alt="ONE 生成的图片"/>:null}<a className="coordinator-task-link" href={message.imageUrl} download>下载图片</a></>:null}
    <MessageAttachments files={message.files}/>
    {message.role==='assistant'?<MessageSources message={message}/>:null}
    {message.role==='assistant'&&message.finishReason==='length'?<div className="coordinator-completion-notice" role="status"><span>本次回答达到长度上限，尚未写完。</span>{message.id===latestAssistantId&&onContinue?<button type="button" disabled={pending} onClick={()=>onContinue(message)}>继续生成</button>:null}</div>:message.role==='assistant'&&message.finishReason==='filtered'?<p className="coordinator-completion-notice" role="status">模型服务未完整返回这次回答，请调整问题后再试。</p>:null}
    {message.status==='failed'&&onRestore?<button type="button" className="coordinator-task-link" disabled={pending} onClick={()=>onRestore(message.text)}>放回输入框</button>:null}
    {!report?taskIds.map(id=><button key={id} type="button" className="coordinator-task-link" aria-label={`打开任务：${tasks.find(task=>task.id===id)?.title || '查看任务'}`} onClick={()=>onOpen(id)}><Lightbulb size={13}/>{tasks.find(task=>task.id===id)?.title || '查看任务'} <span aria-hidden="true">↗</span></button>):null}
    {message.role==='assistant'&&!report&&renderAssistantActions?<div className="coordinator-answer-actions">{renderAssistantActions(message)}</div>:null}
   </article>;})}
   {pending||retainProgress?<div data-task-dispatch-anchor="" data-task-progress-anchor=""><ResponseProgress key={(progress||lastProgress.current)?.startedAt} {...(progress||lastProgress.current)} completed={!pending&&completed} onStop={onStop}/></div>:null}
  </div>
  {newMessages?<button className="coordinator-new-message" type="button" onClick={showLatest}>有新消息 ↓</button>:null}
 </div>;
}
