import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { decryptCredential, encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import { NotionMcpService } from "./notionMcpService.js";

function fixture() {
  const database = { knowledgeConnections: [], auditLogs: [] } as unknown as Database;
  const store = {
    async read() { return database; },
    async mutate<T>(fn: (db: Database) => T) { return fn(database); }
  } as Store;
  return { database, store };
}

test("Notion OAuth uses PKCE, stores only encrypted tokens and rejects state replay", async () => {
  const f = fixture();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/register")) return new Response(JSON.stringify({ client_id: "notion-client" }));
    if (String(input).endsWith("/token")) return new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, workspace_id: "notion-space", workspace_name: "My Notion", user_id: "notion-user" }));
    throw new Error("unexpected request");
  };
  const createClient = async (token: string) => ({
    async listTools() { return { tools: [{ name: "notion-fetch" }] }; },
    async callTool() { assert.equal(token, "access-secret"); return { content: [{ type: "text", text: "verified" }] }; },
    async close() {}
  });
  const service = new NotionMcpService(f.store, { fetch: fetcher as typeof fetch, createClient });
  const started = await service.beginAuthorization({ workspaceId: "workspace-a", userId: "user-a", appOrigin: "https://one.example" });
  const authorization = new URL(started.authorizationUrl);
  const state = authorization.searchParams.get("state")!;
  assert.equal(authorization.origin, "https://mcp.notion.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://one.example/api/knowledge/connections/notion/oauth/callback");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("code_challenge"));
  const registrationBody = JSON.parse(String(requests[0].init?.body));
  assert.equal(registrationBody.token_endpoint_auth_method, "none");

  // A different service instance can finish the callback after a restart.
  const restarted = new NotionMcpService(f.store, { fetch: fetcher as typeof fetch, createClient });
  const connection = await restarted.completeAuthorization(state, "one-time-code");
  assert.equal(connection.workspaceId, "workspace-a");
  assert.equal(connection.providerSpaceName, "My Notion");
  assert.equal(decryptCredential(connection.encryptedAccessToken!, knowledgeCredentialContext("workspace-a", "notion", "access_token")), "access-secret");
  assert.equal(decryptCredential(connection.encryptedRefreshToken!, knowledgeCredentialContext("workspace-a", "notion", "refresh_token")), "refresh-secret");
  assert.doesNotMatch(JSON.stringify(connection), /access-secret|refresh-secret|client-secret/);
  const tokenBody = String(requests[1].init?.body);
  assert.match(tokenBody, /code_verifier=/);
  assert.doesNotMatch(tokenBody, /resource=/);
  assert.equal(new Headers(requests[1].init?.headers).get("Authorization"), null);
  await assert.rejects(service.completeAuthorization(state, "replayed-code"), /无效|使用/);
});

test("cancelling a reconnect keeps the existing working Notion connection", async () => {
  const f = fixture();
  f.database.knowledgeConnections.push({
    id: "notion-a", workspaceId: "workspace-a", provider: "notion", status: "connected", clientId: "client-a",
    encryptedAccessToken: encryptCredential("still-valid"), oauthTokenAuthMethod: "none", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const service = new NotionMcpService(f.store);
  const started = await service.beginAuthorization({ workspaceId: "workspace-a", userId: "user-a", appOrigin: "https://one.example" });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  assert.equal(f.database.knowledgeConnections[0].status, "connected");
  await service.cancelAuthorization(state);
  assert.equal(f.database.knowledgeConnections[0].status, "connected");
  assert.equal(decryptCredential(f.database.knowledgeConnections[0].encryptedAccessToken!), "still-valid");
});

test("Notion search calls only the reviewed read-only tools and parses fetched pages", async () => {
  const f = fixture();
  f.database.knowledgeConnections.push({
    id: "notion-a", workspaceId: "workspace-a", provider: "notion", status: "connected", clientId: "client-a",
    encryptedAccessToken: encryptCredential("workspace-a-token"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const calls: string[] = [];
  const service = new NotionMcpService(f.store, {
    createClient: async token => {
      assert.equal(token, "workspace-a-token");
      return {
        async listTools() { return { tools: [{ name: "notion-search" }, { name: "notion-fetch" }, { name: "notion-create-pages" }, { name: "notion-update-page" }] }; },
        async callTool(params) {
          calls.push(params.name);
          if (params.name === "notion-search") return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "page-a", title: "Project A", url: "https://www.notion.so/page-a", highlight: "search excerpt" }] }) }] };
          if (params.name === "notion-fetch") return { content: [{ type: "text", text: JSON.stringify({ title: "Project A", url: "https://www.notion.so/page-a", text: "trusted as reference only" }) }] };
          throw new Error("write tool must never be called");
        },
        async close() {}
      };
    }
  });
  const chunks = await service.search("workspace-a", "project", 5);
  assert.deepEqual(calls, ["notion-search", "notion-fetch"]);
  assert.equal(chunks[0].provider, "notion");
  assert.equal(chunks[0].content, "trusted as reference only");
  assert.equal(chunks[0].sourceUrl, "https://www.notion.so/page-a");
  await assert.rejects(service.search("workspace-b", "project", 5), /连接 Notion/);
});

test("Notion refresh stays scoped to the exact workspace connection", async () => {
  const f = fixture();
  const expired = new Date(Date.now() - 60_000).toISOString();
  for (const workspaceId of ["workspace-a", "workspace-b"]) f.database.knowledgeConnections.push({
    id: `notion-${workspaceId}`, workspaceId, provider: "notion", status: "connected", clientId: `client-${workspaceId}`,
    encryptedAccessToken: encryptCredential(`old-${workspaceId}`), encryptedRefreshToken: encryptCredential(`refresh-${workspaceId}`),
    credentialExpiresAt: expired, createdAt: expired, updatedAt: expired
  });
  const usedTokens: string[] = [];
  const service = new NotionMcpService(f.store, {
    fetch: (async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("refresh_token"), "refresh-workspace-a");
      return new Response(JSON.stringify({ access_token: "new-workspace-a", refresh_token: "rotated-a", expires_in: 3600 }));
    }) as typeof fetch,
    createClient: async token => ({
      async listTools() { usedTokens.push(token); return { tools: [{ name: "notion-fetch" }] }; },
      async callTool() { return { content: [{ type: "text", text: "self" }] }; },
      async close() {}
    })
  });
  await service.verify("workspace-a");
  assert.deepEqual(usedTokens, ["new-workspace-a"]);
  assert.equal(decryptCredential(f.database.knowledgeConnections[0].encryptedAccessToken!, knowledgeCredentialContext("workspace-a", "notion", "access_token")), "new-workspace-a");
  assert.equal(decryptCredential(f.database.knowledgeConnections[1].encryptedAccessToken!), "old-workspace-b");
});
