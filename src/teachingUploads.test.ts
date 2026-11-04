import test from 'node:test';
import assert from 'node:assert/strict';
import { teachingUploadWait, uploadTeachingBatch, uploadTeachingFile, type TeachingRequest } from './teachingUploads';

const file = () => new File(['sixbytes'], '作业.txt', { type: 'text/plain' });
test('abort reaches the current chunk and never completes, polls, retries or starts another file', async () => {
  const controller = new AbortController(), paths: string[] = [];
  const request: TeachingRequest = async <T>(path: string, options?: RequestInit) => {
    paths.push(path);
    if (path.endsWith('/uploads')) return { attachment: { id: 'file-one', originalName: '作业.txt' }, chunkBytes: 4 } as T;
    if (options?.method === 'DELETE') return {} as T;
    assert.equal(options?.signal, controller.signal);
    return await new Promise<T>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
  };
  const work = uploadTeachingBatch(request, '/private', [file(), file()], { signal: controller.signal, onProgress: () => {}, onUploaded: () => assert.fail('no file completed') });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.deepEqual(paths, ['/private/uploads', '/private/uploads/file-one/chunks?offset=0', '/private/uploads/file-one']);
});
test('stopping parse polling interrupts its wait immediately and preserves earlier completed files', async () => {
  const controller = new AbortController(), completed: string[] = []; let allocated = 0, checks = 0;
  const request: TeachingRequest = async <T>(path: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') return {} as T;
    if (path.endsWith('/uploads')) return { attachment: { id: `file-${++allocated}`, originalName: '作业.txt' } } as T;
    if (path.endsWith('/file-2')) { checks++; queueMicrotask(() => controller.abort()); return { attachment: { id: 'file-2', originalName: '作业.txt', status: 'queued' } } as T; }
    if (path.endsWith('/file-1')) return { attachment: { id: 'file-1', originalName: '作业.txt', status: 'ready' } } as T;
    return {} as T;
  };
  await assert.rejects(uploadTeachingBatch(request, '/private', [file(), file(), file()], { signal: controller.signal, onProgress: () => {}, onUploaded: file => completed.push(file.id) }), { name: 'AbortError' });
  assert.deepEqual(completed, ['file-1']); assert.equal(allocated, 2); assert.equal(checks, 1);
  const stopped = new AbortController(); const wait = teachingUploadWait(10_000, stopped.signal); stopped.abort(); await assert.rejects(wait, { name: 'AbortError' });
});
test('a lost upload receipt is not retried automatically and onCreated preserves the allocated original id', async () => {
  let calls = 0; const ids: string[] = [];
  const request: TeachingRequest = async <T>(path: string) => { calls++; if (path.endsWith('/uploads')) return { attachment: { id: 'original-file', originalName: '作业.txt' } } as T; throw new Error('network response unknown'); };
  await assert.rejects(uploadTeachingFile(request, '/private', file(), () => {}, { onCreated: file => ids.push(file.id) }), /unknown/);
  assert.equal(calls, 2); assert.deepEqual(ids, ['original-file']);
});

test('cancel during allocation still obtains and deletes the original id before any chunk is sent', async () => {
  const controller = new AbortController(), methods: string[] = [];
  const request: TeachingRequest = async <T>(path: string, options?: RequestInit) => {
    methods.push(`${options?.method}:${path}`);
    if (options?.method === 'POST') { assert.equal(options.signal, undefined, 'allocation receipt must not be lost by abort'); controller.abort(); return { attachment: { id: 'late-original-id', originalName: '作业.txt' } } as T; }
    assert.equal(options?.method, 'DELETE'); assert.equal(options.signal?.aborted, false); return {} as T;
  };
  await assert.rejects(uploadTeachingFile(request, '/private', file(), () => {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(methods, ['POST:/private/uploads', 'DELETE:/private/uploads/late-original-id']);
});
