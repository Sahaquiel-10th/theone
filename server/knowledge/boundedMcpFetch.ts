import { assertAllowedConnectorUrl } from "../connectors/securityPolicy.js";

/** Bound every transport request, including SSE, without accepting redirects or arbitrary endpoints. */
export function boundedMcpFetch(fetcher: typeof fetch, endpoint: string, hosts: readonly string[], timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const url = assertAllowedConnectorUrl(input instanceof Request ? input.url : String(input), hosts);
    const expected = new URL(endpoint);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.search) throw new Error("MCP 请求地址不在允许列表中");
    const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]) });
    const maxBytes = 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new Error("MCP 返回内容超过安全限制"); }
    if (!response.body) return response;
    const reader = response.body.getReader(); let total = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const { done, value } = await reader.read(); if (done) { controller.close(); reader.releaseLock(); return; } total += value.byteLength; if (total > maxBytes) { await reader.cancel(); reader.releaseLock(); throw new Error("MCP 返回内容超过安全限制"); } controller.enqueue(value); }
        catch (error) { controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); }
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
