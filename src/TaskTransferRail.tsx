import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Loader2, AlertCircle, ChevronDown, Lightbulb } from "lucide-react";
import { transferStateLabel } from './noviceUx';
export type Transfer = { id: string; taskId: string; title: string; state: string; reported?: boolean; reportable?: boolean; outcome?: string; phase?: string; local?: boolean };
export const transferSettled = (state: string) => ["completed", "returned", "partial", "needs_input", "failed", "interrupted", "cancelled"].includes(state);

/** The server receipt survives reloads. Viewing an outcome and reporting it are separate actions. */
export const newAutomaticReceiptIds = (tasks: Transfer[]) => tasks.filter(t=>transferSettled(t.state)&&!t.reported&&t.reportable!==false).map(t=>t.id);
export function visibleTransfers(tasks: Transfer[]) {
  const grouped = new Map<string, Transfer>();
  for (const task of tasks) {
    if (transferSettled(task.state)&&task.reported) continue;
    const previous = grouped.get(task.taskId);
    if (!previous || transferSettled(previous.state) || !transferSettled(task.state)) grouped.set(task.taskId, task);
  }
  return [...grouped.values()];
}
/** Cache only this acknowledged batch while it returns; newer work for the task always wins. */
export function presentationTransfers(tasks:Transfer[],delivered:Set<string>,returning:Transfer[]) {
  const current=visibleTransfers(tasks).filter(task=>!delivered.has(task.id));
  const currentTasks=new Set(current.map(task=>task.taskId));
  return [...current,...visibleTransfers(returning).filter(task=>!currentTasks.has(task.taskId))];
}
export function transferFeedbackLabel(task: Transfer) {
  if(task.phase)return task.phase;
  if(task.state==='waiting')return '等待前一步完成';
  if(task.state==='prepared_local')return '等待确认本机执行';
  if(task.outcome==='needs_input'||task.state==='needs_input')return '需要你补充信息';
  if(task.outcome==='partial'||task.state==='partial')return '已有部分结果，需要核对';
  if(task.outcome==='failed')return '未完成，查看原因';
  if(task.state==='returned')return '结果已返回，查看内容';
  return transferStateLabel(task.state);
}

/** Receipt delivery never changes drafts, input focus, or the user's read state. */
export function TaskTransferRail({ tasks, busy, onOpen, onReport, onStop }: { tasks: Transfer[]; busy: boolean; onOpen: (id: string) => void; onReport: (ids: string[]) => Promise<boolean | void>;onStop?:(task:Transfer,source:HTMLElement)=>Promise<void> }) {
  const [returning, setReturning] = useState<Transfer[]>([]), [error, setError] = useState(false), [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(true), [attempt, setAttempt] = useState(0), [briefing,setBriefing] = useState(false);
  const [retryAt,setRetryAt]=useState(0);
  const [stopping,setStopping]=useState<string[]>([]),[stopError,setStopError]=useState('');
  const delivered=useRef(new Set<string>()), inFlight=useRef(false), report=useRef(onReport); report.current=onReport;
  const visible = presentationTransfers(tasks,delivered.current,returning);
  const pages = Math.max(1,Math.ceil(visible.length / 4));
  const ready=newAutomaticReceiptIds(tasks).filter(id=>!delivered.current.has(id)).slice(0,10), key=ready.join('|');
  useEffect(() => {
    if(busy||!key||inFlight.current||error||retryAt>Date.now())return;
    const timer=setTimeout(()=>{
      if(inFlight.current)return;
      const ids=key.split('|'),batch=tasks.filter(task=>ids.includes(task.id)&&transferSettled(task.state));inFlight.current=true;setBriefing(true);
      void report.current(ids).then(result=>{
        if(result===false){setRetryAt(Date.now()+1500);return;}
        ids.forEach(id=>delivered.current.add(id));setReturning(batch);
      }).catch(()=>setError(true)).finally(()=>{inFlight.current=false;setBriefing(false);});
    },250);
    return()=>clearTimeout(timer);
  },[key,busy,error,attempt,retryAt]);
  useEffect(()=>{if(!retryAt)return;const timer=setTimeout(()=>{setRetryAt(0);setAttempt(v=>v+1);},Math.max(0,retryAt-Date.now()));return()=>clearTimeout(timer);},[retryAt]);
  useEffect(()=>{if(!returning.length)return;const timer=setTimeout(()=>{setReturning([]);setAttempt(v=>v+1);},650);return()=>clearTimeout(timer);},[returning]);
  if (!visible.length&&!returning.length) return null;
  const feedbackCount=new Set(visible.filter(t=>transferSettled(t.state)).map(t=>t.taskId)).size;
  return <aside className="task-transfer-rail" aria-label="正在处理的任务">
    <button type="button" className="task-transfer-bubble task-transfer-heading" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>
      {feedbackCount?<Lightbulb size={15} className="task-feedback-light"/>:<Loader2 size={14} className={visible.some(t=>!transferSettled(t.state)&&t.state!=='paused'&&t.state!=='prepared_local')?'task-transfer-spinner':''}/>}
      <span><strong>任务 · {visible.length}</strong><small>{feedbackCount?`${feedbackCount} 件有反馈${briefing?' · 正在告诉 ONE':''}`:'处理期间可以继续聊天'}</small></span><ChevronDown size={14}/>
    </button>
    {expanded?visible.slice(Math.min(page,pages-1)*4,(Math.min(page,pages-1)+1)*4).map(task=><div className="task-transfer-row" data-task-transfer-id={task.taskId} key={task.id}>
      <button type="button" className={`task-transfer-bubble ${returning.some(item=>item.id===task.id)?'is-returning':''} ${transferSettled(task.state)?'is-settled':''}`} onClick={()=>onOpen(task.taskId)}>
        {['completed','returned'].includes(task.state)&&!['needs_input','partial','failed'].includes(task.outcome||'')?<Check size={14}/>:transferSettled(task.state)||task.state==='paused'||task.state==='prepared_local'?<AlertCircle size={14}/>:<Loader2 size={14} className={task.state==='waiting'?'':'task-transfer-spinner'}/>}
        <span><strong>{task.title}</strong><small>{transferFeedbackLabel(task)}</small></span><ArrowUpRight size={12}/>
      </button>
      {task.state==='paused'||task.state==='prepared_local'?<button type="button" className="task-transfer-more" onClick={()=>onOpen(task.taskId)}>{task.state==='prepared_local'?'打开任务':'查看恢复方式'}</button>:null}
      {!transferSettled(task.state)&&onStop?<button type="button" className="task-transfer-more" disabled={stopping.includes(task.id)} onClick={event=>{const source=event.currentTarget;setStopping(old=>[...old,task.id]);void onStop(task,source).catch(e=>setStopError(e instanceof Error?e.message:'停止未确认')).finally(()=>setStopping(old=>old.filter(id=>id!==task.id)));}}>{stopping.includes(task.id)?'停止中':'停止'}</button>:null}
    </div>):null}
    {stopError?<small role="alert">{stopError}</small>:null}
    {expanded&&pages>1?<button type="button" className="task-transfer-more" onClick={()=>setPage((Math.min(page,pages-1)+1)%pages)}>另外的任务 · {Math.min(page,pages-1)+1}/{pages}</button>:null}
    {error?<button type="button" className="task-transfer-more" disabled={busy||briefing} onClick={()=>{setError(false);setAttempt(v=>v+1);}}>反馈尚未回到对话 · 重试</button>:null}
  </aside>;
}
