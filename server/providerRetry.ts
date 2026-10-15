/** Retry only an explicit rate-limit rejection, never an ambiguous connection
 * failure or a stream that may already have produced tools, pixels or writes. */
export type ProviderRetryNotice = { attempt: number; maxRetries: number; delayMs: number; nextRetryAt: string };
export type ProviderRetryOptions = {
  fetch?: typeof fetch;
  beforeRetry?: () => Promise<void>;
  onRetry?: (notice: ProviderRetryNotice) => Promise<void>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('REQUEST_CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function fetchWithSafeRetries(url: string | URL, init: RequestInit, options: ProviderRetryOptions = {}) {
  const maxRetries = 2;
  for (let attempt = 0; ; attempt++) {
    if (init.signal?.aborted) throw new Error('REQUEST_CANCELLED');
    if (attempt) await options.beforeRetry?.();
    const response = await (options.fetch ?? fetch)(url, init);
    if (response.status !== 429 || attempt >= maxRetries) return response;
    const header = response.headers.get('retry-after');
    const requested = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000
      : header ? Date.parse(header) - Date.now() : 0;
    // Respect a long server delay by asking for action, not retrying too early.
    if (Number.isFinite(requested) && requested > 30_000) return response;
    const delayMs = Math.max([2000, 5000][attempt], Number.isFinite(requested) ? requested : 0);
    await response.body?.cancel();
    await options.onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, nextRetryAt: new Date(Date.now() + delayMs).toISOString() });
    await (options.wait ?? wait)(delayMs, init.signal ?? undefined);
  }
}
