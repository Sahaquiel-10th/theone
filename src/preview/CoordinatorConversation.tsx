import {useFollowLatest} from '../useFollowLatest';
import type {Message,Task} from './dispatchPreviewState';
import {OneWaitingCopy} from '../OnePersonality';
import {Lightbulb} from 'lucide-react';
import {MessageMarkdown} from '../MessageMarkdown';
import {ResponseProgress} from '../ResponseProgress';
import {privateImageUrl} from '../coordinatorMessage';

/** Local presentation prototype: a single assistant conversation, not another task dashboard. */
export function CoordinatorConversation({messages,tasks,pending,onOpen,visible=true,progress,onStop,onRestore}:{messages:Message[];tasks:Task[];pending:boolean;onOpen:(id:string)=>void;visible?:boolean;progress?:{phase:string;startedAt:string}|null;onStop?:()=>Promise<void>;onRestore?:(text:string)=>void}) {
 const {scroll,newMessages,onScroll,showLatest}=useFollowLatest('coordinator',visible);
 return <div className="coordinator-conversation">
  <div ref={scroll} className="coordinator-messages" aria-label="与 ONE 的持续对话" role="log" aria-live="polite" onScroll={onScroll}>
   {messages.map(message=><article key={message.id} className={`coordinator-message ${message.role}`} data-message-kind={message.kind||'conversation'}>
    {message.featureName?<span className="coordinator-feature-label">{message.featureName}</span>:null}{message.role==='assistant'?<MessageMarkdown>{message.text}</MessageMarkdown>:<p>{message.text}</p>}
    {privateImageUrl(message.imageUrl)?<><img className="generated-image" src={message.imageUrl} alt="ONE 生成的图片" loading="lazy"/><a className="coordinator-task-link" href={message.imageUrl} download>下载图片</a></>:null}
    {message.files?.map(file=><small key={file.id}>📎 {file.originalName}</small>)}
    {message.status==='failed'&&onRestore?<button type="button" className="coordinator-task-link" disabled={pending} onClick={()=>onRestore(message.text)}>放回输入框</button>:null}
    {(message.taskIds?.length ? message.taskIds : message.taskId ? [message.taskId] : []).map(id=><button key={id} type="button" className="coordinator-task-link" aria-label={`打开任务：${tasks.find(task=>task.id===id)?.title || '查看事情'}`} onClick={()=>onOpen(id)}><Lightbulb size={13}/>{tasks.find(task=>task.id===id)?.title || '查看事情'} <span aria-hidden="true">↗</span></button>)}
   </article>)}
   {pending?onStop?<ResponseProgress {...progress} onStop={onStop}/>:<OneWaitingCopy/>:null}
  </div>
  {newMessages?<button className="coordinator-new-message" type="button" onClick={showLatest}>有新消息 ↓</button>:null}
 </div>;
}
