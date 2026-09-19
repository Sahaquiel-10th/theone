import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Wallet, Zap } from "lucide-react";
import type { api as apiType } from "./oneApi";
import { SettingsDialog } from "./SettingsControls";
import { PriceNotices } from "./PriceNotices";
type Order = { id: string; status: string; requestedMicros: number; amountCny: number; createdAt: string; expiresAt?: string };
const power = (n = 0) => (n / 1e6).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const date = (s: string) => new Date(s).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function PaymentPanel({ api, rate, balance = 0, reserved = 0, onPaid }: { api: typeof apiType; rate: number; balance?: number; reserved?: number; onPaid: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [pricesOpen, setPricesOpen] = useState(false), [revision, setRevision] = useState(0);
  const [spent, setSpent] = useState<number | null>(null), [kind, setKind] = useState("usage");
  useEffect(() => { const abort = new AbortController(); api<{ spentMicros: number }>("/api/me/billing/summary", { signal: abort.signal }).then(r => setSpent(r.spentMicros)).catch(() => setSpent(null)); return () => abort.abort(); }, [api, revision]);
  const refresh = useCallback(async () => { await onPaid(); setRevision(n => n + 1); }, [onPaid]);
  const percent = spent === null ? null : balance + spent > 0 ? Math.max(0, Math.min(100, balance / (balance + spent) * 100)) : 0;
  return <div className="power-dashboard">
    <PriceNotices api={api} />
    <section className="power-overview"><div className="power-overview-top"><span><Zap size={17} />我的电力</span><button type="button" className="power-price-link" onClick={() => setPricesOpen(true)}>计费价格<ChevronRight size={14} /></button></div><div className="power-overview-main"><div><strong>{power(balance)}</strong><span>电力余额</span></div><button type="button" className="primary" onClick={() => setOpen(true)}><Wallet size={17} />充值</button></div>
      {percent !== null ? <><progress aria-label="电力余额占余额与累计消耗的比例" max={100} value={percent} /><div className="power-overview-foot"><span>累计消耗 {power(spent!)} 电力</span><span>剩余 {percent > 0 && percent < 0.1 ? "< 0.1" : percent.toFixed(1)}%</span></div></> : null}
      {reserved > 0 ? <p className="power-reserved">处理中 {power(reserved)} · 当前可用 {power(Math.max(0, balance - reserved))} 电力</p> : null}
    </section>
    <section className="power-history"><div className="settings-tabs" aria-label="账单类型">{[["usage", "消耗明细"], ["orders", "充值记录"], ["ledger", "电力流水"]].map(([id, label]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}</div><BillingHistory key={kind} api={api} kind={kind} revision={revision} onPaid={refresh} /></section>
    {open ? <RechargeDialog api={api} rate={rate} onPaid={refresh} onClose={() => setOpen(false)} /> : null}
    {pricesOpen ? <SettingsDialog title="当前计费价格" onClose={() => setPricesOpen(false)}><CurrentPrices api={api} /></SettingsDialog> : null}
  </div>;
}

function RechargeDialog({ api, rate, onPaid, onClose }: { api: typeof apiType; rate: number; onPaid: () => Promise<void>; onClose: () => void }) {
  const [amount, setAmount] = useState("5"), [custom, setCustom] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [payment, setPayment] = useState<{ order: Order; qrCode: string | null } | null>(null);
  const pending = useRef<{ operationId: string; amountFen: number } | null>(null), checking = useRef(false), credited = useRef(false);
  const yuan = amount === "custom" ? custom : amount;
  const valid = /^\d+(\.\d{1,2})?$/.test(yuan) && Number(yuan) >= 0.01 && Number(yuan) <= 10000 && rate > 0;
  async function create() {
    if (busy || (!pending.current && !valid)) return;
    setBusy(true); setError("");
    pending.current ??= { operationId: crypto.randomUUID(), amountFen: Math.round(Number(yuan) * 100) };
    try { setPayment(await api("/api/me/payments/wechat", { method: "POST", body: JSON.stringify(pending.current) })); }
    catch (e) { setError(e instanceof Error ? e.message : "暂时无法生成付款码，请重试"); } finally { setBusy(false); }
  }
  const check = useCallback(async (manual = false) => {
    if (!payment || checking.current || credited.current) return;
    checking.current = true; if (manual) { setBusy(true); setError(""); }
    try {
      const r = await api<{ order: Order }>(`/api/me/payments/${encodeURIComponent(payment.order.id)}/check`, { method: "POST" });
      if (r.order.status === "paid") { credited.current = true; setPayment(p => p ? { ...p, order: r.order } : p); setError(""); await onPaid(); }
      else if (manual) setError("暂未收到付款，稍后再试");
    } catch (e) { if (manual) setError(e instanceof Error ? e.message : "暂时无法核对，请稍后重试"); }
    finally { checking.current = false; if (manual) setBusy(false); }
  }, [api, payment, onPaid]);
  useEffect(() => {
    if (!payment || payment.order.status !== "pending") return;
    const timer = window.setInterval(() => { if (!document.hidden && (!payment.order.expiresAt || Date.parse(payment.order.expiresAt) > Date.now())) void check(); }, 5000);
    return () => window.clearInterval(timer);
  }, [payment, check]);
  return <SettingsDialog title="充值电力" onClose={onClose}>
    {!payment ? <PriceNotices api={api} /> : null}
    {!payment ? <><p className="settings-caption">选择充值金额（元）</p><div className="recharge-amount-grid">{["5", "10", "15", "20", "50", "100", "custom"].map(n => <button type="button" key={n} disabled={!!pending.current} aria-pressed={amount === n} onClick={() => setAmount(n)}>{n === "custom" ? "自定义" : <><small>¥</small>{n}</>}</button>)}</div>{amount === "custom" ? <label className="recharge-custom">充值金额<input autoFocus type="number" min="0.01" max="10000" step="0.01" placeholder="最低 ¥0.01" value={custom} disabled={!!pending.current} onChange={e => setCustom(e.target.value)} /></label> : null}<div className="recharge-preview"><span>预计到账</span><strong>{valid ? power(Math.floor(Math.round(Number(yuan) * 100) * 10000 / rate)) : "—"}<small> 电力</small></strong></div><p className="settings-caption">¥{rate} / 电力 · 优惠按实际消耗计费</p><button type="button" className="primary recharge-pay-button" disabled={busy || (!pending.current && !valid)} onClick={() => void create()}>{busy ? "正在生成付款码…" : pending.current ? "重试生成付款码" : "微信支付"}</button></>
      : payment.order.status === "paid" ? <div className="recharge-success"><span><Check size={30} /></span><h3>充值成功</h3><p>{power(payment.order.requestedMicros)} 电力已到账</p><button type="button" className="primary recharge-pay-button" onClick={onClose}>完成</button></div>
      : <div className="recharge-qr"><strong>¥{payment.order.amountCny.toFixed(2)}</strong><p>到账 {power(payment.order.requestedMicros)} 电力</p>{payment.qrCode ? <img src={payment.qrCode} width={208} height={208} alt="微信付款二维码" /> : <p className="settings-empty">付款码暂未生成，请核对订单状态</p>}<p className="settings-caption">打开微信扫一扫</p><button type="button" className="secondary" disabled={busy} onClick={() => void check(true)}>{busy ? "正在核对…" : "我已支付"}</button><p className="settings-caption">关闭后可在充值记录中核对订单</p></div>}
    {error ? <p className="settings-inline-error" role="status">{error}</p> : null}
  </SettingsDialog>;
}

function CurrentPrices({ api }: { api: typeof apiType }) {
  const [prices, setPrices] = useState<any[] | null>(null), [query, setQuery] = useState(""), [page, setPage] = useState(1), [error, setError] = useState("");
  useEffect(() => { const abort = new AbortController(); api<{ prices: any[] }>("/api/pricing", { signal: abort.signal }).then(r => setPrices(r.prices)).catch(() => { if (!abort.signal.aborted) setError("暂时无法加载价格"); }); return () => abort.abort(); }, [api]);
  const filtered = (prices || []).filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <><input className="settings-search-input" aria-label="搜索模型价格" type="search" placeholder="搜索模型" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /><div className="price-list">{filtered.slice((page - 1) * 6, page * 6).map(p => <article key={p.id}><strong>{p.name}</strong><span>{p.pricing?.label || "当前价格"}</span><p>{p.image !== undefined ? `${p.image} 电力 / 次` : `输入 ${p.input} / 输出 ${p.output} 电力 / 百万 Token`}</p></article>)}</div>{error || !prices || !filtered.length ? <p className="settings-empty">{error || (!prices ? "正在加载…" : "暂无匹配模型")}</p> : null}<Pagination page={page} total={filtered.length} size={6} onChange={setPage} /></>;
}
function Pagination({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  return <div className="settings-pagination"><button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(total / size))}</span><button type="button" disabled={page * size >= total} onClick={() => onChange(page + 1)}>下一页</button></div>;
}
function BillingHistory({ api, kind, revision, onPaid }: { api: typeof apiType; kind: string; revision: number; onPaid: () => Promise<void> }) {
  const [page, setPage] = useState(1), [error, setError] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [data, setData] = useState<{ items: any[]; total: number; pageSize: number } | null>(null);
  useEffect(() => { const abort = new AbortController(); setData(null); setError("");
    api<any>(`/api/me/billing/history?kind=${kind}&page=${page}`, { signal: abort.signal }).then(setData).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort(); }, [api, kind, page, revision, reload]);
  async function check(id: string) {
    setBusy(true); setError("");
    try { const result = await api<{ order: Order }>(`/api/me/payments/${encodeURIComponent(id)}/check`, { method: "POST" }); if (result.order.status === "paid") { await onPaid(); setReload(n => n + 1); } else setError("暂未收到付款"); }
    catch (e) { setError(e instanceof Error ? e.message : "核对失败"); } finally { setBusy(false); }
  }
  const statuses: Record<string, string> = { pending: "处理中", success: "已完成", failed: "未完成", needs_review: "待核对", waived: "未扣费", paid: "已支付", cancelled: "已取消" };
  return <div className="billing-history">{error ? <p className="settings-inline-error" role="status">{error}</p> : null}{!data ? <p className="settings-empty">{error ? "账单暂不可用" : "正在加载…"}</p> : !data.items.length ? <p className="settings-empty">{kind === "usage" ? "还没有消耗记录" : kind === "orders" ? "还没有充值记录" : "还没有电力流水"}</p> : data.items.map(row => <details className="billing-row" key={row.id}><summary><span><strong>{kind === "orders" ? "微信充值" : row.title || row.modelNameSnapshot || "模型调用"}</strong><small>{date(row.createdAt)}{row.status ? ` · ${statuses[row.status] || "已结算"}` : ""}</small></span><span className="billing-row-amount">{kind === "orders" ? `¥${row.amountCny.toFixed(2)}` : `${power(row.amountMicros ?? row.chargedMicros)} 电力`}<ChevronRight size={15} /></span></summary><div className="billing-row-detail">{kind === "usage" ? <><p>输入 {row.inputTokens} / 输出 {row.outputTokens} Token</p>{row.pricingSnapshot ? <p>{row.pricingSnapshot.label} · ×{row.pricingSnapshot.multiplier}</p> : null}</> : null}{kind === "orders" ? <><p>到账 {power(row.requestedMicros)} 电力</p>{row.status === "pending" ? <button type="button" className="secondary" disabled={busy} onClick={() => void check(row.id)}>核对支付</button> : null}</> : null}<p className="billing-order-id">编号 {row.id}</p></div></details>)}{data ? <Pagination page={page} total={data.total} size={data.pageSize} onChange={setPage} /> : null}</div>;
}
