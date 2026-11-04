import { currentApiIdentity, type api as Api } from './oneApi';
import { industryFavoriteIds, isIndustryFavoriteId, type IndustryFavoriteId } from './industryFavoriteIds';

type Identity = ReturnType<typeof currentApiIdentity>;
export type IndustryFavoritesSnapshot = { favoriteIds: IndustryFavoriteId[]; loading: boolean; error: string; savingIds: IndustryFavoriteId[] };
export function parseIndustryFavorites(value: unknown): IndustryFavoriteId[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('favoriteIds' in value) || !Array.isArray(value.favoriteIds)
    || value.favoriteIds.length > industryFavoriteIds.length || value.favoriteIds.some(id => !isIndustryFavoriteId(id)) || new Set(value.favoriteIds).size !== value.favoriteIds.length) throw new Error('收藏结果暂时无法核对，请重试读取。');
  const ids: unknown[] = value.favoriteIds;
  return industryFavoriteIds.filter(id => ids.includes(id));
}

/** Server-confirmed favorites, independent of browser storage. Read and write
 * generations stop old GETs or another card's PUT from undoing confirmed state. */
export function industryFavoritesResource(request: typeof Api, options: { identity?: () => Identity } = {}) {
  const identity = options.identity ?? currentApiIdentity, owner = identity();
  const current = () => { const now = identity(); return now.userId === owner.userId && now.workspaceId === owner.workspaceId && now.revision === owner.revision; };
  let snapshot: IndustryFavoritesSnapshot = { favoriteIds: [], loading: true, error: '', savingIds: [] }, loaded = false, readSequence = 0;
  const inactive: IndustryFavoritesSnapshot = { favoriteIds: [], loading: false, error: '账号或空间已切换，请重新进入工作台。', savingIds: [] };
  const listeners = new Set<() => void>(), versions = new Map<IndustryFavoriteId, number>();
  const saving = new Map<IndustryFavoriteId, { desired: boolean; promise: Promise<void> }>();
  const failedWrites = new Map<IndustryFavoriteId, boolean>();
  const changed = (patch: Partial<IndustryFavoritesSnapshot>) => { if (!current()) return; snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const bump = (id: IndustryFavoriteId) => versions.set(id, (versions.get(id) ?? 0) + 1);
  const saveError = () => failedWrites.size ? '收藏保存未确认，页面保留上次确认的状态。请重试核对并保存；重复设置不会重复切换。' : '';
  async function refresh() {
    if (!current()) return;
    const sequence = ++readSequence, start = new Map(versions);
    changed({ loading: !loaded, error: saveError() });
    try {
      const value = await request<unknown>('/api/industry/favorites');
      if (!current() || sequence !== readSequence) return;
      const ids = parseIndustryFavorites(value);
      const merged = industryFavoriteIds.filter(id => (versions.get(id) ?? 0) !== (start.get(id) ?? 0) || saving.has(id) ? snapshot.favoriteIds.includes(id) : ids.includes(id));
      for (const [id, desired] of failedWrites) if ((versions.get(id) ?? 0) === (start.get(id) ?? 0) && !saving.has(id) && ids.includes(id) === desired) failedWrites.delete(id);
      loaded = true; changed({ favoriteIds: merged, loading: false, error: saveError() });
    } catch {
      if (current() && sequence === readSequence) changed({ loading: false, error: '收藏暂时未能读取，已确认的状态仍保留。请重试后再设置收藏。' });
    }
  }
  function setFavorite(id: IndustryFavoriteId, desired: boolean): Promise<void> {
    if (!current()) return Promise.resolve();
    if (!isIndustryFavoriteId(id) || typeof desired !== 'boolean') { changed({ error: '请选择现有工作台设置收藏。' }); return Promise.resolve(); }
    if (!loaded) { changed({ error: '收藏还未读取成功，请先重试读取。' }); return Promise.resolve(); }
    const active = saving.get(id);
    if (active) return active.desired === desired ? active.promise : active.promise.then(() => setFavorite(id, desired));
    // A new explicit desired state replaces this card's previous failed intent;
    // the global Retry action must not queue that older intent behind this one.
    failedWrites.delete(id);
    bump(id);
    const operation = Promise.resolve().then(async () => {
      if (!current()) return;
      try {
        const value = await request<unknown>(`/api/industry/favorites/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ favorite: desired }) });
        if (!current()) return;
        const ids = parseIndustryFavorites(value);
        if (ids.includes(id) !== desired) throw new Error('Favorite state mismatch');
        // Another card may have completed a newer concurrent PUT. Only this
        // request's own absolute desired state is proven by its response.
        const next = new Set(snapshot.favoriteIds); if (desired) next.add(id); else next.delete(id);
        failedWrites.delete(id); bump(id);
        changed({ favoriteIds: industryFavoriteIds.filter(item => next.has(item)), error: saveError() });
      } catch {
        if (current()) { failedWrites.set(id, desired); bump(id); changed({ error: saveError() }); }
      } finally {
        if (current()) { saving.delete(id); changed({ savingIds: industryFavoriteIds.filter(item => saving.has(item)) }); }
      }
    });
    saving.set(id, { desired, promise: operation });
    changed({ savingIds: industryFavoriteIds.filter(item => saving.has(item)), error: saveError() });
    return operation;
  }
  async function retry() {
    if (!current()) return;
    if (loaded) await Promise.all([...failedWrites].map(([id, desired]) => setFavorite(id, desired)));
    await refresh();
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => current() ? snapshot : inactive,
    checkIdentity: () => { if (!current()) for (const listener of listeners) listener(); },
    refresh, setFavorite, retry,
  };
}
