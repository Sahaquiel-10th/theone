import { useEffect, useId, useRef, useState } from 'react';
import { Search, Upload, WandSparkles } from 'lucide-react';
import type { AvatarAvailableFeature, AvatarBusinessConfig, AvatarServiceConfig } from './AvatarService';
import { Pagination, SettingsDialog } from './SettingsControls';
import { appendAvatarMethod, avatarFeatureSelected, avatarFeatureSuggestions, avatarWithFeature, avatarWithMode, AVATAR_FEATURE_LIMIT, AVATAR_METHOD_LIMIT } from './avatarConfigurationState';

// Intent: teachers bring their own materials, then choose a few delivery tools.
// Hierarchy: import leads; only selected tools occupy the workbench. Palette,
// depth and surfaces reuse ONE glass/ink tokens; inherited type, 4 px spacing.
export function AvatarMethodFields({ value, onChange, features, disabled = false }: {
    value: AvatarServiceConfig; onChange: (value: AvatarServiceConfig) => void;
    features: AvatarAvailableFeature[]; disabled?: boolean;
}) {
    const titleId = useId(), errorId = useId(), inputRef = useRef<HTMLInputElement>(null);
    const latest = useRef({ value, onChange, disabled }); latest.current = { value, onChange, disabled };
    const importGeneration = useRef(0);
    useEffect(() => () => { importGeneration.current++; }, []);
    const [fileError, setFileError] = useState(''), [importedName, setImportedName] = useState(''), [importing, setImporting] = useState(false);
    const [choosingFeatures, setChoosingFeatures] = useState(false), [query, setQuery] = useState(''), [page, setPage] = useState(1);
    const consultation = value.mode === 'consultation';
    const filtered = features.filter(f => `${f.name} ${f.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 8)));
    const suggestions = avatarFeatureSuggestions(features, value.mode).filter(f => !avatarFeatureSelected(value, f));
    async function readMethod(file?: File) {
        if (!file) return;
        setFileError(''); setImportedName('');
        if (!/\.(md|txt)$/i.test(file.name) || file.size > 128 * 1024) { setFileError('请选择 128 KB 以内的 .md 或 .txt 文档；其他格式可先复制文字粘贴到下方。'); return; }
        setImporting(true);
        const generation = ++importGeneration.current;
        try { const text = await file.text(), current = latest.current; if (generation !== importGeneration.current) return; if (current.disabled) throw new Error('配置正在保存，这份文档尚未加入。保存完成后请再次导入。'); current.onChange({ ...current.value, method: appendAvatarMethod(current.value.method, text) }); setImportedName(file.name); }
        catch (e) { setFileError(e instanceof Error ? e.message : '没能读取文档，原内容没有改动；请重选或粘贴文字。'); }
        finally { setImporting(false); }
    }
    return <section className="avatar-config-section avatar-method-section" aria-labelledby={titleId}>
        <header><span className="avatar-section-index">02</span><div><h3 id={titleId}>{'提示词、资料与工具'}</h3><p>{consultation ? '提供服务介绍、常见问题和判断标准，先了解需求，再帮访客选择。' : '放入课程、方法和案例，让分身依据资料回答，并交付具体成果。'}</p></div></header>
        <div className="avatar-document-import"><div><strong>先放入你的资料</strong><p>{consultation ? '例如：你提供什么服务、适合谁、常见疑问及如何联系你。' : '例如：课程讲义、咨询方法、案例和交付标准。'}</p></div>
            <button type="button" className="avatar-document-import-button" disabled={disabled || importing} onClick={() => inputRef.current?.click()} aria-describedby={errorId}><Upload size={17} aria-hidden="true" />{importing ? '正在读取文档…' : value.method.trim() ? '继续导入文档' : '导入文档'}</button>
            <input ref={inputRef} type="file" hidden aria-label="导入分身资料文档" accept=".md,.txt,text/plain,text/markdown" disabled={disabled || importing} onChange={e => { void readMethod(e.target.files?.[0]); e.target.value = ''; }} />
            <small id={errorId}>支持 .md、.txt，单份最多 128 KB；文字追加到下方，不覆盖已有内容。仅读取你选中的文档。</small></div>
        {fileError ? <p className="avatar-config-error" role="alert">{fileError}</p> : null}{importedName ? <p className="avatar-import-result" role="status">已追加《{importedName}》的文字，保存分身后生效。</p> : null}
        <label>提示词<textarea rows={7} maxLength={AVATAR_METHOD_LIMIT} value={value.method} disabled={disabled} onChange={e => onChange({ ...value, method: e.target.value })} placeholder={consultation ? '介绍你能解决什么问题、服务适合谁。访客应先说明哪些情况，什么情况下建议与你本人联系？' : '写下你的判断方法、知识要点和交付标准。例如：先确认目标与现状，再按三个维度分析，最后给出建议。'} /><small>{value.method.length.toLocaleString()} / 12,000 字</small></label>
        <fieldset className="avatar-feature-options"><legend>分身可以使用的功能 <span>选填，最多 4 项</span></legend>
            <div className="avatar-feature-picker-header"><p>{consultation ? '按需添加评估、测算或填表，不必把所有功能都开放给访客。' : '按需添加表格、方案或网页交付；不选功能也能用资料回答。'}</p><button type="button" disabled={disabled || !features.length} onClick={() => { setQuery(''); setPage(1); setChoosingFeatures(true); }}>选择功能 <span>{value.features.length} / 4</span></button></div>
            {!features.length ? <p className="hint">暂无可用于公开交付的功能，仍可用提示词回答问题。</p> : null}
            {value.features.map(selected => { const f = features.find(f => f.id === selected.featureId && f.releaseId === selected.releaseId);
                if (!f) return <div className="avatar-unavailable-feature" key={`${selected.featureId}:${selected.releaseId}`}><p>一项原功能已不可用，请移除后重新选择。</p><button type="button" disabled={disabled} onClick={() => onChange({ ...value, features: value.features.filter(v => v !== selected) })}>移除不可用功能</button></div>;
                return <div className="avatar-feature-option avatar-selected-feature" key={`${f.id}:${f.releaseId}`}><header><div><strong>{f.name}</strong><small>{f.description}</small>{f.usageMultiplier !== undefined ? <small>功能计费倍率：{f.usageMultiplier}（以该功能模型参考价为基准），按实际用量结算。</small> : null}</div><button type="button" disabled={disabled} aria-label={`移除功能：${f.name}`} onClick={() => onChange(avatarWithFeature(value, f, false))}>移除</button></header>
                    <div className="avatar-feature-workflow"><label>什么时候用<textarea rows={2} required maxLength={500} value={selected.when} disabled={disabled} onChange={e => onChange({ ...value, features: value.features.map(v => v === selected ? { ...v, when: e.target.value } : v) })} placeholder={consultation ? '例如：访客想比较方案，或需要初步预算时。' : '例如：访客需要把建议整理成可填写表格时。'} /></label><label>按什么流程交付<textarea rows={3} maxLength={1800} value={selected.workflow} disabled={disabled} onChange={e => onChange({ ...value, features: value.features.map(v => v === selected ? { ...v, workflow: e.target.value } : v) })} placeholder="先确认必要信息，再做测算表；缺少数字时留空，让访客自行填写。" /></label></div></div>;
            })}
            {!value.features.length && features.length ? <p className="avatar-feature-empty">还没选择功能。先配好资料和回答要求，也可以开始测试。</p> : null}
            {suggestions.length && value.features.length < AVATAR_FEATURE_LIMIT ? <div className="avatar-feature-suggestions"><span><WandSparkles size={14} aria-hidden="true" />可以看看</span>{suggestions.map(f => <button type="button" key={`${f.id}:${f.releaseId}`} disabled={disabled} onClick={() => onChange(avatarWithFeature(value, f, true))}>＋ {f.name}</button>)}</div> : null}
        </fieldset>
        {choosingFeatures ? <SettingsDialog title="选择分身可用的功能" eyebrow={`已选 ${value.features.length} / 4 项 · 只选这位分身真正需要的`} className="avatar-feature-picker-dialog" onClose={() => setChoosingFeatures(false)}>
            <div className="settings-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="搜索分身功能" placeholder="搜索功能名称或用途" value={query} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); } }} onChange={e => { setQuery(e.target.value); setPage(1); }} /></div><p className="avatar-feature-picker-status" role="status">已选 {value.features.length} / 4 项{value.features.length >= AVATAR_FEATURE_LIMIT ? '；移除一项后可选择其他功能。' : '；选择后在配置页填写调用条件。'}</p>
            <div className="avatar-feature-choice-list">{filtered.slice((currentPage - 1) * 8, currentPage * 8).map(f => { const selected = avatarFeatureSelected(value, f); return <label className="avatar-feature-choice" key={`${f.id}:${f.releaseId}`}><input type="checkbox" checked={selected} disabled={disabled || (!selected && value.features.length >= AVATAR_FEATURE_LIMIT)} onChange={e => onChange(avatarWithFeature(value, f, e.target.checked))} /><span><strong>{f.name}</strong><small>{f.description}</small></span></label>; })}{!filtered.length ? <p className="settings-empty">没有找到这个功能，试试其他名称或用途。</p> : null}</div>
            <Pagination page={currentPage} total={filtered.length} size={8} onChange={setPage} /><div className="avatar-dialog-actions"><button type="button" className="primary" onClick={() => setChoosingFeatures(false)}>完成选择</button></div>
        </SettingsDialog> : null}
    </section>;
}

// Goal and visitor greeting stay separate; exploring another goal keeps all text.
export function AvatarWelcomeFields({ value, onChange, authorName, disabled = false, section }: {
    value: AvatarServiceConfig; onChange: (value: AvatarServiceConfig) => void;
    authorName?: string; disabled?: boolean; section?: 'purpose' | 'welcome';
}) {
    const groupName = useId(), consultation = value.mode === 'consultation';
    return <>{section !== 'welcome' ? <><p className="avatar-author-note">作者：<strong>{authorName || '你的账号名称'}</strong><small>与账号资料一致，访客能看到这位作者。</small></p>
        <fieldset className="avatar-mode-options"><legend>主要用途</legend><label className="sharing-check"><input type="radio" name={`avatar-mode-${groupName}`} checked={consultation} disabled={disabled} onChange={() => onChange(avatarWithMode(value, 'consultation'))} /><span><strong>售前咨询</strong><small>了解需求、解答服务疑问，再引导访客与你本人联系。</small></span></label><label className="sharing-check"><input type="radio" name={`avatar-mode-${groupName}`} checked={!consultation} disabled={disabled} onChange={() => onChange(avatarWithMode(value, 'knowledge'))} /><span><strong>知识服务</strong><small>依据资料和方法回答，按需交付表格或方案。</small></span></label></fieldset>
        <div className="avatar-purpose-guide" role="status"><strong>{consultation ? '先帮你接待潜在客户' : '把你的知识变成可使用的服务'}</strong><p>{consultation ? '配置重点：服务介绍 → 常见问题 → 了解需求 → 自愿留下联系方式。下方会显示适合咨询的资料与问题示例。' : '配置重点：知识资料 → 回答方法 → 交付工具 → 使用额度与收费。下方会显示适合知识服务的资料与问题示例。'}</p><small>切换用途只调整服务目标和配置引导，不覆盖已填内容，也不改变收费或知识授权。</small></div></> : null}
        {section !== 'purpose' ? <><label>{consultation ? '访客进来时，你想先说什么？' : '先向访客介绍这项知识服务'}<textarea rows={3} maxLength={500} value={value.welcome} disabled={disabled} onChange={e => onChange({ ...value, welcome: e.target.value })} placeholder={consultation ? '你好，我是林老师的 AI 分身。先说说你遇到的问题，我可以帮你了解哪种服务更合适。' : '你好，我可以根据林老师的课程与方法帮你分析问题。你想先学一个概念，还是解决一件具体的事？'} /><small>这段开场白显示在访客页面，不是给 AI 的回答要求。</small></label>
        <fieldset className="avatar-starters-editor"><legend>访客可以直接点选的问题 <span>选填，最多 4 个</span></legend><small>像快捷提问按钮一样，帮助访客开始对话；不会自动提问。</small>{Array.from({ length: Math.min(4, Math.max(1, value.starterQuestions.length + 1)) }, (_, i) => <label key={i} className="avatar-starter-editor-row"><span>问题 {i + 1}</span><input aria-label={`开场问题 ${i + 1}`} maxLength={160} value={value.starterQuestions[i] ?? ''} disabled={disabled} placeholder={i === 0 ? consultation ? '例如：我适合从哪个服务开始？' : '例如：帮我用你的方法分析一个案例' : '再加一个问题'} onChange={e => { const next = [...value.starterQuestions]; next[i] = e.target.value; onChange({ ...value, starterQuestions: next }); }} /></label>)}</fieldset></> : null}</>;
}

// Pricing describes what the teacher sells, never automatic platform collection.
export function AvatarBusinessFields({ value, onChange, disabled = false, section, mode }: {
    value: AvatarBusinessConfig; onChange: (value: AvatarBusinessConfig) => void;
    disabled?: boolean; section?: 'pricing' | 'contact'; mode?: AvatarServiceConfig['mode'];
}) {
    const groupName = useId();
    return <div className="avatar-business-fields">{section !== 'contact' ? <>
        <fieldset><legend>谁可以使用这个分身？</legend><label className="sharing-check"><input type="radio" name={`avatar-access-${groupName}`} checked={value.access === 'open'} disabled={disabled} onChange={() => onChange({ ...value, access: 'open' })} /><span>打开链接即可使用</span></label><label className="sharing-check"><input type="radio" name={`avatar-access-${groupName}`} checked={value.access === 'entitlement'} disabled={disabled} onChange={() => onChange({ ...value, access: 'entitlement' })} /><span>登录并兑换你的服务后使用</span></label><small>服务资格只用于本分身，与 ONE 会员和钱包分开。选择用途不会替你更改这项设置。</small></fieldset>
        <fieldset><legend>收费方案 <span>选填</span></legend><p className="hint">{mode === 'consultation' ? '售前接待可以不设收费方案；若也提供收费服务，可在这里展示。' : '设置你卖给访客的价格、可用额度和有效期。'}先由你自行收款或确认赠送，再发放兑换码；这里不会自动扣款或续费，也不代收款、自动分账。</p>{value.plans.map((plan, i) => <section className="avatar-plan-editor" key={plan.id ?? i}>
            <header><strong>{plan.name || `收费方案 ${i + 1}`}</strong><button type="button" disabled={disabled} onClick={() => onChange({ ...value, plans: value.plans.filter((_, n) => n !== i) })}>移除</button></header><label>方案名称<input required maxLength={60} value={plan.name} disabled={disabled} placeholder="例如：30 天学习陪伴" onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, name: e.target.value } : p) })} /></label>
            <div className="avatar-two-column"><label>包含什么<select value={plan.kind} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, kind: e.target.value as 'monthly' | 'credits', validDays: e.target.value === 'monthly' ? 30 : p.validDays } : p) })}><option value="monthly">30 天使用期＋固定额度</option><option value="credits">一次购买的额度包</option></select></label><label>向客户收多少钱（元）<input type="number" min="0" max="100000" step="0.01" value={plan.priceCny} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, priceCny: Number(e.target.value) } : p) })} /></label></div>
            <div className="avatar-two-column"><label>客户可用额度（电力）<input type="number" min="0.01" max="10000" step="0.01" value={plan.quota} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, quota: Number(e.target.value) } : p) })} /><small>这是使用额度，不是给你充值的电力；实际费用仍按用量结算。</small></label><label>兑换后可用天数<input type="number" min="1" max="89" value={plan.kind === 'monthly' ? 30 : plan.validDays} disabled={disabled || plan.kind === 'monthly'} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, validDays: Number(e.target.value) } : p) })} /></label></div>
        </section>)}<button type="button" disabled={disabled || value.plans.length >= 6} onClick={() => onChange({ ...value, plans: [...value.plans, { name: '', kind: 'monthly', quota: 1, priceCny: 0, validDays: 30, status: 'active' }] })}>＋ 添加收费方案</button></fieldset></> : null}
        {section !== 'pricing' ? <fieldset><legend>收集客户信息 <span>选填</span></legend><p className="hint">{mode === 'knowledge' ? '需要后续人工辅导时，可邀请访客留下联系方式。' : '让有意向的访客留下需求与联系方式，方便你本人跟进。'}访客自行填写并确认发送；你只会收到这份表单，不会收到聊天原文。未添加字段时不显示表单。</p>{value.intakeFields.map((field, i) => <div className="avatar-intake-editor" key={field.id}>
            <label>想问客户什么？<input aria-label={`客户信息字段 ${i + 1}`} required maxLength={40} value={field.label} placeholder="例如：称呼、微信号、咨询需求" disabled={disabled} onChange={e => onChange({ ...value, intakeFields: value.intakeFields.map((f, n) => n === i ? { ...f, label: e.target.value } : f) })} /></label><label>填写类型<select aria-label={`字段 ${i + 1} 的类型`} value={field.type} disabled={disabled} onChange={e => onChange({ ...value, intakeFields: value.intakeFields.map((f, n) => n === i ? { ...f, type: e.target.value as typeof field.type } : f) })}><option value="text">文字</option><option value="number">数字</option><option value="email">邮箱</option><option value="phone">电话</option></select></label><label className="sharing-check"><input type="checkbox" checked={!!field.required} disabled={disabled} onChange={e => onChange({ ...value, intakeFields: value.intakeFields.map((f, n) => n === i ? { ...f, required: e.target.checked } : f) })} />必填</label><button type="button" aria-label={`移除客户信息字段 ${i + 1}`} disabled={disabled} onClick={() => onChange({ ...value, intakeFields: value.intakeFields.filter((_, n) => n !== i) })}>移除</button>
        </div>)}<button type="button" disabled={disabled || value.intakeFields.length >= 6} onClick={() => onChange({ ...value, intakeFields: [...value.intakeFields, { id: `field_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, label: '', type: 'text' }] })}>＋ 添加要收集的信息</button></fieldset> : null}
    </div>;
}
