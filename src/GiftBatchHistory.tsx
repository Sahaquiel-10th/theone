import { useEffect, useState } from "react";
import type { api as apiType } from "./oneApi";
export function GiftBatchHistory({ api, revision }: { api: typeof apiType; revision: string }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(1), [selected, setSelected] = useState(""), [detailPage, setDetailPage] = useState(1);
  const [data, setData] = useState<any>(null), [detail, setDetail] = useState<any>(null), [error, setError] = useState("");
  useEffect(() => { if (!open) return; const c = new AbortController(); setError(""); setData(null);
    api(`/api/admin/power/gift-batches?page=${page}`, { signal: c.signal }).then(setData).catch(e => { if (!c.signal.aborted) setError(e.message); }); return () => c.abort(); }, [api, open, page, revision]);
  useEffect(() => { setDetail(null); if (!selected) return; const c = new AbortController();
    api(`/api/admin/power/gift-batches/${encodeURIComponent(selected)}?page=${detailPage}`, { signal: c.signal }).then(setDetail).catch(e => { if (!c.signal.aborted) setError(e.message); }); return () => c.abort(); }, [api, selected, detailPage]);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>赠送批次</summary>{error ? <p>{error}</p> : null}{data?.items.map((b: any) => <div key={b.id}><p>{b.title} · {b.count} 人 · 每人 {b.amountMicros / 1e6} 电力<br />{b.createdAt} · {b.id}</p><button onClick={() => { setSelected(selected === b.id ? "" : b.id); setDetailPage(1); }}>明细</button>{selected === b.id ? <div>{detail?.items.map((e: any) => <p key={e.id}>{e.username} +{e.amountMicros / 1e6} 电力</p>)}<button disabled={detailPage <= 1} onClick={() => setDetailPage(p => p - 1)}>上一页</button><button disabled={!detail || detailPage * 10 >= detail.total} onClick={() => setDetailPage(p => p + 1)}>下一页</button></div> : null}</div>)}<button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><span> 第 {page} 页 </span><button disabled={!data || page * 10 >= data.total} onClick={() => setPage(p => p + 1)}>下一页</button></details>;
}
