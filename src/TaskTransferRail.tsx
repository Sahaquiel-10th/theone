import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Loader2, AlertCircle, ChevronDown } from "lucide-react";
import { transferStateLabel } from './noviceUx';
export type Transfer = { id: string; taskId: string; title: string; state: string };
export const transferSettled = (state: string) => ["completed", "failed", "interrupted", "cancelled"].includes(state);
export const newAutomaticReceiptIds = (tasks:Transfer[],seen:Set<string>,observed:Set<string>) => tasks.filter(t=>transferSettled(t.state)&&!seen.has(t.id)&&observed.has(t.taskId)).map(t=>t.id);

export function visibleTransfers(tasks: Transfer[]) {
  const grouped = new Map<string, Transfer>();
  for (const task of tasks) {
    const previous = grouped.get(task.taskId);
    if (!previous || transferSettled(previous.state) || !transferSettled(task.state)) grouped.set(task.taskId, task);
  }
  return [...grouped.values()];
}

/** Motion follows persisted receipts, never predicts success or takes input focus. */
export function TaskTransferRail({ tasks, busy, onOpen, onReport, onStop }: { tasks: Transfer[]; busy: boolean; onOpen: (id: string) => void; onReport: (ids: string[]) => Promise<void>;onStop?:(task:Transfer,source:HTMLElement)=>Promise<void> }) {
  const [returning, setReturning] = useState<string[]>([]), [error, setError] = useState(false), [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [briefing, setBriefing] = useState(false);
  const [stopping,setStopping]=useState<string[]>([]),[stopError,setStopError]=useState('');
  const observedRunning=useRef(new Set<string>());
  const seenReceipts=useRef<Set<string>|null>(null), currentReceipts=useRef(new Set<string>());
  const manualBriefing=useRef(false);
  const visible = visibleTransfers(tasks);
  const pages = Math.ceil(visible.length / 4);
  const inFlight = useRef(false), report = useRef(onReport); report.current = onReport;
  const ready = tasks.filter(t => transferSettled(t.state)).map(t => t.id).slice(0, 10), key = ready.join("|");
  useEffect(()=>{
    if(!tasks.length)return;
    if(!seenReceipts.current)seenReceipts.current=new Set(tasks.filter(t=>transferSettled(t.state)).map(t=>t.id));
    tasks.filter(t=>!transferSettled(t.state)).forEach(t=>observedRunning.current.add(t.taskId));
    newAutomaticReceiptIds(tasks,seenReceipts.current,observedRunning.current).forEach(id=>currentReceipts.current.add(id));
    tasks.filter(t=>transferSettled(t.state)).forEach(t=>seenReceipts.current!.add(t.id));
    if(currentReceipts.current.size)setBriefing(true);
  },[tasks]);
  useEffect(() => {
    if (!briefing || busy || !key || inFlight.current || error) return;
    // Automatic return only for work observed running here, never unrelated old receipts.
    const ids = manualBriefing.current ? key.split('|') : tasks.filter(t=>transferSettled(t.state)&&currentReceipts.current.has(t.id)).map(t=>t.id).slice(0,10);
    if(!ids.length)return;
    inFlight.current = true; setReturning(ids);
    let issued = false;
    const timer = setTimeout(() => { issued=true; void report.current(ids).then(()=>{ids.forEach(id=>currentReceipts.current.delete(id));}).catch(() => setError(true)).finally(() => { inFlight.current = false; manualBriefing.current=false;setReturning([]); setBriefing(false); }); }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650);
    return () => { clearTimeout(timer); if(!issued)inFlight.current = false; setReturning([]); };
  }, [key, busy, error, briefing]);
  if (!tasks.length) return null;
  return <aside className="task-transfer-rail" aria-label="正在处理的任务">
    <button type="button" className="task-transfer-bubble" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}><Loader2 size={14} className={visible.some(t=>!transferSettled(t.state)&&t.state!=='paused')?'task-transfer-spinner':''}/><span><strong>任务 · {visible.length}</strong><small>{ready.length ? `${new Set(tasks.filter(t=>transferSettled(t.state)).map(t=>t.taskId)).size} 件有反馈` : '查看进展或停止任务'}</small></span><ChevronDown size={14}/></button>
    {expanded ? visible.slice(Math.min(page, pages - 1) * 4, (Math.min(page, pages - 1) + 1) * 4).map(task => <div className="task-transfer-row" key={task.id}><button type="button" className={`task-transfer-bubble ${returning.includes(task.id) ? 'is-returning' : ''} ${transferSettled(task.state) ? 'is-settled' : ''}`} onClick={() => onOpen(task.taskId)}>
      {task.state === 'completed' ? <Check size={14}/> : transferSettled(task.state)||task.state==='paused' ? <AlertCircle size={14}/> : <Loader2 size={14} className="task-transfer-spinner"/>}
      <span><strong>{task.title}</strong><small>{transferStateLabel(task.state)}</small></span><ArrowUpRight size={12}/>
    </button>{task.state==='paused'?<button type="button" className="task-transfer-more" onClick={()=>onOpen(task.taskId)}>查看恢复方式</button>:null}{!transferSettled(task.state)&&onStop?<button type="button" className="task-transfer-more" disabled={stopping.includes(task.id)} onClick={event=>{const source=event.currentTarget;setStopping(old=>[...old,task.id]);void onStop(task,source).catch(e=>setStopError(e instanceof Error?e.message:'停止未确认')).finally(()=>setStopping(old=>old.filter(id=>id!==task.id)));}}>停止</button>:null}</div>) : null}
    {stopError?<small role="alert">{stopError}</small>:null}
    {expanded && pages > 1 ? <button type="button" className="task-transfer-more" onClick={() => setPage((Math.min(page, pages - 1) + 1) % pages)}>更多任务 · {Math.min(page, pages - 1) + 1}/{pages}</button> : null}
    {expanded && ready.length > 0 ? <button type="button" className="task-transfer-more" disabled={busy || briefing} onClick={() => {manualBriefing.current=true; setError(false); setBriefing(true); }}>让 ONE 说说结果</button> : null}
    {error ? <button type="button" className="task-transfer-more" disabled={busy} onClick={() => { setError(false); setBriefing(true); }}>结果回流未确认 · 重试</button> : null}
  </aside>;
}
