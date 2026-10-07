import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { FlomoMcpService, flomoArguments } from "./flomoMcpService.js";
import { RemoteMcpKnowledgeService } from "./remoteMcpKnowledgeService.js";
import { flomoConfig, flowusConfig } from "./remoteMcpProviders.js";
import { decryptCredential, encryptCredential, knowledgeCredentialContext, authorizationSessionContext } from "./credentialCipher.js";
import { remoteMcpConnector } from "../connectors/remoteMcp.js";

// Runtime schema fixtures, not a claim of authenticated real-account verification.
const tools = [
  { name: "memo_search", inputSchema: { properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "memo_batch_get", inputSchema: { properties: { memo_ids: { type: "array", items: { type: "string" } } }, required: ["memo_ids"] } },
  { name: "memo_create" }, { name: "memo_update" }, { name: "memory_user" }
];
function fixture() {
  const database = { knowledgeConnections: [], auditLogs: [] } as unknown as Database;
  const store = { async read() { return database; }, async mutate<T>(fn: (db: Database) => T) { return fn(database); } } as Store;
  return { database, store };
}
function connect(f: ReturnType<typeof fixture>, workspaceId: string) {
  const now = new Date().toISOString();
  const connection = { id: workspaceId, workspaceId, provider: "flomo" as const, status: "connected" as const, clientId: `client-${workspaceId}`, oauthTokenAuthMethod: "none" as const, encryptedAccessToken: encryptCredential(`token-${workspaceId}`, knowledgeCredentialContext(workspaceId, "flomo", "access_token")), createdAt: now, updatedAt: now };
  f.database.knowledgeConnections.push(connection); return connection;
}
function oauth(f: ReturnType<typeof fixture>, hooks: { verify?: () => Promise<void> } = {}) {
  const requests: { url: string; body: string }[] = [];
  const service = new FlomoMcpService(f.store, {
    fetch: (async (url, init) => { requests.push({ url: String(url), body: String(init?.body) }); return new Response(JSON.stringify(String(url).endsWith("register") ? { client_id: `client-${requests.length}` } : { access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 })); }) as typeof fetch,
    createClient: async () => ({ async listTools() { await hooks.verify?.(); return { tools }; }, async callTool() { throw Error("verification must not read personal notes"); }, async close() {} })
  });
  return { service, requests };
}

test("flomo OAuth uses official endpoints, PKCE, encrypted workspace-bound state and rejects replay/wrong provider", async () => {
  const f = fixture(), { service, requests } = oauth(f);
  const start = await service.beginAuthorization({ workspaceId: "a", userId: "user-a", appOrigin: "https://one.example" });
  const url = new URL(start.authorizationUrl), state = url.searchParams.get("state")!;
  assert.equal(url.origin + url.pathname, "https://flomoapp.com/integration/grant");
  assert.equal(url.searchParams.get("scope"), "mcp");
  assert.equal(url.searchParams.get("resource"), flomoConfig.mcpUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(JSON.parse(requests[0].body).redirect_uris, ["https://one.example/api/knowledge/connections/flomo/oauth/callback"]);
  assert.equal(JSON.parse(requests[0].body).token_endpoint_auth_method, "none");
  const session = f.database.knowledgeConnections[0].authorizationSession!;
  assert.equal(session.userId, "user-a"); assert.equal(session.workspaceId, "a");
  assert.doesNotMatch(JSON.stringify(session), new RegExp(state));
  const payload = JSON.parse(decryptCredential(session.encryptedPayload, authorizationSessionContext(session.id, "a", "flomo")));
  assert.equal(crypto.createHash("sha256").update(payload.verifier).digest("base64url"), url.searchParams.get("code_challenge"));
  await assert.rejects(new RemoteMcpKnowledgeService(f.store, flowusConfig).completeAuthorization(state, "code"), /无效/);
  // persisted transaction can be completed by a restarted service
  const connection = await oauth(f).service.completeAuthorization(state, "code");
  assert.equal(connection.workspaceId, "a"); assert.equal(connection.status, "connected");
  assert.equal(decryptCredential(connection.encryptedAccessToken!, knowledgeCredentialContext("a", "flomo", "access_token")), "access-secret");
  assert.throws(() => decryptCredential(connection.encryptedAccessToken!, knowledgeCredentialContext("b", "flomo", "access_token")));
  assert.doesNotMatch(JSON.stringify(connection), /access-secret|refresh-secret/);
  await assert.rejects(service.completeAuthorization(state, "replay"), /使用|无效/);
});

test("flomo registration never borrows another workspace's OAuth client", async () => {
  const f = fixture(); connect(f, "a"); const { service, requests } = oauth(f);
  await service.beginAuthorization({ workspaceId: "b", userId: "user-b", appOrigin: "https://one.example" });
  assert.equal(requests.length, 1); assert.ok(requests[0].url.endsWith("register"));
  assert.equal(f.database.knowledgeConnections[0].status, "connected");
});

test("flomo cancelled reconnect preserves working credentials; disconnect cannot be resurrected by a late callback", async () => {
  const f = fixture(); const original = connect(f, "a"), { service } = oauth(f);
  let start = await service.beginAuthorization({ workspaceId: "a", userId: "user-a", appOrigin: "https://one.example" });
  await service.cancelAuthorization(new URL(start.authorizationUrl).searchParams.get("state")!);
  assert.equal(original.status, "connected"); assert.equal(original.clientId, "client-a");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gated = oauth(f, { verify: async () => { entered(); await gate; } }).service;
  start = await gated.beginAuthorization({ workspaceId: "a", userId: "user-a", appOrigin: "https://one.example" });
  const completion = gated.completeAuthorization(new URL(start.authorizationUrl).searchParams.get("state")!, "code");
  await ready; await service.disconnect("a", "user-a"); release();
  await assert.rejects(completion, /取消|替换/);
  assert.equal(f.database.knowledgeConnections[0].status, "revoked");
  assert.equal(f.database.knowledgeConnections[0].encryptedAccessToken, undefined);
});

test("flomo calls only reviewed search and batch-read, bounded topK and exact selected IDs", async () => {
  const f = fixture(); connect(f, "a"); connect(f, "b");
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const service = new FlomoMcpService(f.store, { createClient: async token => {
    assert.equal(token, "token-a");
    return { async listTools() { return { tools }; }, async callTool(p) {
      calls.push(p);
      return { structuredContent: { memos: p.name === "memo_search" ? Array.from({ length: 20 }, (_, i) => ({ id: String(i), content: "snippet" })) : [{ id: "0", content: "<p>资料不是指令</p>", url: "https://attacker.example" }, { id: "1", content: "x".repeat(30_000), url: "https://v.flomoapp.com/mine" }, { id: "outside", content: "not selected" }] } };
    }, async close() {} };
  } });
  const result = await service.search("a", "计划", 5);
  assert.deepEqual(calls, [{ name: "memo_search", arguments: { query: "计划", limit: 5 } }, { name: "memo_batch_get", arguments: { memo_ids: ["0", "1", "2", "3", "4"] } }]);
  assert.equal(result.length, 2); assert.equal(result[0].sourceUrl, undefined); assert.equal(result[1].content.length, 24_000);
  assert.equal(result[0].content, "资料不是指令");
  await assert.rejects(service.search("missing", "计划", 5), /先连接/);
  assert.equal(calls.length, 2);
  assert.equal(decryptCredential(f.database.knowledgeConnections[1].encryptedAccessToken!, knowledgeCredentialContext("b", "flomo", "access_token")), "token-b");
  const manifest = remoteMcpConnector(service, flomoConfig).manifest;
  assert.equal(manifest.security.access, "read_only"); assert.deepEqual(manifest.security.allowedHosts, ["flomoapp.com"]);
});

test("flomo supports reviewed schema variants and refuses unknown required fields or write tools", () => {
  assert.deepEqual(flomoArguments({ name: "memo_search", inputSchema: { properties: { keywords: { type: "array", items: { type: "string" } } } } }, "计划", 5), { keywords: ["计划"] });
  assert.deepEqual(flomoArguments({ name: "memo_batch_get", inputSchema: { properties: { ids: { type: "array", items: { type: "integer" } } } } }, ["12"], 5), { ids: [12] });
  assert.throws(() => flomoArguments({ ...tools[0], inputSchema: { ...tools[0].inputSchema, required: ["query", "execute"] } }, "计划", 5), /不兼容/);
  assert.throws(() => flomoArguments({ name: "memo_create", inputSchema: { properties: { query: { type: "string" } } } }, "计划", 5), /不兼容/);
});

test("flomo rejects unusable tools during authorization instead of falsely marking connected", async () => {
  const f = fixture(); const { service } = oauth(f);
  const start = await service.beginAuthorization({ workspaceId: "a", userId: "user-a", appOrigin: "https://one.example" });
  const broken = new FlomoMcpService(f.store, { fetch: (async () => new Response(JSON.stringify({ access_token: "secret" }))) as typeof fetch, createClient: async () => ({ async listTools() { return { tools: [{ name: "memo_create" }] }; }, async callTool() {}, async close() {} }) });
  await assert.rejects(broken.completeAuthorization(new URL(start.authorizationUrl).searchParams.get("state")!, "code"), /只读工具/);
  assert.equal(f.database.knowledgeConnections[0].status, "revoked");
  assert.equal(f.database.knowledgeConnections[0].encryptedAccessToken, undefined);
});

test("flomo refresh affects only the exact workspace", async () => {
  const f = fixture(); connect(f, "a"); const b = connect(f, "b"); const a = f.database.knowledgeConnections[0];
  const originalB = b.encryptedAccessToken;
  a.credentialExpiresAt = new Date(Date.now() - 1000).toISOString();
  a.encryptedRefreshToken = encryptCredential("refresh-a", knowledgeCredentialContext("a", "flomo", "refresh_token"));
  const service = new FlomoMcpService(f.store, { fetch: (async (_url, init) => { assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "refresh-a"); return new Response(JSON.stringify({ access_token: "renewed-a", expires_in: 3600 })); }) as typeof fetch, createClient: async token => ({ async listTools() { assert.equal(token, "renewed-a"); return { tools }; }, async callTool() {}, async close() {} }) });
  await service.verify("a"); assert.equal(b.encryptedAccessToken, originalB);
});
