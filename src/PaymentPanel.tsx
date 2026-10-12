import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Zap } from "lucide-react";
import type { api as apiType } from "./oneApi";
import { MembershipPanel } from "./MembershipPanel";
import type { MembershipProduct } from "../server/memberships";
import { SettingsDialog } from "./SettingsControls";
import { PriceNotices } from "./PriceNotices";
import { CacheUsageDetails } from "./CacheUsageDetails";
import { InfoHint } from './InfoHint';
import { allowanceRules } from './noviceUx';
type Order = { product?: {label:string;kind:string}; id: string; status: string; requestedMicros: number; amountCny: number; createdAt: string; expiresAt?: string };
const date = (s: string) => new Date(s).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function PaymentPanel({ api, userId, rate, balance = 0, reserved = 0, showPriceDetails = true, onPaid }: { api: typeof apiType; userId: string; rate: number; balance?: number; reserved?: number; showPriceDetails?: boolean; onPaid: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [pricesOpen, setPricesOpen] = useState(false), [revision, setRevision] = useState(0);
  const [product,setProduct]=useState<MembershipProduct|undefined>();
  const [purchaseNote,setPurchaseNote]=useState('');
  const [kind, setKind] = useState("usage");
  const refresh = useCallback(async () => { await onPaid(); setRevision(n => n + 1); }, [onPaid]);
  return <div className="power-dashboard">
    <MembershipPanel api={api} revision={revision} onChanged={refresh} onPurchase={(p,timing)=>{setProduct(p);setPurchaseNote(timing);setOpen(true);}} />

    {balance > 0 ? <section className="power-overview power-extra"><div className="power-overview-top"><span><Zap size={17} />额外额度 · 长期保留 <InfoHint label="额外额度说明">{allowanceRules}</InfoHint></span>{showPriceDetails ? <button type="button" className="power-price-link" onClick={() => setPricesOpen(true)}>计费详情<ChevronRight size={14} /></button> : null}</div><div className="power-overview-main"><div><strong>¥{(balance*rate/1e6).toFixed(2)}</strong><span>额度参考值 · 非现金余额</span></div></div>
    </section> : null}
    <section className="power-history"><div className="settings-tabs" aria-label="账单类型">{[["usage", "使用记录"], ["orders", "支付记录"], ["ledger", "额度变动"]].map(([id, label]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}</div>{showPriceDetails?<details className="billing-explanation"><summary>计费说明与价格通知</summary><PriceNotices key={userId} api={api} userId={userId}/><p>使用记录查看每次消耗；额度变动查看赠送、扣除和调整。</p><button type="button" onClick={()=>setPricesOpen(true)}>查看计费详情</button></details>:null}<BillingHistory key={kind} api={api} kind={kind} revision={revision} rate={rate} onPaid={refresh} /></section>
    {open && product ? <MembershipCheckout api={api} product={product} timing={purchaseNote} onPaid={refresh} onClose={() => setOpen(false)} /> : null}
    {pricesOpen ? <SettingsDialog title="当前计费价格" onClose={() => setPricesOpen(false)}><CurrentPrices api={api} /></SettingsDialog> : null}
  </div>;
}

function MembershipCheckout({ api, product, timing, onPaid, onClose }: { api: typeof apiType; product: MembershipProduct; timing:string; onPaid: () => Promise<void>; onClose: () => void }) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [payment,setPayment]=useState<{order:Order;qrCode:string|null}|null>(null);
  const operationId=useRef(crypto.randomUUID()),checking=useRef(false),credited=useRef(false);
  async function create(){
    if(busy)return;setBusy(true);setError('');
    try{setPayment(await api('/api/me/payments/wechat',{method:'POST',body:JSON.stringify({operationId:operationId.current,productId:product.id})}));}
    catch(e){setError(e instanceof Error?e.message:'暂时无法生成付款码，请重试');}finally{setBusy(false);}
  }
  const check=useCallback(async(manual=false)=>{
    if(!payment||checking.current||credited.current)return;
    checking.current=true;if(manual){setBusy(true);setError('');}
    try{
      const r=await api<{order:Order}>(`/api/me/payments/${encodeURIComponent(payment.order.id)}/check`,{method:'POST'});
      if(r.order.status==='paid'){credited.current=true;setPayment(p=>p?{...p,order:r.order}:p);setError('');await onPaid();}
      else if(manual)setError('暂未收到付款，稍后再试');
    }catch(e){if(manual)setError(e instanceof Error?e.message:'暂时无法核对，请稍后重试');}
    finally{checking.current=false;if(manual)setBusy(false);}
  },[api,payment,onPaid]);
  useEffect(()=>{
    if(!payment||payment.order.status!=='pending')return;
    const timer=window.setInterval(()=>{if(!document.hidden&&(!payment.order.expiresAt||Date.parse(payment.order.expiresAt)>Date.now()))void check();},5000);
    return()=>window.clearInterval(timer);
  },[payment,check]);
  return <SettingsDialog title={product.label} onClose={onClose}>
    {!payment?<><p className="membership-checkout-price">¥{(product.amountFen/100).toFixed(2)}</p><p>{timing}</p><p className="settings-caption">{product.kind==='membership'?'按月发放额度，未用完的月额度不累计。':'请核对交付安排。'} 此次为单次购买，不会自动续费。</p><button type="button" className="primary recharge-pay-button" disabled={busy} onClick={()=>void create()}>{busy?'正在生成付款码…':'生成微信付款码'}</button></>
      :payment.order.status==='paid'?<div className="recharge-success"><span><Check size={30}/></span><h3>支付成功</h3><p>{payment.order.product?.kind==='key'?'等待启动器交付，绑定后激活会员':'会员购买成功，生效时间可在会员详情查看'}</p><button type="button" className="primary recharge-pay-button" onClick={onClose}>完成</button></div>
      :<div className="recharge-qr"><strong>¥{payment.order.amountCny.toFixed(2)}</strong><p>{payment.order.product?.label??product.label}</p>{payment.qrCode?<img src={payment.qrCode} width={208} height={208} alt="微信付款二维码"/>:<p className="settings-empty">付款码暂未生成，请核对订单状态</p>}<p className="settings-caption">打开微信扫一扫</p><button type="button" className="secondary" disabled={busy} onClick={()=>void check(true)}>{busy?'正在核对…':'我已支付'}</button><p className="settings-caption">关闭后可在支付记录中核对订单</p></div>}
    {error?<p className="settings-inline-error" role="status">{error}</p>:null}
  </SettingsDialog>;
}

function CurrentPrices({ api }: { api: typeof apiType }) {
  const [prices, setPrices] = useState<any[] | null>(null), [query, setQuery] = useState(""), [page, setPage] = useState(1), [error, setError] = useState("");
  useEffect(() => { const abort = new AbortController(); api<{ prices: any[] }>("/api/pricing", { signal: abort.signal }).then(r => setPrices(r.prices)).catch(() => { if (!abort.signal.aborted) setError("暂时无法加载价格"); }); return () => abort.abort(); }, [api]);
  const filtered = (prices || []).filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <><p className="settings-caption">以下为实际费率，已包含优惠或服务费。计量单位由模型计算，不等于字数；每次实际消耗请查看账单。</p><input className="settings-search-input" aria-label="搜索模型价格" type="search" placeholder="搜索模型" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /><div className="price-list">{filtered.slice((page - 1) * 6, page * 6).map(p => <article key={p.id}><strong>{p.name}</strong><span>{p.pricing?.label || "当前价格"}</span>{p.pricing?.longContext ? <small>≤ {p.pricing.longContext.thresholdInputTokens.toLocaleString()} 输入计量单位</small> : null}<p>{p.image !== undefined ? `${p.image} 额度 / 次` : `输入 ${p.input} / 输出 ${p.output} 电力 / 百万计量单位`}</p>{p.cachePrices ? <details><summary>缓存价格</summary><p>缓存读取 {p.cachePrices.read} / 基础写入 {p.cachePrices.write} / 1 小时写入 {p.cachePrices.write1h} 电力 / 百万计量单位</p></details> : null}{p.pricing?.longContext ? <details><summary>&gt; {p.pricing.longContext.thresholdInputTokens.toLocaleString()} 输入计量单位</summary><p>输入 {p.pricing.longContext.referenceInput * p.pricing.multiplier} / 输出 {p.pricing.longContext.referenceOutput * p.pricing.multiplier} 电力 / 百万计量单位</p>{p.pricing.longContext.referenceCache ? <p>缓存读取 {p.pricing.longContext.referenceCache.read * p.pricing.multiplier} / 基础写入 {p.pricing.longContext.referenceCache.write * p.pricing.multiplier} / 1 小时写入 {p.pricing.longContext.referenceCache.write1h * p.pricing.multiplier} 电力 / 百万计量单位</p> : null}<p>输入含缓存，超过阈值后整次调用采用此档；历史账单保留原价格。</p></details> : null}</article>)}</div>{error || !prices || !filtered.length ? <p className="settings-empty">{error || (!prices ? "正在加载…" : "暂无匹配模型")}</p> : null}<Pagination page={page} total={filtered.length} size={6} onChange={setPage} /></>;
}
function Pagination({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  if(total<=size)return null;
  return <div className="settings-pagination"><button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(total / size))}</span><button type="button" disabled={page * size >= total} onClick={() => onChange(page + 1)}>下一页</button></div>;
}
function BillingHistory({ api, kind, revision, rate, onPaid }: { api: typeof apiType; kind: string; revision: number; rate:number; onPaid: () => Promise<void> }) {
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
  return <div className="billing-history">{error ? <p className="settings-inline-error" role="status">{error}</p> : null}{!data ? <p className="settings-empty">{error ? "账单暂不可用" : "正在加载…"}</p> : !data.items.length ? <p className="settings-empty">{kind === "usage" ? "还没有消耗记录" : kind === "orders" ? "还没有支付记录" : "还没有额度流水"}</p> : data.items.map(row => <details className="billing-row" key={row.id}><summary><span><strong>{kind === "orders" ? row.product?.label??"微信充值" : row.title || row.modelNameSnapshot || "模型调用"}</strong><small>{date(row.createdAt)}{row.status ? ` · ${statuses[row.status] || "已结算"}` : ""}</small></span><span className="billing-row-amount">{kind === "orders" ? `¥${row.amountCny.toFixed(2)}` : `¥${((row.amountMicros ?? row.chargedMicros ?? 0) * rate / 1e6).toLocaleString("zh-CN", {maximumFractionDigits: 4})}（额度参考值）`}<ChevronRight size={15} /></span></summary><div className="billing-row-detail">{kind === "usage" ? <CacheUsageDetails row={row} /> : null}{kind === "orders" ? <><p>{row.product?`${row.product.label}${row.membershipActivatedAt?" · 已激活":""}`:`补充额外额度 · 实付 ¥${row.amountCny.toFixed(2)}`}</p>{row.status === "pending" ? <button type="button" className="secondary" disabled={busy} onClick={() => void check(row.id)}>核对支付</button> : null}</> : null}<p className="billing-order-id">编号 {row.id}</p></div></details>)}{data ? <Pagination page={page} total={data.total} size={data.pageSize} onChange={setPage} /> : null}</div>;
}
