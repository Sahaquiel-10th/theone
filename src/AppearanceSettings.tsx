import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { AccountProfile, ProfilePatch } from "./Onboarding";
import { resolvedAppearanceScene, type AppearanceScene } from "./appearancePreferences";

const scenes = [
  { id: "graphite", name: "石墨框景", description: "深色框景，清透的银白工作面" },
  { id: "silver", name: "浅银光场", description: "柔和光场，轻盈的浅银工作面" },
] as const;

function ScenePreview({ scene }: { scene: AppearanceScene }) {
  const id = useId().replace(/:/g, "");
  return <svg className="one-appearance-preview" data-scene={scene} viewBox="0 0 192 112" aria-hidden="true" focusable="false">
    <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--appearance-glass-top)"/><stop offset="1" stopColor="var(--appearance-glass-bottom)"/></linearGradient></defs>
    <rect className="appearance-frame" width="192" height="112" rx="14"/>
    <rect className="appearance-rail" x="8" y="8" width="19" height="96" rx="9"/>
    <path className="appearance-glass" fill={`url(#${id})`} d="M47 8H137Q149 8 149 20V45Q149 53 157 53H172Q184 53 184 65V92Q184 104 172 104H47Q35 104 35 92V20Q35 8 47 8Z"/>
    <rect className="appearance-glass" fill={`url(#${id})`} x="157" y="13" width="27" height="32" rx="10"/>
    <path className="appearance-message" d="M83 26H127Q132 26 132 31V34Q132 39 127 39H83Q78 39 78 34V31Q78 26 83 26Z"/>
    <path className="appearance-lines" d="M48 50H123M48 57H135M48 64H108"/>
    <rect className="appearance-input" x="47" y="81" width="123" height="13" rx="6"/>
    <circle className="appearance-eye" cx="28" cy="63" r="7"/>
    <path className="appearance-pupil" d="M28.8 59.3L27.9 66.7"/>
    <circle className="appearance-eye" cx="161" cy="87.5" r="4"/>
  </svg>;
}

/** Save through the same authorized account profile path as other preferences. */
export function AppearanceSettings({ profile, onSave }: {
  profile: AccountProfile;
  onSave: (patch: ProfilePatch) => Promise<unknown>;
}) {
  const id = useId();
  const [pending, setPending] = useState<AppearanceScene | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const workspace = useRef(profile.workspaceId);
  workspace.current = profile.workspaceId;
  useEffect(() => { setPending(null); setNotice(""); setError(""); }, [profile.workspaceId]);
  const saved = resolvedAppearanceScene(profile);
  const selected = pending ?? saved;

  async function choose(scene: AppearanceScene) {
    if (pending || scene === saved) return;
    const owner = profile.workspaceId;
    setPending(scene); setNotice(""); setError("");
    try {
      await onSave({ appearance: { scene } });
      if (workspace.current === owner) setNotice("外观已保存");
    } catch (failure) {
      if (workspace.current === owner) setError(failure instanceof Error ? failure.message : "外观没有保存成功，请再试一次");
    } finally {
      if (workspace.current === owner) setPending(null);
    }
  }

  return <section className="one-appearance-settings" aria-labelledby={`${id}-title`} aria-busy={pending !== null}>
    <header><h3 id={`${id}-title`}>工作台外观</h3><p id={`${id}-hint`}>两种外观保留相同的布局与操作。选择会随账号保存。</p></header>
    <fieldset aria-describedby={`${id}-hint`} disabled={pending !== null}>
      <legend className="sr-only">选择工作台外观</legend>
      {scenes.map(scene => <label className="one-appearance-choice" key={scene.id} data-selected={selected === scene.id}>
        <input type="radio" name={`${id}-scene`} value={scene.id} checked={selected === scene.id} onChange={() => void choose(scene.id)}/>
        <ScenePreview scene={scene.id}/>
        <span className="one-appearance-choice-heading"><strong>{scene.name}</strong><span className="one-appearance-check" aria-hidden="true">{selected === scene.id ? <Check size={13}/> : null}</span></span>
        <span className="one-appearance-description">{scene.description}</span>
      </label>)}
    </fieldset>
    <p className="one-appearance-feedback" role={error ? "alert" : "status"}>{pending ? "保存中…" : error || notice || "本机执行时会暂时转黑，结束后回到你选择的外观。"}</p>
  </section>;
}
