import type { IndustryTool } from '../server/industryState';

export type IndustryRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
export type IndustryClientSession = { id: string; tool: IndustryTool; budgetMicros: number; createdAt: string; expiresAt: string };
export type PendingIndustryRequest = { fingerprint: string; path: string; requestKey: string; sourceRequestKey?: string; usageSessionId: string; createdAt: number };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function industryPaidPath(path: string, method = 'GET') {
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/api\/commerce\/(?:recognize|reference\/recognize|modules\/suggest|materials\/recognize|jobs|edits|jobs\/[^/?]+\/(?:generate|retry|derive))$/.test(path)
    || /^\/api\/review-replies\/(?:analyze|recognize|runs|runs\/[^/?]+\/(?:refine|propose-rule))$/.test(path);
}
export function industryFilePath(path: string) { return path.replace(/^\/api\/attachments\/([^/?]+)\/content/, '/api/industry/files/$1/content'); }
export function readIndustryPending(storage: Storage, key: string): PendingIndustryRequest[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is PendingIndustryRequest => !!item && typeof item === 'object'
      && typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint)
      && typeof item.path === 'string' && industryPaidPath(item.path, 'POST')
      && typeof item.requestKey === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(item.requestKey)
      && typeof item.usageSessionId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.usageSessionId)
      && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)).slice(-100) : [];
  } catch { return []; }
}
async function fingerprint(path: string, value: Record<string, unknown>) {
  const { usageSessionId: _session, requestKey: _key, ...body } = value;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([path, body])));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
/** UI request keys and the original budget grant survive lost responses. */
export function createIndustryClient(request: IndustryRequest, options: {
  tool: IndustryTool; storage: Storage; storageKey: string; session: () => IndustryClientSession | undefined;
  onBudgetRequired: () => void; onPending: (items: PendingIndustryRequest[]) => void; onActivity?: () => void;
}) {
  let pending = readIndustryPending(options.storage, options.storageKey);
  const save = () => { try { options.storage.setItem(options.storageKey, JSON.stringify(pending)); } catch { /* This page still keeps original request IDs in memory. */ } options.onPending([...pending]); };
  const invoke: IndustryRequest = async <T,>(path: string, init: RequestInit = {}) => {
    if (path === '/api/attachments' && init.body instanceof FormData) {
      // Snapshot the files before the first await; native FileList may be reset.
      const files = init.body.getAll('files').filter((file): file is File => file instanceof File);
      if (!files.length || files.length > 20) throw new Error('请选择 1–20 份文件');
      const attachments = [];
      for (const file of files) {
        const created = await request<{ attachment: { id: string }; chunkBytes: number }>('/api/industry/files/uploads', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type }) });
        for (let offset = 0; offset < file.size; offset += created.chunkBytes) {
          await request(`/api/industry/files/${created.attachment.id}/chunks?offset=${offset}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(offset, offset + created.chunkBytes) });
        }
        await request(`/api/industry/files/${created.attachment.id}/complete`, { method: 'POST' });
        let result: { id: string; status?: string; parseError?: string } | undefined;
        for (let count = 0; count < 100; count++) {
          const response = await request<{ attachment: typeof result }>(`/api/industry/files/${created.attachment.id}`);
          if (response.attachment?.status === 'ready') { result = response.attachment; break; }
          if (response.attachment?.status === 'failed') throw new Error(response.attachment.parseError || `${file.name} 未能读取，请检查文件`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!result) throw new Error(`${file.name} 仍在检查，请稍后查看原上传记录`);
        attachments.push(result);
      }
      return { attachments } as T;
    }
    if (!industryPaidPath(path, init.method)) return request<T>(path, init);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const hash = await fingerprint(path, body);
    // A remounted form may invent a new key. Until the earlier receipt is
    // reconciled, the same business action must keep its original grant/key.
    const original = pending.find(item => item.fingerprint === hash && item.path === path);
    const session = options.session();
    const usageSessionId = original?.usageSessionId ?? (typeof body.usageSessionId === 'string' && body.usageSessionId ? body.usageSessionId : session?.id);
    if (!usageSessionId) { options.onBudgetRequired(); throw new Error('请先在上方确认本轮 AI 用量上限，再继续这一步。准备资料和上传文件不会扣电力。'); }
    const entry: PendingIndustryRequest = original ?? { fingerprint: hash, path,
      requestKey: typeof body.requestKey === 'string' && body.requestKey ? body.requestKey : crypto.randomUUID(), usageSessionId, createdAt: Date.now() };
    if (!original) { pending.push(entry); save(); }
    try {
      const result = await request<T>(path, { ...init, body: JSON.stringify({ ...body, requestKey: entry.requestKey, usageSessionId: entry.usageSessionId }) });
      pending = pending.filter(item => item !== entry); save(); options.onActivity?.(); return result;
    } catch (error) {
      options.onActivity?.();
      throw error;
    }
  };
  return { request: invoke, pending: () => [...pending], prepareExplicitRetry: (key: string) => {
    const session = options.session();
    if (!session) { options.onBudgetRequired(); throw new Error('请先明确确认新一轮用量，再重新执行'); }
    pending = pending.map(item => item.requestKey === key ? { ...item, sourceRequestKey: item.sourceRequestKey ?? item.requestKey, requestKey: crypto.randomUUID(), usageSessionId: session.id, createdAt: Date.now() } : item); save();
  } };
}
