import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, RotateCcw, X } from 'lucide-react';
import type { api as Api } from './oneApi';
import { SESSION_EVENT } from './oneApi';
import type { PublicationDraft } from './sharingWorkspaceState';
import { normalizedAvatarService } from './AvatarService';
import { AvatarPublicIdentity } from './AvatarPublicIdentity';
import { MessageMarkdown } from './MessageMarkdown';
import { avatarDebugConfigKey, avatarDebugFailure, createAvatarDebugGate, createAvatarDebugSession, createAvatarDebugSubmission, retrieveAvatarDebugReceipt, type AvatarDebugExchange, type AvatarDebugReceipt, type AvatarDebugSession, type AvatarDebugSubmission } from './avatarDebugState';
export type { AvatarDebugSession } from './avatarDebugState';

const power = (micros: number) => (micros / 1e6).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
// Intent: teachers try the exact visitor-facing conversation while editing.
// Hierarchy: avatar name, greeting and actual messages lead; test boundaries sit
// quietly at the composer. Palette: clear glass, ink, fog, warm gray and sage.
// Depth/surfaces: the existing split-pane glass, no second preview card. Shared
// visitor typography, 4 px spacing and a single outer scroll owner are preserved.
export function AvatarDebugPanel({ api, draft, authorName, onClose, modelName, initialSession, onSessionChange }: {
    api: typeof Api; draft: PublicationDraft; authorName?: string; onClose: () => void; modelName?: string;
    initialSession?: AvatarDebugSession; onSessionChange?: (session: AvatarDebugSession) => void;
}) {
    const initial = useRef<AvatarDebugSession | null>(null);
    if (!initial.current) initial.current = createAvatarDebugSession(initialSession);
    const titleId = useId(), questionId = useId(), input = useRef<HTMLTextAreaElement>(null);
    const [question, setQuestion] = useState(initial.current.question), [consent, setConsent] = useState(initial.current.consent), [busy, setBusy] = useState(false);
    const [error, setError] = useState(''), [pending, setPending] = useState<AvatarDebugSubmission | undefined>(initial.current.pending), [exchanges, setExchanges] = useState<AvatarDebugExchange[]>(initial.current.exchanges);
    const gate = useRef(createAvatarDebugGate()), inFlight = useRef(false), threadKey = useRef<string | undefined>(initial.current.threadKey);
    const sessionObserver = useRef(onSessionChange); sessionObserver.current = onSessionChange;
    const sessionSnapshot = useRef<AvatarDebugSession>(initial.current);
    sessionSnapshot.current = { question, consent, pending, exchanges, threadKey: threadKey.current };
    const configKey = avatarDebugConfigKey(draft), service = normalizedAvatarService(draft.service);
    const stale = !!threadKey.current && threadKey.current !== configKey;
    const lastConfig = useRef(configKey);
    useEffect(() => { if (lastConfig.current !== configKey) { lastConfig.current = configKey; setConsent(false); } }, [configKey]);
    useEffect(() => { sessionObserver.current?.(createAvatarDebugSession(sessionSnapshot.current)); }, [question, consent, pending, exchanges, configKey]);
    useEffect(() => {
        const resetSession = () => { gate.current.invalidate(); inFlight.current = false; threadKey.current = undefined; sessionSnapshot.current = createAvatarDebugSession(); sessionObserver.current?.(createAvatarDebugSession()); setBusy(false); setQuestion(''); setConsent(false); setPending(undefined); setExchanges([]); setError('登录账号已切换，请回到当前账号的分身重新打开调试。'); };
        window.addEventListener(SESSION_EVENT, resetSession);
        return () => { gate.current.invalidate(); sessionObserver.current?.(createAvatarDebugSession(sessionSnapshot.current)); window.removeEventListener(SESSION_EVENT, resetSession); };
    }, []);

    async function run(submission: AvatarDebugSubmission) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setError(''); setPending(submission);
        const ticket = gate.current.begin();
        try {
            const receipt = await retrieveAvatarDebugReceipt(submission, body => api<AvatarDebugReceipt>('/api/sharing/manage/preview', { method: 'POST', body }));
            if (!gate.current.current(ticket)) return;
            threadKey.current = submission.configKey;
            setExchanges(current => current.some(exchange => exchange.submission.operationId === submission.operationId) ? current : [...current, { submission, receipt }]);
            setPending(undefined); setQuestion(current => current.trim() === submission.question ? '' : current);
        } catch (failure) {
            if (!gate.current.current(ticket)) return;
            const kind = avatarDebugFailure(failure), message = failure instanceof Error ? failure.message : '暂时没能取得测试结果。';
            if (kind === 'session') { setPending(undefined); setExchanges([]); setQuestion(''); setConsent(false); threadKey.current = undefined; }
            else if (kind === 'finished') { setPending(undefined); setConsent(false); setQuestion(current=>current.trim()?current:submission.question); }
            setError(kind === 'pending' ? '这次还在回答，稍后点“找回这次回答”就好，不会重跑。' : kind === 'uncertain' ? `${message} 原问题已保留，先找回这次回答，不用重新发送。` : `${message} 没有自动重试；已产生的用量会保留。`);
        } finally {
            if (gate.current.current(ticket)) { inFlight.current = false; setBusy(false); }
        }
    }
    function submit(event: FormEvent) {
        event.preventDefault();
        if (inFlight.current || pending || stale) return;
        try { const submission = createAvatarDebugSubmission(draft, question, exchanges, crypto.randomUUID()); setConsent(true); setQuestion(''); threadKey.current = submission.configKey; void run(submission); }
        catch (failure) { setError(failure instanceof Error ? failure.message : '请先核对测试配置。'); }
    }
    function resetTrial() {
        if (inFlight.current || pending) return;
        gate.current.invalidate(); threadKey.current = undefined; setExchanges([]); setQuestion(''); setConsent(false); setError(''); input.current?.focus();
    }
    return <section className="avatar-debug-panel" aria-labelledby={titleId}>
        <header className="avatar-debug-toolbar"><div className="avatar-debug-toolbar-title"><h3 id={titleId}>访客试聊</h3><small className="avatar-debug-note">试聊使用你的电力，不会公开分享。</small></div><div className="avatar-debug-toolbar-actions"><button type="button" className="avatar-debug-new" disabled={busy || !!pending || (!exchanges.length && !threadKey.current)} onClick={resetTrial}><RotateCcw size={14} aria-hidden="true" />新开试聊</button><button type="button" className="avatar-debug-close" aria-label="收起分身调试窗口" onClick={onClose}><X size={18} aria-hidden="true" /></button></div></header>
        <div className="avatar-debug-visitor" aria-label="访客聊天页面">
            <AvatarPublicIdentity name={draft.name.trim() || '你的分身名称'} authorName={authorName} description={draft.description} mode={service.mode}/>
            {stale ? <p className="avatar-debug-stale" role="status">左侧配置已经变化。已有回答仍基于旧配置；{pending ? '先取回原测试结果，再新开试聊。' : '新开试聊后，就会使用新配置。'}</p> : null}
            {!exchanges.length && !pending ? <section className="avatar-welcome"><p>{service.welcome.trim() || '你好，可以先说说你现在想解决的一件事。'}</p>{service.starterQuestions.some(starter=>starter.trim())?<div className="avatar-starter-questions" aria-label="从这些问题开始">{service.starterQuestions.map((starter, index) => starter.trim() ? <button type="button" key={index} disabled={busy || !!pending || stale} onClick={() => { setQuestion(starter); input.current?.focus(); }}>{starter}<ArrowRight size={16} aria-hidden="true" /></button> : null)}</div>:null}</section> : null}
            <div className="public-answers avatar-debug-exchanges" aria-live="polite">{exchanges.map(exchange => <article key={exchange.submission.operationId}><p className="public-question avatar-debug-question">{exchange.submission.question}</p><div className="markdown-body avatar-debug-response">{exchange.submission.configKey !== configKey?<small className="avatar-debug-old-config">旧配置的回答</small>:null}<MessageMarkdown allowImages={false}>{exchange.receipt.response}</MessageMarkdown></div>{exchange.receipt.warning ? <p className="avatar-debug-warning" role="status">{exchange.receipt.warning}</p> : null}{exchange.receipt.finishReason==='length'?<p className="avatar-debug-warning" role="status">回答还没展开完，可以发送“继续”接着聊。</p>:null}{exchange.receipt.chargedMicros>0||exchange.receipt.heldMicros>0?<footer className="avatar-debug-cost"><span>{power(exchange.receipt.chargedMicros)} 电力</span>{exchange.receipt.heldMicros > 0 ? <span>{power(exchange.receipt.heldMicros)} 电力待核对</span> : null}</footer>:null}</article>)}</div>
            {pending ? <article className="avatar-debug-pending" aria-label="待返回的回答"><p className="public-question avatar-debug-question">{pending.question}</p><div className="avatar-debug-pending-status" role="status"><span aria-hidden="true"/>{busy ? '正在回答…' : '回答还没取回，原问题已保留。'}</div>{!busy ? <button type="button" onClick={() => void run(pending)}>找回这次回答</button> : null}<details className="avatar-debug-receipt-details"><summary>查看这次记录</summary><small>提交编号：{pending.operationId}</small><small>重新打开这位分身仍可核对原结果，不会重新执行或重复扣费。</small></details></article> : null}
            {error ? <p className="avatar-debug-error" role="alert">{error}</p> : null}
            <form className="public-composer avatar-debug-form" onSubmit={submit}><label className="avatar-composer-label" htmlFor={questionId}>说说你想解决的事</label><textarea ref={input} id={questionId} aria-label="问题" rows={3} maxLength={2000} value={pending?'':question} disabled={busy || !!pending || stale} onChange={event => setQuestion(event.target.value)} placeholder="从你的实际情况说起…"/>{!draft.modelId?<small className="avatar-debug-note" role="status">先在左侧选择执行模型，就能开始试聊。</small>:null}<footer><small className="avatar-debug-note" title={modelName?`当前模型：${modelName}`:undefined}>问答预览，不执行文件或工具。</small><button type="submit" className="primary" disabled={!question.trim() || !draft.modelId || busy || !!pending || stale}>{busy ? '正在回答…' : '发送'}</button></footer></form>
        </div>
    </section>;
}
