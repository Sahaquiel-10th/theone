import crypto from "node:crypto";
import type { Store } from "../db.js";
import type { Database, KnowledgeConnection } from "../types.js";
import { assertAllowedConnectorUrl, readBoundedJson } from "../connectors/securityPolicy.js";
import { resolveWorkspaceAccess } from "../workspaceAccess.js";
import { uid } from "../security.js";
import { decryptCredential, encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import type { KnowledgeChunk } from "./provider.js";
import { imaFileFormat, readImaFile } from "./imaFileReader.js";

const origin = "https://ima.qq.com";
const paths = {
  libraries: "/openapi/wiki/v1/search_knowledge_base",
  ownedLibraries: "/openapi/wiki/v1/get_addable_knowledge_base_list",
  search: "/openapi/wiki/v1/search_knowledge",
  media: "/openapi/wiki/v1/get_media_info",
  notebooks: "/openapi/note/v1/list_notebook",
  notes: "/openapi/note/v1/search_note",
  content: "/openapi/note/v1/get_doc_content"
} as const;
type Scope = { workspaceId: string; userId: string };
type Credentials = { clientId: string; apiKey: string };
type Library = { id: string; name: string };
type Json = Record<string, unknown>;
type FileMatch = { title: string; mediaType: number; downloadHost?: string };
export const imaMaxSelectedLibraries = 5;
export class ImaError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
function list(value: unknown): Json[] { if (!Array.isArray(value)) throw new ImaError("IMA_RESPONSE_INVALID", "ima 返回的数据格式有变化，请稍后重试"); return value.slice(0, 100).map(object); }
function identifier(value: unknown) { return typeof value === "string" && value.length > 0 && value.length <= 2000 && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function validateCredentials(input: Credentials) {
  if (typeof input.clientId !== "string" || typeof input.apiKey !== "string") throw new ImaError("IMA_CREDENTIAL_INVALID", "请填写 ima 官网生成的 Client ID 和 API Key", 400);
  const result = { clientId: input.clientId.trim(), apiKey: input.apiKey.trim() };
  if (!result.clientId || result.apiKey.length < 8 || result.clientId.length > 2000 || result.apiKey.length > 8192 || /[^\x21-\x7e]/.test(result.clientId + result.apiKey)) throw new ImaError("IMA_CREDENTIAL_INVALID", "凭据格式不正确，请从 ima 官网重新复制完整内容", 400);
  return result;
}
function owner(db: Database, scope: Scope) {
  const user = db.users.find(u => u.id === scope.userId && u.enabled);
  if (!user || resolveWorkspaceAccess(db, user, scope.workspaceId)?.membership.role !== "owner") throw new ImaError("IMA_ACCESS_DENIED", "只有当前空间所有者可以管理 ima 连接", 403);
}
function redact(value: string, credentials: Credentials) {
  let result = value;
  for (const secret of [credentials.apiKey, credentials.clientId]) result = result.split(secret).join("[凭据已隐藏]");
  return result;
}
function readable(value: unknown, credentials: Credentials) {
  return typeof value === "string" ? redact(value, credentials).replace(/<[^<>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim() : "";
}
function relevance(text: string, query: string) {
  const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{1,}/g) || [])];
  const lower = text.toLowerCase();
  return tokens.reduce((score, token) => score + (lower.includes(token) ? token.length : 0), 0);
}
function excerpt(text: string, query: string) {
  if (text.length <= 24_000) return text;
  const words = query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  const position = words.map(w => text.toLowerCase().indexOf(w)).find(p => p >= 0) ?? 0;
  return text.slice(Math.max(0, position - 2000), Math.max(0, position - 2000) + 24_000);
}
export function imaSearchQuery(query: string) {
  let text = query.trim().slice(0, 400);
  // Basic command cleanup only, not semantic search or an extra model call.
  for (let i = 0; i < 4; i++) text = text.replace(/^(?:请|麻烦|帮我|帮忙|搜索一下|搜索|检索|查找一下|查找|查一下|搜一下|找一下|查询|看看)\s*/, "").replace(/^(?:在|从)(?:我(?:的)?)?\s*(?:腾讯\s*)?ima(?:\s*知识库)?\s*(?:里|中)?\s*/i, "").replace(/^(?:please\s+)?(?:search|find|look up)\s+(?:(?:my\s+)?ima\s+)?(?:for\s+)?/i, "");
  text = text.replace(/[。！？?！]+$/g, "").replace(/(?:的相关资料|的相关笔记|的资料|的笔记|相关资料|相关笔记)$/, "").trim();
  return text || query.trim().slice(0, 400);
}

export class ImaService {
  private activeTotal = 0;
  private readonly activeWorkspaces = new Map<string, number>();
  constructor(private store: Store, private fetcher: typeof fetch = fetch) {}
  private acquire(workspaceId: string) {
    const count = this.activeWorkspaces.get(workspaceId) || 0;
    if (count >= 2 || this.activeTotal >= 8) throw new ImaError("IMA_BUSY", "ima 请求较多，请稍后重试", 429);
    this.activeWorkspaces.set(workspaceId, count + 1); this.activeTotal++;
    return () => { const remaining = (this.activeWorkspaces.get(workspaceId) || 1) - 1; if (remaining) this.activeWorkspaces.set(workspaceId, remaining); else this.activeWorkspaces.delete(workspaceId); this.activeTotal--; };
  }
  private find(db: Database, workspaceId: string) { return db.knowledgeConnections.find(c => c.workspaceId === workspaceId && c.provider === "ima"); }
  private credentials(c: KnowledgeConnection): Credentials {
    if (!c.encryptedClientId || !c.encryptedApiKey) throw new ImaError("IMA_AUTH_REQUIRED", "请先连接 ima", 401);
    return { clientId: decryptCredential(c.encryptedClientId, knowledgeCredentialContext(c.workspaceId, "ima", "client_id")), apiKey: decryptCredential(c.encryptedApiKey, knowledgeCredentialContext(c.workspaceId, "ima", "api_key")) };
  }
  private async call(credentials: Credentials, path: typeof paths[keyof typeof paths], body: Json, signal?: AbortSignal): Promise<Json> {
    if (!Object.values(paths).includes(path)) throw new ImaError("IMA_TOOL_DENIED", "此 ima 操作未开放", 403);
    try {
      const response = await this.fetcher(assertAllowedConnectorUrl(origin + path, ["ima.qq.com"]), { method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]), headers: { "Content-Type": "application/json", "ima-openapi-clientid": credentials.clientId, "ima-openapi-apikey": credentials.apiKey }, body: JSON.stringify(body) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new ImaError("IMA_AUTH_REQUIRED", "ima 凭据无效或已过期，请从官网重新获取后连接", 401);
        if (response.status === 403) throw new ImaError("IMA_PERMISSION_REQUIRED", "ima 资料读取权限不足，请检查账号和知识库权限", 403);
        if (response.status === 429) throw new ImaError("IMA_RATE_LIMITED", "ima 调用频率已达上限，请稍后重试", 429);
        throw new ImaError("IMA_UNAVAILABLE", "ima 暂时无法连接，请稍后重试");
      }
      const data = object(await readBoundedJson(response, 512 * 1024));
      if (data.code !== 0) {
        if (data.code === 20004 || data.code === 110042) throw new ImaError("IMA_AUTH_REQUIRED", "ima 凭据无效或已过期，请从官网重新获取后连接", 401);
        if (data.code === 20002 || data.code === 110021) throw new ImaError("IMA_RATE_LIMITED", "ima 调用频率已达上限，请稍后重试", 429);
        if ([110030, 210005, 210011, 210034].includes(Number(data.code))) throw new ImaError("IMA_PERMISSION_REQUIRED", "ima 资料读取权限不足，请检查账号和知识库权限", 403);
        throw new ImaError("IMA_RESPONSE_INVALID", "ima 未能完成读取，请检查凭据或稍后重试");
      }
      if (!data.data || typeof data.data !== "object" || Array.isArray(data.data)) throw new ImaError("IMA_RESPONSE_INVALID", "ima 返回的数据格式有变化，请稍后重试");
      return data.data as Json;
    } catch (error) {
      if (error instanceof ImaError) throw error;
      throw new ImaError("IMA_UNAVAILABLE", "ima 连接超时或响应异常，请稍后重试");
    }
  }
  private async libraries(credentials: Credentials, signal: AbortSignal, query = "") {
    const found = new Map<string, Library>(); let cursor = "", truncated = false;
    const read = async (path: typeof paths.libraries | typeof paths.ownedLibraries) => {
      cursor = "";
      for (let page = 0; page < 5; page++) {
        const data = await this.call(credentials, path, { ...(path === paths.libraries ? { query } : {}), cursor, limit: 20 }, signal);
        const rows = path === paths.libraries ? data.info_list : data.addable_knowledge_base_list;
        for (const row of list(rows).slice(0, 20)) {
          const id = identifier(row.id);
          if (id && redact(id, credentials) !== id) throw new ImaError("IMA_RESPONSE_INVALID", "ima 返回的知识库标识异常，请稍后重试");
          if (id && !found.has(id)) {
            if (found.size >= 100) { truncated = true; return; }
            found.set(id, { id, name: readable(row.name, credentials).slice(0, 200) || "ima 知识库" });
          }
        }
        if (data.is_end === true) return;
        const next = identifier(data.next_cursor);
        if (!next || next === cursor) throw new ImaError("IMA_RESPONSE_INVALID", "ima 知识库列表未完整返回，请稍后重试");
        cursor = next;
      }
      truncated = true;
    };
    await read(paths.libraries);
    // Some accounts omit the personal library from the generic empty-query
    // search. This official endpoint only lists existing writable libraries;
    // it does not add content or request any additional authorization.
    if (!query && !found.size && !truncated) {
      try { await read(paths.ownedLibraries); }
      catch (error) { if (!(error instanceof ImaError) || error.status !== 403) throw error; }
    }
    return { knowledgeBases: [...found.values()], truncated };
  }
  async state(scope: Scope) {
    const db = await this.store.read(); owner(db, scope); const c = this.find(db, scope.workspaceId);
    return { configured: true, connection: this.publicConnection(c) };
  }
  private publicConnection(c?: KnowledgeConnection) {
    return { provider: "ima" as const, status: !c || c.status === "revoked" ? "disconnected" : c.status, credentialsStored: Boolean(c && c.status !== "revoked" && c.encryptedClientId && c.encryptedApiKey && c.credentialOwnerUserId), lastCheckedAt: c?.lastCheckedAt, lastError: c?.lastError, retrievalScope: c?.status !== "revoked" ? c?.retrievalScope : undefined };
  }
  async connect(scope: Scope, input: Credentials) {
    const credentials = validateCredentials(input), operation = uid("ima"), signal = AbortSignal.timeout(30_000);
    owner(await this.store.read(), scope);
    const release = this.acquire(scope.workspaceId);
    try {
    await this.store.mutate(db => {
      owner(db, scope); let c = this.find(db, scope.workspaceId); const now = new Date().toISOString();
      if (!c) { c = { id: uid("knc"), workspaceId: scope.workspaceId, provider: "ima", clientId: "ima-openapi", status: "pending", createdAt: now, updatedAt: now }; db.knowledgeConnections.push(c); }
      c.credentialUpdateId = operation; if (!c.encryptedApiKey) c.status = "pending"; c.updatedAt = now;
    });
    try {
      const available = await this.libraries(credentials, signal);
      const notebook = await this.call(credentials, paths.notebooks, { cursor: "0", limit: 1 }, signal);
      if (!Array.isArray(notebook.note_folder_infos)) throw new ImaError("IMA_RESPONSE_INVALID", "ima 笔记接口检查未通过，请稍后重试");
      return await this.store.mutate(db => {
        owner(db, scope); const c = this.find(db, scope.workspaceId);
        if (c?.credentialUpdateId !== operation) throw new ImaError("IMA_OPERATION_REPLACED", "这次连接已取消或被替换，请重新确认", 409);
        c.status = "connected"; c.clientId = "ima-openapi"; c.credentialOwnerUserId = scope.userId;
        c.encryptedClientId = encryptCredential(credentials.clientId, knowledgeCredentialContext(scope.workspaceId, "ima", "client_id"));
        c.encryptedApiKey = encryptCredential(credentials.apiKey, knowledgeCredentialContext(scope.workspaceId, "ima", "api_key"));
        c.retrievalScope = { ...available, selectedIds: available.knowledgeBases.length <= imaMaxSelectedLibraries ? available.knowledgeBases.map(b => b.id) : [] };
        c.lastError = undefined; c.lastCheckedAt = new Date().toISOString(); c.updatedAt = c.lastCheckedAt; c.credentialUpdateId = undefined;
        db.auditLogs.push({ id: uid("aud"), workspaceId: scope.workspaceId, actorUserId: scope.userId, action: "knowledge.ima.connected", targetType: "knowledge_connection", targetId: c.id, createdAt: c.updatedAt });
        return { connection: this.publicConnection(c) };
      });
    } catch (error) {
      await this.store.mutate(db => { const c = this.find(db, scope.workspaceId); if (c?.credentialUpdateId !== operation) return; c.credentialUpdateId = undefined; if (!c.encryptedApiKey) c.status = "error"; c.lastError = error instanceof ImaError ? error.message : "ima 连接未完成，请稍后重试"; });
      throw error instanceof ImaError ? error : new ImaError("IMA_UNAVAILABLE", "ima 连接未完成，请稍后重试");
    }
    } finally { release(); }
  }
  async disconnect(scope: Scope) {
    await this.store.mutate(db => {
      owner(db, scope); const c = this.find(db, scope.workspaceId); if (!c) return;
      c.status = "revoked"; c.encryptedApiKey = undefined; c.encryptedClientId = undefined; c.credentialUpdateId = undefined; c.credentialOwnerUserId = undefined; c.retrievalScope = undefined; c.lastError = undefined; c.updatedAt = new Date().toISOString();
      db.auditLogs.push({ id: uid("aud"), workspaceId: scope.workspaceId, actorUserId: scope.userId, action: "knowledge.ima.disconnected", targetType: "knowledge_connection", targetId: c.id, createdAt: c.updatedAt });
    });
  }
  private async connected(workspaceId: string) {
    const db = await this.store.read(), c = this.find(db, workspaceId);
    if (!c || c.status === "revoked" || !c.encryptedApiKey || !c.encryptedClientId || !c.credentialOwnerUserId) throw new ImaError("IMA_AUTH_REQUIRED", "请先连接 ima", 401);
    owner(db, { workspaceId, userId: c.credentialOwnerUserId }); return structuredClone(c);
  }
  private async current(c: KnowledgeConnection) {
    const latest = await this.connected(c.workspaceId);
    if (latest.id !== c.id || latest.encryptedApiKey !== c.encryptedApiKey || latest.encryptedClientId !== c.encryptedClientId || JSON.stringify(latest.retrievalScope?.selectedIds) !== JSON.stringify(c.retrievalScope?.selectedIds)) throw new ImaError("IMA_OPERATION_REPLACED", "ima 连接或检索范围已更改，请重试", 409);
  }
  async updateScope(scope: Scope, selectedIds: string[]) {
    if (!Array.isArray(selectedIds) || selectedIds.length > imaMaxSelectedLibraries || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !identifier(id))) throw new ImaError("IMA_SCOPE_INVALID", "请选择最多 5 个知识库", 400);
    await this.store.mutate(db => {
      owner(db, scope); const c = this.find(db, scope.workspaceId);
      if (!c || c.status === "revoked" || !c.retrievalScope) throw new ImaError("IMA_AUTH_REQUIRED", "请先连接 ima", 401);
      if (selectedIds.some(id => !c.retrievalScope!.knowledgeBases.some(b => b.id === id))) throw new ImaError("IMA_SCOPE_INVALID", "所选知识库不属于这次连接，请重新连接以更新列表", 400);
      c.retrievalScope.selectedIds = [...selectedIds]; c.updatedAt = new Date().toISOString();
      db.auditLogs.push({ id: uid("aud"), workspaceId: scope.workspaceId, actorUserId: scope.userId, action: "knowledge.ima.scope_updated", targetType: "knowledge_connection", targetId: c.id, createdAt: c.updatedAt });
    });
    return this.state(scope);
  }
  async refreshLibraries(scope: Scope, query?: string) {
    if (query !== undefined && (typeof query !== "string" || !query.trim() || query.trim().length > 100)) throw new ImaError("IMA_QUERY_INVALID", "请输入最多 100 字的知识库名称", 400);
    owner(await this.store.read(), scope);
    const c = await this.connected(scope.workspaceId), release = this.acquire(scope.workspaceId);
    try {
      const available = await this.libraries(this.credentials(c), AbortSignal.timeout(30_000), query?.trim());
      const matchedCount = available.knowledgeBases.length;
      if (query) {
        const merged = new Map((c.retrievalScope?.knowledgeBases || []).map(library => [library.id, library]));
        for (const library of available.knowledgeBases) merged.set(library.id, library);
        available.truncated ||= merged.size > 100 || Boolean(c.retrievalScope?.truncated);
        available.knowledgeBases = [...merged.values()].slice(0, 100);
      }
      await this.current(c);
      await this.store.mutate(db => {
        owner(db, scope); const target = this.find(db, scope.workspaceId);
        if (!target || target.status === "revoked" || target.encryptedApiKey !== c.encryptedApiKey || target.encryptedClientId !== c.encryptedClientId || JSON.stringify(target.retrievalScope?.selectedIds) !== JSON.stringify(c.retrievalScope?.selectedIds)) throw new ImaError("IMA_OPERATION_REPLACED", "ima 连接或检索范围已更改，请重试", 409);
        target.retrievalScope = { ...available, selectedIds: (c.retrievalScope?.selectedIds || []).filter(id => available.knowledgeBases.some(library => library.id === id)) };
        target.updatedAt = new Date().toISOString();
      });
      return { ...await this.state(scope), matchedCount };
    } finally { release(); }
  }
  localStatus(db: Database, workspaceId: string) {
    const c = this.find(db, workspaceId);
    if (!c || c.status === "revoked" || !c.encryptedApiKey) return { state: "not_connected" as const, code: "AUTHORIZATION_REQUIRED", message: "请连接 ima", evidence: "stored" as const };
    return { state: c.status === "error" ? "error" as const : "configured" as const, code: "CREDENTIAL_STORED", message: c.status === "error" ? "ima 连接需要检查" : "ima 凭据已保存", evidence: "stored" as const };
  }
  async verify(workspaceId: string) {
    const c = await this.connected(workspaceId);
    const release = this.acquire(workspaceId);
    try {
    const data = await this.call(this.credentials(c), paths.notebooks, { cursor: "0", limit: 1 });
    if (!Array.isArray(data.note_folder_infos)) throw new ImaError("IMA_RESPONSE_INVALID", "ima 读取接口暂不可用");
    await this.current(c);
    } finally { release(); }
  }
  async checkSearch(scope: Scope, query: string) {
    if (typeof query !== "string" || !query.trim() || query.trim().length > 400) throw new ImaError("IMA_QUERY_INVALID", "请输入最多 400 字的检索关键词", 400);
    await this.state(scope);
    const snapshot = await this.connected(scope.workspaceId);
    const fileMatches: FileMatch[] = [];
    let chunks: KnowledgeChunk[] = [], contentUnavailable = false;
    try { chunks = await this.search(scope.workspaceId, query.trim(), 5, match => fileMatches.push(match)); }
    catch (error) { if (!(error instanceof ImaError) || error.code !== "IMA_CONTENT_UNAVAILABLE") throw error; contentUnavailable = true; }
    await this.current(snapshot);
    const connection = await this.store.mutate(db => {
      owner(db, scope); const target = this.find(db, scope.workspaceId);
      if (!target || target.id !== snapshot.id || target.status === "revoked" || target.credentialOwnerUserId !== snapshot.credentialOwnerUserId || target.encryptedApiKey !== snapshot.encryptedApiKey || target.encryptedClientId !== snapshot.encryptedClientId || JSON.stringify(target.retrievalScope?.selectedIds) !== JSON.stringify(snapshot.retrievalScope?.selectedIds)) throw new ImaError("IMA_OPERATION_REPLACED", "ima 连接或检索范围已更改，请重试", 409);
      owner(db, { workspaceId: scope.workspaceId, userId: target.credentialOwnerUserId! });
      target.status = "connected"; target.lastError = undefined; target.lastCheckedAt = new Date().toISOString(); target.updatedAt = target.lastCheckedAt;
      return this.publicConnection(target);
    });
    return { chunks, count: chunks.length, connection, fileMatches, status: contentUnavailable ? "content_unavailable" : chunks.length ? "used" : "no_match", message: contentUnavailable ? "已命中文件，但尚未取得可读正文；下列标题不能作为原文引用。" : chunks.length ? "已取得 ima 实际返回的资料片段" : "本次关键词没有命中可读资料，不代表知识库不存在相关内容" };
  }
  async search(workspaceId: string, query: string, topK: number, onFileMatch?: (match: FileMatch) => void): Promise<KnowledgeChunk[]> {
    if (typeof query !== "string" || !query.trim()) return [];
    const c = await this.connected(workspaceId), release = this.acquire(workspaceId);
    try {
    const credentials = this.credentials(c), signal = AbortSignal.timeout(30_000);
    const limit = Math.max(1, Math.min(5, Number.isFinite(topK) ? Math.floor(topK) : 5)), q = imaSearchQuery(query);
    const [byContent, byTitle, ...libraries] = await Promise.all([
      this.call(credentials, paths.notes, { search_type: 1, query_info: { content: q }, start: 0, end: 20 }, signal),
      this.call(credentials, paths.notes, { search_type: 0, query_info: { title: q }, start: 0, end: 20 }, signal),
      ...(c.retrievalScope?.selectedIds || []).slice(0, imaMaxSelectedLibraries).map(knowledge_base_id => this.call(credentials, paths.search, { query: q, cursor: "", knowledge_base_id }, signal))
    ]);
    type Candidate = { id: string; title: string; text: string; noteId?: string; mediaId?: string };
    const candidates = new Map<string, Candidate>();
    for (const data of [byContent, byTitle]) for (const hit of list(data.search_note_infos)) {
      const note = object(hit.note_book_info), noteId = identifier(note.note_id);
      if (noteId) candidates.set("note:" + noteId, { id: "note:" + noteId, noteId, title: readable(note.title, credentials).slice(0, 300) || "ima 笔记", text: readable(note.summary, credentials) });
    }
    for (const data of libraries) for (const hit of list(data.info_list)) {
      const mediaId = identifier(hit.media_id);
      if (mediaId) candidates.set("media:" + mediaId, { id: "media:" + mediaId, mediaId, title: readable(hit.title, credentials).slice(0, 300) || "ima 资料", text: readable(hit.highlight_content, credentials) });
    }
    const readCost = (hit: Candidate) => hit.noteId || hit.text ? 0 : /\.docx$/i.test(hit.title) ? 1 : 2;
    const ordered = [...candidates.values()].sort((a, b) => relevance(b.title + b.text, q) - relevance(a.title + a.text, q) || readCost(a) - readCost(b)).slice(0, limit * 2);
    const chunks: KnowledgeChunk[] = []; let unreadable = false, fileReads = 0;
    for (const hit of ordered) {
      if (chunks.length >= limit) break;
      let content = hit.text;
      try {
        if (hit.mediaId && !content) {
          if (fileReads >= 2 && chunks.length) continue;
          const media = await this.call(credentials, paths.media, { media_id: hit.mediaId }, signal);
          if (media.media_type === 11) hit.noteId = identifier(object(media.notebook_ext_info).notebook_id);
          if (!hit.noteId && fileReads < 2 && imaFileFormat(media.media_type, hit.title)) {
            fileReads++;
            const link = object(media.url_info), headers = object(link.headers), sourceUrl = typeof link.url === "string" ? link.url : "";
            // Object-access headers are scoped to a reviewed file host. Never
            // forward the API Client ID/Key, even if an upstream response echoes them.
            const echoed = [credentials.clientId, credentials.apiKey].some(secret => sourceUrl.includes(secret) || sourceUrl.includes(encodeURIComponent(secret))) || Object.values(headers).some(value => typeof value === "string" && redact(value, credentials) !== value);
            if (!echoed) {
              try { content = readable(await readImaFile({ url: link.url, headers: link.headers, mediaType: media.media_type, title: hit.title, query: q, signal }, this.fetcher), credentials); }
              catch (error) { if (error instanceof Error && error.message === "IMA_FILE_BUSY") throw new ImaError("IMA_BUSY", "ima 文件读取请求较多，请稍后重试", 429); /* Keep unreadable files distinct from an empty search. */ }
            }
          }
          if (onFileMatch && !hit.noteId && !content) {
            let downloadHost: string | undefined;
            try {
              const url = new URL(String(object(media.url_info).url));
              if (url.protocol === "https:" && !url.username && !url.password && /^[a-z0-9.-]{1,253}$/.test(url.hostname) && redact(url.hostname, credentials) === url.hostname) downloadHost = url.hostname;
            } catch { /* Missing/invalid links have no public diagnostic hostname. */ }
            onFileMatch({ title: hit.title, mediaType: Number.isSafeInteger(media.media_type) ? Number(media.media_type) : 0, ...(downloadHost ? { downloadHost } : {}) });
          }
          // Signed URLs/headers stay server-side; unknown hosts are never fetched.
        }
        if (hit.noteId) {
          const body = await this.call(credentials, paths.content, { note_id: hit.noteId, target_content_format: 0 }, signal);
          content = readable(body.content, credentials);
        }
      } catch (error) {
        if (!(error instanceof ImaError) || error.status !== 403) throw error;
        if (hit.noteId) content = ""; // Never pass note metadata as a substitute for denied body access.
      }
      if (!content) { unreadable = true; continue; }
      chunks.push({ provider: "ima", id: crypto.createHash("sha256").update(hit.id).digest("hex").slice(0, 24), title: hit.title, content: excerpt(content, q), sourceUrl: origin });
    }
    await this.current(c);
    if (!chunks.length && unreadable) throw new ImaError("IMA_CONTENT_UNAVAILABLE", "ima 已命中资料，但本次未取得可读正文片段，请在连接详情查看文件读取诊断");
    if (!chunks.length && !c.retrievalScope?.selectedIds.length) throw new ImaError("IMA_KNOWLEDGE_SCOPE_REQUIRED", "ima 本次只检索了个人笔记，尚未检索知识库内的文件；请在连接详情刷新并选择知识库，不能据此判断库内没有内容", 409);
    return chunks;
    } finally { release(); }
  }
}
