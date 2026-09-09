import { KnowledgeChunk, KnowledgeCredentials, KnowledgeProvider } from "./provider.js";
import { assertAllowedConnectorUrl, readBoundedJson } from "../connectors/securityPolicy.js";

const baseUrl = (process.env.GETNOTE_API_URL?.trim() || "https://openapi.biji.com").replace(/\/$/, "");
const apiBase = baseUrl.endsWith("/open/api/v1") ? baseUrl : baseUrl.endsWith("/open") ? `${baseUrl}/api/v1` : `${baseUrl}/open/api/v1`;
assertAllowedConnectorUrl(apiBase, ["openapi.biji.com"]);
const timeoutMs = Math.max(3000, Number(process.env.GETNOTE_API_TIMEOUT_MS ?? 15000));

type GetNoteEnvelope<T> = { success?: boolean; data?: T; error?: { message?: string; reason?: string }; request_id?: string; code?: number };

function safeGetNoteUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "biji.com" || url.hostname.endsWith(".biji.com")) ? url.toString() : undefined;
  } catch { return undefined; }
}

async function request<T>(path: string, credentials?: KnowledgeCredentials, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(credentials ? { Authorization: credentials.apiKey, "X-Client-ID": credentials.clientId } : {}),
        ...init.headers
      }
    });
    const payload: GetNoteEnvelope<T> = await readBoundedJson<GetNoteEnvelope<T>>(response).catch(() => ({} as GetNoteEnvelope<T>));
    if (!response.ok || payload.success === false || (typeof payload.code === "number" && payload.code !== 0)) {
      const codeDetail = payload.code === 10201 ? "当前账号尚未开通会员" : payload.code === 10001 ? "授权已失效，请重新连接" : payload.code === 42900 || payload.code === 10202 ? "调用额度或频率已达上限" : undefined;
      const detail = payload.error?.message || payload.error?.reason || codeDetail || `HTTP ${response.status}`;
      const error = new Error(`得到大脑接口失败：${detail}`) as Error & { status?: number; reason?: string; requestId?: string };
      error.status = response.status;
      error.reason = payload.error?.reason;
      error.requestId = payload.request_id;
      throw error;
    }
    if (!payload.data) throw new Error("得到大脑返回数据为空");
    return payload.data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("得到大脑接口请求超时");
    throw error;
  } finally { clearTimeout(timeout); }
}

export type GetNoteDeviceCode = { code: string; verificationUri: string; userCode: string; expiresIn: number; interval: number };
export type GetNoteTokenResult = { status: "pending"; retryAfterSeconds?: number } | { status: "connected"; clientId: string; apiKey: string; expiresAt?: number };

export class GetNoteProvider implements KnowledgeProvider {
  async verify(credentials: KnowledgeCredentials): Promise<void> {
    await request<{ results?: unknown[] }>("/resource/recall", credentials, {
      method: "POST",
      body: JSON.stringify({ query: "ONE 连接测试", top_k: 1 })
    });
  }

  async startDeviceFlow(clientId: string): Promise<GetNoteDeviceCode> {
    const data = await request<{ code: string; verification_uri: string; user_code: string; expires_in: number; interval: number }>("/oauth/device/code", undefined, { method: "POST", body: JSON.stringify({ client_id: clientId }) });
    const verificationUri = safeGetNoteUrl(data.verification_uri);
    if (!verificationUri) throw new Error("得到大脑返回了未获准的授权地址");
    if (typeof data.code !== "string" || !data.code || data.code.length > 4_096 || typeof data.user_code !== "string" || !data.user_code || data.user_code.length > 128) throw new Error("得到大脑授权响应格式无效");
    const expiresIn = Number(data.expires_in);
    const interval = Number(data.interval || 5);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 24 * 60 * 60 || !Number.isFinite(interval) || interval < 1 || interval > 300) throw new Error("得到大脑授权有效期格式无效");
    return { code: data.code, verificationUri, userCode: data.user_code, expiresIn, interval };
  }

  async pollDeviceFlow(clientId: string, code: string): Promise<GetNoteTokenResult> {
    try {
      const data = await request<{ msg?: string; client_id: string; api_key: string; expires_at?: number }>("/oauth/token", undefined, { method: "POST", body: JSON.stringify({ grant_type: "device_code", client_id: clientId, code }) });
      if (data.msg === "authorization_pending") return { status: "pending" };
      if (data.msg === "slow_down") return { status: "pending", retryAfterSeconds: 10 };
      if (data.msg === "access_denied" || data.msg === "expired_token") throw new Error(data.msg);
      if (typeof data.api_key !== "string" || !data.api_key.trim() || data.api_key.length > 65_536) throw new Error("得到授权响应缺少凭据，请重新发起授权");
      const returnedClientId = data.client_id || clientId;
      if (typeof returnedClientId !== "string" || !returnedClientId || returnedClientId.length > 2_000) throw new Error("得到授权客户端响应格式无效");
      const expiresAt = data.expires_at === undefined ? undefined : Number(data.expires_at);
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new Error("得到授权有效期响应格式无效");
      return { status: "connected", clientId: returnedClientId, apiKey: data.api_key, expiresAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/authorization_pending/i.test(message)) return { status: "pending" };
      if (/slow_down/i.test(message)) return { status: "pending", retryAfterSeconds: 10 };
      throw error;
    }
  }

  async search(credentials: KnowledgeCredentials, query: string, topK: number): Promise<KnowledgeChunk[]> {
    const data = await request<{ results?: Array<{ note_id?: string; title?: string; content?: string; score?: number; url?: string }> }>("/resource/recall", credentials, { method: "POST", body: JSON.stringify({ query, top_k: Math.max(1, Math.min(10, topK)) }) });
    const results = Array.isArray(data.results) ? data.results : [];
    return results.slice(0, 10).filter((item): item is NonNullable<typeof item> => Boolean(item && typeof item === "object")).map((item) => ({ id: item.note_id ? String(item.note_id).slice(0, 500) : undefined, title: String(item.title ?? "得到大脑笔记").slice(0, 300), content: String(item.content ?? "").slice(0, 24_000), score: Number.isFinite(item.score) ? item.score : undefined, sourceUrl: safeGetNoteUrl(item.url) })).filter((item) => item.content);
  }
}

export const getNoteProvider = new GetNoteProvider();
