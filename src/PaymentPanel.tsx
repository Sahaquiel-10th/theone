import { useEffect, useRef, useState } from "react";
import type { api as apiType } from "./oneApi";
type Order = { id: string; status: string; requestedMicros: number; amountCny: number; createdAt: string; expiresAt?: string };
const power = (n: number = 0) => (n / 1e6).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
export function PaymentPanel({ api, rate, onPaid }: { api: typeof apiType; rate: number; onPaid: () => Promise<void> }) {
  const [amount, setAmount] = useState("10"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [payment, setPayment] = useState<{ order: Order; qrCode: string | null } | null>(null);
  const pending = useRef<{ operationId: string; power: number } | null>(null);
  async function create() {
    if (busy) return; setBusy(true); setError("");
    pending.current ??= { operationId: crypto.randomUUID(), power: Number(amount) };
    try { setPayment(await api("/api/me/payments/wechat", { method: "POST", body: JSON.stringify(pending.current) })); }
    catch (e) { setError(e instanceof Error ? e.message : "支付创建失败"); } finally { setBusy(false); }
  }
  async function check(id: string) {
    setBusy(true); setError("");
    try { const r = await api<{ order: Order }>(`/api/me/payments/${encodeURIComponent(id)}/check`, { method: "POST" });
      if (payment?.order.id === id) setPayment({ ...payment, order: r.order });
      setError(r.order.status === "paid" ? "电力已到账" : "暂未收到付款，请稍后核对"); await onPaid();
    } catch (e) { setError(e instanceof Error ? e.message : "核对失败"); } finally { setBusy(false); }
  }
  return <><div className="recharge-inline"><select value={amount} disabled={!!pending.current} onChange={e => setAmount(e.target.value)}>{[10, 50, 100, 500].map(n => <option key={n} value={n}>{n} 电力</option>)}</select><span>¥{(Number(amount) * rate).toFixed(2)}</span><button className="primary" disabled={busy} onClick={() => void create()}>微信充值</button></div>
    <p>充值 100 电力，到账 100 电力。优惠或服务费按使用时公布的价格计算。</p><CurrentPrices api={api} />
    {payment ? <div>{payment.order.status === "paid" ? <p>电力已到账</p> : payment.qrCode ? <img src={payment.qrCode} width={200} height={200} alt="微信扫码支付" /> : <p>订单已保留，请核对付款状态</p>}<p>订单 {payment.order.id}</p><button className="secondary" disabled={busy} onClick={() => void check(payment.order.id)}>核对支付结果</button><button className="secondary" disabled={busy} onClick={() => { pending.current = null; setPayment(null); }}>返回</button></div> : null}
    {error ? <p role="status">{error}</p> : null}
    <BillingHistory api={api} kind="orders" title="充值记录" onCheck={check} />
    <BillingHistory api={api} kind="usage" title="消耗明细" />
    <BillingHistory api={api} kind="ledger" title="电力流水（含赠送）" />
  </>;
}
function CurrentPrices({ api }: { api: typeof apiType }) {
  const [prices, setPrices] = useState<any[]>([]);
  useEffect(() => { const abort = new AbortController(); api<{ prices: any[] }>("/api/pricing", { signal: abort.signal }).then(r => setPrices(r.prices)).catch(() => {}); return () => abort.abort(); }, [api]);
  return <details><summary>当前计费价格</summary>{prices.map(p => <p key={p.id}>{p.name} · {p.pricing ? `${p.pricing.label} ×${p.pricing.multiplier} · v${p.pricing.version}` : "当前价格"}<br />{p.image !== undefined ? `${p.image} 电力 / 次` : `输入 ${p.input} / 输出 ${p.output} 电力 / 百万 Token`}</p>)}</details>;
}
function BillingHistory({ api, kind, title, onCheck }: { api: typeof apiType; kind: string; title: string; onCheck?: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(1), [error, setError] = useState("");
  const [data, setData] = useState<{ items: any[]; total: number; pageSize: number } | null>(null);
  useEffect(() => { if (!open) return; const abort = new AbortController(); setData(null); setError("");
    api<any>(`/api/me/billing/history?kind=${kind}&page=${page}`, { signal: abort.signal }).then(setData).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort(); }, [api, kind, page, open]);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>{title}</summary>{error ? <p>{error}</p> : null}<div className="mini-ledger">{data?.items.map(row => <div key={row.id}><span><strong>{row.title || (kind === "orders" ? `微信充值 · ${row.status === "paid" ? "已支付" : "待核对"}` : `${row.activity || "模型调用"} · ${row.status || "已结算"}`)}</strong><small>{new Date(row.createdAt).toLocaleString("zh-CN")}</small><details><summary>详情</summary><p>编号：{row.id}</p>{kind === "usage" ? <p>输入 {row.inputTokens} / 输出 {row.outputTokens} Token<br />{row.pricingSnapshot?.label} {row.pricingSnapshot ? `×${row.pricingSnapshot.multiplier} · 版本 ${row.pricingSnapshot.version}` : ""}</p> : null}{kind === "orders" ? <p>支付金额 ¥{row.amountCny.toFixed(2)}</p> : null}</details>{onCheck && row.status !== "paid" ? <button className="secondary" onClick={() => void onCheck(row.id)}>核对支付</button> : null}</span><b>{power(row.amountMicros ?? row.chargedMicros ?? row.requestedMicros)} 电力</b></div>)}</div><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><span> 第 {page} 页 </span><button disabled={!data || page * data.pageSize >= data.total} onClick={() => setPage(p => p + 1)}>下一页</button></details>;
}
