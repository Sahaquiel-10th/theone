import { useEffect, useRef, useState, type FormEvent } from "react";
import type { api as Api } from "./oneApi";
import { Pagination, SearchPicker, SettingsDialog } from "./SettingsControls";
import { MessageMarkdown } from "./MessageMarkdown";
import { PublicServicePanel } from './PublicServicePanels';
import { VisitorAccountPanel } from './VisitorAccountPanel';
import { AvatarBusinessFields, AvatarMethodFields, AvatarWelcomeFields } from './AvatarConfiguration';
import { AvatarGuestService, AvatarServiceManagement } from './AvatarBusinessPanels';
import { AvatarArtifacts, type AvatarArtifact } from './AvatarArtifacts';
import { AvatarPublicIdentity } from './AvatarPublicIdentity';
import { avatarRunProgress, avatarServicePayload, emptyAvatarBusiness, emptyAvatarService, normalizedAvatarBusiness, normalizedAvatarService, type AvatarAvailableFeature, type AvatarServiceConfig } from './AvatarService';
import "./public-sharing.css";
type PublicationRow = {
    id: string;
    version: number;
    slug: string;
    name: string;
    description: string;
    authorName?: string;
    service?: {
        mode: 'consultation' | 'knowledge';
        featureCount: number;
    };
    status: string;
    expiresAt: string;
    budgetMicros: number;
    perRunMicros: number;
    spent: number;
    held: number;
    attachments: boolean;
    sources: string[];
};
type List = {
    ready: boolean;
    authorName?: string;
    availableFeatures?: AvatarAvailableFeature[];
    visitorPaymentsEnabled?: boolean;
    items: PublicationRow[];
    total: number;
    sources: {
        id: string;
        provider: string;
        name: string;
    }[];
};
const newDraft = (modelId = '') => ({ name: '', description: '', prompt: '', modelId, sourceIds: [] as string[], attachments: true, budget: 10, perRun: 1, days: 90, confirmed: false, visitorPercent: 0, requireLogin: false, allowedUsernames: [] as string[], service: emptyAvatarService(), serviceBusiness: emptyAvatarBusiness() });
const power = (n: number) => (n / 1e6).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const failure = (e: unknown) => e instanceof Error ? e.message : "暂时未能完成";
const labels: Record<string, string> = { getnote: "得到大脑", notion: "Notion", yinxiang: "印象笔记", flowus: "息流", feishu: "飞书" };
export function SharingCostHelp() { return <details className="sharing-cost-help"><summary aria-label="查看分身费用说明">?</summary><div>收费 0% 时从你的余额扣除；大于 0% 时访客登录并使用自己的电力。低于 100% 的差额由你补贴。API 和指定访客赠送仍由你承担。达到限额、到期或关闭分享后停止。</div></details>; }
export function SharingPanel({ api, models, externalQuery, hideSearch = false }: {
    api: typeof Api;
    models: {
        id: string;
        name: string;
        kind: string;
    }[];
    externalQuery?: string;
    hideSearch?: boolean;
}) {
    const [data, setData] = useState<List>(), [page, setPage] = useState(1), [query, setQuery] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState(false), [receipt, setReceipt] = useState(""), [copied, setCopied] = useState('');
    const [usage, setUsage] = useState<PublicationRow>(), [usagePage, setUsagePage] = useState(1), [rows, setRows] = useState<{
        total: number;
        items: {
            id: string;
            status: string;
            createdAt: string;
            spent: number;
            held: number;
            calls: {
                model: string;
                activity: string;
                spent: number;
                status: string;
            }[];
        }[];
    }>();
    const [draft, setDraft] = useState(newDraft);
    const [services, setServices] = useState<PublicationRow>(), [serviceManagement, setServiceManagement] = useState<PublicationRow>(), [closing, setClosing] = useState<PublicationRow>();
    const [editing, setEditing] = useState<{
        id: string;
        version: number;
        legacy: boolean;
    }>();
    useEffect(() => { if (externalQuery !== undefined) {
        setQuery(externalQuery);
        setPage(1);
    } }, [externalQuery]);
    const load = () => api<List>(`/api/sharing/manage?page=${page}&q=${encodeURIComponent(query)}`).then(setData);
    useEffect(() => { let live = true; void api<List>(`/api/sharing/manage?page=${page}&q=${encodeURIComponent(query)}`).then(d => { if (live)
        setData(d); }).catch(e => { if (live)
        setError(failure(e)); }); return () => { live = false; }; }, [api, page, query]);
    useEffect(() => { if (!usage)
        return; let live = true; setRows(undefined); void api<typeof rows>(`/api/sharing/manage/${usage.id}/usage?page=${usagePage}`).then(d => { if (live)
        setRows(d); }).catch(e => { if (live)
        setError(failure(e)); }); return () => { live = false; }; }, [api, usage, usagePage]);
    async function edit(p: PublicationRow) { setBusy(true); setError(''); try {
        const config = await api<typeof draft & {
            version: number;
            legacyPrompt: boolean;
        }>(`/api/sharing/manage/${p.id}/config`);
        const { name, description, prompt, modelId, sourceIds, attachments, budget, perRun, days, visitorPercent, requireLogin, allowedUsernames } = config;
        setDraft({ name, description, prompt, modelId, sourceIds, attachments, budget, perRun, days, visitorPercent: visitorPercent ?? 0, requireLogin: requireLogin ?? false, allowedUsernames: allowedUsernames ?? [], confirmed: false, service: normalizedAvatarService(config.service), serviceBusiness: normalizedAvatarBusiness(config.serviceBusiness) });
        setEditing({ id: p.id, version: config.version, legacy: config.legacyPrompt });
        setOpen(true);
    }
    catch (e) {
        setError(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function create(e: FormEvent) { e.preventDefault(); setBusy(true); setError(""); try {
        const r = await api<{
            slug: string;
        }>(editing ? `/api/sharing/manage/${editing.id}/update` : "/api/sharing/manage", { method: "POST", body: JSON.stringify({ ...draft, service: avatarServicePayload(draft.service), version: editing?.version }) });
        setReceipt(`${location.origin}/s/${r.slug}`);
        setOpen(false);
        await load();
    }
    catch (e) {
        setError(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function close(p: PublicationRow) { setBusy(true); setError(''); try {
        await api(`/api/sharing/manage/${p.id}/close`, { method: "POST" });
        setClosing(undefined);
        await load();
    }
    catch (e) {
        setError(failure(e));
    }
    finally {
        setBusy(false);
    } }
    return <section className="sharing-panel market-section"><header><div><h3>我的分身</h3><p className="sharing-subtitle">把你的方法、知识和工具，变成可以分享的服务。</p></div><button type="button" className="primary" disabled={!data?.ready || busy} onClick={() => { setEditing(undefined); setError(''); setDraft(newDraft(models.find(m => m.kind === "chat")?.id || '')); setOpen(true); }}>＋ 创建分身</button></header>
    {data?.ready === false ? <p role="status">分享功能准备中，请管理员完成数据库升级。</p> : null}
    {!hideSearch ? <input aria-label="搜索分享分身" placeholder="搜索分身" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/> : null}
    {receipt ? <div className="sharing-receipt"><strong>分享链接</strong><input readOnly aria-label="分享链接" value={receipt}/><button type="button" onClick={() => void navigator.clipboard.writeText(receipt).then(() => setCopied(receipt)).catch(() => setError("请选中链接复制"))}>{copied === receipt ? '已复制' : '复制链接'}</button></div> : null}
    <div className="sharing-list">{data?.items.map(p => <article key={p.id}><header><strong>{p.name}</strong><span>{p.status === "closed" ? "已关闭" : Date.parse(p.expiresAt) < Date.now() ? "已到期" : "分享中"}</span></header><p className="avatar-list-author">{p.authorName || data.authorName || '账号作者'} · {p.service?.mode === 'knowledge' ? '知识服务' : '售前咨询'}</p><p>{p.description}</p><p>已用 {power(p.spent)} / {power(p.budgetMicros)} 电力{p.held ? ` · 预留 ${power(p.held)}` : ""}</p><details><summary>知识范围与使用限额</summary><p>{p.service?.featureCount ? `问答与 ${p.service.featureCount} 项已授权功能` : '问答服务'}{p.attachments ? " · 支持访客附件" : ""}</p><p>知识来源：{p.sources.join("、") || "未分享知识"}</p><p>单次上限 {power(p.perRunMicros)} 电力 · 到期 {new Date(p.expiresAt).toLocaleString()}</p><p>v{p.version ?? 1} · 更新配置保留原链接，历史消耗不清零。</p></details><footer><button type="button" onClick={() => setReceipt(`${location.origin}/s/${p.slug}`)}>分享链接</button><button type="button" onClick={() => setServiceManagement(p)}>服务资格与联系请求</button><button type="button" onClick={() => { setUsage(p); setUsagePage(1); }}>用量详情</button>{p.status === "active" ? <><button type="button" disabled={busy} onClick={() => void edit(p)}>更新配置</button><button type="button" disabled={busy} onClick={() => setClosing(p)}>关闭分享</button></> : null}</footer></article>)}</div>
    <details hidden={!data?.items.length}><summary>API、访客赠送与收益</summary><div className="settings-choice-list">{data?.items.map(p => <button type="button" key={p.id} onClick={() => setServices(p)}>{p.name} · 管理接入与账本</button>)}</div></details>
    {services ? <SettingsDialog title={`${services.name} · 接入与收益`} onClose={() => setServices(undefined)}><PublicServicePanel api={api} publication={services}/></SettingsDialog> : null}
    {serviceManagement ? <SettingsDialog title={`${serviceManagement.name} · 服务管理`} className="avatar-management-dialog" onClose={() => setServiceManagement(undefined)}><AvatarServiceManagement api={api} id={serviceManagement.id}/></SettingsDialog> : null}
    {closing ? <SettingsDialog title="关闭这个分身？" onClose={() => { if (!busy)
        setClosing(undefined); }}><p>“{closing.name}”的链接将停止服务。已产生的费用和成果保留，不会继续接受新问题。</p><footer className="avatar-dialog-actions"><button type="button" data-dialog-focus disabled={busy} onClick={() => setClosing(undefined)}>继续分享</button><button type="button" disabled={busy} onClick={() => void close(closing)}>关闭分享</button></footer>{error ? <p role="alert">{error}</p> : null}</SettingsDialog> : null}
    {data && data.total > 10 ? <Pagination page={page} total={data.total} onChange={setPage}/> : null}{error ? <p role="alert">{error}</p> : null}
    {data?.ready && !data.total ? <p className="sharing-empty">{query ? '没有匹配的分身' : '还没有创建分身'}</p> : null}
    {open ? <SettingsDialog title={editing ? `更新分身 · v${editing.version}` : "创建分身"} className="avatar-config-dialog" onClose={() => { if (!busy)
            setOpen(false); }}><form className="sharing-form avatar-config-form" onSubmit={create}>
      {editing ? <><p className="hint">更新后原链接不变，历史消耗不清零。访客需重新开始，新版不会带入旧会话资料。有效期从本次发布起算；有问题正在回答时暂不能更新。</p>{editing.legacy ? <p role="alert">这是旧版发布记录，请重新填写回答要求；旧系统提示词不会重复叠加。</p> : null}<PublicationHistory api={api} id={editing.id}/></> : null}
      <section className="avatar-config-section"><header><span className="avatar-section-index">01</span><div><h3>对外介绍</h3><p>访客先看到谁在提供服务，以及能聊些什么。</p></div></header><label>分身名称<input required maxLength={60} value={draft.name} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：老徐的家庭财务顾问"/></label>
      <label>一句话介绍<input maxLength={300} value={draft.description} disabled={busy} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="帮谁，解决哪一类问题"/></label>
      <AvatarWelcomeFields value={draft.service} onChange={service => setDraft({ ...draft, service })} authorName={data?.authorName} disabled={busy}/></section>
      <AvatarMethodFields value={draft.service} onChange={service => setDraft({ ...draft, service })} features={data?.availableFeatures ?? []} disabled={busy}/>
      <section className="avatar-config-section"><header><span className="avatar-section-index">03</span><div><h3>回答与知识</h3><p>补充回答习惯，选择可以向访客开放的资料。</p></div></header><label>回答要求<textarea rows={4} maxLength={12000} value={draft.prompt} disabled={busy} onChange={e => setDraft({ ...draft, prompt: e.target.value })} placeholder="语气、回答结构、哪些问题交给你本人处理……"/></label>
      <div className="sharing-model-field"><span>执行模型</span><SearchPicker label="执行模型" value={draft.modelId} options={models.filter(m => m.kind === "chat").map(m => ({ value: m.id, label: m.name }))} onChange={modelId => setDraft({ ...draft, modelId })}/></div>
      <fieldset><legend>分享哪些知识</legend>{data?.sources.map(s => <label className="sharing-check" key={s.id}><input type="checkbox" checked={draft.sourceIds.includes(s.id)} onChange={e => setDraft({ ...draft, sourceIds: e.target.checked ? [...draft.sourceIds, s.id] : draft.sourceIds.filter(id => id !== s.id) })}/>{labels[s.provider] || s.provider} · {s.name}</label>)}<small>勾选后允许访客提问并检索该连接的全部已授权资料，不是单篇文档。未勾选的来源不会读取。</small></fieldset>
      <label className="sharing-check"><input type="checkbox" checked={draft.attachments} onChange={e => setDraft({ ...draft, attachments: e.target.checked })}/>允许访客上传附件用于问答</label>
      {draft.sourceIds.filter(id => !data?.sources.some(s => s.id === id)).map(id => <p key={id}>一个原知识连接已不可用。<button type="button" onClick={() => setDraft({ ...draft, sourceIds: draft.sourceIds.filter(s => s !== id) })}>移除该来源</button></p>)}</section>
      <section className="avatar-config-section"><header><span className="avatar-section-index">04</span><div><h3>访问与费用</h3><p>先确定服务资格，再为实际使用设置可控的限额。</p></div></header>
      <AvatarBusinessFields value={draft.serviceBusiness} onChange={serviceBusiness => setDraft({ ...draft, serviceBusiness, visitorPercent: serviceBusiness.access === 'entitlement' ? 0 : draft.visitorPercent })} disabled={busy}/>
      <details><summary>实际使用费用 · {draft.visitorPercent ? `访客承担 ${draft.visitorPercent}%` : '由我承担'}</summary><label>访客承担 ONE 基础费用的百分比<input type="number" min="0" max="1000" step="1" value={draft.visitorPercent} disabled={busy || !data?.visitorPaymentsEnabled} onChange={e => setDraft({ ...draft, visitorPercent: Number(e.target.value) })}/></label><p className="hint">0 表示你承担；100 表示访客承担基础费用；120 表示加价 20%。低于 100% 的差额由你承担。这里不是相对模型官方价格的折扣。</p>{!data?.visitorPaymentsEnabled ? <p>访客自付尚未开放，目前由你承担实际使用费用。</p> : <p>加价收益只在实际消费后形成，暂不提现。</p>}</details>
      <details><summary>登录与访问范围</summary><label className="sharing-check"><input type="checkbox" checked={draft.requireLogin || draft.serviceBusiness.access === 'entitlement'} disabled={busy || draft.serviceBusiness.access === 'entitlement'} onChange={e => setDraft({ ...draft, requireLogin: e.target.checked })}/>要求访客登录账号{draft.serviceBusiness.access === 'entitlement' ? '（领取资格需要登录）' : ''}</label><label>仅这些已注册账号可以访问<textarea rows={3} value={draft.allowedUsernames.join('\n')} onChange={e => setDraft({ ...draft, allowedUsernames: e.target.value.split('\n') })} placeholder="每行一个，留空不限定"/></label></details>
      <section className="sharing-budget"><header><span>使用额度</span><SharingCostHelp /></header><div className="sharing-grid"><label>总电力<input type="number" min="0.01" max="10000" step="0.01" required value={draft.budget} onChange={e => setDraft({ ...draft, budget: Number(e.target.value) })}/></label><label>单次电力<input type="number" min="0.01" max={draft.budget} step="0.01" required value={draft.perRun} onChange={e => setDraft({ ...draft, perRun: Number(e.target.value) })}/></label><label>有效天数<input type="number" min="1" max="90" required value={draft.days} onChange={e => setDraft({ ...draft, days: Number(e.target.value) })}/></label></div></section>
      </section><label className="sharing-check"><input required type="checkbox" checked={draft.confirmed} onChange={e => setDraft({ ...draft, confirmed: e.target.checked })}/>确认知识范围、服务内容与费用承担规则</label>
      {error ? <p role="alert">{error}</p> : null}<footer className="avatar-config-footer"><span>发布后可以继续调整，原链接保留。</span><button className="primary" disabled={busy || !draft.modelId || !draft.confirmed}>{busy ? "正在发布…" : editing ? "确认更新，保留原链接" : "发布并生成链接"}</button></footer>
    </form></SettingsDialog> : null}
    {usage ? <SettingsDialog title={`${usage.name} · 用量`} onClose={() => setUsage(undefined)}><p>仅显示任务状态和费用，不展示访客原文或附件。</p>{rows?.items.map(r => <details key={r.id}><summary>{new Date(r.createdAt).toLocaleString()} · {({ completed: "完成", running: "进行中", failed: "未完成", interrupted: "已中断" } as Record<string, string>)[r.status]} · {power(r.spent)} 电力</summary><p>任务编号 {r.id}</p><p>预留 {power(r.held)} 电力</p>{r.calls?.map((c, i) => <p key={i}>{c.activity} · {c.model} · {power(c.spent)} 电力</p>)}</details>)}{rows ? <Pagination page={usagePage} total={rows.total} onChange={setUsagePage}/> : <p>正在加载…</p>}</SettingsDialog> : null}
  </section>;
}
function PublicationHistory({ api, id }: {
    api: typeof Api;
    id: string;
}) {
    const [page, setPage] = useState(1), [open, setOpen] = useState(false), [error, setError] = useState(''), [data, setData] = useState<{
        total: number;
        history: {
            version: number;
            name: string;
            prompt: string;
            legacyPrompt: boolean;
            updatedAt: string;
            budget: number;
            perRun: number;
        }[];
    }>();
    useEffect(() => { if (!open)
        return; let active = true; void api<typeof data>(`/api/sharing/manage/${id}/config?page=${page}`).then(v => { if (active)
        setData(v); }).catch(e => { if (active)
        setError(failure(e)); }); return () => { active = false; }; }, [api, id, page, open]);
    return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>历史配置（保留最近 20 版）</summary>{data?.history.map(v => <details key={v.version}><summary>v{v.version} · {v.name} · {new Date(v.updatedAt).toLocaleString()}</summary><p>总额度 {v.budget} · 单次 {v.perRun} 电力</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v.legacyPrompt ? '旧版未独立保存用户回答要求' : v.prompt || '未填写额外回答要求'}</p></details>)}{data && !data.total ? <p>暂无历史版本</p> : null}<button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span> {page} </span><button type="button" disabled={!data || page * 5 >= data.total} onClick={() => setPage(page + 1)}>下一页</button>{error ? <p role="alert">{error}</p> : null}</details>;
}
type Run = {
    id: string;
    operationId: string;
    content: string;
    response?: string;
    status: string;
    stage?: string;
    artifacts?: AvatarArtifact[];
    finishReason?: string;
    error?: string;
    warning?: string;
    createdAt: string;
    chargedMicros?: number;
};
type FileItem = {
    id: string;
    originalName: string;
    status?: string;
    parseError?: string;
};
export function PublicSharingPage({ slug }: {
    slug: string;
}) {
    const [meta, setMeta] = useState<{
        name: string;
        authorName?: string;
        description: string;
        service?: Pick<AvatarServiceConfig, 'mode' | 'welcome' | 'starterQuestions'>;
        attachments: boolean;
        version: number;
        visitorPercent: number;
        requireLogin: boolean;
        paymentEnabled: boolean;
    }>(), [token, setToken] = useState(() => { try {
        return sessionStorage.getItem(`one-guest:${slug}`) || "";
    }
    catch {
        return "";
    } }), [items, setItems] = useState<Run[]>([]), [page, setPage] = useState(1), [total, setTotal] = useState(0), [text, setText] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [files, setFiles] = useState<FileItem[]>([]), [retry, setRetry] = useState<{
        operationId: string;
        content: string;
        attachmentIds: string[];
        confirmedPriceVersion?: number;
        confirmedPayment?: boolean;
    }>(), [paymentConfirmed, setPaymentConfirmed] = useState(false), [restart, setRestart] = useState(false), [needsRestart, setNeedsRestart] = useState(false);
    const live = useRef(true), tokenRef = useRef(token);
    tokenRef.current = token;
    const base = `/api/sharing/${encodeURIComponent(slug)}`;
    async function request<T>(path: string, options: RequestInit = {}, auth = tokenRef.current): Promise<T> { const headers = new Headers(options.headers); if (auth)
        headers.set("Authorization", `Bearer ${auth}`); if (!headers.has("Content-Type"))
        headers.set("Content-Type", "application/json"); const r = await fetch(base + path, { ...options, headers, credentials: "same-origin" }); const d = await r.json(); if(auth&&auth!==tokenRef.current)throw new Error('会话已切换，旧请求不会带入当前会话。'); if (!r.ok) {
        if ((d.code === 'PUBLICATION_UPDATED' || d.code === 'VISITOR_LOGIN_REQUIRED') && live.current) {
            setItems([]);
            setFiles([]);
            setRetry(undefined);
            setNeedsRestart(true);
        }
        throw Object.assign(new Error(d.error || "暂时无法访问"), { status: r.status });
    } return d; }
    async function load() { const d = await request<{
        items: Run[];
        total: number;
    }>(`/session?page=${page}`); if (live.current) {
        setItems(d.items);
        setTotal(d.total);
    } }
    useEffect(() => { live.current = true; void request<typeof meta>("", {}, "").then(d => { if (live.current)
        setMeta(d); }).catch(e => { if (live.current)
        setError(failure(e)); }); return () => { live.current = false; }; }, [slug]);
    useEffect(() => { if (!token)
        return; let cancelled = false; let timer: ReturnType<typeof setTimeout>; async function poll() { try {
        const d = await request<{
            items: Run[];
            total: number;
        }>(`/session?page=${page}`);
        if (cancelled)
            return;
        setItems(d.items);
        setTotal(d.total);
        if (d.items.some(r => r.status === "running"))
            timer = setTimeout(poll, 2500);
    }
    catch (e) {
        if (!cancelled)
            setError(failure(e));
    } } void poll(); return () => { cancelled = true; clearTimeout(timer); }; }, [token, page, busy]);
    async function start() { setBusy(true); setError(""); try {
        const fresh = await request<typeof meta>("", {}, "");
        setMeta(fresh);
        const d = await request<{
            token: string;
        }>("/sessions", { method: "POST" }, "");
        tokenRef.current = d.token;
        setToken(d.token);
        try {
            sessionStorage.setItem(`one-guest:${slug}`, d.token);
        }
        catch { }
        setItems([]);
        setPage(1);
        setText('');
        setFiles([]);
        setRetry(undefined);
        setNeedsRestart(false);
        setRestart(false);
        return true;
    }
    catch (e) {
        setError(failure(e));
        return false;
    }
    finally {
        setBusy(false);
    } }
    async function chooseStarter(question: string) { if (!token && !(await start()))
        return; setText(question); requestAnimationFrame(() => document.getElementById('avatar-question')?.focus()); }
    async function send(e: FormEvent) { e.preventDefault(); if (needsRestart || items.some(r => r.status === 'running') || (!text.trim() && !retry))
        return; setBusy(true); setError(""); const payload = retry || { operationId: crypto.randomUUID(), content: text.trim(), attachmentIds: files.map(f => f.id), confirmedPriceVersion: meta?.version, confirmedPayment: paymentConfirmed }; setRetry(payload); try {
        await request("/questions", { method: "POST", body: JSON.stringify(payload) });
        setRetry(undefined);
        setText("");
        setFiles([]);
        setPage(1);
        await load();
    }
    catch (e) {
        if (e && typeof e === "object" && "status" in e && [400, 401, 402, 403, 404, 410, 413, 422, 429].includes(Number(e.status)))
            setRetry(undefined);
        setError(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function upload(selected: FileList | null) { if (!selected)
        return; setUploading(true); setError(""); try {
        if (selected.length + files.length > 5)
            throw new Error("每条消息最多 5 个附件");
        for (const file of Array.from(selected)) {
            const created = await request<{
                attachment: FileItem;
            }>("/uploads", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type }) });
            const id = created.attachment.id;
            setFiles(current => [...current, created.attachment]);
            for (let offset = 0; offset < file.size; offset += 4 * 1024 ** 2) {
                await request(`/uploads/${id}/chunks?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + 4 * 1024 ** 2) });
            }
            await request(`/uploads/${id}/complete`, { method: "POST" });
        }
    }
    catch (e) {
        setFiles(current => current.map(f => f.status === "uploading" ? { ...f, status: "failed", parseError: "上传未完成，请移除后重试" } : f));
        setError(failure(e));
    }
    finally {
        setUploading(false);
    } }
    useEffect(() => { const pending = files.filter(f => !["ready", "failed"].includes(f.status || "")); if (!pending.length || uploading)
        return; let cancelled = false; const timer = setTimeout(() => void Promise.all(pending.map(async (f) => (await request<{
        attachment: FileItem;
    }>(`/uploads/${f.id}`)).attachment)).then(results => { if (!cancelled)
        setFiles(current => current.map(f => results.find(r => r.id === f.id) || f)); }).catch(e => { if (!cancelled) {
        setError(failure(e));
        setFiles(current => current.map(f => pending.some(p => p.id === f.id) ? { ...f, status: "failed" } : f));
    } }), 2000); return () => { cancelled = true; clearTimeout(timer); }; }, [files, uploading, token]);
    const running = items.some(r => r.status === "running");
    return <main className="public-sharing-page"><AvatarPublicIdentity name={meta?.name || '正在打开…'} description={meta?.description || ''} authorName={meta?.authorName} mode={meta?.service?.mode}/>
    <p className="sharing-privacy">你正在与 AI 分身交流。问题与附件不会自动发给作者；只有你确认发送的联系表单会交给作者。{meta?.visitorPercent ? `实际使用按 ONE 基础费用的 ${meta.visitorPercent}% 从你的电力扣除；指定赠送额度优先由作者承担。` : '实际使用费用由作者承担。'}</p>
    <VisitorAccountPanel required={!!meta?.requireLogin} onChanged={() => { setToken(''); tokenRef.current = ''; setItems([]); setText(''); setFiles([]); setRetry(undefined); setPaymentConfirmed(false); setError(''); setNeedsRestart(false); try {
        sessionStorage.removeItem(`one-guest:${slug}`);
    }
    catch { } }}/>
    {meta ? <AvatarGuestService key={`${slug}:${token}:${meta.version}`} request={request} token={token} version={meta.version} authorName={meta.authorName} refreshKey={items.filter(r=>r.status!=='running').map(r=>`${r.id}:${r.chargedMicros??0}`).join('|')} onRedeemed={() => void load().catch(e => setError(failure(e)))}/> : null}
    {meta?.visitorPercent ? <label><input type="checkbox" checked={paymentConfirmed} onChange={e => setPaymentConfirmed(e.target.checked)}/>我确认当前版本的收费百分比，并承担实际消耗</label> : null}
    {!items.length && meta ? <section className="avatar-welcome"><p>{meta.service?.welcome || '你好，可以先说说你现在想解决的一件事。'}</p>{meta.service?.starterQuestions?.length ? <div className="avatar-starter-questions" aria-label="从这些问题开始">{meta.service.starterQuestions.map((q, i) => <button type="button" key={i} disabled={busy || running || needsRestart} onClick={() => void chooseStarter(q)}>{q}<span aria-hidden="true">↗</span></button>)}</div> : null}</section> : null}
    {!token ? <button className="primary" disabled={!meta || busy} onClick={() => void start()}>{busy ? '正在连接…' : '开始聊聊'}</button> : <>
      <div className="public-answers" aria-live="polite">{items.slice().reverse().map(r => <article key={r.id}><p className="public-question">{r.content}</p>{r.status === 'running' ? <p className="avatar-run-progress" role="status"><span aria-hidden="true"/>{avatarRunProgress(r.stage)}</p> : null}<div className="markdown-body"><MessageMarkdown allowImages={false}>{r.response || r.error || (r.status === 'running' ? '' : '这次还没做完，可以补充要求后继续。')}</MessageMarkdown></div>{r.artifacts?.length ? <AvatarArtifacts artifacts={r.artifacts} runId={r.id} base={base} token={token}/> : null}{r.status !== 'running' ? <small>{r.chargedMicros ? `本次消耗 ${power(r.chargedMicros)} 电力` : '本次没有从你的钱包扣除已结算费用'}</small> : null}{r.warning ? <p role="status">{r.warning}</p> : null}{r.finishReason === "length" ? <p>回答还没展开完，可以发送“继续”接着聊。</p> : null}</article>)}</div>
      {total > 10 && !running ? <Pagination page={page} total={total} onChange={setPage}/> : null}
      <form className="public-composer" onSubmit={send}><label className="avatar-composer-label" htmlFor="avatar-question">{running ? '可以先想想下一问，当前问题还在处理' : '说说你想解决的事'}</label><textarea id="avatar-question" aria-label="问题" rows={3} maxLength={6000} value={text} onChange={e => setText(e.target.value)} disabled={!!retry || needsRestart} placeholder="从你的实际情况说起…"/>
        {files.map(f => <div className="sharing-file" key={f.id}><span>{f.originalName} · {f.status === "ready" ? "已就绪" : f.status === "failed" ? f.parseError || "未完成" : "处理中…"}</span><button type="button" disabled={uploading || busy || !!retry} onClick={() => setFiles(current => current.filter(x => x.id !== f.id))}>移除</button></div>)}
        <footer>{meta?.attachments ? <label className="sharing-upload">添加附件<input type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.webp,.gif" disabled={busy || uploading || running || !!retry || needsRestart} onChange={e => { void upload(e.target.files); e.target.value = ""; }}/></label> : null}<button className="primary" disabled={busy || uploading || running || needsRestart || files.some(f => f.status !== "ready") || (!text.trim() && !retry) || !!meta?.visitorPercent && !paymentConfirmed}>{busy ? '正在提交…' : retry ? '找回这次提交' : '发送'}</button></footer>
        {retry && !busy ? <p className="hint" role="status">提交结果尚未确认，先找回这次请求，不会再做一份。</p> : null}
        {meta?.attachments ? <small>最多 5 个附件，单文件 200 MB；图片 20 MB。只用于本会话问答。</small> : null}
      </form></>}
    {error ? <div className="avatar-public-error" role="alert"><p>{error}</p>{token ? <div>{!needsRestart ? <button type="button" disabled={busy || uploading} onClick={() => void load().then(() => setError('')).catch(e => setError(failure(e)))}>查看最新进展</button> : null}<button type="button" disabled={busy || uploading || running || !!retry} onClick={() => setRestart(true)}>开启新会话</button></div> : null}</div> : null}
    {restart ? <SettingsDialog title="开启一段新会话？" onClose={() => { if (!busy)
        setRestart(false); }}><p>新会话不会带入当前问题和附件。当前记录不会删除，但请先保存需要的成果。</p><footer className="avatar-dialog-actions"><button type="button" data-dialog-focus disabled={busy} onClick={() => setRestart(false)}>留在这里</button><button type="button" disabled={busy} onClick={() => void start()}>开启新会话</button></footer></SettingsDialog> : null}
  </main>;
}
