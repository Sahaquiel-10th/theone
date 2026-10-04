import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronLeft, FlaskConical, Pause, RotateCcw, SlidersHorizontal, X } from './PreviewIcons';
import { OneCompanionEye } from '../OneCompanionEye';
import { OneWaitingCopy, useOneGreeting } from '../OnePersonality';
import { initialPreview, previewReducer, type Task } from './dispatchPreviewState';
import './dispatch-preview.css';

const taskLabels = { idle: '还没开始', running: '正在处理', completed: '结果好了', failed: '需要重试', stopped: '已停止' };
const messageLabels = { running: '这轮处理中', queued: '已收到 · 待处理', held: '先记着 · 不执行', done: '已处理', cancelled: '已停止处理', failed: '这轮失败 · 要求已保留' };

export function DispatchPreview() {
 const [state, dispatch] = useReducer(previewReducer, undefined, initialPreview);
 const [debugOpen, setDebugOpen] = useState(false);
 const [historyOpen, setHistoryOpen] = useState(false);
 const [entry, setEntry] = useState(0);
 const [composerFocused, setComposerFocused] = useState(false);
 const inputRef = useRef<HTMLTextAreaElement>(null);
 const companionRef = useRef<HTMLElement>(null);
 const previousBounds = useRef<DOMRect | null>(null);
 const dialogueRef = useRef<HTMLDivElement>(null);
 const paperRef = useRef<HTMLDivElement>(null);
 const positions = useRef(new Map<string, number>());
 const greeting = useOneGreeting(String(entry));
 const task = state.tasks.find(t => t.id === state.selected);
 const busy = Boolean(state.pending);

 useLayoutEffect(() => {
  const element = companionRef.current;
  if (!element) return;
  const next = element.getBoundingClientRect();
  const before = previousBounds.current;
  previousBounds.current = next;
  if (before && !matchMedia('(prefers-reduced-motion: reduce)').matches && window.innerWidth > 850) {
   const animation = element.animate([{ transform: `translate(${before.left - next.left}px, ${before.top - next.top}px)` }, { transform: 'translate(0,0)' }], { duration: 900, easing: 'cubic-bezier(.4,0,.2,1)' });
   return () => animation.cancel();
  }
 }, [Boolean(state.selected)]);
 useEffect(() => { if (!historyOpen && dialogueRef.current) dialogueRef.current.scrollTop = dialogueRef.current.scrollHeight; }, [state.dialogue, busy, historyOpen]);

 useEffect(() => {
  if (!state.pending) return;
  const { id, dueAt } = state.pending;
  const timer = setTimeout(() => dispatch({ type: 'ack', id, now: Date.now() }), Math.max(0, dueAt - Date.now()));
  return () => clearTimeout(timer);
 }, [state.pending]);
 useEffect(() => {
  if (state.manual) return;
  const timers = state.tasks.filter(t => t.status === 'running' && t.dueAt !== null).map(t => setTimeout(() => dispatch({ type: 'finish', taskId: t.id, round: t.round, now: Date.now() }), Math.max(0, t.dueAt! - Date.now())));
  return () => timers.forEach(clearTimeout);
 }, [state.tasks, state.manual]);
 useEffect(() => {
  // No result handoff while writing, reading a paper, or another turn is active.
  if (busy || state.draft.trim() || composerFocused || historyOpen || state.selected || !state.notices.length) return;
  const timer = setTimeout(() => dispatch({ type: 'report' }), 1200);
  return () => clearTimeout(timer);
 }, [busy, state.draft, composerFocused, historyOpen, state.selected, state.notices]);
 useEffect(() => { if (paperRef.current) paperRef.current.scrollTop = positions.current.get(state.selected || '') || 0; }, [state.selected]);

 function select(id: string | null) {
  if (paperRef.current && state.selected) positions.current.set(state.selected, paperRef.current.scrollTop);
  dispatch({ type: 'select', taskId: id });
  if (!id) setEntry(n => n + 1);
 }
 function submit() { if (!busy && state.draft.trim()) dispatch({ type: 'submit', text: state.draft, id: crypto.randomUUID(), now: Date.now() }); }
 function fill(text: string) { dispatch({ type: 'draft', text }); inputRef.current?.focus(); }
 const visibleDialogue = historyOpen ? state.dialogue : state.dialogue.slice(-4);

 return <div className="dp-app">
  <header className="dp-header"><button className="dp-brand" onClick={() => select(null)} aria-label="回到 ONE 首页"><img src="/one-mark.svg" alt="" />One</button><span className="dp-nav">工作台 <span>功能</span></span><button className="dp-debug-toggle" onClick={() => setDebugOpen(v => !v)} aria-expanded={debugOpen}><SlidersHorizontal size={15} />调试</button></header>
  <div className="dp-preview-label"><FlaskConical size={13} />本地交互预览 · 规则分流 / 合成结果 · 不调用 AI，不扣费 · 刷新重置</div>
  <main className={`dp-layout ${task ? 'has-paper' : 'is-home'}`}>
   <section className="dp-stage" aria-label="事情工作区">
    <div className="dp-task-strip" aria-label="我的事情">{state.tasks.map(t => <button key={t.id} className={`dp-task-tab ${state.selected === t.id ? 'selected' : ''}`} onClick={() => select(t.id)} aria-pressed={state.selected === t.id}><span className={`dp-status-dot ${t.status}`} /><span>{t.title}</span>{t.queue.length > 0 && <small>+{t.queue.length}</small>}{t.unread && <span className="dp-unread" aria-label="有新结果" />}</button>)}</div>
    {task ? <article className="dp-paper" aria-label={task.title}>
     <header className="dp-paper-header"><div><small>这件事情</small><h1>{task.title}</h1></div><button className="dp-icon" aria-label="收起这件事" onClick={() => select(null)}><X size={18} /></button></header>
     <div className="dp-paper-status"><span className={`dp-status-dot ${task.status}`} />{taskLabels[task.status]}{task.round > 0 && <span>第 {task.round} 轮</span>}{task.queue.length > 0 && <span>{task.queue.length} 条补充待处理</span>}</div>
     <div className="dp-paper-scroll" ref={paperRef} onScroll={e => positions.current.set(task.id, e.currentTarget.scrollTop)}>
      {task.messages.length === 0 ? <div className="dp-paper-empty">这件事还没开始。直接告诉 ONE 就好。</div> : task.messages.map(m => <div className={`dp-paper-message ${m.role}`} key={m.id}><small>{m.role === 'user' ? '你' : '任务结果 · 模拟'}</small><p>{m.text}</p>{m.status && <span className={`dp-message-status ${m.status}`}>{messageLabels[m.status]}</span>}</div>)}
      {task.status === 'running' && <div className="dp-worker-wait"><OneWaitingCopy /><small>{state.manual ? '自动执行已暂停，可在调试中手动完成' : '模拟执行中；你可以继续跟 ONE 说话'}</small></div>}
     </div>
     <footer className="dp-paper-footer">{task.status === 'failed' ? <button onClick={() => dispatch({ type: 'retry', taskId: task.id, now: Date.now() })}><RotateCcw size={14} />重试这轮</button> : <span>{task.result ? '完整成果留在这件事里' : '每条原话都会保留在这里'}</span>}<button onClick={() => fill(`${task.id === 'ui' ? 'UI' : '露营'} 还可以补充：`)}>补充想法 <ArrowUpRight size={14} /></button></footer>
    </article> : <div className="dp-home-note"><div className="dp-home-recent">{state.tasks.filter(t => t.status !== 'idle').map(t => <button key={t.id} onClick={() => select(t.id)}>{t.title}<span>{taskLabels[t.status]} <ArrowUpRight size={13} /></span></button>)}</div></div>}
   </section>
   <section className="dp-companion" aria-label="与 ONE 对话" ref={companionRef}>
    <div className="dp-presence"><OneCompanionEye mood={busy ? 'thinking' : state.draft ? 'attentive' : 'idle'} onActivate={() => select(null)} /><div><small>ONE</small><h2>{state.selected ? '我在，接着说。' : greeting}</h2></div></div>
    <div className="dp-master-dialogue" aria-label="主对话" ref={dialogueRef}><div className="dp-dialogue-heading"><span>和 ONE 说话</span>{state.dialogue.length > 4 && <button onClick={() => setHistoryOpen(v => !v)}>{historyOpen ? '收起' : '之前说过的'}<ChevronDown size={12} /></button>}</div>
     {visibleDialogue.map(m => <div key={m.id} className={`dp-master-message ${m.role}`}><small>{m.role === 'user' ? '你' : 'ONE'}</small><p>{m.text}</p>{m.taskId && <button onClick={() => select(m.taskId!)}>查看这件事 <ArrowUpRight size={12} /></button>}</div>)}
     {busy && <div className="dp-master-wait" role="status"><span className="dp-status-dot running" />ONE 正在承接这句话…</div>}
     {!state.dialogue.length && <p className="dp-opening">不用开新聊天。想到哪件事，直接说。</p>}
    </div>
    <div className="dp-composer-anchor">
     {state.notices.length > 0 && <div className="dp-arrivals"><span className="dp-unread" /><span>{state.notices.length} 条进展等你看</span><button disabled={busy || Boolean(state.draft.trim())} onClick={() => dispatch({ type: 'report' })}>听简报</button></div>}
     <form className={`dp-composer ${busy ? 'busy' : ''}`} onSubmit={e => { e.preventDefault(); submit(); }}><textarea ref={inputRef} aria-label="告诉 ONE" placeholder="告诉我，你想做什么" value={state.draft} onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)} onChange={e => dispatch({ type: 'draft', text: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><div><span>{busy ? '等 ONE 接住这句，再发送下一句' : 'Enter 发送 · Shift Enter 换行'}</span><button type="submit" aria-label="发送给 ONE" disabled={busy || !state.draft.trim()}><ArrowUp size={20} /></button></div></form>
     <div className="dp-suggestions"><button onClick={() => fill('明天干脆去露营吧')}>聊露营</button><button onClick={() => fill('好像上次的 UI 我有了个新的灵感')}>聊旧 UI</button><button onClick={() => fill('UI 输入框可以再大一点，一会补充上去')}>追加 UI 想法</button></div>
    </div>
   </section>
  </main>
  {debugOpen && <aside className="dp-debug" aria-label="模拟调试"><header><h2>模拟调试</h2><button className="dp-icon" aria-label="关闭调试" onClick={() => setDebugOpen(false)}><X size={18} /></button></header><p>只识别 UI、露营与最近任务的简单指代。这里不是实际调度 AI。</p><label>调度等待 <strong>{state.schedulerMs / 1000} 秒</strong><input aria-label="调度等待秒数" type="range" min="500" max="8000" step="500" value={state.schedulerMs} onChange={e => dispatch({ type: 'settings', schedulerMs: Number(e.target.value) })} /></label><label>任务等待 <strong>{state.workerMs / 1000} 秒</strong><input aria-label="任务等待秒数" type="range" min="5000" max="60000" step="1000" value={state.workerMs} onChange={e => dispatch({ type: 'settings', workerMs: Number(e.target.value) })} /></label><label className="dp-check"><input type="checkbox" checked={state.manual} onChange={e => dispatch({ type: 'settings', manual: e.target.checked })} />暂停自动完成（仍可手动完成）</label><small>延迟调整对下一轮生效；已启动轮次保留原定时间。</small>{state.tasks.map(t => <DebugTask key={t.id} task={t} onFinish={failed => dispatch({ type: 'finish', taskId: t.id, round: t.round, now: Date.now(), failed })} />)}<button className="dp-reset" onClick={() => { dispatch({ type: 'reset' }); positions.current.clear(); setEntry(n => n + 1); }}><RotateCcw size={14} />重置演示</button><a href="/output/playwright/focus-preview.html"><ChevronLeft size={13} />之前的工作台预览</a></aside>}
 </div>;
}
function DebugTask({ task, onFinish }: { task: Task; onFinish: (failed: boolean) => void }) { return <div className="dp-debug-task"><strong>{task.title}</strong><small>{taskLabels[task.status]} · 排队 {task.queue.length} 条</small><div><button disabled={task.status !== 'running'} onClick={() => onFinish(false)}><Check size={13} />完成这轮</button><button disabled={task.status !== 'running'} onClick={() => onFinish(true)}><Pause size={13} />模拟失败</button></div></div>; }
