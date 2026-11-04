export type TeachingRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
export type TeachingUpload = { id: string; originalName: string; status?: string; parseError?: string; size?: number; mimeType?: string };
export const teachingFileAccept = '.docx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.mp4,.webm,.mov';
export type TeachingUploadOptions = { signal?: AbortSignal; onCreated?: (file: TeachingUpload) => void };
export const teachingUploadAborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';
function check(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('上传已停止，未提交作业。', 'AbortError'); }
export function teachingUploadWait(milliseconds: number, signal?: AbortSignal) {
  check(signal);
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('上传已停止，未提交作业。', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function discardCancelledUpload(request: TeachingRequest, base: string, id: string) {
  const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), 3000);
  try { await request(`${base}/uploads/${encodeURIComponent(id)}`, { method: 'DELETE', signal: cleanup.signal }); }
  catch { /* An uncertain cleanup remains visible in the exact-owner inventory. */ }
  finally { clearTimeout(timer); }
}
/** Allocation is allowed to return its original id even after cancellation.
 * Chunks and parse waits are aborted; unused allocations are then deleted. */
export async function uploadTeachingFile(request: TeachingRequest, base: string, file: File, onProgress: (message: string) => void, options: TeachingUploadOptions = {}): Promise<TeachingUpload> {
  const { signal } = options; check(signal);
  if (file.size < 1 || file.size > 200 * 1024 * 1024) throw new Error('请选择 1 字节至 200 MB 的文件。');
  onProgress(`正在上传 ${file.name} · 0%`);
  let allocatedId: string | undefined;
  try {
  const created = await request<{ attachment: TeachingUpload; chunkBytes?: number }>(`${base}/uploads`, { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type }) });
  allocatedId = created.attachment?.id;
  options.onCreated?.(created.attachment); check(signal);
  if (!created.attachment?.id) throw new Error('上传编号未确认，请核对原上传记录。');
  const bytes = created.chunkBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 4 * 1024 * 1024) throw new Error('上传分块信息未确认，请保留原记录后重试。');
  for (let offset = 0; offset < file.size; offset += bytes) {
    check(signal);
    await request(`${base}/uploads/${created.attachment.id}/chunks?offset=${offset}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(offset, offset + bytes), signal });
    check(signal); onProgress(`正在上传 ${file.name} · ${Math.min(100, Math.round((offset + bytes) / file.size * 100))}%`);
  }
  check(signal);
  await request(`${base}/uploads/${created.attachment.id}/complete`, { method: 'POST', signal });
  check(signal); onProgress(`正在检查 ${file.name}`);
  for (let i = 0; i < 100; i++) {
    check(signal);
    const result = await request<{ attachment: TeachingUpload }>(`${base}/uploads/${created.attachment.id}`, { signal });
    check(signal);
    if (result.attachment.status === 'ready') return result.attachment;
    if (result.attachment.status === 'failed') throw new Error(result.attachment.parseError ?? `${file.name} 未能处理，请检查原件。`);
    await teachingUploadWait(1200, signal);
  }
  throw new Error('文件仍在检查，请核对原上传记录；没有自动重新上传或提交。');
  } catch (error) {
    if (signal?.aborted && allocatedId) {
      // Explicit cancellation only. Unknown network failures retain their record
      // for reconciliation. The server rejects deletion of every referenced file.
      await discardCancelledUpload(request, base, allocatedId);
    }
    throw error;
  }
}
export async function uploadTeachingBatch(request: TeachingRequest, base: string, files: readonly File[], options: TeachingUploadOptions & { onProgress: (message: string) => void; onUploaded: (file: TeachingUpload, index: number) => void }): Promise<TeachingUpload[]> {
  if (!files.length || files.length > 10) throw new Error('每份作业请选择 1–10 个附件。');
  // Snapshot before awaiting: a file input can be reset or the source array changed.
  const selected = [...files], uploaded: TeachingUpload[] = [];
  for (const [index, file] of selected.entries()) {
    check(options.signal);
    const result = await uploadTeachingFile(request, base, file, message => options.onProgress(`第 ${index + 1}/${selected.length} 个 · ${message}`), options);
    if (options.signal?.aborted) await discardCancelledUpload(request, base, result.id);
    check(options.signal); uploaded.push(result); options.onUploaded(result, index);
  }
  return uploaded;
}
