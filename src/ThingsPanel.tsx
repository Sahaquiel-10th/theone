import { useRef, useState, type ReactNode } from "react";
import {useFollowLatest} from './useFollowLatest';
import { MessageMarkdown } from "./MessageMarkdown";
import "./things-panel.css";
import { transferStateLabel } from "./noviceUx";
import { Zap } from "lucide-react";

type Thing = {
  id: string;
  title: string;
  updatedAt: string;
  archived?: boolean;
  messages: { id?: string; role: string; content: string }[];
  messagesLoaded?: boolean;
  taskState?: 'active' | 'review' | 'ended' | 'history';
  outcome?: string;
  unread?: boolean;
};
export function ThingsPanel({
  one,
  items,
  selectedId,
  drafts,
  onDraftChange,
  onSelect,
  onSend,
  onWorkbench,
  hasMore,
  onMore,
  loadingMore,
  executionDisabled = false,
  executionPreparing = false,
  executionContent,
  destinationPicker,
  sendLabel = '发送',
  onExecuteDraft,
  onRemove,
  taskNotice,
}: {
  one?: ReactNode;
  items: Thing[];
  selectedId: string;
  drafts: Record<string, string>;
  onDraftChange: (id: string, text: string) => void;
  onSelect: (id: string) => void;
  onSend: (id: string, text: string) => void | Promise<void>;
  onWorkbench: (id: string) => void;
  onRemove?: (id:string)=>Promise<void>;
  taskNotice?: ReactNode;
  hasMore: boolean;
  onMore: () => void;
  loadingMore: boolean;
  executionDisabled?: boolean;
  executionPreparing?: boolean;
  executionContent?: ReactNode;
  destinationPicker?: ReactNode;
  sendLabel?: string;
  onExecuteDraft?: (id: string, text: string, source: HTMLElement) => Promise<void>;
}) {
  const [sending, setSending] = useState<string[]>([]),
    [errors, setErrors] = useState<Record<string,string>>({});
  const inFlight = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const [category,setCategory]=useState<'active'|'review'|'ended'|'history'>('active');
  const [page, setPage] = useState(1);
  const selected = items.find((item) => item.id === selectedId && !item.archived);
  const reviewUnread=items.filter(item=>!item.archived&&item.taskState==='review'&&item.unread).length;
  const found = items.filter((item) =>
    !item.archived && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (item.taskState||'history')===category,
  );
  const pages = Math.max(1, Math.ceil(found.length / 10)),
    current = Math.min(page, pages);
  const draft = drafts[selectedId] || "";
  const {scroll: messagesRef, onScroll} = useFollowLatest(selectedId, Boolean(selected));
  return (
    <section className="things-browser" aria-label="任务列表与对话">
      <aside className="things-list">
        <header className="things-list-heading">
          <h2>任务</h2>
          {one}
        </header>
        <input
          aria-label="搜索任务和历史对话"
          placeholder="搜索当前列表"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        <nav className="task-category-tabs" aria-label="任务状态">{([['active','进行中'],['review','待确认'],['ended','已结束'],['history','历史对话']] as const).map(([id,label])=><button type="button" key={id} aria-pressed={category===id} onClick={()=>{setCategory(id);setPage(1);setQuery('');}}>{label}{id==='review'&&reviewUnread?<span className="task-review-dot" aria-label={`${reviewUnread} 个结果尚未查看`}/>:null}</button>)}</nav>
        <div className="things-list-items">
          {found.slice((current - 1) * 10, current * 10).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={selectedId === item.id ? "true" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <strong>{item.title}{item.unread?<span className="task-review-dot" aria-label="结果尚未查看"/>:null}</strong>
              <small>
                {item.taskState==='active'?'正在处理 · ':item.taskState==='review'||item.taskState==='ended'?`${item.outcome?transferStateLabel(item.outcome):'已结束 · 查看回执'} · `:'历史对话 · '}{new Date(item.updatedAt).toLocaleDateString("zh-CN")}
              </small>
            </button>
          ))}
          {!found.length ? <p>{query?'已加载的当前列表中没有匹配记录。':category==='active'?'目前没有进行中的任务。新结果在“待确认”，看过的工作在“已结束”。':category==='review'?'没有待确认的结果。新成果和需要你处理的任务会显示在这里。':'这里暂时没有记录。'}</p> : null}
        </div>
        {pages > 1 ? (
          <footer>
            <button
              type="button"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              type="button"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </button>
          </footer>
        ) : null}
        {hasMore ? (
          <button type="button" disabled={loadingMore} onClick={onMore}>
            {loadingMore ? "正在加载" : "加载更早记录"}
          </button>
        ) : null}
      </aside>
      <section className="things-thread" aria-label="任务完整对话">
        {selected ? (
          <>
            <header>
              <h2>{selected.title}</h2>
              <div className="things-thread-actions">
              {onRemove?<button type="button" onClick={()=>{if(confirm('删除任务并停止待办？历史保留，可恢复；已发生的操作不会撤销。'))void onRemove(selected.id).catch(e=>setErrors(old=>({...old,[selected.id]:e.message})));}}>删除任务</button>:null}
              <button type="button" onClick={() => onWorkbench(selected.id)}>
                在工作台继续 ↗
              </button>
              </div>
            </header>
            {taskNotice}
            <div className="things-thread-messages" ref={messagesRef} onScroll={onScroll}>
              {selected.messagesLoaded === false ? (
                <p>正在打开…</p>
              ) : selected.messages.length ? (
                selected.messages.map((message, index) => (
                  <article key={message.id || index} className={message.role}>
                    <small>{message.role === "user" ? "你" : "ONE"}</small>
                    {message.role === "assistant" ? (
                      <MessageMarkdown>{message.content}</MessageMarkdown>
                    ) : (
                      <p>{message.content}</p>
                    )}
                  </article>
                ))
              ) : (
                <p>此任务还没有消息。</p>
              )}
            </div>
            {executionContent}
            {destinationPicker}
            {errors[selectedId] ? <p className="things-send-error" role="alert">{errors[selectedId]}</p> : null}
            {(
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!draft.trim() || inFlight.current.has(selected.id) || selected.messagesLoaded === false) return;
                  const id = selected.id,
                    original = draft;
                  inFlight.current.add(id);
                  setSending((old) => [...old, id]);
                  setErrors(old=>({...old,[id]:''}));
                  try {
                    await onSend(id, original);
                    onDraftChange(id, "");
                  } catch (e) {
                    setErrors(old=>({...old,[id]:e instanceof Error ? e.message : "发送未完成，草稿已保留"}));
                  } finally {
                    inFlight.current.delete(id);
                    setSending((old) => old.filter((item) => item !== id));
                  }
                }}
              >
                <textarea
                  aria-label="直接继续此任务"
                  placeholder="继续此任务…"
                  value={draft}
                  disabled={sending.includes(selected.id) || selected.messagesLoaded === false}
                  onChange={(event) =>
                    onDraftChange(selected.id, event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <button
                  id="one-things-send"
                  type="submit"
                  disabled={!draft.trim() || sending.includes(selected.id) || selected.messagesLoaded === false}
                >
                  {sending.includes(selected.id) ? "接收中" : sendLabel}
                </button>
                {onExecuteDraft ? <button className="things-compose-execute" type="button" disabled={!draft.trim()||executionDisabled||executionPreparing||sending.includes(selected.id)||selected.messagesLoaded===false} onClick={event=>{setErrors(old=>({...old,[selected.id]:''}));void onExecuteDraft(selected.id,draft,event.currentTarget).catch(e=>setErrors(old=>({...old,[selected.id]:e instanceof Error?e.message:'执行未确认，草稿已保留'})));}}><Zap size={14} aria-hidden="true"/><span>本机执行</span></button> : null}
              </form>
            )}
          </>
        ) : (
          <div className="things-thread-empty">选择一个任务，查看结果或继续聊。</div>
        )}
      </section>
    </section>
  );
}
