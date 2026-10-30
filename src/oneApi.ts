import {coordinatorRecoveryCopy,parseCoordinatorFailure,type CoordinatorFailure} from './coordinatorRecovery';

/** Compatibility for reviewed auth middleware responses predating failure metadata. */
function reviewedAuthFailure(path:string,status:number,fields:Record<string,unknown>):CoordinatorFailure|undefined {
  if(!path.startsWith('/api/'))return;
  if(status===428&&['ONE_KEY_REQUIRED','ONE_KEY_LOGIN_REQUIRED','ONE_KEY_UPGRADE_REQUIRED'].includes(String(fields.code))
    ||status===403&&fields.code==='ONE_KEY_LOGIN_REQUIRED')return{code:'key_required',stage:'accepting',outcome:'unknown'};
  if(status===401&&(fields.error==='未登录或登录已过期'||fields.error==='账号不可用')
    ||status===403&&fields.error==='Workspace 不存在或无权访问')return{code:'account_unavailable',stage:'accepting',outcome:'unknown'};
}

let expectedUserId = "";
let expectedWorkspaceId = "";
let identityRevision = 0;
export const SESSION_EVENT = "one-session-changed";
export const SESSION_STORAGE_KEY = "one-session-revision";
export function expectUser(id: string, workspaceId = "") { expectedUserId = id; expectedWorkspaceId = workspaceId; identityRevision++; }
export function announceSessionChange() {
  try { localStorage.setItem(SESSION_STORAGE_KEY, crypto.randomUUID()); } catch { /* Private-mode storage may be disabled. */ }
}
export class ApiError extends Error {
  constructor(message: string, readonly requestId?: string, readonly status?: number, readonly code?: string, readonly retryable?: boolean, readonly failure?:CoordinatorFailure) { super(message); }
}
export function apiForUser(userId: string, workspaceId = expectedWorkspaceId) {
  const revision = identityRevision;
  return <T>(path: string, options: RequestInit = {}) => api<T>(path, options, userId, workspaceId, revision);
}
export async function api<T>(path: string, options: RequestInit = {}, ownerId?: string, workspaceId = expectedWorkspaceId, revision = identityRevision): Promise<T> {
  const identity = ownerId ?? expectedUserId;
  // Bind the request to the component that created it, including continuations
  // that resume AFTER an account switch but BEFORE fetch has started.
  if (ownerId !== undefined && (identity !== expectedUserId || workspaceId !== expectedWorkspaceId || revision !== identityRevision)) {
    throw new ApiError("登录账号已切换，旧页面的操作已取消", undefined, 409, "SESSION_CHANGED");
  }
  const identityFree = path === "/api/me" || path.startsWith("/api/auth/");
  const headers = new Headers(options.headers);
  try{headers.set('X-ONE-Time-Zone',Intl.DateTimeFormat().resolvedOptions().timeZone);}catch{/* Server uses the saved zone or its explicit default. */}
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!identityFree && identity) headers.set("X-ONE-User", identity);
  if (!identityFree && workspaceId) headers.set("X-ONE-Workspace", workspaceId);
  const response = await fetch(path, {
    ...options, credentials: "same-origin",
    headers
  });
  let payload:unknown;
  let invalidJson=false;
  try { payload=await response.json(); } catch { payload={};invalidJson=response.status!==204; }
  const fields=payload&&typeof payload==='object'?payload as Record<string,unknown>:{};
  // Discard any late response from the previous account after another tab logs in.
  if ((!identityFree && (identity !== expectedUserId || workspaceId !== expectedWorkspaceId || revision !== identityRevision)) || fields.code === "SESSION_CHANGED") {
    window.dispatchEvent(new Event(SESSION_EVENT));
    throw new ApiError("登录账号已切换，正在重新确认当前页面", undefined, 409, "SESSION_CHANGED");
  }
  if (!response.ok) {
    const requestId = typeof fields.requestId==='string'?fields.requestId:response.headers.get("x-request-id") || undefined;
    const ownedAuth=reviewedAuthFailure(path,response.status,fields),failure=parseCoordinatorFailure(fields.failure)??ownedAuth;
    const message=ownedAuth?(fields.code==='ONE_KEY_UPGRADE_REQUIRED'?'请更新 ONE Key 启动器，再从 U 盘双击 ONE 登录。':coordinatorRecoveryCopy(ownedAuth))
      :typeof fields.error==='string'?fields.error:(response.status === 504 ? "服务响应超时，请查看这条消息的处理结果" : `请求失败（${response.status}）`);
    throw new ApiError(requestId ? `${message} · 编号 ${requestId}` : message, requestId, response.status, typeof fields.code==='string'?fields.code:undefined, typeof fields.retryable==='boolean'?fields.retryable:undefined,failure);
  }
  if(invalidJson)throw new ApiError('服务返回的内容暂时无法核对，正在查看原结果。',response.headers.get('x-request-id')||undefined,response.status,'INVALID_RESPONSE',false,/^\/api\/coordinator\/messages(?:\/[^/?]+)?(?:\?|$)/.test(path)?{code:'invalid_receipt',stage:'receipt',outcome:'unknown'}:undefined);
  if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&'failure' in fields)return{...fields,failure:parseCoordinatorFailure(fields.failure)} as T;
  return payload as T;
}
