/** Only protocol evidence counts as native search; prose and links alone do not. */
export function providerSearchEvidence(response: Record<string, unknown>) {
  const output = Array.isArray(response.output) ? response.output : [];
  const calls = output.filter((item: any) => item?.type === 'web_search_call');
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 2048) return;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
      urls.add(url.toString());
    } catch { /* Never log malformed upstream content. */ }
  };
  for (const call of calls as any[]) for (const source of call.action?.sources ?? []) add(source?.url);
  for (const item of output as any[]) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) for (const annotation of part?.annotations ?? []) {
      if (annotation?.type === 'url_citation') add(annotation.url);
    }
  }
  const completedCalls = calls.filter((call: any) => call.status === 'completed').length;
  return {
    completed: response.status === 'completed', searchCalls: calls.length,
    completedSearchCalls: completedCalls, sources: [...urls].slice(0, 8),
    passed: response.status === 'completed' && completedCalls > 0 && urls.size > 0,
  };
}

export function safeProbeError(raw: unknown) {
  const error = raw && typeof raw === 'object' ? (raw as any).error : undefined;
  const code = typeof error?.code === 'string' && !error.code.startsWith('sk-') && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.code) ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : '';
  const hint = /not.*support|unsupported|unknown.*tool|invalid.*tool|不支持/i.test(message) ? 'search_tool_not_supported'
    : /permission|forbidden|not.*allowed|授权|权限/i.test(message) ? 'search_not_permitted'
    : /quota|balance|credit|余额|额度/i.test(message) ? 'provider_quota'
    : /rate.?limit|too many|限流/i.test(message) ? 'provider_rate_limit' : 'provider_error';
  return { code, hint };
}
