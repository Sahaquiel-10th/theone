import { useState, type ReactNode } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import "./things-panel.css";

type Thing = {
  id: string;
  title: string;
  updatedAt: string;
  messages: { id?: string; role: string; content: string }[];
  messagesLoaded?: boolean;
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
}: {
  one?: ReactNode;
  items: Thing[];
  selectedId: string;
  drafts: Record<string, string>;
  onDraftChange: (id: string, text: string) => void;
  onSelect: (id: string) => void;
  onSend?: (id: string, text: string) => void;
  onWorkbench: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
  loadingMore: boolean;
}) {
  const [sending, setSending] = useState<string[]>([]),
    [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const selected = items.find((item) => item.id === selectedId);
  const found = items.filter((item) =>
    item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(found.length / 10)),
    current = Math.min(page, pages);
  const draft = drafts[selectedId] || "";
  return (
    <section className="things-browser" aria-label="事情列表与对话">
      <aside className="things-list">
        <header className="things-list-heading">
          <h2>事情</h2>
          {one}
        </header>
        <input
          aria-label="搜索事情"
          placeholder="搜索事情"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        <div className="things-list-items">
          {found.slice((current - 1) * 10, current * 10).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={selectedId === item.id ? "true" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <strong>{item.title}</strong>
              <small>
                {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
              </small>
            </button>
          ))}
          {!found.length ? <p>还没有找到这件事。</p> : null}
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
            {loadingMore ? "正在加载" : "加载更多记录"}
          </button>
        ) : null}
      </aside>
      <section className="things-thread" aria-label="事情完整对话">
        {selected ? (
          <>
            <header>
              <h2>{selected.title}</h2>
              <button type="button" onClick={() => onWorkbench(selected.id)}>
                放到工作台 ↗
              </button>
            </header>
            <div className="things-thread-messages">
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
                <p>这件事还没开始。</p>
              )}
            </div>
            {error ? <p role="alert">{error}</p> : null}
            {onSend ? (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!draft.trim() || sending.includes(selected.id)) return;
                  const id = selected.id,
                    original = draft;
                  setSending((old) => [...old, id]);
                  setError("");
                  try {
                    await onSend(id, original);
                    onDraftChange(id, "");
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : "发送未完成，草稿已保留",
                    );
                  } finally {
                    setSending((old) => old.filter((item) => item !== id));
                  }
                }}
              >
                <textarea
                  aria-label="直接继续这件事"
                  placeholder="继续这件事…"
                  value={draft}
                  disabled={sending.includes(selected.id)}
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
                  type="submit"
                  disabled={!draft.trim() || sending.includes(selected.id)}
                >
                  {sending.includes(selected.id) ? "接收中" : "发送"}
                </button>
              </form>
            ) : null}
          </>
        ) : (
          <div className="things-thread-empty">选一件事，接着聊。</div>
        )}
      </section>
    </section>
  );
}
