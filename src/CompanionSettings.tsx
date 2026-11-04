import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AccountProfile, ProfilePatch } from './Onboarding';
import type { CompanionPreferences } from '../server/oneCompanion';
import { companionChoices, companionIntensityChoices, companionSample } from './companionPersonas';

const initial = (profile: AccountProfile): CompanionPreferences => ({ persona: profile.companion?.persona ?? 'chunibyo', intensity: profile.companion?.intensity ?? 'normal', custom: profile.companion?.custom ?? '' });
const styles = `
.one-companion-settings{display:grid;gap:20px;color:var(--fluid-ink,#25333d);min-width:0}
.one-companion-settings>header{display:grid;gap:6px}.one-companion-settings h3{margin:0;font-size:16px;line-height:1.5;font-weight:620}.one-companion-settings p{margin:0}
.one-companion-settings .companion-hint,.one-companion-settings small{font-size:12px;line-height:1.7;color:var(--fluid-muted,#53616d)}
.one-companion-settings fieldset{padding:0;margin:0;border:0;min-width:0}.one-companion-settings legend,.one-companion-settings .companion-custom-label{margin-bottom:10px;font-size:13px;font-weight:600}
.one-companion-settings .companion-personas{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.one-companion-settings .companion-choice{display:grid;gap:6px;align-content:start;min-height:88px;padding:12px;border:1px solid var(--fluid-line,#52667730);border-radius:12px;cursor:pointer;background:transparent}
.one-companion-settings .companion-choice[data-selected=true]{background:var(--fluid-selection,#e0ddc33d);border-color:var(--fluid-focus,#806300)}.one-companion-settings .companion-choice:hover{background:var(--fluid-hover,#5266770a)}
.one-companion-settings .companion-choice:has(input:focus-visible){outline:2px solid var(--fluid-focus,#806300);outline-offset:3px}.one-companion-settings .companion-choice-heading{display:flex;gap:8px;align-items:center;min-height:24px}.one-companion-settings .companion-choice input{flex:none;accent-color:var(--fluid-focus,#806300);width:16px;height:16px;margin:0}.one-companion-settings .companion-choice strong{font-size:13px;font-weight:600}.one-companion-settings .companion-choice q{font-size:12px;line-height:1.65;quotes:none;overflow-wrap:anywhere}
.one-companion-settings .companion-strength{display:flex;flex-wrap:wrap;gap:8px}.one-companion-settings .companion-strength .companion-choice{flex:1;min-width:110px;min-height:44px;gap:2px;padding:10px}
.one-companion-settings .companion-preview{display:grid;gap:8px;padding:16px;background:var(--fluid-hover,#5266770a);border-radius:12px}.one-companion-settings .companion-preview>p{font-size:14px;line-height:1.8;overflow-wrap:anywhere}
.one-companion-settings .companion-custom{display:grid;gap:6px}.one-companion-settings .companion-custom input{box-sizing:border-box;width:100%;min-width:0;min-height:44px;padding:10px 12px;border:1px solid var(--fluid-line,#52667730);border-radius:10px;color:inherit;background:var(--fluid-hover,#5266770a);font:inherit;font-size:13px}
.one-companion-settings .companion-custom input:focus-visible,.one-companion-settings button:focus-visible{outline:2px solid var(--fluid-focus,#806300);outline-offset:3px}.one-companion-settings .companion-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.one-companion-settings button{min-height:44px;padding:10px 16px}.one-companion-settings [role=alert]{font-size:13px;line-height:1.7}.one-companion-settings fieldset:disabled{opacity:.65}.one-companion-settings fieldset:disabled label{cursor:wait}
@media(max-width:520px){.one-companion-settings .companion-personas{grid-template-columns:minmax(0,1fr)}}
`;

/** A local preview followed by an explicit save through the owner's profile API. */
export function CompanionSettings({ profile, onSave }: { profile: AccountProfile; onSave: (patch: ProfilePatch) => Promise<unknown> }) {
  const id = useId(), revision = useRef(0);
  const [draft, setDraft] = useState(() => initial(profile));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    revision.current++; setDraft(initial(profile)); setBusy(false); setError(''); setNotice('');
    return () => { revision.current++; };
  }, [profile.workspaceId, profile.companion?.persona, profile.companion?.intensity, profile.companion?.custom]);
  const changed = !profile.companion || JSON.stringify(draft) !== JSON.stringify(initial(profile));
  const invalid = [...(draft.custom ?? '')].length > 120 || /[\r\n]/.test(draft.custom ?? '');
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || invalid || !changed) return;
    const request = ++revision.current; setBusy(true); setError(''); setNotice('');
    try { await onSave({ companion: draft }); if (request === revision.current) setNotice('ONE 的性格已保存，下次回复就会使用。'); }
    catch (failure) { if (request === revision.current) setError(failure instanceof Error ? failure.message : '没有保存成功，请再试一次'); }
    finally { if (request === revision.current) setBusy(false); }
  }
  return <form className="one-companion-settings" onSubmit={save} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <style>{styles}</style>
    <header><h3 id={`${id}-title`}>ONE 的性格</h3><p className="companion-hint">选一个聊得来的搭档。文章、方案等成果会按你的具体要求来写。</p></header>
    <fieldset disabled={busy}><legend>选个搭档</legend><div className="companion-personas">{companionChoices.map(choice => <label className="companion-choice" key={choice.id} data-selected={draft.persona === choice.id}>
      <span className="companion-choice-heading"><input type="radio" name={`${id}-persona`} value={choice.id} checked={draft.persona === choice.id} onChange={() => setDraft(old => ({ ...old, persona: choice.id }))}/><strong>{choice.name}</strong></span>
      <small>{choice.description}</small><q>{choice.sample}</q>
    </label>)}</div></fieldset>
    <fieldset disabled={busy}><legend>戏份多少</legend><div className="companion-strength">{companionIntensityChoices.map(choice => <label className="companion-choice" key={choice.id} data-selected={draft.intensity === choice.id}>
      <span className="companion-choice-heading"><input type="radio" name={`${id}-intensity`} value={choice.id} checked={draft.intensity === choice.id} onChange={() => setDraft(old => ({ ...old, intensity: choice.id }))}/><strong>{choice.name}</strong></span><small>{choice.description}</small>
    </label>)}</div></fieldset>
    <div className="companion-preview" aria-live="polite"><small>语气示例</small><p>{companionSample(draft.persona, draft.intensity, profile.displayName)}</p>{draft.custom?.trim() ? <small>还会参考你的补充：{draft.custom}</small> : null}</div>
    <label className="companion-custom" htmlFor={`${id}-custom`}><span className="companion-custom-label">再加一句人设或口癖 <small>选填</small></span><input id={`${id}-custom`} value={draft.custom ?? ''} disabled={busy} maxLength={240} onChange={event => setDraft(old => ({ ...old, custom: event.target.value }))} placeholder="比如：像一起做产品的老朋友，少说套话" aria-describedby={`${id}-custom-hint`}/><small id={`${id}-custom-hint`}>一行，最多 120 个字。这里只调整说话风格。</small></label>
    <div className="companion-actions"><button type="submit" className="primary" disabled={busy || !changed || invalid}>{busy ? '保存中…' : '保存性格'}</button><p className="companion-hint" role="status">{invalid ? '请缩短到 120 个字以内，并写成一行。' : notice || (!profile.companion ? '首次聊天会随机选一位，也可以现在自己选。' : changed ? '预览还没有保存。' : '当前性格会持续保留，随时可以换。')}</p></div>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
