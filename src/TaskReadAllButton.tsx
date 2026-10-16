import { useRef, useState } from 'react';
import { CheckCheck } from 'lucide-react';

/** Changes notification state only. The caller captures the exact visible receipts. */
export function TaskReadAllButton({ count, onReadAll }: { count: number; onReadAll: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  async function read() {
    if (pending.current || count <= 0) return;
    pending.current = true; setBusy(true); setError('');
    try { await onReadAll(); }
    catch (e) { setError(e instanceof Error ? e.message : '没能清除提醒，再试一次？'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="task-read-all">
    <button type="button" className="task-read-all-button" disabled={busy || count <= 0} aria-busy={busy}
      title="只清除消息提醒，不停止或删除任务，也不代表已验收" onClick={() => void read()}>
      <CheckCheck size={16} aria-hidden="true"/><span>{busy ? '正在标为已读…' : count > 0 ? '全部标为已读' : '全部已读'}</span>
      {count > 0 ? <span className="task-read-all-count">未读 {count} 条</span> : null}
    </button>
    {error ? <small role="alert">{error}</small> : null}
  </div>;
}
