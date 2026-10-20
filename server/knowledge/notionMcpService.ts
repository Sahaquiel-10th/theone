import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Store } from "../db.js";
import { AuthorizationSessions } from "../connectors/authorizationSessions.js";
import { assertAllowedConnectorUrl, readBoundedJson } from "../connectors/securityPolicy.js";
import { uid } from "../security.js";
import type { ConnectorAuthorizationSession, Database, KnowledgeConnection } from "../types.js";
import { decryptCredential, encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import type { KnowledgeChunk } from "./provider.js";
import { createNotionFetch } from './notionTransport.js';

const MCP_URL = "https://mcp.notion.com/mcp";
const AUTHORIZATION_URL = "https://mcp.notion.com/authorize";
const TOKEN_URL = "https://mcp.notion.com/token";
const REGISTRATION_URL = "https://mcp.notion.com/register";
const readOnlyTools = new Set(["notion-fetch", "notion-search"]);
const flowLifetimeMs = 10 * 60 * 1000;
const maxChunkChars = 24_000;
const maxToolTextChars = 256_000;
const notionHosts = ["mcp.notion.com"] as const;
const mcpTimeoutMs = Math.max(3_000, Number(process.env.NOTION_MCP_TIMEOUT_MS ?? 20_000));

type OAuthClient = { clientId: string; clientSecret?: string; tokenAuthMethod: "none" | "client_secret_post" };
type OAuthFlow = OAuthClient & {
  enableWriting?: boolean;
  workspaceId: string;
  userId: string;
  connectionId?: string;
  previousStatus?: KnowledgeConnection["status"];
  redirectUri: string;
  verifier: string;
};
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  client_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  user_id?: string;
};

function requiredResponseString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value || value.length > maxLength) throw new Error(`Notion ${label}响应格式无效`);
  return value;
}

function optionalResponseString(value: unknown, label: string, maxLength: number) {
  return value === undefined || value === null ? undefined : requiredResponseString(value, label, maxLength);
}

function validatedToken(value: unknown): TokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notion 授权响应格式无效");
  const token = value as Record<string, unknown>;
  const expires = token.expires_in === undefined ? undefined : Number(token.expires_in);
  if (expires !== undefined && (!Number.isFinite(expires) || expires <= 0 || expires > 366 * 24 * 60 * 60)) throw new Error("Notion 授权有效期响应格式无效");
  return {
    access_token: requiredResponseString(token.access_token, "访问令牌", 65_536),
    refresh_token: optionalResponseString(token.refresh_token, "刷新令牌", 65_536),
    client_id: optionalResponseString(token.client_id, "客户端", 2_000),
    workspace_id: optionalResponseString(token.workspace_id, "工作空间", 2_000),
    workspace_name: optionalResponseString(token.workspace_name, "工作空间名称", 500),
    user_id: optionalResponseString(token.user_id, "用户", 2_000),
    expires_in: expires
  };
}
type McpClient = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

async function withinDeadline<T>(operation: Promise<T>, message: string, timeoutMs = mcpTimeoutMs) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeClient(client: McpClient) {
  await withinDeadline(client.close(), "Notion MCP 连接关闭超时", 2_000).catch(() => undefined);
}

function transientConnectionFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const e = error as {code?: unknown; message?: unknown; cause?: unknown; errors?: unknown};
  if (typeof e.code === 'string' && ['ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ECONNRESET','ECONNREFUSED','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(e.code)) return true;
  if (typeof e.message === 'string' && /^(?:fetch failed|Notion MCP 连接超时)$/.test(e.message)) return true;
  return transientConnectionFailure(e.cause, depth + 1) || Array.isArray(e.errors) && e.errors.slice(0,8).some(e => transientConnectionFailure(e, depth + 1));
}

export type NotionWritePhase = 'authorization' | 'connect' | 'tools' | 'send';
export class NotionWriteError extends Error {
  constructor(readonly phase: NotionWritePhase, readonly delivery: 'not_sent' | 'rejected' | 'unknown', readonly reason: 'connection' | 'authorization' | 'permission' | 'validation' | 'unavailable' | 'upstream', readonly upstreamCode?: string) {
    super(delivery === 'not_sent' ? reason === 'authorization' ? 'Notion 授权或连接已改变，保存请求尚未发出。' : 'Notion 保存请求尚未发出，请检查连接后继续。' : delivery === 'rejected' ? 'Notion 没有接受这次保存，请检查连接和页面权限后继续。' : 'Notion 保存未确认，请先核对原页面；不会重复写入。');
    this.name = 'NotionWriteError';
  }
}

/** Keep only a reviewed error code. Never persist raw provider text: it can
 * contain article content, URLs, credentials, or untrusted instructions. */
function notionErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const codes = ['unauthorized','restricted_resource','object_not_found','validation_error','rate_limited','internal_server_error','service_unavailable','permission_denied','access_denied'];
  if (typeof v.code === 'string' && codes.includes(v.code)) return v.code;
  if (v.error && typeof v.error === 'object') return notionErrorCode(v.error);
  return undefined;
}
function rejectedWrite(result: unknown): NotionWriteError | undefined {
  if (!result || typeof result !== 'object' || (result as {isError?:unknown}).isError !== true) return undefined;
  let value: unknown = (result as {structuredContent?:unknown}).structuredContent;
  if (!value) { try { value = JSON.parse(textContent(result)); } catch { /* not a structured rejection */ } }
  const code = notionErrorCode(value);
  const reason = code === 'unauthorized' ? 'authorization' : ['restricted_resource','object_not_found','permission_denied','access_denied'].includes(code || '') ? 'permission' : code === 'validation_error' ? 'validation' : 'upstream';
  // An unstructured isError or a server failure is not proof that a write did
  // not happen. Only documented, precondition rejections can be retried.
  const definitive = ['unauthorized','restricted_resource','object_not_found','permission_denied','access_denied','validation_error','rate_limited'].includes(code || '');
  return new NotionWriteError('send', definitive ? 'rejected' : 'unknown', reason, code);
}

export type NotionMcpServiceOptions = {
  fetch?: typeof fetch;
  createClient?: (accessToken: string) => Promise<McpClient>;
};

function connectionFor(db: Database, workspaceId: string) {
  return db.knowledgeConnections.find(item => item.workspaceId === workspaceId && item.provider === "notion");
}

function connectionSecret(connection: KnowledgeConnection, field: "client_secret" | "access_token" | "refresh_token", encrypted: string) {
  return decryptCredential(encrypted, knowledgeCredentialContext(connection.workspaceId, "notion", field));
}

function protectConnectionSecret(workspaceId: string, field: "client_secret" | "access_token" | "refresh_token", value: string) {
  return encryptCredential(value, knowledgeCredentialContext(workspaceId, "notion", field));
}

function safeOrigin(value: string) {
  const origin = new URL(value).origin;
  if (process.env.NODE_ENV === "production" && !origin.startsWith("https://")) throw new Error("生产环境的 APP_ORIGIN 必须使用 HTTPS");
  return origin;
}

function encodeChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function textContent(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const blocks = (result as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return "";
  return blocks.map(block => {
    if (!block || typeof block !== "object") return "";
    const value = block as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n").slice(0, maxToolTextChars);
}

function safeNotionSourceUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "notion.so" || url.hostname === "www.notion.so") ? url.toString() : undefined;
  } catch { return undefined; }
}

function jsonContent(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function objectString(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of keys) if (typeof object[key] === "string" && object[key]) return object[key] as string;
  return undefined;
}

function searchCandidates(value: unknown) {
  const found: Array<{ id?: string; title?: string; url?: string; excerpt?: string;createdAt?:string;updatedAt?:string }> = [];
  const seen = new Set<unknown>();
  function visit(current: unknown, depth = 0) {
    if (!current || typeof current !== "object" || seen.has(current) || seen.size >= 2_000 || depth > 12) return;
    seen.add(current);
    if (Array.isArray(current)) { current.forEach(item => visit(item, depth + 1)); return; }
    const id = objectString(current, ["id", "page_id", "database_id"]);
    const url = safeNotionSourceUrl(objectString(current, ["url", "href"]));
    const title = objectString(current, ["title", "name"]);
    const excerpt = objectString(current, ["highlight", "excerpt", "snippet", "text"]);
    if ((id || url) && (title || excerpt)) found.push({ id, url, title, excerpt,createdAt:objectString(current,['created_time','created_at'])?.slice(0,40),updatedAt:objectString(current,['last_edited_time','updated_at'])?.slice(0,40) });
    Object.values(current as Record<string, unknown>).forEach(item => visit(item, depth + 1));
  }
  visit(value);
  const unique = new Map<string, (typeof found)[number]>();
  for (const item of found) unique.set(item.id || item.url || `${item.title}:${item.excerpt}`, item);
  return [...unique.values()];
}

function fetchedChunk(result: unknown, fallback: { id?: string; title?: string; url?: string; excerpt?: string;createdAt?:string;updatedAt?:string }): KnowledgeChunk {
  const text = textContent(result);
  const parsed = jsonContent(text);
  const title = objectString(parsed, ["title", "name"]) || fallback.title || "Notion 页面";
  const sourceUrl = safeNotionSourceUrl(objectString(parsed, ["url", "href"]) || fallback.url);
  const body = objectString(parsed, ["text", "content", "markdown"]) || text || fallback.excerpt || "";
  return { id: fallback.id, provider: "notion", title, sourceUrl, content: body.slice(0, maxChunkChars),createdAt:objectString(parsed,['created_time','created_at'])?.slice(0,40)??fallback.createdAt,updatedAt:objectString(parsed,['last_edited_time','updated_at'])?.slice(0,40)??fallback.updatedAt };
}

export class NotionMcpService {
  private readonly fetcher: typeof fetch;
  private readonly createClient: (accessToken: string) => Promise<McpClient>;
  private readonly authorizationSessions: AuthorizationSessions;
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(private store: Store, options: NotionMcpServiceOptions = {}) {
    this.fetcher = options.fetch || createNotionFetch();
    this.authorizationSessions = new AuthorizationSessions(store);
    this.createClient = options.createClient || (async (accessToken) => {
      const client = new Client({ name: "ONE", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(assertAllowedConnectorUrl(MCP_URL, notionHosts), {
        fetch: this.fetcher,
        requestInit: { redirect: "error", headers: { Authorization: `Bearer ${accessToken}` } }
      });
      try { await withinDeadline(client.connect(transport), "Notion MCP 连接超时"); }
      catch (error) { await closeClient(client); throw error; }
      return client;
    });
  }

  localStatus(db: Database, workspaceId: string) {
    const connection = connectionFor(db, workspaceId);
    if (!connection || connection.status === "revoked") return { state: "not_connected" as const, code: "AUTHORIZATION_REQUIRED", message: "请连接 Notion", evidence: "stored" as const };
    if (connection.status === "pending") return { state: "pending" as const, code: "AUTHORIZATION_PENDING", message: "等待完成 Notion 授权", evidence: "stored" as const };
    if (connection.status === "error") return { state: "error" as const, code: "CONNECTION_ERROR", message: "Notion 连接需要检查", evidence: "stored" as const };
    if (!connection.clientId || !connection.encryptedAccessToken) return { state: "not_connected" as const, code: "CREDENTIAL_UNAVAILABLE", message: "Notion 授权资料不完整，请重新连接", evidence: "stored" as const };
    return { state: "configured" as const, code: "CREDENTIAL_STORED", message: "已保存 Notion 授权", evidence: "stored" as const };
  }

  async beginAuthorization(params: { workspaceId: string; userId: string; appOrigin: string; enableWriting?: boolean }) {
    const redirectUri = `${safeOrigin(params.appOrigin)}/api/knowledge/connections/notion/oauth/callback`;
    const db = await this.store.read();
    const client = await this.oauthClient(db, redirectUri);
    const previous = connectionFor(db, params.workspaceId);
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    await this.authorizationSessions.create({
      workspaceId: params.workspaceId, userId: params.userId, connectorId: "notion", protocol: "oauth_pkce", state,
      payload: { ...client, enableWriting: params.enableWriting === true, connectionId: previous?.id, previousStatus: previous?.status === "pending" ? undefined : previous?.status, redirectUri, verifier },
      expiresAt: Date.now() + flowLifetimeMs
    });
    await this.store.mutate(mutable => {
      const timestamp = new Date().toISOString();
      let connection = connectionFor(mutable, params.workspaceId);
      if (!connection) {
        connection = { id: uid("knc"), workspaceId: params.workspaceId, provider: "notion", status: "pending", clientId: client.clientId, createdAt: timestamp, updatedAt: timestamp };
        mutable.knowledgeConnections.push(connection);
      }
      if (connection.status !== "connected") connection.status = "pending";
      connection.clientId = client.clientId;
      connection.encryptedClientSecret = client.clientSecret ? protectConnectionSecret(params.workspaceId, "client_secret", client.clientSecret) : undefined;
      connection.oauthTokenAuthMethod = client.tokenAuthMethod;
      connection.lastError = undefined;
      connection.updatedAt = timestamp;
    });
    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      response_type: "code", client_id: client.clientId, redirect_uri: redirectUri,
      code_challenge: encodeChallenge(verifier), code_challenge_method: "S256",
      state, resource: MCP_URL, scope: "default"
    }).toString();
    return { authorizationUrl: url.toString(), expiresIn: flowLifetimeMs / 1000 };
  }

  async completeAuthorization(state: string, code: string) {
    const claimed = await this.authorizationSessions.claimState("notion", state);
    let flow: OAuthFlow;
    try { flow = this.oauthFlow(claimed.session, claimed.payload); }
    catch (error) { await this.authorizationSessions.finish(claimed.session.id); throw error; }
    let token: TokenResponse;
    try {
      token = await this.exchangeToken(flow, code);
      await this.authorizationSessions.markVerifying(claimed.session.id);
      await this.verifyAccessToken(token.access_token);
      if (flow.enableWriting) {
        const client = await withinDeadline(this.createClient(token.access_token), 'Notion 写入连接超时');
        try {
          const listed = await withinDeadline(client.listTools(), 'Notion 工具查询超时');
          if (!['notion-create-pages', 'notion-update-page'].every(name => listed.tools.some(tool => tool.name === name))) throw new Error('当前 Notion 连接不支持写入，原只读连接保留');
        } finally { await closeClient(client); }
      }
    } catch (error) {
      await this.authorizationSessions.finish(claimed.session.id);
      await this.restoreFlow(flow);
      throw error;
    }
    const timestamp = new Date().toISOString();
    const connection = await this.store.mutate(db => {
      let target = connectionFor(db, flow.workspaceId);
      if (!target) {
        target = { id: uid("knc"), workspaceId: flow.workspaceId, provider: "notion", status: "connected", clientId: flow.clientId, createdAt: timestamp, updatedAt: timestamp };
        db.knowledgeConnections.push(target);
      }
      target.status = "connected";
      // New credentials never inherit a writing grant from another account.
      target.notionWriting = flow.enableWriting ? { grantId: uid('nwgrant'), userId: flow.userId, authorizedAt: timestamp } : undefined;
      target.clientId = token.client_id || flow.clientId;
      target.encryptedClientSecret = flow.clientSecret ? protectConnectionSecret(flow.workspaceId, "client_secret", flow.clientSecret) : undefined;
      target.oauthTokenAuthMethod = flow.tokenAuthMethod;
      target.encryptedAccessToken = protectConnectionSecret(flow.workspaceId, "access_token", token.access_token);
      target.encryptedRefreshToken = token.refresh_token ? protectConnectionSecret(flow.workspaceId, "refresh_token", token.refresh_token) : undefined;
      target.credentialExpiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined;
      target.providerSpaceId = token.workspace_id;
      target.providerSpaceName = token.workspace_name;
      target.providerUserId = token.user_id;
      target.lastCheckedAt = timestamp;
      target.lastError = undefined;
      target.updatedAt = timestamp;
      db.auditLogs.push({ id: uid("aud"), workspaceId: flow.workspaceId, actorUserId: flow.userId, action: "knowledge.notion.connected", targetType: "knowledge_connection", targetId: target.id, createdAt: timestamp });
      return target;
    });
    await this.authorizationSessions.finish(claimed.session.id);
    return connection;
  }

  async cancelAuthorization(state: string) {
    const cancelled = await this.authorizationSessions.cancelState("notion", state);
    if (cancelled) await this.restoreFlow(this.oauthFlow(cancelled.session, cancelled.payload));
  }

  async disconnect(workspaceId: string, userId: string) {
    const current = connectionFor(await this.store.read(), workspaceId);
    if (current?.encryptedAccessToken) {
      const body = new URLSearchParams({ token: connectionSecret(current, "access_token", current.encryptedAccessToken), client_id: current.clientId });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      if (current.encryptedClientSecret && current.oauthTokenAuthMethod === "client_secret_post") body.append("client_secret", connectionSecret(current, "client_secret", current.encryptedClientSecret));
      await this.fetcher(assertAllowedConnectorUrl(TOKEN_URL, notionHosts), { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
    }
    await this.store.mutate(db => {
      const connection = connectionFor(db, workspaceId);
      if (!connection) return;
      connection.status = "revoked";
      connection.notionWriting = undefined;
      connection.encryptedAccessToken = undefined;
      connection.encryptedRefreshToken = undefined;
      connection.providerSpaceId = undefined;
      connection.providerSpaceName = undefined;
      connection.providerUserId = undefined;
      connection.updatedAt = new Date().toISOString();
      db.auditLogs.push({ id: uid("aud"), workspaceId, actorUserId: userId, action: "knowledge.notion.disconnected", targetType: "knowledge_connection", targetId: connection.id, createdAt: connection.updatedAt });
    });
  }

  async verify(workspaceId: string) {
    await this.withRefresh(workspaceId, connection => this.callReadOnly(connection, "notion-fetch", { id: "self" }));
  }

  async search(workspaceId: string, query: string, topK: number): Promise<KnowledgeChunk[]> {
    return this.withRefresh(workspaceId, connection => this.searchConnected(connection, query, topK));
  }

  private async searchConnected(connection: KnowledgeConnection, query: string, topK: number): Promise<KnowledgeChunk[]> {
    const client = await this.clientFor(connection);
    try {
      const listed = await withinDeadline(client.listTools(), "Notion MCP 工具查询超时");
      const available = new Set(listed.tools.map(tool => tool.name).filter(name => readOnlyTools.has(name)));
      const searchTool = available.has("notion-search") ? "notion-search" : "";
      if (!searchTool) throw new Error("Notion MCP 当前没有可用的只读搜索工具");
      // Non-relevance ordering forces workspace search, never Notion AI search.
      const searchResult = await withinDeadline(client.callTool({ name: searchTool, arguments: { query, sort: 'last_edited' } }), "Notion MCP 搜索超时");
      this.assertToolResult(searchResult);
      const searchText = textContent(searchResult);
      const candidates = searchCandidates(jsonContent(searchText)).slice(0, topK);
      if (!candidates.length) return searchText ? [{ provider: "notion", title: "Notion 搜索结果", content: searchText.slice(0, maxChunkChars) }] : [];
      const chunks: KnowledgeChunk[] = [];
      for (const candidate of candidates) {
        if (available.has("notion-fetch") && (candidate.id || candidate.url)) {
          try {
            const result = await withinDeadline(client.callTool({ name: "notion-fetch", arguments: { id: candidate.id || candidate.url! } }), "Notion MCP 读取超时");
            this.assertToolResult(result);
            chunks.push(fetchedChunk(result, candidate));
            continue;
          } catch (error) {
            if (this.isAuthorizationError(error)) throw error;
            // A search excerpt is still useful when one page cannot be fetched.
          }
        }
        chunks.push({ id: candidate.id, provider: "notion", title: candidate.title || "Notion 页面", sourceUrl: candidate.url, content: (candidate.excerpt || candidate.title || "").slice(0, maxChunkChars),createdAt:candidate.createdAt,updatedAt:candidate.updatedAt });
      }
      return chunks.filter(chunk => chunk.content);
    } finally {
      await closeClient(client);
    }
  }

  private async callReadOnly(connection: KnowledgeConnection, name: string, args: Record<string, unknown>) {
    if (!readOnlyTools.has(name)) throw new Error("Notion 工具未获准使用");
    for (let attempt=0;;attempt++) {
      const client = await this.clientFor(connection);
      try {
        const listed = await withinDeadline(client.listTools(), "Notion MCP 工具查询超时");
        if (!listed.tools.some(tool => tool.name === name)) throw new Error("Notion MCP 缺少所需的只读工具");
        const result = await withinDeadline(client.callTool({ name, arguments: args }), "Notion MCP 读取超时");
        this.assertToolResult(result);
        return result;
      } catch (error) {
        if(attempt>=1 || this.isAuthorizationError(error) || !(transientConnectionFailure(error) || error instanceof Error && /^Notion MCP (?:工具查询|读取)超时$/.test(error.message)))throw error;
      } finally { await closeClient(client); }
    }
  }

  async readDocument(workspaceId: string, id: string) {
    return this.withRefresh(workspaceId, connection => this.callReadOnly(connection, 'notion-fetch', { id }));
  }

  /** Internal reviewed writer only. Never exposed as an arbitrary browser tool proxy.
   * Refresh before sending; an uncertain mutation is NEVER replayed after 401/timeout. */
  async callDocumentTool(workspaceId: string, connectionId: string, grantId: string, userId: string, name: string, args: Record<string, unknown>, beforeSend?: () => Promise<void>) {
    if (!['notion-create-pages', 'notion-update-page', 'notion-get-async-task'].includes(name)) throw new Error('Notion 写入工具未授权');
    let connection: KnowledgeConnection;
    try { connection = await this.connected(workspaceId); }
    catch { throw new NotionWriteError('authorization', 'not_sent', 'authorization'); }
    if (connection.id !== connectionId || connection.status !== 'connected' || connection.notionWriting?.grantId !== grantId || connection.notionWriting.userId !== userId) throw new Error('Notion 写入授权已改变，请重新确认');
    let phase: NotionWritePhase = 'connect';
    let client: McpClient;
    try { client = await this.clientFor(connection); }
    catch (error) { throw new NotionWriteError(phase, 'not_sent', transientConnectionFailure(error) ? 'connection' : this.isAuthorizationError(error) || error instanceof Error && /连接已改变/.test(error.message) ? 'authorization' : 'upstream'); }
    try {
      phase = 'tools';
      let listed: Awaited<ReturnType<McpClient['listTools']>>;
      try { listed = await withinDeadline(client.listTools(), 'Notion 写入工具查询超时'); }
      catch (error) {
        // Discovery is read-only. Reconnect once here, before any mutation has
        // been sent; never repeat callTool after a lost write acknowledgement.
        if (!transientConnectionFailure(error) && !(error instanceof Error && error.message === 'Notion 写入工具查询超时')) throw error;
        await closeClient(client);
        client = await this.clientFor(connection);
        listed = await withinDeadline(client.listTools(), 'Notion 写入工具查询超时');
      }
      if (!listed.tools.some(tool => tool.name === name)) throw new NotionWriteError(phase, 'not_sent', 'unavailable');
      // Connection establishment can wait/retry. Recheck the exact grant before
      // sending any write, rather than trusting the pre-connect snapshot.
      const current = await this.connected(workspaceId);
      if (current.id !== connectionId || current.status !== 'connected' || current.notionWriting?.grantId !== grantId || current.notionWriting.userId !== userId) throw new Error('Notion 写入授权已改变，请重新确认');
      // The durable checkpoint belongs immediately before the actual mutation,
      // not before connecting/listing tools. The caller rechecks the parent too.
      await beforeSend?.();
      phase = 'send';
      const result = await withinDeadline(client.callTool({ name, arguments: args }), 'Notion 写入结果未知，请在 Notion 核对；不会自动重跑');
      const rejected = rejectedWrite(result);
      if (rejected) throw rejected;
      this.assertToolResult(result);
      return result;
    } catch (error) {
      if (error instanceof NotionWriteError) throw error;
      // Keep grant-change wording compatible while withholding provider text.
      if (phase !== 'send' && error instanceof Error && /授权已改变/.test(error.message)) throw error;
      throw new NotionWriteError(phase, phase === 'send' ? 'unknown' : 'not_sent', transientConnectionFailure(error) ? 'connection' : this.isAuthorizationError(error) ? 'authorization' : 'upstream');
    } finally { await closeClient(client); }
  }

  private async verifyAccessToken(accessToken: string) {
    const client = await this.createClient(accessToken);
    try {
      const listed = await withinDeadline(client.listTools(), "Notion MCP 工具查询超时");
      if (!listed.tools.some(tool => tool.name === "notion-fetch")) throw new Error("Notion MCP 缺少所需的只读工具");
      const result = await withinDeadline(client.callTool({ name: "notion-fetch", arguments: { id: "self" } }), "Notion MCP 读取超时");
      this.assertToolResult(result);
    } finally {
      await closeClient(client);
    }
  }

  private assertToolResult(result: unknown) {
    if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) throw new Error("Notion MCP 读取失败");
  }

  private async withRefresh<T>(workspaceId: string, operation: (connection: KnowledgeConnection) => Promise<T>) {
    let connection = await this.connected(workspaceId);
    try { return await operation(connection); }
    catch (error) {
      if (!connection.encryptedRefreshToken || !this.isAuthorizationError(error)) throw error;
      await this.refreshAccessToken(connection);
      connection = await this.connected(workspaceId);
      return operation(connection);
    }
  }

  private isAuthorizationError(error: unknown) {
    const value = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /unauthori[sz]ed|invalid[_ -]?token|expired[_ -]?token|\b401\b/i.test(value);
  }

  private async connected(workspaceId: string) {
    let db = await this.store.read();
    let connection = connectionFor(db, workspaceId);
    if (!connection || connection.status === "revoked" || !connection.encryptedAccessToken) throw new Error("请先连接 Notion");
    if (connection.credentialExpiresAt && Date.parse(connection.credentialExpiresAt) <= Date.now() + 60_000) {
      await this.refreshAccessToken(connection);
      db = await this.store.read();
      connection = connectionFor(db, workspaceId);
    }
    if (!connection?.encryptedAccessToken) throw new Error("Notion 授权资料不完整，请重新连接");
    return connection;
  }

  private async clientFor(connection: KnowledgeConnection) {
    const connectionId = connection.id, encryptedToken = connection.encryptedAccessToken;
    for (let attempt = 0; ; attempt++) {
      const current = connectionFor(await this.store.read(), connection.workspaceId);
      if (!current || current.id !== connectionId || current.status !== 'connected' || current.encryptedAccessToken !== encryptedToken) throw new Error('Notion 连接已改变，请重新检查');
      try {
        return await withinDeadline(this.createClient(connectionSecret(current, "access_token", encryptedToken!)), "Notion MCP 连接超时");
      } catch (error) {
        // Only reconnect before any tool request exists. Never replay a callTool
        // (including a possibly-applied write) after a timeout or disconnect.
        if (attempt >= 1 || this.isAuthorizationError(error) || !transientConnectionFailure(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }

  private async refreshAccessToken(connection: KnowledgeConnection) {
    const existing = this.refreshes.get(connection.workspaceId);
    if (existing) return existing;
    const refresh = (async () => {
      if (!connection.encryptedRefreshToken) throw new Error("Notion 授权已过期，请重新连接");
      const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: connectionSecret(connection, "refresh_token", connection.encryptedRefreshToken), client_id: connection.clientId });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
      if (connection.encryptedClientSecret && connection.oauthTokenAuthMethod === "client_secret_post") params.append("client_secret", connectionSecret(connection, "client_secret", connection.encryptedClientSecret));
      const response = await this.fetcher(assertAllowedConnectorUrl(TOKEN_URL, notionHosts), { method: "POST", headers, body: params, redirect: "error" });
      if (!response.ok) throw new Error("Notion 授权已过期，请重新连接");
      const token = validatedToken(await readBoundedJson<unknown>(response, 256 * 1024));
      await this.store.mutate(db => {
        const target = connectionFor(db, connection.workspaceId);
        if (!target || target.id !== connection.id || target.status === "revoked") throw new Error("Notion 连接已被撤销");
        target.encryptedAccessToken = protectConnectionSecret(target.workspaceId, "access_token", token.access_token);
        if (token.refresh_token) target.encryptedRefreshToken = protectConnectionSecret(target.workspaceId, "refresh_token", token.refresh_token);
        target.credentialExpiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined;
        target.status = "connected";
        target.lastError = undefined;
        target.updatedAt = new Date().toISOString();
      });
      return token.access_token;
    })().finally(() => this.refreshes.delete(connection.workspaceId));
    this.refreshes.set(connection.workspaceId, refresh);
    return refresh;
  }

  private async oauthClient(db: Database, redirectUri: string): Promise<OAuthClient> {
    const configuredId = process.env.NOTION_MCP_CLIENT_ID?.trim();
    if (configuredId) {
      const clientSecret = process.env.NOTION_MCP_CLIENT_SECRET?.trim() || undefined;
      return { clientId: configuredId, clientSecret, tokenAuthMethod: clientSecret ? "client_secret_post" : "none" };
    }
    // Connections created before the auth-method fix are intentionally ignored:
    // their clients were registered as client_secret_basic and cannot complete
    // Notion's documented public-client exchange.
    const stored = db.knowledgeConnections.find(item => item.provider === "notion" && item.clientId && item.oauthTokenAuthMethod);
    if (stored) return { clientId: stored.clientId, clientSecret: stored.encryptedClientSecret ? connectionSecret(stored, "client_secret", stored.encryptedClientSecret) : undefined, tokenAuthMethod: stored.oauthTokenAuthMethod! };
    const response = await this.fetcher(assertAllowedConnectorUrl(REGISTRATION_URL, notionHosts), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ONE", client_uri: safeOrigin(redirectUri), redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" })
    });
    if (!response.ok) throw new Error("暂时无法初始化 Notion 授权，请稍后重试");
    const registered = await readBoundedJson<{ client_id?: unknown }>(response, 256 * 1024);
    return { clientId: requiredResponseString(registered.client_id, "OAuth Client ID", 2_000), tokenAuthMethod: "none" };
  }

  private async exchangeToken(flow: OAuthFlow, code: string) {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: flow.verifier });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "ONE-MCP-Client/0.1" };
    if (flow.clientSecret && flow.tokenAuthMethod === "client_secret_post") body.append("client_secret", flow.clientSecret);
    const response = await this.fetcher(assertAllowedConnectorUrl(TOKEN_URL, notionHosts), { method: "POST", headers, body, redirect: "error" });
    if (!response.ok) throw new Error("Notion 授权确认失败，请返回 ONE 重试");
    return validatedToken(await readBoundedJson<unknown>(response, 256 * 1024));
  }

  private oauthFlow(session: ConnectorAuthorizationSession, payload: Record<string, unknown>): OAuthFlow {
    const required = (key: string) => {
      const value = payload[key];
      if (typeof value !== "string" || !value) throw new Error("Notion 授权资料格式无效");
      return value;
    };
    const method = payload.tokenAuthMethod;
    if (method !== "none" && method !== "client_secret_post") throw new Error("Notion 授权客户端认证方式无效");
    const previousStatus = payload.previousStatus;
    if (previousStatus !== undefined && !["pending", "connected", "error", "revoked"].includes(String(previousStatus))) throw new Error("Notion 原连接状态无效");
    return {
      workspaceId: session.workspaceId, userId: session.userId, clientId: required("clientId"),
      enableWriting: payload.enableWriting === true,
      clientSecret: typeof payload.clientSecret === "string" ? payload.clientSecret : undefined,
      tokenAuthMethod: method,
      connectionId: typeof payload.connectionId === "string" ? payload.connectionId : undefined,
      previousStatus: previousStatus as KnowledgeConnection["status"] | undefined,
      redirectUri: required("redirectUri"), verifier: required("verifier")
    };
  }

  private async restoreFlow(flow: OAuthFlow) {
    await this.store.mutate(db => {
      const connection = connectionFor(db, flow.workspaceId);
      if (!connection) return;
      if (flow.connectionId && connection.id === flow.connectionId) connection.status = flow.previousStatus || "revoked";
      else if (!flow.connectionId && connection.status === "pending") connection.status = "revoked";
      connection.updatedAt = new Date().toISOString();
    });
  }
}
