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
const limits = '仅测试回答和所选知识检索；不执行功能、不接收附件、不提交客户信息、不发布分享，也不向访客收费。';

// Intent: a teacher compares the live visitor entrance with a real private answer.
// Hierarchy: appearance is explicitly free; the consented test is separate below.
// Palette/depth: existing ONE glass and ink; 4 px rhythm, one natural scroll owner.
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
            else if (kind === 'finished') { setPending(undefined); setConsent(false); }
            setError(kind === 'pending' ? '原测试还在回答。稍后点“核对测试结果”取回原回执，不会重复调用或重复扣费。' : kind === 'uncertain' ? `${message} 原问题和提交编号已保留；请先核对测试结果，不要重新提交。` : `${message} 没有自动重试；如已产生模型用量会保留。`);
        } finally {
            if (gate.current.current(ticket)) { inFlight.current = false; setBusy(false); }
        }
    }
    function submit(event: FormEvent) {
        event.preventDefault();
        if (!consent || inFlight.current || pending || stale) return;
        try { const submission = createAvatarDebugSubmission(draft, question, exchanges, crypto.randomUUID()); threadKey.current = submission.configKey; void run(submission); }
        catch (failure) { setError(failure instanceof Error ? failure.message : '请先核对测试配置。'); }
    }
    function resetTrial() {
        if (inFlight.current || pending) return;
        gate.current.invalidate(); threadKey.current = undefined; setExchanges([]); setQuestion(''); setConsent(false); setError(''); input.current?.focus();
    }
    return <section className="avatar-debug-panel" aria-labelledby={titleId}>
        <header><div><h3 id={titleId}>预览与调试</h3><p>左边改配置，这边看访客入口、试一轮真实回答。不用先保存或分享。</p></div><button type="button" className="avatar-debug-close" aria-label="收起分身调试窗口" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
        <section className="avatar-debug-appearance" aria-label="访客入口外观预览"><div className="avatar-debug-section-label"><strong>访客会先看到这些</strong><span>外观预览，不消耗电力</span></div><AvatarPublicIdentity name={draft.name.trim() || '你的分身名称'} authorName={authorName} description={draft.description} mode={service.mode} />
            <div className="avatar-welcome"><p>{service.welcome.trim() || '在左侧填写开场白，看看你会怎样迎接访客。'}</p><div className="avatar-starter-questions">{service.starterQuestions.map((starter, index) => starter.trim() ? <button type="button" key={index} disabled={busy || !!pending} onClick={() => { setQuestion(starter); input.current?.focus(); }}><span>{starter}</span><ArrowRight size={16} aria-hidden="true" /></button> : null)}</div><small>点选问题只会填入下方输入框；确认并发送后才会使用模型。</small></div>
        </section>
        <section className="avatar-debug-live" aria-label="私有真实回答测试"><div className="avatar-debug-section-label"><strong>实际回答测试</strong><button type="button" disabled={busy || !!pending || (!exchanges.length && !threadKey.current)} onClick={resetTrial}><RotateCcw size={14} aria-hidden="true" />新开试聊</button></div><p className="avatar-debug-model-note">模型：{modelName || (draft.modelId ? '左侧选定的问答模型' : '尚未选择')} · {draft.sourceIds.length ? `会检索选中的 ${draft.sourceIds.length} 个知识来源` : '未选择个人知识来源'}</p><p className="avatar-debug-limitations">{limits} 测试用量由你承担。</p>
            {stale ? <p className="avatar-debug-stale" role="status">左侧配置已经变化。下面的回答仍基于提交时的旧配置；{pending ? '先取回原测试结果，再新开试聊。' : '请点“新开试聊”，避免把旧配置的对话带进新测试。'}</p> : null}
            <div className="avatar-debug-exchanges" aria-live="polite">{exchanges.map(exchange => <article key={exchange.submission.operationId}><p className="avatar-debug-question"><span>你扮演访客</span>{exchange.submission.question}</p><div className="avatar-debug-response"><small>分身回答{exchange.submission.configKey !== configKey ? ' · 旧配置' : ''}</small><MessageMarkdown allowImages={false}>{exchange.receipt.response}</MessageMarkdown></div>{exchange.receipt.warning ? <p className="avatar-debug-warning">{exchange.receipt.warning}</p> : null}<footer><span>本次已用 {power(exchange.receipt.chargedMicros)} 电力</span>{exchange.receipt.heldMicros > 0 ? <span>另有 {power(exchange.receipt.heldMicros)} 电力待核对</span> : null}</footer><details><summary>本轮测试范围</summary><p>{exchange.receipt.limitations}</p></details></article>)}</div>
            {pending ? <section className="avatar-debug-pending" aria-label="待核对的测试"><p>{busy ? '正在取得这一次测试的回答…' : '这次结果尚未确认，原提交已保留。'}</p><small>原问题：{pending.question}</small><small>提交编号：{pending.operationId}</small>{!busy ? <button type="button" onClick={() => void run(pending)}>核对测试结果（不重跑）</button> : null}<small>收起窗口不会停止服务端已开始的测试；本次登录内重新打开这位分身，可继续核对原结果。请勿另开相同测试。</small></section> : null}
            {error ? <p className="avatar-debug-error" role="alert">{error}</p> : null}
            <form className="avatar-debug-form" onSubmit={submit}><label htmlFor={questionId}>扮演访客问一句<textarea ref={input} id={questionId} rows={3} maxLength={2000} value={question} disabled={busy || !!pending || stale} onChange={event => setQuestion(event.target.value)} placeholder={service.mode === 'consultation' ? '例如：我现在这个情况，适合找你做咨询吗？' : '例如：请用你的方法，帮我分析这个问题。'} /></label><small className="avatar-debug-input-help">每轮问题最多 2000 字，只带入最近几轮试聊。这里用于短回答测试，达到测试长度上限会提示，不会自动续写。</small><label className="avatar-debug-consent"><input type="checkbox" checked={consent} disabled={busy || !!pending || stale} onChange={event => setConsent(event.target.checked)} /><span>我知道真实试聊会使用我自己的电力；不会开放分享或执行功能。</span></label><button type="submit" className="primary" disabled={!consent || !question.trim() || !draft.modelId || busy || !!pending || stale}>{busy ? '等待本次回答…' : '发送测试（使用我的电力）'}</button></form>
        </section>
    </section>;
}
