import crypto from "node:crypto";
import type { Store } from "../db.js";
import type { Database, KnowledgeConnection } from "../types.js";
import { AuthorizationSessions } from "../connectors/authorizationSessions.js";
import { readBoundedJson } from "../connectors/securityPolicy.js";
import { encryptCredential, decryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import type { KnowledgeChunk } from "./provider.js";

const host = "https://open.feishu.cn";
const callback = "/api/knowledge/connections/feishu/oauth/callback";
type Scope = { workspaceId: string; userId: string };
type Options = { fetch?: typeof fetch; appId?: string; appSecret?: string; origin?: string; scopes?: string; installUrl?: string };
const connection = (db: Database, workspaceId: string) => db.knowledgeConnections.find(c => c.workspaceId === workspaceId && c.provider === "feishu");
const context = (workspaceId: string, field: string) => knowledgeCredentialContext(workspaceId, "feishu", field);
function owner(db: Database, scope: Scope) {
  if (!db.users.some(u => u.id === scope.userId && u.enabled) || !db.workspaces.some(w => w.id === scope.workspaceId && w.status === "active") || !db.workspaceMembers.some(m => m.workspaceId === scope.workspaceId && m.userId === scope.userId && m.role === "owner")) throw new Error("无权操作此连接");
}
function text(value: unknown, max: number) { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("飞书响应或输入无效"); return value; }
function id(value: unknown) { const s = text(value, 200); if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("飞书文档标识无效"); return s; }
export class FeishuService {
  private options: Options;
  private sessions: AuthorizationSessions;
  private refreshes = new Map<string, Promise<void>>();
  constructor(private store: Store, options: Options = {}) {
    this.options = { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, origin: process.env.APP_ORIGIN, scopes: process.env.FEISHU_OAUTH_SCOPES, installUrl: process.env.FEISHU_INSTALL_URL, ...options };
    this.sessions = new AuthorizationSessions(store);
  }
  configured() { return Boolean(this.options.appId && this.options.appSecret && this.options.scopes && /^https:\/\//.test(this.options.origin || "")); }
  setup() {
    let installUrl: string | undefined;
    try { const u = new URL(this.options.installUrl || ""); if (u.protocol === "https:" && !u.username && !u.password && (u.hostname === "feishu.cn" || u.hostname.endsWith(".feishu.cn"))) installUrl = u.href; } catch { /* No reviewed install link configured. */ }
    return { configured: this.configured(), installUrl };
  }
  localStatus(db: Database, workspaceId: string) {
    const c = connection(db, workspaceId);
    if (!this.configured()) return { state: "unavailable" as const, code: "APP_SETUP_REQUIRED", message: "等待开通 ONE 飞书应用", evidence: "stored" as const };
    if (!c || c.status === "revoked" || !c.encryptedAccessToken) return { state: "not_connected" as const, code: "AUTHORIZATION_REQUIRED", message: "连接飞书", evidence: "stored" as const };
    return { state: c.status === "connected" ? "configured" as const : "error" as const, code: "AUTHORIZATION_STORED", message: c.lastError || "飞书已连接", evidence: "stored" as const };
  }
  private async request(path: string, method: string, body?: unknown, token?: string): Promise<any> {
    try {
      const response = await (this.options.fetch || fetch)(host + path, { method, redirect: "error", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await readBoundedJson<any>(response);
      if (!response.ok || result.error || (result.code !== undefined && result.code !== 0)) throw new Error("provider_error");
      return result;
    } catch { throw new Error("飞书请求未完成，请检查企业安装、授权权限或稍后重试；写入结果请先核对飞书"); }
  }
  async begin(scope: Scope) {
    owner(await this.store.read(), scope);
    if (!this.configured()) throw new Error("请先由管理员开通 ONE 飞书应用");
    const state = crypto.randomBytes(32).toString("base64url"), verifier = crypto.randomBytes(32).toString("base64url");
    const redirectUri = new URL(callback, this.options.origin).href;
    await this.sessions.create({ ...scope, connectorId: "feishu", protocol: "oauth_pkce", state, expiresAt: Date.now() + 600000, payload: { clientId: this.options.appId, verifier, redirectUri } });
    const url = new URL(host + "/open-apis/authen/v1/authorize");
    url.search = new URLSearchParams({ client_id: this.options.appId!, response_type: "code", redirect_uri: redirectUri, state, scope: this.options.scopes!, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    return { authorizationUrl: url.href };
  }
  async cancel(state: string) { await this.sessions.cancelState("feishu", state); }
  async complete(state: string, code: string) {
    const { session, payload } = await this.sessions.claimState("feishu", state);
    try {
      owner(await this.store.read(), session);
      if (payload.clientId !== this.options.appId) throw new Error("应用配置已变更，请重新连接");
      const token = await this.request("/open-apis/authen/v2/oauth/token", "POST", { grant_type: "authorization_code", client_id: this.options.appId, client_secret: this.options.appSecret, code: text(code, 4096), redirect_uri: payload.redirectUri, code_verifier: payload.verifier });
      const access = text(token.access_token, 65536), refresh = text(token.refresh_token, 65536);
      const expires = Number(token.expires_in); if (!Number.isFinite(expires) || expires <= 0) throw new Error("飞书授权有效期无效");
      const info = await this.request("/open-apis/authen/v1/user_info", "GET", undefined, access);
      const openId = id(info.data?.open_id);
      await this.store.mutate(db => {
        owner(db, session); const c = connection(db, session.workspaceId);
        if (c?.authorizationSession?.id !== session.id) throw new Error("授权已经取消或替换");
        c.clientId = this.options.appId!; c.encryptedAccessToken = encryptCredential(access, context(c.workspaceId, "access_token"));
        c.encryptedRefreshToken = encryptCredential(refresh, context(c.workspaceId, "refresh_token"));
        c.providerUserId = openId; c.providerSpaceName = typeof info.data.name === "string" ? info.data.name.slice(0, 100) : "飞书账号";
        c.credentialExpiresAt = new Date(Date.now() + expires * 1000).toISOString(); c.status = "connected"; c.lastError = undefined; c.authorizationSession = undefined; c.updatedAt = new Date().toISOString();
      });
    } finally { await this.sessions.finish(session.id); }
  }
  private async credential(workspaceId: string) {
    if (!this.configured()) throw new Error("飞书应用尚未开通");
    let c = connection(await this.store.read(), workspaceId);
    if (!c || c.status === "revoked" || !c.encryptedAccessToken || c.clientId !== this.options.appId) throw new Error("请重新授权飞书");
    if (!c.credentialExpiresAt || Date.parse(c.credentialExpiresAt) <= Date.now() + 60000) {
      let pending = this.refreshes.get(workspaceId);
      if (!pending) { const snapshot = structuredClone(c); pending = this.refresh(snapshot); this.refreshes.set(workspaceId, pending); }
      try { await pending; } finally { if (this.refreshes.get(workspaceId) === pending) this.refreshes.delete(workspaceId); }
      c = connection(await this.store.read(), workspaceId);
    }
    if (!c || c.status === "revoked" || !c.encryptedAccessToken) throw new Error("请重新授权飞书");
    return { token: decryptCredential(c.encryptedAccessToken, context(workspaceId, "access_token")), encrypted: c.encryptedAccessToken, user: c.providerUserId };
  }
  private async refresh(snapshot: KnowledgeConnection) {
    if (!snapshot.encryptedRefreshToken) throw new Error("飞书授权已过期，请重新连接");
    const result = await this.request("/open-apis/authen/v2/oauth/token", "POST", { grant_type: "refresh_token", client_id: this.options.appId, client_secret: this.options.appSecret, refresh_token: decryptCredential(snapshot.encryptedRefreshToken, context(snapshot.workspaceId, "refresh_token")) });
    const access = text(result.access_token, 65536), refresh = text(result.refresh_token, 65536), expires = Number(result.expires_in);
    if (!Number.isFinite(expires) || expires <= 0) throw new Error("飞书授权有效期无效");
    await this.store.mutate(db => {
      const c = connection(db, snapshot.workspaceId);
      if (!c || c.status === "revoked" || c.encryptedAccessToken !== snapshot.encryptedAccessToken) throw new Error("飞书连接已变更，请重试");
      c.encryptedAccessToken = encryptCredential(access, context(c.workspaceId, "access_token")); c.encryptedRefreshToken = encryptCredential(refresh, context(c.workspaceId, "refresh_token"));
      c.credentialExpiresAt = new Date(Date.now() + expires * 1000).toISOString(); c.updatedAt = new Date().toISOString();
    });
  }
  async disconnect(scope: Scope) {
    await this.store.mutate(db => { owner(db, scope); const c = connection(db, scope.workspaceId); if (!c) return;
      c.status = "revoked"; c.encryptedAccessToken = undefined; c.encryptedRefreshToken = undefined; c.authorizationSession = undefined; c.updatedAt = new Date().toISOString(); });
  }
  async search(workspaceId: string, query: string, topK: number): Promise<KnowledgeChunk[]> {
    const credential = await this.credential(workspaceId);
    const result = await this.request("/open-apis/suite/docs-api/search/object", "POST", { search_key: query.slice(0, 200), count: Math.min(20, Math.max(1, topK * 2)), offset: 0, docs_types: ["doc"] }, credential.token);
    const docs = result.data?.docs_entities;
    if (!Array.isArray(docs)) throw new Error("飞书搜索响应无效");
    const chunks: KnowledgeChunk[] = [];
    for (const doc of docs.filter((d: any) => d.docs_type === "docx").slice(0, topK)) {
      const documentId = id(doc.docs_token);
      const read = await this.request(`/open-apis/docx/v1/documents/${documentId}/raw_content`, "GET", undefined, credential.token);
      if (typeof read.data?.content === "string") chunks.push({ provider: "feishu", id: documentId, title: typeof doc.title === "string" ? doc.title.slice(0, 300) : "飞书文档", content: read.data.content.slice(0, 24000), sourceUrl: await this.documentUrl(documentId, credential.token) });
    }
    const current = connection(await this.store.read(), workspaceId);
    if (current?.encryptedAccessToken !== credential.encrypted || current.status === "revoked") throw new Error("飞书连接已变更，请重试");
    return chunks;
  }
  private async documentUrl(documentId: string, token: string) {
    try {
      const result = await this.request("/open-apis/drive/v1/metas/batch_query", "POST", { request_docs: [{ doc_token: documentId, doc_type: "docx" }], with_url: true }, token);
      const url = new URL(result.data?.metas?.[0]?.url);
      if (url.protocol === "https:" && !url.username && !url.password && url.hostname.endsWith(".feishu.cn")) return url.href;
    } catch { /* A missing optional link must not repeat a completed write. */ }
    return undefined;
  }
  async saveAnswer(scope: Scope, params: { operationId: string; sourceMessageId: string; title: string; expectedAccount: string }) {
    const operationId = id(params.operationId), title = text(params.title.trim(), 200);
    const db = await this.store.read(); owner(db, scope);
    const message = db.messages.find(m => m.id === params.sourceMessageId && m.workspaceId === scope.workspaceId && m.userId === scope.userId && m.role === "assistant");
    if (!message) throw new Error("回答不存在或无权访问");
    const content = text(message.content, 40000);
    const credential = await this.credential(scope.workspaceId);
    if (!params.expectedAccount || credential.user !== params.expectedAccount) throw new Error("飞书账号已改变，请重新确认");
    const existing = await this.store.mutate(mutable => {
      owner(mutable, scope); const c = connection(mutable, scope.workspaceId);
      if (!c || c.status === "revoked" || c.encryptedAccessToken !== credential.encrypted) throw new Error("连接已变更");
      c.documentWrites ||= [];
      const prior = c.documentWrites.find(w => w.id === operationId || w.sourceMessageId === params.sourceMessageId && w.userId === scope.userId);
      if (prior) { if (prior.userId !== scope.userId || prior.sourceMessageId !== params.sourceMessageId || prior.title !== title) throw new Error("保存请求已变更，请核对之前的操作"); return structuredClone(prior); }
      if (c.documentWrites.length >= 10000) throw new Error("保存记录已达上限，请联系管理员");
      c.documentWrites.push({ id: operationId, userId: scope.userId, sourceMessageId: message.id, title, status: "pending", createdAt: new Date().toISOString() });
      return undefined;
    });
    if (existing) return existing;
    let documentId: string | undefined;
    try {
      const created = await this.request("/open-apis/docx/v1/documents", "POST", { title }, credential.token);
      documentId = id(created.data?.document?.document_id);
      await this.store.mutate(mutable => { const w = connection(mutable, scope.workspaceId)?.documentWrites?.find(w => w.id === operationId); if (!w) throw new Error("保存记录不存在"); w.documentId = documentId; });
      const current = connection(await this.store.read(), scope.workspaceId);
      if (current?.status === "revoked" || current?.encryptedAccessToken !== credential.encrypted) throw new Error("连接已断开");
      // Bounded plain-text paragraphs: never interpret model text as executable HTML.
      const chunks = content.match(/[\s\S]{1,1000}/gu) || [];
      await this.request(`/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, "POST", { children: chunks.map(content => ({ block_type: 2, text: { elements: [{ text_run: { content } }] } })), index: -1 }, credential.token);
      const url = await this.documentUrl(documentId, credential.token);
      return await this.store.mutate(mutable => {
        const w = connection(mutable, scope.workspaceId)?.documentWrites?.find(w => w.id === operationId && w.userId === scope.userId);
        if (!w) throw new Error("保存记录不存在"); w.status = "completed"; w.url = url;
        mutable.auditLogs.push({ id: crypto.randomUUID(), workspaceId: scope.workspaceId, actorUserId: scope.userId, action: "feishu.document.created", targetType: "document", targetId: documentId!, details: { operationId }, createdAt: new Date().toISOString() });
        return structuredClone(w);
      });
    } catch {
      return this.store.mutate(mutable => { const w = connection(mutable, scope.workspaceId)?.documentWrites?.find(w => w.id === operationId && w.userId === scope.userId); if (!w) throw new Error("请先核对飞书保存结果"); w.status = "uncertain"; return structuredClone(w); });
    }
  }
}
