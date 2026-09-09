const defaultMaxJsonBytes = 1024 * 1024;

export function assertAllowedConnectorUrl(input: string | URL, allowedHosts: readonly string[]) {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  const hosts = new Set(allowedHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error("连接器远端地址不在服务端允许列表中");
  }
  return url;
}

export async function readBoundedJson<T>(response: Response, maxBytes = defaultMaxJsonBytes): Promise<T> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("连接器返回内容超过安全限制");
  if (!response.body) return {} as T;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("连接器返回内容超过安全限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
