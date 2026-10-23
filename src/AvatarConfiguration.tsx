import { useState } from 'react';
import type { AvatarAvailableFeature, AvatarBusinessConfig, AvatarServiceConfig } from './AvatarService';
// Intent: a teacher turns their own method into a service; the selected method and
// delivery tools lead. Existing ONE paper/ink/sage, quiet borders, 4 px spacing.
export function AvatarMethodFields({ value, onChange, features, disabled = false }: {
    value: AvatarServiceConfig;
    onChange: (value: AvatarServiceConfig) => void;
    features: AvatarAvailableFeature[];
    disabled?: boolean;
}) {
    const [fileError, setFileError] = useState('');
    async function readMethod(file?: File) {
        if (!file)
            return;
        setFileError('');
        if (!/\.(md|txt)$/i.test(file.name) || file.size > 128 * 1024) {
            setFileError('请选择 128 KB 以内的 .md 或 .txt 方法文档。');
            return;
        }
        try {
            const text = await file.text();
            if (text.length > 12000)
                throw new Error('方法文档超过 12000 字，请精简后再导入。');
            onChange({ ...value, method: text });
        }
        catch (e) {
            setFileError(e instanceof Error ? e.message : '没能读取文档，请重选或直接粘贴。');
        }
    }
    return <section className="avatar-config-section" aria-labelledby="avatar-method-title"><header><span className="avatar-section-index">02</span><div><h3 id="avatar-method-title">方法与交付</h3><p>把你的判断方法写清楚，再选需要用的工具。</p></div></header>
    <label>方法资料<textarea rows={7} maxLength={12000} value={value.method} disabled={disabled} onChange={e => onChange({ ...value, method: e.target.value })} placeholder="例如：先问目标与现状，再按我的三个判断维度分析，最后给出可执行的建议。资料不足时先追问，不编造事实。"/></label>
    <div className="avatar-method-import"><label className="avatar-file-control">从文档导入<input type="file" accept=".md,.txt,text/plain,text/markdown" disabled={disabled} onChange={e => { void readMethod(e.target.files?.[0]); e.target.value = ''; }}/></label><small>仅导入这份文档的文字，不读取其他本机文件。</small></div>{fileError ? <p role="alert">{fileError}</p> : null}
    <fieldset className="avatar-feature-options"><legend>允许分身使用的功能 <span>最多 4 项</span></legend>{!features.length ? <p className="hint">暂无可用于公开交付的功能，仍可用方法资料回答问题。</p> : features.map(f => { const selected = value.features.find(v => v.featureId === f.id && v.releaseId === f.releaseId); return <div className="avatar-feature-option" key={`${f.id}:${f.releaseId}`}><label className="sharing-check"><input type="checkbox" checked={!!selected} disabled={disabled || (!selected && value.features.length >= 4)} onChange={e => onChange({ ...value, features: e.target.checked ? [...value.features, { featureId: f.id, releaseId: f.releaseId, when: '', workflow: '' }] : value.features.filter(v => v !== selected) })}/><span><strong>{f.name}</strong><small>{f.description}</small>{f.usageMultiplier!==undefined?<small>功能计费倍率：{f.usageMultiplier}（以该功能模型参考价为基准），按实际用量结算。</small>:null}</span></label>{selected ? <div className="avatar-feature-workflow"><label>什么时候用<textarea rows={2} required maxLength={500} value={selected.when} disabled={disabled} onChange={e => onChange({ ...value, features: value.features.map(v => v === selected ? { ...v, when: e.target.value } : v) })} placeholder="例如：访客需要填写预算，或比较两个方案时。"/></label><label>按什么流程交付<textarea rows={3} maxLength={1800} value={selected.workflow} disabled={disabled} onChange={e => onChange({ ...value, features: value.features.map(v => v === selected ? { ...v, workflow: e.target.value } : v) })} placeholder="例如：先确认收入与支出，再做可填写的测算表；缺少数字时留空，让访客自行填写。"/></label></div> : null}</div>; })}
      {value.features.filter(v => !features.some(f => f.id === v.featureId && f.releaseId === v.releaseId)).map(v => <div className="avatar-unavailable-feature" key={v.featureId}><p>一项原功能已不可用，请移除后重新选择。</p><button type="button" disabled={disabled} onClick={() => onChange({ ...value, features: value.features.filter(f => f !== v) })}>移除不可用功能</button></div>)}
    </fieldset>
  </section>;
}
// Intent: the visitor sees an expert's welcome rather than prompt machinery.
// Name and greeting lead; existing type scale, warm inset inputs, compact groups.
export function AvatarWelcomeFields({ value, onChange, authorName, disabled = false }: {
    value: AvatarServiceConfig;
    onChange: (value: AvatarServiceConfig) => void;
    authorName?: string;
    disabled?: boolean;
}) {
    return <><p className="avatar-author-note">作者：<strong>{authorName || '你的账号名称'}</strong><small>与账号资料一致，访客能看到这位作者。</small></p><fieldset className="avatar-mode-options"><legend>主要用途</legend><label className="sharing-check"><input type="radio" name="avatar-mode" checked={value.mode === 'consultation'} disabled={disabled} onChange={() => onChange({ ...value, mode: 'consultation' })}/><span><strong>售前咨询</strong><small>了解需求、解答疑问，需要时交给你继续聊。</small></span></label><label className="sharing-check"><input type="radio" name="avatar-mode" checked={value.mode === 'knowledge'} disabled={disabled} onChange={() => onChange({ ...value, mode: 'knowledge' })}/><span><strong>知识服务</strong><small>用你的方法与资料，持续给出建议和成果。</small></span></label></fieldset><label>开场白<textarea rows={3} maxLength={500} value={value.welcome} disabled={disabled} onChange={e => onChange({ ...value, welcome: e.target.value })} placeholder="你好，我们可以先聊聊你现在最想解决的一件事。"/></label><fieldset className="avatar-starters-editor"><legend>访客可以从这些问题开始 <span>选填，最多 4 个</span></legend>{Array.from({ length: Math.min(4, Math.max(1, value.starterQuestions.length + 1)) }, (_, index) => <input key={index} aria-label={`开场问题 ${index + 1}`} maxLength={160} value={value.starterQuestions[index] ?? ''} disabled={disabled} placeholder={index === 0 ? '例如：我适合从哪个方案开始？' : '再加一个问题'} onChange={e => { const next = [...value.starterQuestions]; next[index] = e.target.value; onChange({ ...value, starterQuestions: next }); }}/>)}</fieldset></>;
}
// Intent: service eligibility is distinct from wallet billing; teachers see the
// access choice before optional plans. No simulated purchase or payout controls.
export function AvatarBusinessFields({ value, onChange, disabled = false }: {
    value: AvatarBusinessConfig;
    onChange: (value: AvatarBusinessConfig) => void;
    disabled?: boolean;
}) {
    return <div className="avatar-business-fields"><fieldset><legend>服务资格</legend><label className="sharing-check"><input type="radio" name="avatar-access" checked={value.access === 'open'} disabled={disabled} onChange={() => onChange({ ...value, access: 'open' })}/><span>打开链接即可使用</span></label><label className="sharing-check"><input type="radio" name="avatar-access" checked={value.access === 'entitlement'} disabled={disabled} onChange={() => onChange({ ...value, access: 'entitlement' })}/><span>领取服务资格后使用</span></label><small>服务资格只用于本分身，与 ONE 会员和钱包分开。</small></fieldset>
    <fieldset><legend>服务方案 <span>选填</span></legend><p className="hint">先由你完成收款或确认赠送，再发放兑换码。这里不会自动扣款或续费。</p>{value.plans.map((plan, i) => <section className="avatar-plan-editor" key={plan.id ?? i}><header><strong>{plan.name || `方案 ${i + 1}`}</strong><button type="button" disabled={disabled} onClick={() => onChange({ ...value, plans: value.plans.filter((_, n) => n !== i) })}>移除</button></header><label>方案名称<input required maxLength={60} value={plan.name} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, name: e.target.value } : p) })}/></label><div className="avatar-two-column"><label>使用方式<select value={plan.kind} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, kind: e.target.value as 'monthly' | 'credits', validDays: e.target.value === 'monthly' ? 30 : p.validDays } : p) })}><option value="monthly">30 天含额度</option><option value="credits">额度包</option></select></label><label>服务价（元）<input type="number" min="0" max="100000" step="0.01" value={plan.priceCny} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, priceCny: Number(e.target.value) } : p) })}/></label></div><div className="avatar-two-column"><label>使用额度（电力）<input type="number" min="0.01" max="10000" step="0.01" value={plan.quota} disabled={disabled} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, quota: Number(e.target.value) } : p) })}/></label><label>有效天数<input type="number" min="1" max="89" value={plan.kind === 'monthly' ? 30 : plan.validDays} disabled={disabled || plan.kind === 'monthly'} onChange={e => onChange({ ...value, plans: value.plans.map((p, n) => n === i ? { ...p, validDays: Number(e.target.value) } : p) })}/></label></div></section>)}<button type="button" disabled={disabled || value.plans.length >= 6} onClick={() => onChange({ ...value, plans: [...value.plans, { name: '', kind: 'monthly', quota: 1, priceCny: 0, validDays: 30, status: 'active' }] })}>＋ 添加服务方案</button></fieldset>
    <fieldset><legend>联系表单 <span>选填</span></legend><p className="hint">访客自行填写并确认发送，你只会收到这份表单，不会收到聊天原文。</p>{value.intakeFields.map((field, i) => <div className="avatar-intake-editor" key={i}><input aria-label={`联系字段 ${i + 1}`} required maxLength={40} value={field.label} placeholder="例如：怎么称呼你" disabled={disabled} onChange={e => onChange({ ...value, intakeFields: value.intakeFields.map((f, n) => n === i ? { ...f, label: e.target.value } : f) })}/><select aria-label={`字段 ${i + 1} 的类型`} value={field.type} disabled={disabled} onChange={e => onChange({ ...value, intakeFields: value.intakeFields.map((f, n) => n === i ? { ...f, type: e.target.value as typeof field.type } : f) })}><option value="text">文字</option><option value="number">数字</option><option value="email">邮箱</option><option value="phone">电话</option></select><label className="sharing-check"><input type="checkbox" checked={!!field.required} disabled={disabled} onChange={e => onChange({ ...value, intakeFields: value.intakeFields.map((f, n) => n === i ? { ...f, required: e.target.checked } : f) })}/>必填</label><button type="button" aria-label={`移除联系字段 ${i + 1}`} disabled={disabled} onClick={() => onChange({ ...value, intakeFields: value.intakeFields.filter((_, n) => n !== i) })}>移除</button></div>)}<button type="button" disabled={disabled || value.intakeFields.length >= 6} onClick={() => onChange({ ...value, intakeFields: [...value.intakeFields, { id: `field_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, label: '', type: 'text' }] })}>＋ 添加联系字段</button></fieldset>
  </div>;
}
