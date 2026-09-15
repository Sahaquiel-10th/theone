let expectedUserId = "";
export const SESSION_EVENT = "one-session-changed";
export const SESSION_STORAGE_KEY = "one-session-revision";
export function expectUser(id: string) { expectedUserId = id; }
export function announceSessionChange() {
  try { localStorage.setItem(SESSION_STORAGE_KEY, crypto.randomUUID()); } catch { /* Private-mode storage may be disabled. */ }
}
export class ApiError extends Error {
  constructor(message: string, readonly requestId?: string, readonly status?: number, readonly code?: string, readonly retryable?: boolean) { super(message); }
}
export function apiForUser(userId: string) {
  return <T>(path: string, options: RequestInit = {}) => api<T>(path, options, userId);
}
export async function api<T>(path: string, options: RequestInit = {}, ownerId?: string): Promise<T> {
  const identity = ownerId ?? expectedUserId;
  // Bind the request to the component that created it, including continuations
  // that resume AFTER an account switch but BEFORE fetch has started.
  if (ownerId !== undefined && identity !== expectedUserId) {
    throw new ApiError("登录账号已切换，旧页面的操作已取消", undefined, 409, "SESSION_CHANGED");
  }
  const identityFree = path === "/api/me" || path.startsWith("/api/auth/");
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!identityFree && identity) headers.set("X-ONE-User", identity);
  const response = await fetch(path, {
    ...options, credentials: "same-origin",
    headers
  });
  const payload = await response.json().catch(() => ({}));
  // Discard any late response from the previous account after another tab logs in.
  if ((!identityFree && identity !== expectedUserId) || payload.code === "SESSION_CHANGED") {
    window.dispatchEvent(new Event(SESSION_EVENT));
    throw new ApiError("登录账号已切换，正在重新确认当前页面", undefined, 409, "SESSION_CHANGED");
  }
  if (!response.ok) {
    const requestId = payload.requestId || response.headers.get("x-request-id") || undefined;
    const message = payload.error || (response.status === 504 ? "服务响应超时，请查看这条消息的处理结果" : `请求失败（${response.status}）`);
    throw new ApiError(requestId ? `${message} · 编号 ${requestId}` : message, requestId, response.status, payload.code, payload.retryable);
  }
  return payload as T;
}
