import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Store } from "../db.js";
import { uid } from "../security.js";
import type { Database, KnowledgeConnection } from "../types.js";
import { decryptCredential, encryptCredential } from "./credentialCipher.js";
import type { KnowledgeChunk } from "./provider.js";

const MCP_URL = "https://mcp.notion.com/mcp";
const AUTHORIZATION_URL = "https://mcp.notion.com/authorize";
const TOKEN_URL = "https://mcp.notion.com/token";
const REGISTRATION_URL = "https://mcp.notion.com/register";
const readOnlyTools = new Set(["notion-fetch", "notion-search", "notion-ai-search"]);
const flowLifetimeMs = 10 * 60 * 1000;
const maxChunkChars = 24_000;

type OAuthClient = { clientId: string; clientSecret?: string };
type OAuthFlow = OAuthClient & {
  workspaceId: string;
  userId: string;
  connectionId?: string;
  previousStatus?: KnowledgeConnection["status"];
  redirectUri: string;
  verifier: string;
  expiresAt: number;
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
type McpClient = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

export type NotionMcpServiceOptions = {
  fetch?: typeof fetch;
  createClient?: (accessToken: string) => Promise<McpClient>;
};

function connectionFor(db: Database, workspaceId: string) {
  return db.knowledgeConnections.find(item => item.workspaceId === workspaceId && item.provider === "notion");
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
  }).filter(Boolean).join("\n");
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
  const found: Array<{ id?: string; title?: string; url?: string; excerpt?: string }> = [];
  const seen = new Set<unknown>();
  function visit(current: unknown) {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) { current.forEach(visit); return; }
    const id = objectString(current, ["id", "page_id", "database_id"]);
    const url = objectString(current, ["url", "href"]);
    const title = objectString(current, ["title", "name"]);
    const excerpt = objectString(current, ["highlight", "excerpt", "snippet", "text"]);
    if ((id || url) && (title || excerpt)) found.push({ id, url, title, excerpt });
    Object.values(current as Record<string, unknown>).forEach(visit);
  }
  visit(value);
  const unique = new Map<string, (typeof found)[number]>();
  for (const item of found) unique.set(item.id || item.url || `${item.title}:${item.excerpt}`, item);
  return [...unique.values()];
}

function fetchedChunk(result: unknown, fallback: { id?: string; title?: string; url?: string; excerpt?: string }): KnowledgeChunk {
  const text = textContent(result);
  const parsed = jsonContent(text);
  const title = objectString(parsed, ["title", "name"]) || fallback.title || "Notion 页面";
  const sourceUrl = objectString(parsed, ["url", "href"]) || fallback.url;
  const body = objectString(parsed, ["text", "content", "markdown"]) || text || fallback.excerpt || "";
  return { id: fallback.id, provider: "notion", title, sourceUrl, content: body.slice(0, maxChunkChars) };
}

export class NotionMcpService {
  private readonly fetcher: typeof fetch;
  private readonly createClient: (accessToken: string) => Promise<McpClient>;
  private readonly flows = new Map<string, OAuthFlow>();
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(private store: Store, options: NotionMcpServiceOptions = {}) {
    this.fetcher = options.fetch || fetch;
    this.createClient = options.createClient || (async (accessToken) => {
      const client = new Client({ name: "ONE", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
      });
      await client.connect(transport);
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

  async beginAuthorization(params: { workspaceId: string; userId: string; appOrigin: string }) {
    await this.pruneFlows();
    const redirectUri = `${safeOrigin(params.appOrigin)}/api/knowledge/connections/notion/oauth/callback`;
    const db = await this.store.read();
    const client = await this.oauthClient(db, redirectUri);
    const previous = connectionFor(db, params.workspaceId);
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    this.flows.set(state, { ...client, workspaceId: params.workspaceId, userId: params.userId, connectionId: previous?.id, previousStatus: previous?.status === "pending" ? undefined : previous?.status, redirectUri, verifier, expiresAt: Date.now() + flowLifetimeMs });
    await this.store.mutate(mutable => {
      const timestamp = new Date().toISOString();
      let connection = connectionFor(mutable, params.workspaceId);
      if (!connection) {
        connection = { id: uid("knc"), workspaceId: params.workspaceId, provider: "notion", status: "pending", clientId: client.clientId, createdAt: timestamp, updatedAt: timestamp };
        mutable.knowledgeConnections.push(connection);
      }
      if (connection.status !== "connected") connection.status = "pending";
      connection.clientId = client.clientId;
      connection.encryptedClientSecret = client.clientSecret ? encryptCredential(client.clientSecret) : undefined;
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
    const flow = this.flows.get(state);
    if (!flow || flow.expiresAt <= Date.now()) { this.flows.delete(state); throw new Error("Notion 授权流程已过期，请返回 ONE 重试"); }
    // State and authorization code are single-use even when the token exchange fails.
    this.flows.delete(state);
    let token: TokenResponse;
    try { token = await this.exchangeToken(flow, code); }
    catch (error) { await this.restoreFlow(flow); throw error; }
    const timestamp = new Date().toISOString();
    const connection = await this.store.mutate(db => {
      let target = connectionFor(db, flow.workspaceId);
      if (!target) {
        target = { id: uid("knc"), workspaceId: flow.workspaceId, provider: "notion", status: "connected", clientId: flow.clientId, createdAt: timestamp, updatedAt: timestamp };
        db.knowledgeConnections.push(target);
      }
      target.status = "connected";
      target.clientId = token.client_id || flow.clientId;
      target.encryptedClientSecret = flow.clientSecret ? encryptCredential(flow.clientSecret) : undefined;
      target.encryptedAccessToken = encryptCredential(token.access_token);
      target.encryptedRefreshToken = token.refresh_token ? encryptCredential(token.refresh_token) : undefined;
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
    return connection;
  }

  async cancelAuthorization(state: string) {
    const flow = this.flows.get(state);
    if (!flow) return;
    this.flows.delete(state);
    await this.restoreFlow(flow);
  }

  async disconnect(workspaceId: string, userId: string) {
    const current = connectionFor(await this.store.read(), workspaceId);
    if (current?.encryptedAccessToken) {
      const body = new URLSearchParams({ token: decryptCredential(current.encryptedAccessToken), client_id: current.clientId });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      if (current.encryptedClientSecret) headers.Authorization = `Basic ${Buffer.from(`${current.clientId}:${decryptCredential(current.encryptedClientSecret)}`).toString("base64")}`;
      await this.fetcher(TOKEN_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
    }
    await this.store.mutate(db => {
      const connection = connectionFor(db, workspaceId);
      if (!connection) return;
      connection.status = "revoked";
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
      const listed = await client.listTools();
      const available = new Set(listed.tools.map(tool => tool.name).filter(name => readOnlyTools.has(name)));
      let aiSearchAvailable = false;
      if (available.has("notion-fetch") && available.has("notion-ai-search")) {
        try {
          const self = await client.callTool({ name: "notion-fetch", arguments: { id: "self" } });
          this.assertToolResult(self);
          const selfText = textContent(self);
          aiSearchAvailable = /["']?ai_search["']?[\s\S]{0,300}["']?status["']?\s*:\s*["']available["']/i.test(selfText);
        } catch (error) {
          if (this.isAuthorizationError(error)) throw error;
          // Keyword search remains the safe baseline.
        }
      }
      const searchTool = aiSearchAvailable ? "notion-ai-search" : available.has("notion-search") ? "notion-search" : "";
      if (!searchTool) throw new Error("Notion MCP 当前没有可用的只读搜索工具");
      const searchResult = await client.callTool({ name: searchTool, arguments: { query } });
      this.assertToolResult(searchResult);
      const searchText = textContent(searchResult);
      const candidates = searchCandidates(jsonContent(searchText)).slice(0, topK);
      if (!candidates.length) return searchText ? [{ provider: "notion", title: "Notion 搜索结果", content: searchText.slice(0, maxChunkChars) }] : [];
      const chunks: KnowledgeChunk[] = [];
      for (const candidate of candidates) {
        if (available.has("notion-fetch") && (candidate.id || candidate.url)) {
          try {
            const result = await client.callTool({ name: "notion-fetch", arguments: { id: candidate.id || candidate.url! } });
            this.assertToolResult(result);
            chunks.push(fetchedChunk(result, candidate));
            continue;
          } catch (error) {
            if (this.isAuthorizationError(error)) throw error;
            // A search excerpt is still useful when one page cannot be fetched.
          }
        }
        chunks.push({ id: candidate.id, provider: "notion", title: candidate.title || "Notion 页面", sourceUrl: candidate.url, content: (candidate.excerpt || candidate.title || "").slice(0, maxChunkChars) });
      }
      return chunks.filter(chunk => chunk.content);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async callReadOnly(connection: KnowledgeConnection, name: string, args: Record<string, unknown>) {
    if (!readOnlyTools.has(name)) throw new Error("Notion 工具未获准使用");
    const client = await this.clientFor(connection);
    try {
      const listed = await client.listTools();
      if (!listed.tools.some(tool => tool.name === name)) throw new Error("Notion MCP 缺少所需的只读工具");
      const result = await client.callTool({ name, arguments: args });
      this.assertToolResult(result);
      return result;
    } finally {
      await client.close().catch(() => undefined);
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
    return this.createClient(decryptCredential(connection.encryptedAccessToken!));
  }

  private async refreshAccessToken(connection: KnowledgeConnection) {
    const existing = this.refreshes.get(connection.workspaceId);
    if (existing) return existing;
    const refresh = (async () => {
      if (!connection.encryptedRefreshToken) throw new Error("Notion 授权已过期，请重新连接");
      const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptCredential(connection.encryptedRefreshToken), client_id: connection.clientId, resource: MCP_URL });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      if (connection.encryptedClientSecret) headers.Authorization = `Basic ${Buffer.from(`${connection.clientId}:${decryptCredential(connection.encryptedClientSecret)}`).toString("base64")}`;
      const response = await this.fetcher(TOKEN_URL, { method: "POST", headers, body: params });
      if (!response.ok) throw new Error("Notion 授权已过期，请重新连接");
      const token = await response.json() as TokenResponse;
      if (!token.access_token) throw new Error("Notion 刷新授权未返回访问令牌");
      await this.store.mutate(db => {
        const target = connectionFor(db, connection.workspaceId);
        if (!target || target.id !== connection.id || target.status === "revoked") throw new Error("Notion 连接已被撤销");
        target.encryptedAccessToken = encryptCredential(token.access_token);
        if (token.refresh_token) target.encryptedRefreshToken = encryptCredential(token.refresh_token);
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
    if (configuredId) return { clientId: configuredId, clientSecret: process.env.NOTION_MCP_CLIENT_SECRET?.trim() || undefined };
    const stored = db.knowledgeConnections.find(item => item.provider === "notion" && item.clientId);
    if (stored) return { clientId: stored.clientId, clientSecret: stored.encryptedClientSecret ? decryptCredential(stored.encryptedClientSecret) : undefined };
    const response = await this.fetcher(REGISTRATION_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ONE", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_basic" })
    });
    if (!response.ok) throw new Error("暂时无法初始化 Notion 授权，请稍后重试");
    const registered = await response.json() as { client_id?: string; client_secret?: string };
    if (!registered.client_id) throw new Error("Notion 未返回 OAuth Client ID");
    return { clientId: registered.client_id, clientSecret: registered.client_secret };
  }

  private async exchangeToken(flow: OAuthFlow, code: string) {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: flow.verifier, resource: MCP_URL });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (flow.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${flow.clientId}:${flow.clientSecret}`).toString("base64")}`;
    const response = await this.fetcher(TOKEN_URL, { method: "POST", headers, body });
    if (!response.ok) throw new Error("Notion 授权确认失败，请返回 ONE 重试");
    const token = await response.json() as TokenResponse;
    if (!token.access_token) throw new Error("Notion 授权成功但未返回访问令牌");
    return token;
  }

  private async pruneFlows() {
    for (const [state, flow] of this.flows) if (flow.expiresAt <= Date.now()) {
      this.flows.delete(state);
      await this.restoreFlow(flow);
    }
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
