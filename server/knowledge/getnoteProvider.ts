import { KnowledgeChunk, KnowledgeCredentials, KnowledgeProvider } from "./provider.js";
import { assertAllowedConnectorUrl, readBoundedJson } from "../connectors/securityPolicy.js";

const baseUrl = (process.env.GETNOTE_API_URL?.trim() || "https://openapi.biji.com").replace(/\/$/, "");
const apiBase = baseUrl.endsWith("/open/api/v1") ? baseUrl : baseUrl.endsWith("/open") ? `${baseUrl}/api/v1` : `${baseUrl}/open/api/v1`;
assertAllowedConnectorUrl(apiBase, ["openapi.biji.com"]);
const timeoutMs = Math.max(3000, Number(process.env.GETNOTE_API_TIMEOUT_MS ?? 15000));

type GetNoteEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: string | { code?: number; message?: string; reason?: string; retryable?: boolean };
  request_id?: string;
  code?: number;
  message?: string;
  reason?: string;
  retryable?: boolean;
};

export type GetNoteProviderPhase = "authorization_start" | "authorization_poll" | "credential_verify" | "recall";
export type GetNoteProviderErrorCode =
  | "GETNOTE_MEMBER_REQUIRED"
  | "GETNOTE_SCOPE_REQUIRED"
  | "GETNOTE_CREDENTIAL_EXPIRED"
  | "GETNOTE_AUTHORIZATION_PENDING"
  | "GETNOTE_AUTHORIZATION_SLOW_DOWN"
  | "GETNOTE_AUTHORIZATION_REJECTED"
  | "GETNOTE_AUTHORIZATION_EXPIRED"
  | "GETNOTE_AUTHORIZATION_CONSUMED"
  | "GETNOTE_OAUTH_CLIENT_INVALID"
  | "GETNOTE_RATE_LIMITED"
  | "GETNOTE_RESPONSE_INVALID"
  | "GETNOTE_UNAVAILABLE";

export class GetNoteProviderError extends Error {
  constructor(
    readonly code: GetNoteProviderErrorCode,
    message: string,
    readonly phase: GetNoteProviderPhase,
    readonly status: number,
    readonly retryable: boolean,
    readonly providerCode?: number,
    readonly providerRequestId?: string
  ) {
    super(message);
    this.name = "GetNoteProviderError";
  }
}

function safeGetNoteUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "biji.com" || url.hostname.endsWith(".biji.com")) ? url.toString() : undefined;
  } catch { return undefined; }
}

function safeProviderRequestId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function getNoteAuthorizationHeader(apiKey: string) {
  const value = apiKey.trim();
  return /^Bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}

function providerFailure(payload: GetNoteEnvelope<unknown>, responseStatus: number, phase: GetNoteProviderPhase) {
  const nestedError = payload.error && typeof payload.error === "object" ? payload.error : undefined;
  const upstream = [
    typeof payload.error === "string" ? payload.error : undefined,
    nestedError?.message,
    nestedError?.reason,
    payload.message,
    payload.reason
  ].filter((value): value is string => typeof value === "string").join(" ");
  const normalized = upstream.toLowerCase();
  const providerCode = typeof nestedError?.code === "number" ? nestedError.code : typeof payload.code === "number" ? payload.code : undefined;
  const requestId = safeProviderRequestId(payload.request_id);
  if (phase === "authorization_poll") {
    if (/authorization_pending/.test(normalized)) {
      return new GetNoteProviderError("GETNOTE_AUTHORIZATION_PENDING", "正在等待得到大脑授权。", phase, 202, true, providerCode, requestId);
    }
    if (/slow_down/.test(normalized)) {
      return new GetNoteProviderError("GETNOTE_AUTHORIZATION_SLOW_DOWN", "得到大脑正在处理授权。", phase, 429, true, providerCode, requestId);
    }
    if (/already.?consumed|already.?used/.test(normalized)) {
      return new GetNoteProviderError("GETNOTE_AUTHORIZATION_CONSUMED", "这次授权已经使用，请重新连接。", phase, 410, false, providerCode, requestId);
    }
    if (/expired_token|authorization.?expired/.test(normalized)) {
      return new GetNoteProviderError("GETNOTE_AUTHORIZATION_EXPIRED", "得到大脑授权已过期，请重新连接。", phase, 410, false, providerCode, requestId);
    }
    if (/access.?denied|rejected|拒绝|取消授权/.test(normalized)) {
      return new GetNoteProviderError("GETNOTE_AUTHORIZATION_REJECTED", "得到大脑授权未完成，请重新连接。", phase, 403, false, providerCode, requestId);
    }
  }
  if (providerCode === 10201 || /(?:非会员|not.?a?.?member|membership.?required)/i.test(upstream)) {
    return new GetNoteProviderError("GETNOTE_MEMBER_REQUIRED", "这个得到大脑账号还没有会员，请开通后重试。", phase, 403, false, providerCode, requestId);
  }
  if (/note\.recall\.read|(?:required|missing).?scope|权限不足|permission.?denied/.test(normalized)) {
    return new GetNoteProviderError("GETNOTE_SCOPE_REQUIRED", "得到大脑暂未向 ONE 开通知识召回权限，请联系 ONE 管理员。", phase, 503, false, providerCode, requestId);
  }
  if (/invalid.?client|unknown.?client|client.?id/.test(normalized)) {
    return new GetNoteProviderError("GETNOTE_OAUTH_CLIENT_INVALID", "ONE 的得到大脑授权配置不可用，请联系 ONE 管理员。", phase, 503, false, providerCode, requestId);
  }
  if (responseStatus === 401 || providerCode === 10001 || /expired.?token|invalid.?(?:token|credential|api.?key)|授权.*失效/.test(normalized)) {
    return new GetNoteProviderError("GETNOTE_CREDENTIAL_EXPIRED", "得到大脑授权已失效，请重新连接。", phase, 401, false, providerCode, requestId);
  }
  if (responseStatus === 403) {
    return new GetNoteProviderError("GETNOTE_SCOPE_REQUIRED", "得到大脑账号权限不足，请确认会员与授权范围。", phase, 403, false, providerCode, requestId);
  }
  if (responseStatus === 429 || providerCode === 42900 || providerCode === 10202 || /rate.?limit|quota|限流|额度|频率/.test(normalized)) {
    return new GetNoteProviderError("GETNOTE_RATE_LIMITED", "得到大脑请求较多，ONE 会自动重试。", phase, 429, true, providerCode, requestId);
  }
  if (responseStatus >= 500 || responseStatus === 408 || nestedError?.retryable === true || payload.retryable === true) {
    return new GetNoteProviderError("GETNOTE_UNAVAILABLE", "得到大脑暂时无法连接，ONE 会自动重试。", phase, 503, true, providerCode, requestId);
  }
  return new GetNoteProviderError(
    phase === "authorization_poll" ? "GETNOTE_AUTHORIZATION_REJECTED" : "GETNOTE_RESPONSE_INVALID",
    phase === "authorization_poll" ? "得到大脑授权未完成，请重新连接。" : "得到大脑返回异常，请稍后重试。",
    phase,
    phase === "authorization_poll" ? 403 : 502,
    false,
    providerCode,
    requestId
  );
}

async function request<T>(path: string, credentials: KnowledgeCredentials | undefined, init: RequestInit, phase: GetNoteProviderPhase) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(credentials ? { Authorization: getNoteAuthorizationHeader(credentials.apiKey), "X-Client-ID": credentials.clientId } : {}),
        ...init.headers
      }
    });
    const payload: GetNoteEnvelope<T> = await readBoundedJson<GetNoteEnvelope<T>>(response).catch(() => ({} as GetNoteEnvelope<T>));
    if (!response.ok || payload.success === false || (typeof payload.code === "number" && payload.code !== 0)) {
      throw providerFailure(payload, response.status, phase);
    }
    if (!payload.data) throw new GetNoteProviderError("GETNOTE_RESPONSE_INVALID", "得到大脑返回异常，请稍后重试。", phase, 502, true, undefined, safeProviderRequestId(payload.request_id));
    return payload.data;
  } catch (error) {
    if (error instanceof GetNoteProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new GetNoteProviderError("GETNOTE_UNAVAILABLE", "得到大脑响应超时，ONE 会自动重试。", phase, 504, true);
    throw new GetNoteProviderError("GETNOTE_UNAVAILABLE", "得到大脑暂时无法连接，ONE 会自动重试。", phase, 503, true);
  } finally { clearTimeout(timeout); }
}

export type GetNoteDeviceCode = { code: string; verificationUri: string; userCode: string; expiresIn: number; interval: number };
export type GetNoteTokenResult =
  | { status: "pending"; retryAfterSeconds?: number }
  | { status: "ended"; reason: "denied" | "expired" | "consumed" }
  | { status: "connected"; clientId: string; apiKey: string; expiresAt?: number };

export class GetNoteProvider implements KnowledgeProvider {
  async verify(credentials: KnowledgeCredentials): Promise<void> {
    await request<{ results?: unknown[] }>("/resource/recall", credentials, {
      method: "POST",
      body: JSON.stringify({ query: "ONE 连接测试", top_k: 1 })
    }, "credential_verify");
  }

  async startDeviceFlow(clientId: string): Promise<GetNoteDeviceCode> {
    const data = await request<{ code: string; verification_uri: string; user_code: string; expires_in: number; interval: number }>("/oauth/device/code", undefined, { method: "POST", body: JSON.stringify({ client_id: clientId }) }, "authorization_start");
    const verificationUri = safeGetNoteUrl(data.verification_uri);
    if (!verificationUri) throw new Error("得到大脑返回了未获准的授权地址");
    if (typeof data.code !== "string" || !data.code || data.code.length > 4_096 || typeof data.user_code !== "string" || !data.user_code || data.user_code.length > 128) throw new GetNoteProviderError("GETNOTE_RESPONSE_INVALID", "得到大脑授权响应无效，请重试。", "authorization_start", 502, false);
    const expiresIn = Number(data.expires_in);
    const interval = Number(data.interval || 5);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 24 * 60 * 60 || !Number.isFinite(interval) || interval < 1 || interval > 300) throw new GetNoteProviderError("GETNOTE_RESPONSE_INVALID", "得到大脑授权响应无效，请重试。", "authorization_start", 502, false);
    return { code: data.code, verificationUri, userCode: data.user_code, expiresIn, interval };
  }

  async pollDeviceFlow(clientId: string, code: string): Promise<GetNoteTokenResult> {
    try {
      const data = await request<{ msg?: string; client_id: string; api_key: string; expires_at?: number }>("/oauth/token", undefined, { method: "POST", body: JSON.stringify({ grant_type: "device_code", client_id: clientId, code }) }, "authorization_poll");
      const status = String(data.msg ?? "").trim().toLowerCase();
      if (status === "authorization_pending") return { status: "pending" };
      if (status === "slow_down") return { status: "pending", retryAfterSeconds: 10 };
      if (status === "access_denied" || status === "rejected") return { status: "ended", reason: "denied" };
      if (status === "expired_token") return { status: "ended", reason: "expired" };
      if (status === "already_consumed") return { status: "ended", reason: "consumed" };
      if (typeof data.api_key !== "string" || !data.api_key.trim() || data.api_key.length > 65_536) throw new GetNoteProviderError("GETNOTE_RESPONSE_INVALID", "得到大脑没有返回有效凭证，请重新连接。", "authorization_poll", 502, false);
      const returnedClientId = data.client_id || clientId;
      if (typeof returnedClientId !== "string" || !returnedClientId || returnedClientId.length > 2_000) throw new GetNoteProviderError("GETNOTE_RESPONSE_INVALID", "得到大脑授权响应无效，请重新连接。", "authorization_poll", 502, false);
      const rawExpiresAt = data.expires_at === undefined ? undefined : Number(data.expires_at);
      if (rawExpiresAt !== undefined && (!Number.isFinite(rawExpiresAt) || rawExpiresAt <= 0)) throw new GetNoteProviderError("GETNOTE_RESPONSE_INVALID", "得到大脑授权响应无效，请重新连接。", "authorization_poll", 502, false);
      const expiresAt = rawExpiresAt && rawExpiresAt > 10_000_000_000 ? Math.floor(rawExpiresAt / 1000) : rawExpiresAt;
      return { status: "connected", clientId: returnedClientId, apiKey: data.api_key, expiresAt };
    } catch (error) {
      if (error instanceof GetNoteProviderError) {
        if (error.code === "GETNOTE_AUTHORIZATION_PENDING") return { status: "pending" };
        if (error.code === "GETNOTE_AUTHORIZATION_SLOW_DOWN") return { status: "pending", retryAfterSeconds: 10 };
        if (error.code === "GETNOTE_AUTHORIZATION_REJECTED") return { status: "ended", reason: "denied" };
        if (error.code === "GETNOTE_AUTHORIZATION_EXPIRED") return { status: "ended", reason: "expired" };
        if (error.code === "GETNOTE_AUTHORIZATION_CONSUMED") return { status: "ended", reason: "consumed" };
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/authorization_pending/i.test(message)) return { status: "pending" };
      if (/slow_down/i.test(message)) return { status: "pending", retryAfterSeconds: 10 };
      throw error;
    }
  }

  async search(credentials: KnowledgeCredentials, query: string, topK: number): Promise<KnowledgeChunk[]> {
    const data = await request<{ results?: Array<{ note_id?: string; title?: string; content?: string; score?: number; url?: string }> }>("/resource/recall", credentials, { method: "POST", body: JSON.stringify({ query, top_k: Math.max(1, Math.min(10, topK)) }) }, "recall");
    const results = Array.isArray(data.results) ? data.results : [];
    return results.slice(0, 10).filter((item): item is NonNullable<typeof item> => Boolean(item && typeof item === "object")).map((item) => ({ id: item.note_id ? String(item.note_id).slice(0, 500) : undefined, title: String(item.title ?? "得到大脑笔记").slice(0, 300), content: String(item.content ?? "").slice(0, 24_000), score: Number.isFinite(item.score) ? item.score : undefined, sourceUrl: safeGetNoteUrl(item.url) })).filter((item) => item.content);
  }
}

export const getNoteProvider = new GetNoteProvider();
