import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {Check} from 'lucide-react';
import type { AccountProfile, ProfilePatch } from './Onboarding';
import type { CompanionPreferences } from '../server/oneCompanion';
import { companionChoices, companionIntensityChoices, companionSample } from './companionPersonas';

const initial = (profile: AccountProfile): CompanionPreferences => ({ persona: profile.companion?.persona ?? 'chunibyo', intensity: profile.companion?.intensity ?? 'normal', custom: profile.companion?.custom ?? '' });

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
  const invalid = [...(draft.custom ?? '')].length > 120 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(draft.custom ?? '');
  const savedPersona=companionChoices.find(choice=>choice.id===profile.companion?.persona);
  const selectedPersona=companionChoices.find(choice=>choice.id===draft.persona)!;
  const selectedIntensity=companionIntensityChoices.find(choice=>choice.id===draft.intensity)!;
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || invalid || !changed) return;
    const request = ++revision.current; setBusy(true); setError(''); setNotice('');
    try { await onSave({ companion: draft }); if (request === revision.current) setNotice('ONE 的性格已保存，下次回复就会使用。'); }
    catch (failure) { if (request === revision.current) setError(failure instanceof Error ? failure.message : '没有保存成功，请再试一次'); }
    finally { if (request === revision.current) setBusy(false); }
  }
  return <form className="one-companion-settings" onSubmit={save} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <header className="companion-settings-header"><div><h3 id={`${id}-title`}>ONE 的性格</h3><span className="companion-current">{savedPersona?`当前：${savedPersona.name}`:'首次聊天会随机选一位'}</span></div><p className="companion-hint">选个聊得来的搭档，文章和方案仍按你的要求来写。</p></header>
    <fieldset className="companion-persona-field" disabled={busy}><legend>选个搭档</legend><div className="companion-personas">{companionChoices.map(choice => <label className="companion-choice" key={choice.id} data-selected={draft.persona === choice.id}>
      <input className="companion-radio" type="radio" name={`${id}-persona`} value={choice.id} checked={draft.persona === choice.id} onChange={() => {setDraft(old => ({ ...old, persona: choice.id }));setNotice('');setError('');}}/>
      <span className="companion-choice-name">{choice.name}</span><span className="companion-choice-tag">{choice.description}</span>{draft.persona===choice.id&&<Check className="companion-choice-check" size={13} aria-hidden="true"/>}
    </label>)}</div></fieldset>
    <fieldset className="companion-intensity-field" disabled={busy}><legend>戏份多少</legend><div className="companion-strength">{companionIntensityChoices.map(choice => <label className="companion-segment" key={choice.id} data-selected={draft.intensity === choice.id} title={choice.description}>
      <input className="companion-radio" type="radio" name={`${id}-intensity`} value={choice.id} checked={draft.intensity === choice.id} onChange={() => {setDraft(old => ({ ...old, intensity: choice.id }));setNotice('');setError('');}}/><span>{choice.name}</span><span className="companion-sr-only">，{choice.description}</span>
    </label>)}</div></fieldset>
    <div className="companion-preview" aria-live="polite" aria-atomic="true"><div className="companion-preview-label"><span>试试这个口气</span><span>{selectedPersona.name} · {selectedIntensity.name}</span></div><p>{companionSample(draft.persona, draft.intensity, profile.displayName)}</p></div>
    <details className="companion-custom"><summary>补充聊天偏好<span>{draft.custom?.trim()?'已填写':'选填'}</span></summary><div><label htmlFor={`${id}-custom`}>还希望 ONE 怎么和你说话？</label><input className="companion-custom-input" id={`${id}-custom`} value={draft.custom ?? ''} disabled={busy} maxLength={240} aria-invalid={invalid||undefined} onChange={event => {setDraft(old => ({ ...old, custom: event.target.value }));setNotice('');setError('');}} placeholder="比如：像一起做产品的老朋友，少说套话" aria-describedby={`${id}-custom-hint`}/><small id={`${id}-custom-hint`}>一行，最多 120 个字。保存后用于聊天；上面是预设口气示例。</small></div></details>
    <div className="companion-actions"><button type="submit" className="companion-save" disabled={busy || !changed || invalid}>{busy ? '保存中…' : '保存性格'}</button><p className="companion-hint" role="status">{invalid ? '请缩短到 120 个字以内，并写成一行。' : notice || (changed ? '预览还没有保存。' : '随时可以换，聊得顺口就好。')}</p></div>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
