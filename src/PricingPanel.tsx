import { useState } from "react";
import type { api as apiType } from "./oneApi";
import { Pagination, SettingsDialog } from "./SettingsControls";
type CachePrices = { read: number; write: number; write1h: number };
type Price = { referenceInput: number; referenceOutput: number; referenceCache?: CachePrices; multiplier: number; version: number; label: string; effectiveAt?: string; publishedAt?: string; explanation?: string };
type PricedModel = { id: string; name?: string; kind?: string; imagePowerPerCall?: number; costImagePowerPerCall?: number; cacheCostPrices?: CachePrices; inputPowerPerMillion: number; outputPowerPerMillion: number; costInputPowerPerMillion: number; costOutputPowerPerMillion: number; pricing?: Price; pricingHistory?: { pricing: Price; cancelledAt?: string }[] };
const time = (s?: string) => s ? new Date(s).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + "（北京时间）" : "立即生效";
const fmt = (n: number) => Number(n.toFixed(6)).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
function supplierRatio(model: PricedModel): number | "" {
  const pairs = [[model.pricing?.referenceInput ?? model.inputPowerPerMillion, model.costInputPowerPerMillion], [model.pricing?.referenceOutput ?? model.outputPowerPerMillion, model.costOutputPowerPerMillion]];
  if (model.pricing?.referenceCache && model.cacheCostPrices) for (const key of ["read", "write", "write1h"] as const) pairs.push([model.pricing.referenceCache[key], model.cacheCostPrices[key]]);
  const ratios = pairs.filter(([base]) => base > 0).map(([base, cost]) => cost / base);
  return ratios.length && pairs.every(([base, cost]) => base > 0 || cost === 0) && ratios.every(r => Math.abs(r - ratios[0]) < 1e-8) ? Number(ratios[0].toFixed(8)) : "";
}
export function PricingPanel({ api, model, reload }: { api: typeof apiType; model: PricedModel; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="secondary" onClick={() => setOpen(true)}>配置价格与通知</button>{open ? <SettingsDialog title={`${model.name || "模型"} · 定价`} onClose={() => setOpen(false)}><PriceEditor key={`${model.id}-${model.pricingHistory?.length}-${model.pricingHistory?.filter(p => p.cancelledAt).length}`} api={api} model={model} reload={reload} /></SettingsDialog> : null}</>;
}
function PriceEditor({ api, model, reload }: { api: typeof apiType; model: PricedModel; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState({ referenceInput: model.pricing?.referenceInput ?? model.inputPowerPerMillion, referenceOutput: model.pricing?.referenceOutput ?? model.outputPowerPerMillion,
    multiplier: model.pricing?.multiplier ?? 0.8, procurementMultiplier: supplierRatio(model) });
  const [explanation, setExplanation] = useState(""), [schedule, setSchedule] = useState(false), [effectiveAt, setEffectiveAt] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [step, setStep] = useState(0);
  const [cacheEnabled, setCacheEnabled] = useState(Boolean(model.pricing?.referenceCache));
  const [cacheDraft, setCacheDraft] = useState({ read: String(model.pricing?.referenceCache?.read ?? ""), write: String(model.pricing?.referenceCache?.write ?? ""), write1h: String(model.pricing?.referenceCache?.write1h ?? "") });
  const pending = model.pricingHistory?.find(r => !r.cancelledAt && Date.parse(r.pricing.effectiveAt || "") > Date.now());
  async function publish() {
    if (![draft.referenceInput, draft.referenceOutput, draft.multiplier].every(Number.isFinite) || draft.referenceInput < 0 || draft.referenceOutput < 0 || draft.multiplier < .001 || draft.multiplier > 100) { setMessage("请检查官方价与对外系数"); return; }
    if (draft.procurementMultiplier === "" || !Number.isFinite(draft.procurementMultiplier) || draft.procurementMultiplier < 0) { setMessage("请填写进货系数；旧价格比例不一致时请重新确认"); return; }
    if (cacheEnabled && Object.values(cacheDraft).some(v => !v.trim() || !Number.isFinite(Number(v)) || Number(v) < 0)) { setMessage("请完整填写缓存官方价，不支持的项可填 0"); return; }
    if (!explanation.trim() || schedule && (!effectiveAt || Date.parse(effectiveAt + "+08:00") <= Date.now())) { setMessage("请填写调价说明及有效的生效时间"); return; }
    const date = schedule ? new Date(effectiveAt + "+08:00").toISOString() : undefined;
    if (!confirm(`发布价格与通知？\n${time(date)}\n用户输入 / 输出价格：${fmt(draft.referenceInput * draft.multiplier)} / ${fmt(draft.referenceOutput * draft.multiplier)} 电力 / 百万 Token\n${cacheEnabled ? "缓存读取 / 基础写入 / 1 小时：" + (["read", "write", "write1h"] as const).map(k => fmt(Number(cacheDraft[k]) * draft.multiplier)).join(" / ") + " 电力 / 百万 Token" : "未配置缓存价；真实缓存调用将进入待核对"}\n${explanation}`)) return;
    const cachePayload = cacheEnabled ? { referenceCache: Object.fromEntries(Object.entries(cacheDraft).map(([key, v]) => [key, Number(v)])) } : {};
    setBusy(true); try { await api(`/api/admin/models/${model.id}/pricing`, { method: "POST", body: JSON.stringify({ ...draft, ...cachePayload, explanation, effectiveAt: date }) }); await reload(); setMessage("价格与通知已发布"); }
    catch (e) { setMessage(e instanceof Error ? e.message : "发布失败"); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!confirm("撤回尚未生效的调价？用户端会保留已撤回记录。")) return;
    setBusy(true); try { await api(`/api/admin/models/${model.id}/pricing/scheduled`, { method: "DELETE" }); await reload(); } catch(e) { setMessage(e instanceof Error ? e.message : "撤回失败"); } finally { setBusy(false); }
  }
  const fields = (keys: (keyof typeof draft)[]) => <div className="pricing-field-grid">{keys.map(key => <label key={key}>{({ referenceInput: "输入", referenceOutput: "输出", multiplier: "对外消费系数", procurementMultiplier: "进货系数" })[key]}<input type="number" min={key === "multiplier" ? 0.001 : 0} step="0.000001" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value === "" && key === "procurementMultiplier" ? "" : Number(e.target.value) })} /></label>)}</div>;
  return <div className="pricing-editor"><p className="settings-caption">1 电力对应 1 美元计价单位。人民币充值汇率单独设置。</p>{pending ? <div className="pricing-preview"><strong>已有预约调价</strong><p>{time(pending.pricing.effectiveAt)}</p><p>{pending.pricing.explanation}</p><button type="button" className="secondary" disabled={busy} onClick={() => void cancel()}>撤回预约</button></div> : <>
    <div className="settings-tabs"><button type="button" aria-pressed={step === 0} onClick={() => setStep(0)}>1 · 配置价格</button><button type="button" aria-pressed={step === 1} onClick={() => setStep(1)}>2 · 通知与发布</button></div><div hidden={step !== 0}><h3>官方参考价 <small>美元 / 百万 Token</small></h3>{fields(["referenceInput", "referenceOutput"])}
    <h3>统一折扣系数 <small>进货与对外收费分别填一个系数，缓存自动使用相同系数</small></h3>{fields(["procurementMultiplier", "multiplier"])}<p className="settings-caption">例如进货系数 0.2 表示中转站成本为官方价 2 折；对外系数 0.8 表示用户按官方价 8 折，1.2 表示增加 20% 服务费。</p>
    <details className="pricing-cache"><summary>缓存官方价{cacheEnabled ? " · 已配置" : " · 未配置"}</summary><label className="check"><input type="checkbox" checked={cacheEnabled} onChange={e => setCacheEnabled(e.target.checked)} />启用缓存独立计价</label>{cacheEnabled ? <><div className="pricing-field-grid">{(["read", "write", "write1h"] as const).map(key => <label key={key}>{key === "read" ? "缓存读取" : key === "write" ? "基础写入 / 5 分钟" : "1 小时写入"}<input type="number" min="0" step="0.000001" value={cacheDraft[key]} onChange={e => setCacheDraft({ ...cacheDraft, [key]: e.target.value })} /></label>)}</div><p className="settings-caption">缓存采购价和用户价分别自动乘以进货系数、对外系数，不再重复填写。</p><p>用户缓存价格：{(["read", "write", "write1h"] as const).map(k => cacheDraft[k] === "" ? "—" : fmt(Number(cacheDraft[k]) * draft.multiplier)).join(" / ")} 电力 / 百万 Token</p></> : <p className="settings-caption">遇到真实缓存用量但未配置价格时，会保留为待核对，不按普通输入价扣费。</p>}</details>
    <div className="pricing-preview"><strong>{draft.multiplier < 1 ? `优惠期 · ${fmt(draft.multiplier * 10)} 折` : draft.multiplier > 1 ? `增加 ${fmt((draft.multiplier - 1) * 100)}% 服务费` : "官方原价"}</strong><p>用户输入 / 输出：{fmt(draft.referenceInput * draft.multiplier)} / {fmt(draft.referenceOutput * draft.multiplier)} 电力 / 百万 Token</p>{draft.procurementMultiplier === "" ? <p>旧进货价格比例不一致，请填写统一系数。</p> : <p>预计输入 / 输出毛利：${fmt(draft.referenceInput * (draft.multiplier - draft.procurementMultiplier))} / ${fmt(draft.referenceOutput * (draft.multiplier - draft.procurementMultiplier))} / 百万 Token</p>}</div>
    <button type="button" className="primary recharge-pay-button" onClick={() => setStep(1)}>下一步：填写通知</button></div><div hidden={step !== 1}><h3>通知与生效时间</h3><label>给用户的调价说明<textarea rows={3} maxLength={1000} placeholder="例如：内测优惠期，按官方参考价八折计费。" value={explanation} onChange={e => setExplanation(e.target.value)} /></label><div className="settings-tabs"><button type="button" aria-pressed={!schedule} onClick={() => setSchedule(false)}>立即生效</button><button type="button" aria-pressed={schedule} onClick={() => setSchedule(true)}>预约生效</button></div>{schedule ? <label>生效时间（北京时间）<input type="datetime-local" value={effectiveAt} onChange={e => setEffectiveAt(e.target.value)} /></label> : null}<div className="pricing-preview">用户输入 / 输出：{fmt(draft.referenceInput * draft.multiplier)} / {fmt(draft.referenceOutput * draft.multiplier)} 电力 / 百万 Token</div><button type="button" className="primary recharge-pay-button" disabled={busy || !explanation.trim()} onClick={() => void publish()}>发布价格与通知</button></div></>}
    {message ? <p role="status">{message}</p> : null}
    <details className="pricing-history"><summary>历史价格与通知</summary>{[...(model.pricingHistory || [])].reverse().slice((historyPage - 1) * 5, historyPage * 5).map(r => <article key={r.pricing.version}><strong>v{r.pricing.version} · {r.cancelledAt ? "已撤回" : r.pricing.label}</strong><p>{time(r.pricing.effectiveAt || r.pricing.publishedAt)}</p><p>{r.pricing.explanation || "原计费价格"}</p></article>)}<div className="settings-pagination"><button type="button" disabled={historyPage <= 1} onClick={() => setHistoryPage(historyPage - 1)}>上一页</button><span>{historyPage}</span><button type="button" disabled={historyPage * 5 >= (model.pricingHistory?.length || 0)} onClick={() => setHistoryPage(historyPage + 1)}>下一页</button></div></details>
  </div>;
}
export function PricingCatalog({ api, models, reload }: { api: typeof apiType; models: PricedModel[]; reload: () => Promise<void> }) {
  const [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const filtered = models.filter(m => (m.name || "").toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="pricing-catalog"><h3>模型与定价</h3><p className="settings-caption">配置官方价、进货系数和对外系数。</p><input type="search" aria-label="搜索定价模型" placeholder="搜索模型" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />{filtered.slice((page - 1) * 8, page * 8).map(m => <article key={m.id}><div><strong>{m.name}</strong><small>{m.kind === "image" ? `${fmt(m.imagePowerPerCall || 0)} 电力 / 张` : `${m.pricing?.label || "待确认价格"} · 输入 ${fmt(m.inputPowerPerMillion)} / 输出 ${fmt(m.outputPowerPerMillion)} 电力 / 百万 Token`}</small></div>{m.kind === "image" ? <ImagePriceEditor api={api} model={m} reload={reload} /> : <PricingPanel api={api} model={m} reload={reload} />}</article>)}{!filtered.length ? <p className="settings-empty">暂无匹配模型</p> : null}<Pagination page={page} total={filtered.length} size={8} onChange={setPage} /></section>;
}
function ImagePriceEditor({ api, model, reload }: { api: typeof apiType; model: PricedModel; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [price, setPrice] = useState(model.imagePowerPerCall || 0), [cost, setCost] = useState(model.costImagePowerPerCall || 0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save() {
    if (!confirm("保存图片按次计费价格？仅影响后续调用。")) return;
    setBusy(true); setError("");
    try { await api(`/api/admin/models/${model.id}`, { method: "PATCH", body: JSON.stringify({ imagePowerPerCall: price, costImagePowerPerCall: cost }) }); await reload(); setOpen(false); }
    catch(e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  return <><button type="button" className="secondary" onClick={() => setOpen(true)}>配置按次价格</button>{open ? <SettingsDialog title={`${model.name} · 按张计费`} onClose={() => setOpen(false)}><div className="pricing-editor"><label>用户价格（电力 / 张）<input type="number" min="0.000001" step="0.000001" value={price} onChange={e => setPrice(Number(e.target.value))} /></label><label>采购价格（电力 / 张）<input type="number" min="0" step="0.000001" value={cost} onChange={e => setCost(Number(e.target.value))} /></label><button type="button" className="primary" disabled={busy || price <= 0 || cost < 0} onClick={() => void save()}>保存价格</button>{error ? <p role="status">{error}</p> : null}</div></SettingsDialog> : null}</>;
}
