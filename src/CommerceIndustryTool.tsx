import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import { apiForUser, currentApiIdentity } from './oneApi';
import { CommerceWorkspace } from './Commerce';
import { ImageEditWorkspace } from './ImageEdit';
import { ReviewRepliesWorkspace } from './ReviewReplies';
import { IndustryFilesContext } from './IndustryFiles';
import { createIndustryClient, readIndustryPending, type IndustryClientSession, type PendingIndustryRequest } from './industryClient';
import type { CommerceWorkspaceKind } from './industryWorkspaceState';
import type { IndustryReceipt } from '../server/industryState';
import './commerce-industry.css';

type Pricing = { chatReady: boolean; imageReady: boolean; chat?: { name: string; inputPowerPerMillion: number; outputPowerPerMillion: number }; image?: { powerPerImage: number } };
const names = { product_creative: '主图与标题', image_edit: '小修小改', review_reply: '评价回复' };
const power = (micros: number) => (micros / 1e6).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
function storedSession(key: string): IndustryClientSession | undefined {
  try { const value = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return value && typeof value.id === 'string' && typeof value.budgetMicros === 'number' && typeof value.expiresAt === 'string' ? value : undefined; } catch { return; }
}
export function CommerceIndustryTool({ kind, onBack, onOpenSidebar = () => {} }: { kind: CommerceWorkspaceKind; onBack: () => void; onOpenSidebar?: () => void }) {
  const [identity] = useState(currentApiIdentity), request = useMemo(() => apiForUser(identity.userId, identity.workspaceId), [identity]);
  const scope = `${identity.workspaceId}:${identity.userId}:${kind}`, sessionKey = `one-industry-budget:v1:${scope}`, pendingKey = `one-industry-pending:v1:${scope}`;
  const [session, setSession] = useState<IndustryClientSession | undefined>(() => storedSession(sessionKey)), sessionRef = useRef(session); sessionRef.current = session;
  const [pricing, setPricing] = useState<Pricing>(), [budget, setBudget] = useState('10'), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [used, setUsed] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState(() => readIndustryPending(sessionStorage, pendingKey)), [retryable, setRetryable] = useState<string[]>([]);
  const consent = useRef<HTMLDetailsElement>(null), container = useRef<HTMLDivElement>(null), live = useRef(true), confirmKey = useRef(crypto.randomUUID()), refreshing = useRef(false);
  const activeSession = () => sessionRef.current && sessionRef.current.expiresAt > new Date().toISOString() ? sessionRef.current : undefined;
  function needBudget() { if (consent.current) { consent.current.open = true; consent.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }
  async function refreshUsage() {
    const value = sessionRef.current; if (!value || refreshing.current) return; refreshing.current = true;
    try { const response = await request<{ session: IndustryClientSession; usedMicros: number }>(`/api/industry/usage-sessions/${encodeURIComponent(value.id)}`); if (live.current && sessionRef.current?.id === value.id && response.session.id === value.id) { setUsed(response.usedMicros); setSession(response.session); } }
    catch { /* Reading a job remains usable when a previous grant expires. */ }
    finally { refreshing.current = false; }
  }
  const client = useMemo(() => createIndustryClient(request, { tool: kind, storage: sessionStorage, storageKey: pendingKey,
    session: activeSession, onBudgetRequired: needBudget, onPending: setPending, onActivity: () => { void refreshUsage(); } }), [request, kind, pendingKey]);
  const filesContext = useMemo(() => ({ identity, onError: setError }), [identity]);
  useEffect(() => {
    live.current = true;
    void request<{ pricing: Pricing }>('/api/industry/config').then(value => { if (live.current) setPricing(value.pricing); }).catch(error => { if (live.current) setError(error.message); });
    void refreshUsage();
    const timer = setInterval(() => { if (container.current?.offsetParent !== null && document.visibilityState === 'visible') void refreshUsage(); }, 15_000);
    return () => { live.current = false; clearInterval(timer); };
  }, []);
  async function authorize() {
    const amount = Math.round(Number(budget) * 1e6);
    if (!confirmed || !Number.isSafeInteger(amount) || amount < 100_000 || amount > 10_000_000_000) { setError('请填写 0.1–10000 电力的本轮上限，并确认用量'); return; }
    setBusy(true); setError('');
    try {
      const result = await request<{ session: IndustryClientSession; usedMicros: number }>('/api/industry/usage-sessions', { method: 'POST', body: JSON.stringify({ tool: kind, requestKey: confirmKey.current, budgetMicros: amount, confirmed: true }) });
      if (!live.current) return; setSession(result.session); sessionRef.current = result.session; setUsed(result.usedMicros); setConfirmed(false); confirmKey.current = crypto.randomUUID();
      try { sessionStorage.setItem(sessionKey, JSON.stringify(result.session)); } catch { /* Current visit can still use the authorized grant. */ }
      if (consent.current) consent.current.open = false; setNotice('本轮用量已确认，可以继续识别、生成或修改。');
    } catch (error) { setError(error instanceof Error ? error.message : '用量确认未完成，请核对后继续'); }
    finally { if (live.current) setBusy(false); }
  }
  async function checkOriginal(item: PendingIndustryRequest) {
    setError('');
    setRetryable(old => old.filter(key => key !== item.requestKey));
    try {
      const query = new URLSearchParams({ tool: kind, path: item.path });
      const { receipt } = await request<{ receipt: IndustryReceipt }>(`/api/industry/receipts/${encodeURIComponent(item.requestKey)}?${query}`);
      if (receipt.requestKey !== item.requestKey) throw new Error('原操作编号尚未核对');
      setNotice(receipt.message);
      if (receipt.retryAllowed && ['failed', 'interrupted', 'uncertain', 'not_accepted'].includes(receipt.status)) setRetryable(old => [...new Set([...old, item.requestKey])]);
    } catch {
      setNotice('尚未精确核对原操作，请先从下方任务历史查看。再次点原操作会沿用原编号；未开启新的付费尝试。');
    }
  }
  const grant = activeSession();
  return <IndustryFilesContext.Provider value={filesContext}><div className="industry-tool-shell" ref={container}>
    <section className="industry-usage" aria-label={`${names[kind]}的 AI 用量`}>
      <div><strong>{grant ? <><Check size={15} aria-hidden="true"/>本轮最多 {power(grant.budgetMicros)} 电力</> : '准备资料免费，使用 AI 前确认用量'}</strong><span>{grant ? `已用与预留 ${power(used)} 电力` : kind === 'review_reply' ? '使用 ONE 现行价格 · 文字与图片理解按 token 计费' : `使用 ONE 现行价格${pricing?.image ? ` · 图片 ${pricing.image.powerPerImage} 电力/次` : ''}`}</span></div>
      <details ref={consent}><summary>{grant ? '用量与新一轮授权' : '确认本轮用量'}<ChevronDown size={14}/></summary><div>
        <p>识别、建议、方案、生成与继续修改，共享这轮上限。按实际用量结算，用量授权有效 24 小时。</p>
        {kind !== 'review_reply' ? pricing?.image ? <p>图片：{pricing.image.powerPerImage} 电力/次，每张独立调用。</p> : <p>图片能力当前尚未就绪，已上传资料和历史结果仍可查看。</p> : null}
        {pricing?.chat ? <details className="industry-token-prices"><summary>查看文字计价</summary><p>输入 {pricing.chat.inputPowerPerMillion}、输出 {pricing.chat.outputPowerPerMillion} 电力/百万 token。</p></details> : <p>文字能力当前尚未就绪。</p>}
        <label>本轮电力上限<input aria-label="本轮电力上限" type="number" min="0.1" max="10000" step="0.1" value={budget} disabled={busy} onChange={e => { setBudget(e.target.value); setConfirmed(false); confirmKey.current = crypto.randomUUID(); }}/></label>
        <label className="industry-consent-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>我确认按 ONE 现行价格使用 AI，本轮最多 {budget || '0'} 电力。</label>
        <button type="button" className="industry-consent-submit" disabled={busy || !confirmed} onClick={() => void authorize()}>{busy ? <LoaderCircle size={15} className="creative-spin"/> : null}{grant ? '明确开启新一轮用量' : '确认后使用 AI'}</button>
      </div></details>
      {grant ? <button type="button" className="industry-usage-refresh" aria-label="核对本轮工作台用量" onClick={() => void refreshUsage()}><RefreshCw size={15}/></button> : null}
    </section>
    {error ? <p className="industry-tool-error" role="alert">{error}</p> : null}{notice ? <p className="industry-tool-notice" role="status">{notice}</p> : null}
    {pending.length ? <details className="industry-pending"><summary>有 {pending.length} 步操作的回执待核对</summary><p>再次点原操作会沿用原编号。查询和查看已有记录不调用模型。</p>{pending.map(item => <div key={item.requestKey}><span>{/recognize/.test(item.path) ? '资料或截图识别' : /refine/.test(item.path) ? '继续优化' : /jobs|edits/.test(item.path) ? '图片任务' : 'AI 辅助操作'}</span><button type="button" onClick={() => void checkOriginal(item)}>核对原请求</button>{retryable.includes(item.requestKey) ? <button type="button" onClick={() => { try { client.prepareExplicitRetry(item.requestKey); setRetryable([]); setNotice('原记录已保留。再次点击该操作时，将独立重新执行，可能再次产生费用。'); } catch (error) { setError(error instanceof Error ? error.message : '请先确认用量'); } }}>保留记录，另开操作（可能再次计费）</button> : null}</div>)}</details> : null}
    {kind === 'product_creative' ? <CommerceWorkspace key={scope} api={client.request} userId={scope} agentId="industry-commerce-main" onBack={onBack} onOpenSidebar={onOpenSidebar}/> : kind === 'image_edit' ? <ImageEditWorkspace key={scope} api={client.request} userId={scope} agentId="industry-image-edit" onBack={onBack} onOpenSidebar={onOpenSidebar}/> : <ReviewRepliesWorkspace key={scope} api={client.request} userId={scope} agentId="review_reply" onBack={onBack} onOpenSidebar={onOpenSidebar}/>}
  </div></IndustryFilesContext.Provider>;
}
