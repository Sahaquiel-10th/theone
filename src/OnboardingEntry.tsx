import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { AccountProfile } from '../server/betaProfile';
import type { CuriousOnboardingView, CuriousSessionView } from '../server/curiousOnboarding';
import { api, currentApiIdentity } from './oneApi';

export type OnboardingEntryMode = 'continue' | 'restart' | 'review';
export type OnboardingEntryAction = { mode: OnboardingEntryMode; label: string; primary: boolean };

/** These are entry intentions, not permission to reset a server session. The
 * parent reconciles the latest session and uses its revision before acting. */
export function onboardingEntryActions(profile: Pick<AccountProfile, 'onboarding'>, session?: Pick<CuriousSessionView, 'status'>): OnboardingEntryAction[] {
  if (session?.status === 'active' || session?.status === 'paused') return [
    { mode: 'continue', label: '继续认识 ONE', primary: true },
    { mode: 'restart', label: '重新开始', primary: false },
  ];
  if (session?.status === 'completed') return [
    { mode: 'restart', label: '重新认识 ONE', primary: true },
    { mode: 'review', label: '查看上次聊天', primary: false },
  ];
  return [{ mode: 'continue', label: profile.onboarding.journey || profile.onboarding.completedAt ? '体验新版引导' : '认识 ONE', primary: true }];
}

const sameIdentity = (expected: ReturnType<typeof currentApiIdentity>) => {
  const current = currentApiIdentity();
  return current.userId === expected.userId && current.workspaceId === expected.workspaceId && current.revision === expected.revision;
};

export function OnboardingEntry({ profile, request = api, onOpen }: {
  profile: AccountProfile;
  request?: typeof api;
  onOpen: (mode: OnboardingEntryMode) => Promise<unknown>;
}) {
  const [view, setView] = useState<CuriousOnboardingView>();
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [opening, setOpening] = useState<OnboardingEntryMode>();
  const mounted = useRef(false), readVersion = useRef(0), actionVersion = useRef(0), locked = useRef(false);
  const reload = useCallback(async () => {
    if (locked.current || !mounted.current) return;
    const token = ++readVersion.current, owner = currentApiIdentity();
    setLoading(true); setError('');
    try {
      const next = await request<CuriousOnboardingView>('/api/me/profile/curious-onboarding');
      if (mounted.current && token === readVersion.current && sameIdentity(owner)) setView(next);
    } catch (failure) {
      if (mounted.current && token === readVersion.current && sameIdentity(owner)) setError(failure instanceof Error ? failure.message : '暂时没连上这段聊天，请再查看一次。');
    } finally {
      if (mounted.current && token === readVersion.current && sameIdentity(owner)) setLoading(false);
    }
  }, [request, profile.workspaceId]);
  useEffect(() => {
    mounted.current = true; setView(undefined); setOpening(undefined); setError('');
    return () => { mounted.current = false; ++readVersion.current; ++actionVersion.current; locked.current = false; };
  }, [request, profile.workspaceId]);
  useEffect(() => { void reload(); }, [reload, profile.updatedAt]);
  useEffect(() => {
    const refresh = () => { void reload(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [reload]);
  async function open(mode: OnboardingEntryMode) {
    if (locked.current || loading || !view) return;
    locked.current = true; ++readVersion.current;
    const token = ++actionVersion.current, owner = currentApiIdentity();
    setOpening(mode); setError('');
    let succeeded = false;
    try { await onOpen(mode); succeeded = true; }
    catch (failure) {
      if (mounted.current && token === actionVersion.current && sameIdentity(owner)) setError(failure instanceof Error ? failure.message : '这段聊天暂时没打开，已聊过的内容会保留。');
    } finally {
      if (mounted.current && token === actionVersion.current && sameIdentity(owner)) {
        locked.current = false; setOpening(undefined);
        if (succeeded) void reload();
      }
    }
  }
  const busy = loading || opening !== undefined;
  const actions = onboardingEntryActions(profile, view?.session);
  const hasPreviousWork = Boolean(profile.onboarding.handbook || profile.onboarding.journey?.handbook || profile.onboarding.journeyHistory?.some(journey => journey.handbook));
  return <div className="story-settings-entry onboarding-entry" aria-busy={busy}>
    <div className="onboarding-entry-copy"><h3>新手引导</h3><p>在主对话里聊几句，ONE 会顺着你的日常了解你，一起找找能帮上忙的事。</p>{hasPreviousWork && <small>已有的任务和使用说明会保留。</small>}</div>
    <div className="onboarding-entry-actions">
      {loading && !view ? <button type="button" className="primary" disabled>正在确认状态…</button> : actions.map(action => <button type="button" key={action.mode} className={action.primary ? 'primary' : undefined} disabled={busy || !view} onClick={() => void open(action.mode)}>{opening === action.mode ? '正在打开…' : action.label}<ArrowUpRight size={15} aria-hidden="true"/></button>)}
    </div>
    {error && <div className="onboarding-entry-error"><p role="alert">{error}</p><button type="button" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true"/>重新查看状态</button></div>}
  </div>;
}
