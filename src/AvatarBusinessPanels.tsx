import { useEffect, useState, type FormEvent } from 'react';
import type { api as Api } from './oneApi';
import { SettingsDialog } from './SettingsControls';
import type { AvatarIntakeField } from './AvatarService';
type ServicePlan = {
    id: string;
    name: string;
    kind: 'monthly' | 'credits';
    quotaMicros: number;
    priceCny: number;
    validDays: number;
    status?: string;
};
type Entitlement = {
    id: string;
    planName: string;
    status: string;
    expired?: boolean;
    quotaMicros: number;
    spentMicros: number;
    heldMicros: number;
    remainingMicros: number;
    expiresAt: string;
    visitorName?: string;
};
type ServiceSnapshot = {
    access: 'open' | 'entitlement';
    paymentMode?: string;
    plans: ServicePlan[];
    intakeFields: AvatarIntakeField[];
    entitlement?: Entitlement;
    codes?: {
        id: string;
        planName: string;
        status: string;
        expiresAt: string;
        createdAt: string;
        source: string;
    }[];
    entitlements?: Entitlement[];
};
const power = (n: number) => (n / 1e6).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const failure = (e: unknown) => e instanceof Error ? e.message : '暂时没能完成，请稍后再试。';
type GuestRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
// Intent: teachers hand over bounded service access after a real agreement. The
// issued code is the focal receipt; codes/consented contacts remain separate.
export function AvatarServiceManagement({ api, id }: {
    api: typeof Api;
    id: string;
}) {
    const [data, setData] = useState<ServiceSnapshot>(), [planId, setPlanId] = useState(''), [source, setSource] = useState<'manual_fulfillment' | 'gift'>('manual_fulfillment'), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [code, setCode] = useState(''), [codeExpires, setCodeExpires] = useState(''), [revoke, setRevoke] = useState<{
        kind: 'codes' | 'grants';
        id: string;
        name: string;
    }>();
    const [leads, setLeads] = useState<{
        id: string;
        submittedAt: string;
        fields: {
            id: string;
            label: string;
            type: string;
            value: string | number;
        }[];
    }[]>(), [showLeads, setShowLeads] = useState(false);
    const base = `/api/sharing/manage/${id}`;
    async function load() { const snapshot = await api<ServiceSnapshot>(`${base}/service`); setData(snapshot); setPlanId(current => snapshot.plans.some(p => p.id === current) ? current : snapshot.plans.find(p => p.status !== 'archived')?.id ?? ''); }
    useEffect(() => { let active = true; void api<ServiceSnapshot>(`${base}/service`).then(d => { if (active) {
        setData(d);
        setPlanId(d.plans.find(p => p.status !== 'archived')?.id ?? '');
    } }).catch(e => { if (active)
        setMessage(failure(e)); }); return () => { active = false; }; }, [api, id]);
    async function issue() { setBusy(true); setMessage(''); try {
        const r = await api<{
            code: string;
            grant: {
                expiresAt: string;
            };
        }>(`${base}/service/codes`, { method: 'POST', body: JSON.stringify({ planId, source, confirmed, expiresDays: 7 }) });
        setCode(r.code);
        setCodeExpires(r.grant.expiresAt);
        setConfirmed(false);
        await load();
    }
    catch (e) {
        setMessage(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function revokeNow() { if (!revoke)
        return; setBusy(true); setMessage(''); try {
        await api(`${base}/service/${revoke.kind}/${encodeURIComponent(revoke.id)}/revoke`, { method: 'POST' });
        setRevoke(undefined);
        await load();
        setMessage('已撤销，不影响已完成的成果。');
    }
    catch (e) {
        setMessage(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function readLeads() { setShowLeads(true); setMessage(''); try {
        const r = await api<{
            items: NonNullable<typeof leads>;
        }>(`${base}/leads`);
        setLeads(r.items);
    }
    catch (e) {
        setMessage(failure(e));
    } }
    return <div className="sharing-form avatar-service-management"><p className="hint">服务资格与 ONE 钱包分开。实际使用费用仍按分身设置结算，不会自动从服务价中收款或分账。</p><section><h3>发放服务资格</h3>{data?.access === 'entitlement' && data.plans.some(p => p.status !== 'archived') ? <><label>服务方案<select value={planId} disabled={busy} onChange={e => setPlanId(e.target.value)}>{data.plans.filter(p => p.status !== 'archived').map(p => <option key={p.id} value={p.id}>{p.name} · {power(p.quotaMicros)} 电力 / {p.validDays} 天</option>)}</select></label><fieldset><legend>发放原因</legend><label className="sharing-check"><input type="radio" name="avatar-code-source" checked={source === 'manual_fulfillment'} onChange={() => setSource('manual_fulfillment')}/>已在线下完成服务安排</label><label className="sharing-check"><input type="radio" name="avatar-code-source" checked={source === 'gift'} onChange={() => setSource('gift')}/>赠送体验</label></fieldset><label className="sharing-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>确认发放；使用仍受分身总额度和费用规则约束</label><button type="button" className="primary" disabled={busy || !planId || !confirmed} onClick={() => void issue()}>{busy ? '正在发放…' : '生成一次性兑换码'}</button></> : <p>{data?.access === 'open' ? '此分身目前打开链接即可使用。需要发放资格时，请先在配置里选择“领取服务资格后使用”。' : '请先在“更新配置”里添加服务方案。'}</p>}{code ? <div className="sharing-receipt" role="status"><strong>兑换码只展示这一次，请保存后交给对方</strong><input readOnly aria-label="服务兑换码" value={code}/><div><button type="button" onClick={() => void navigator.clipboard.writeText(code).catch(() => setMessage('请选中兑换码手动复制。'))}>复制兑换码</button><button type="button" onClick={() => setCode('')}>已保存，隐藏</button></div><small>请于 {new Date(codeExpires).toLocaleString()} 前兑换；成功后绑定领取者，不能转给其他账号。</small></div> : null}</section>
    <section><h3>兑换码与已领取资格</h3>{!data ? <p role="status">正在加载…</p> : <>{!(data.codes?.length || data.entitlements?.length) ? <p>还没有发放记录。</p> : null}{data.codes?.map(c => <div className="avatar-management-row" key={c.id}><div><strong>{c.planName}</strong><small>{c.status === 'active' ? '待领取' : c.status === 'redeemed' ? '已领取' : '已撤销'} · 兑换期限 {new Date(c.expiresAt).toLocaleDateString()}</small></div>{c.status === 'active' ? <button type="button" disabled={busy} onClick={() => setRevoke({ kind: 'codes', id: c.id, name: c.planName })}>撤销兑换码</button> : null}</div>)}{data.entitlements?.map(g => <div className="avatar-management-row" key={g.id}><div><strong>{g.visitorName || '领取者'} · {g.planName}</strong><small>剩余 {power(g.remainingMicros)} 电力 · {g.status === 'active' ? `到期 ${new Date(g.expiresAt).toLocaleDateString()}` : '已结束'}</small></div>{g.status === 'active' ? <button type="button" disabled={busy} onClick={() => setRevoke({ kind: 'grants', id: g.id, name: g.planName })}>撤销资格</button> : null}</div>)}</>}</section>
    <section><header className="avatar-inline-header"><h3>访客发来的联系请求</h3><button type="button" disabled={busy} onClick={() => void readLeads()}>{showLeads ? '刷新请求' : '查看请求'}</button></header><p className="hint">只显示访客确认发送的表单，不包含原始聊天或附件。</p>{showLeads ? leads?.length ? leads.map(l => <article className="avatar-lead-receipt" key={l.id}><small>{new Date(l.submittedAt).toLocaleString()}</small><dl>{l.fields.map(field => <div key={field.id}><dt>{field.label}</dt><dd>{String(field.value)}</dd></div>)}</dl></article>) : <p>{leads ? '还没有收到联系请求。' : '正在读取…'}</p> : null}</section>
    {message ? <p role="status">{message}</p> : null}{revoke ? <SettingsDialog title={revoke.kind === 'codes' ? '撤销这个兑换码？' : '撤销这份服务资格？'} onClose={() => { if (!busy)
        setRevoke(undefined); }}><p>“{revoke.name}”将停止{revoke.kind === 'codes' ? '领取' : '继续使用'}，已完成的成果保留。</p><footer className="avatar-dialog-actions"><button type="button" data-dialog-focus disabled={busy} onClick={() => setRevoke(undefined)}>保留</button><button type="button" disabled={busy} onClick={() => void revokeNow()}>确认撤销</button></footer></SettingsDialog> : null}</div>;
}
// Intent: visitors understand the service they have, then can redeem or explicitly
// send contact details. No raw conversation is silently included in the form.
export function AvatarGuestService({ request, token, version, authorName, refreshKey, onRedeemed }: {
    request: GuestRequest;
    token: string;
    version: number;
    authorName?: string;
    refreshKey?: string;
    onRedeemed: () => void;
}) {
    const [data, setData] = useState<ServiceSnapshot>(), [code, setCode] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [fields, setFields] = useState<Record<string, string>>({}), [review, setReview] = useState<{
        operationId: string;
        fields: Record<string, string | number>;
    }>(), [sent, setSent] = useState(false);
    useEffect(() => { let active = true; void request<ServiceSnapshot>('/service').then(d => { if (active)
        setData(d); }).catch(e => { if (active)
        setMessage(failure(e)); }); return () => { active = false; }; }, [token, version, refreshKey]);
    async function redeem(e: FormEvent) { e.preventDefault(); setBusy(true); setMessage(''); try {
        await request('/service/redeem', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
        setCode('');
        setData(await request<ServiceSnapshot>('/service'));
        setMessage('服务资格已领取，可以继续聊了。');
        onRedeemed();
    }
    catch (e) {
        setMessage(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function submitLead() { if (!review)
        return; setBusy(true); setMessage(''); try {
        await request('/leads', { method: 'POST', body: JSON.stringify({ ...review, consent: true }) });
        setReview(undefined);
        setSent(true);
        setMessage(`已发给${authorName || '老师'}，不会附带聊天记录。`);
    }
    catch (e) {
        setMessage(failure(e));
    }
    finally {
        setBusy(false);
    } }
    return <div className="avatar-guest-service">{data?.entitlement ? <div className="avatar-entitlement" role="status"><strong>{data.entitlement.planName}</strong><span>剩余 {power(data.entitlement.remainingMicros)} 电力 · {new Date(data.entitlement.expiresAt).toLocaleDateString()} 到期</span>{data.entitlement.status !== 'active' || data.entitlement.expired ? <small>这份服务资格已结束，请联系老师安排新的资格。</small> : null}</div> : null}
    {data?.plans.length || data?.access === 'entitlement' ? <details className="avatar-service-access" open={data.access === 'entitlement' && !data.entitlement ? true : undefined}><summary>{data.entitlement ? '服务方案与兑换' : data.access === 'entitlement' ? '领取服务资格' : '服务方案（按需了解）'}</summary>{data.plans.map(plan => <article className="avatar-public-plan" key={plan.id}><div><strong>{plan.name}</strong><span>¥{plan.priceCny.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</span></div><small>{plan.validDays} 天 · {power(plan.quotaMicros)} 电力额度{plan.kind === 'monthly' ? ' · 不自动续费' : ''}</small></article>)}<p className="hint">由{authorName || '老师'}安排服务和收款。这里不在线扣款；拿到兑换码后登录账号领取。</p>{data.access === 'entitlement' && token ? <form onSubmit={redeem}><label>兑换码<input autoComplete="off" maxLength={120} value={code} onChange={e => setCode(e.target.value)}/></label><button type="submit" disabled={busy || !code.trim()}>{busy ? '正在领取…' : '领取服务资格'}</button></form> : <p className="hint">{data.access === 'entitlement' ? '登录并开始会话后，可在这里兑换。' : '需要这项服务时，请联系作者安排。'}</p>}</details> : null}
    {token && data?.intakeFields.length ? <details className="avatar-contact-form"><summary>想请{authorName || '老师'}继续聊聊？</summary>{sent ? <p role="status">联系请求已发送。需要补充时，可以编辑后再发。</p> : null}<form onSubmit={e => { e.preventDefault(); const submitted: Record<string, string | number> = {}; for (const field of data.intakeFields) {
        const value = fields[field.id]?.trim() ?? '';
        if (value)
            submitted[field.id] = field.type === 'number' ? Number(value) : value;
    } setReview(current => current ?? { operationId: crypto.randomUUID(), fields: submitted }); }}>{data.intakeFields.map(field => <label key={field.id}>{field.label}{field.required ? ' *' : ''}<input type={field.type === 'phone' ? 'tel' : field.type} required={field.required} maxLength={600} value={fields[field.id] ?? ''} onChange={e => { setFields({ ...fields, [field.id]: e.target.value }); setSent(false); }}/></label>)}<small>下一步先核对，只发送你填写的这些内容。</small><button type="submit" disabled={busy}>核对后发送</button></form></details> : null}
    {message ? <p role="status">{message}</p> : null}{review ? <SettingsDialog title={`发给${authorName || '老师'}的内容`} onClose={() => { if (!busy)
        setReview(undefined); }}><p>只发送以下表单，不包含本次聊天与附件。</p><dl className="avatar-lead-preview">{Object.entries(review.fields).map(([id, value]) => <div key={id}><dt>{data?.intakeFields.find(f => f.id === id)?.label || id}</dt><dd>{String(value ?? '未填写')}</dd></div>)}</dl><footer className="avatar-dialog-actions"><button type="button" data-dialog-focus disabled={busy} onClick={() => setReview(undefined)}>返回修改</button><button type="button" className="primary" disabled={busy} onClick={() => void submitLead()}>{busy ? '正在发送…' : '同意并发送'}</button></footer></SettingsDialog> : null}
  </div>;
}
