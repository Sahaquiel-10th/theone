import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { currentApiIdentity, SESSION_EVENT, type api as Api } from './oneApi';
import { industryFavoritesResource } from './industryFavoritesResource';

export function useIndustryFavorites(api: typeof Api) {
  const identity = currentApiIdentity();
  const resource = useMemo(() => industryFavoritesResource(api), [api, identity.userId, identity.workspaceId, identity.revision]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => {
    void resource.refresh();
    const refresh = () => { if (document.visibilityState !== 'hidden') void resource.refresh(); };
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    window.addEventListener(SESSION_EVENT, resource.checkIdentity);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); window.removeEventListener(SESSION_EVENT, resource.checkIdentity); };
  }, [resource]);
  return { ...snapshot, setFavorite: resource.setFavorite, retry: resource.retry };
}
