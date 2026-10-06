import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Loader2, AlertCircle } from "lucide-react";
export type Transfer = { id: string; taskId: string; title: string; state: string };
export const transferSettled = (state: string) => ["completed", "failed", "interrupted", "cancelled"].includes(state);

/** Motion follows persisted receipts, never predicts success or takes input focus. */
export function TaskTransferRail({ tasks, busy, onOpen, onReport }: { tasks: Transfer[]; busy: boolean; onOpen: (id: string) => void; onReport: (ids: string[]) => Promise<void> }) {
  const [returning, setReturning] = useState<string[]>([]), [error, setError] = useState(false), [page, setPage] = useState(0);
  const pages = Math.ceil(tasks.length / 4);
  const inFlight = useRef(false), report = useRef(onReport); report.current = onReport;
  const ready = tasks.filter(t => transferSettled(t.state)).map(t => t.id).slice(0, 10), key = ready.join("|");
  useEffect(() => {
    if (busy || !key || inFlight.current || error) return;
    const ids = key.split("|");
    inFlight.current = true; setReturning(ids);
    const timer = setTimeout(() => { void report.current(ids).catch(() => setError(true)).finally(() => { inFlight.current = false; setReturning([]); }); }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650);
    return () => { clearTimeout(timer); inFlight.current = false; setReturning([]); };
  }, [key, busy, error]);
  if (!tasks.length) return null;
  return <aside className="task-transfer-rail" aria-label="正在处理的事情">
    {tasks.slice(Math.min(page, pages - 1) * 4, (Math.min(page, pages - 1) + 1) * 4).map(task => <button type="button" key={task.id} className={`task-transfer-bubble ${returning.includes(task.id) ? 'is-returning' : ''} ${transferSettled(task.state) ? 'is-settled' : ''}`} onClick={() => onOpen(task.taskId)}>
      {task.state === 'completed' ? <Check size={14}/> : transferSettled(task.state) ? <AlertCircle size={14}/> : <Loader2 size={14} className="task-transfer-spinner"/>}
      <span><strong>{task.title}</strong><small>{task.state === 'queued' ? '等这一轮接着做' : task.state === 'selecting_target' ? '等你选择工作文件夹' : task.state === 'completed' ? '结果已返回' : transferSettled(task.state) ? '需要看一下' : '正在处理'}</small></span><ArrowUpRight size={12}/>
    </button>)}
    {pages > 1 ? <button type="button" className="task-transfer-more" onClick={() => setPage((Math.min(page, pages - 1) + 1) % pages)}>其他事情 · {Math.min(page, pages - 1) + 1}/{pages}</button> : null}
    {error ? <button type="button" className="task-transfer-more" onClick={() => setError(false)}>结果回流未确认 · 重试</button> : null}
  </aside>;
}
