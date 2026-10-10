export interface NoticeStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const key = (userId: string, version: string) => `one.runtime.seen.${encodeURIComponent(userId)}.${encodeURIComponent(version)}`;
export function runtimeNoticeSeen(storage: NoticeStorage, userId: string, version: string): boolean {
  try { return storage.getItem(key(userId, version)) === '1'; } catch { return false; }
}
export function rememberRuntimeNotice(storage: NoticeStorage, userId: string, version: string): void {
  try { storage.setItem(key(userId, version), '1'); } catch { /* Optional browser storage. */ }
}
