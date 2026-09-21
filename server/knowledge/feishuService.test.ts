import test from "node:test";
import assert from "node:assert/strict";
import { FeishuService } from "./feishuService.js";
import type { Database } from "../types.js";
import type { Store } from "../db.js";
function fixture() {
  const db = { users: [{ id: "a", enabled: true }, { id: "b", enabled: true }], workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ workspaceId: "wa", userId: "a", role: "owner" }, { workspaceId: "wb", userId: "b", role: "owner" }], knowledgeConnections: [], auditLogs: [], messages: [{ id: "ma", userId: "a", workspaceId: "wa", role: "assistant", content: "结果正文" }, { id: "mb", userId: "b", workspaceId: "wb", role: "assistant", content: "私密正文" }] } as unknown as Database;
  const store = { read: async () => db, mutate: async (fn: (db: Database) => unknown) => fn(db) } as Store;
  const requests: { path: string; body: any; token: string | null }[] = [];
  let uncertain = false;
  const fetcher = async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body, token: new Headers(init?.headers).get("Authorization") });
    const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
    if (path.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "secret-access", refresh_token: "secret-refresh", expires_in: 7200 }));
    if (path.endsWith("/user_info")) return ok({ open_id: "open_a", name: "测试账号" });
    if (path.endsWith("/search/object")) return ok({ docs_entities: [{ docs_token: "doc_a", docs_type: "docx", title: "项目" }] });
    if (path.endsWith("/raw_content")) return ok({ content: "项目资料" });
    if (path.endsWith("/batch_query")) return ok({ metas: [{ url: "https://test.feishu.cn/docx/doc_a" }] });
    if (path.endsWith("/documents")) return ok({ document: { document_id: "doc_a" } });
    if (path.endsWith("/children")) { if (uncertain) throw new Error("secret upstream payload"); return ok({ children: [] }); }
    throw new Error("unexpected endpoint");
  };
  const service = new FeishuService(store, { fetch: fetcher as typeof fetch, appId: "app", appSecret: "app-secret", origin: "https://one.example", scopes: "offline_access search:docs:read docx:document" });
  const scope = { workspaceId: "wa", userId: "a" };
  const connect = async () => { const start = await service.begin(scope); const url = new URL(start.authorizationUrl); await service.complete(url.searchParams.get("state")!, "code"); return url; };
  return { db, store, requests, service, scope, connect, failWrite: () => { uncertain = true; } };
}
test("Feishu OAuth uses PKCE, encrypted scoped storage, owner authorization and one-use state", async () => {
  const f = fixture(); await assert.rejects(f.service.begin({ workspaceId: "wb", userId: "a" }), /无权/);
  const url = await f.connect(); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.doesNotMatch(JSON.stringify(f.db), /secret-access|secret-refresh|app-secret/);
  await assert.rejects(f.service.complete(url.searchParams.get("state")!, "code"), /无效|使用/);
  const results = await f.service.search("wa", "项目", 3); assert.equal(results[0].content, "项目资料");
  const before = f.requests.length; await assert.rejects(f.service.search("wb", "私密", 3), /授权/); assert.equal(f.requests.length, before);
  assert.equal(f.requests.find(r => r.path.endsWith("search/object"))?.token, "Bearer secret-access");
});
test("Feishu confirmed write uses owned server message and persistent deduplication", async () => {
  const f = fixture(); await f.connect();
  const params = { operationId: "op_a", sourceMessageId: "ma", title: "结果", expectedAccount: "open_a" };
  await assert.rejects(f.service.saveAnswer(f.scope, { ...params, sourceMessageId: "mb" }), /无权/);
  await assert.rejects(f.service.saveAnswer(f.scope, { ...params, expectedAccount: "wrong" }), /改变/);
  const result = await f.service.saveAnswer(f.scope, params); assert.equal(result.status, "completed");
  const count = f.requests.length;
  assert.equal((await f.service.saveAnswer(f.scope, params)).documentId, result.documentId); assert.equal(f.requests.length, count);
  assert.equal(f.requests.find(r => r.path.endsWith("/children"))?.body.children[0].text.elements[0].text_run.content, "结果正文");
  assert.doesNotMatch(JSON.stringify(f.db.auditLogs), /结果正文|私密正文|secret/);
});
test("Feishu ambiguous writes never blindly repeat; disconnect removes access", async () => {
  const f = fixture(); await f.connect(); f.failWrite();
  const params = { operationId: "op_a", sourceMessageId: "ma", title: "结果", expectedAccount: "open_a" };
  assert.equal((await f.service.saveAnswer(f.scope, params)).status, "uncertain");
  const count = f.requests.length; assert.equal((await f.service.saveAnswer(f.scope, { ...params, operationId: "another" })).status, "uncertain"); assert.equal(f.requests.length, count);
  await f.service.disconnect(f.scope); await assert.rejects(f.service.search("wa", "项目", 3), /授权/);
});
test("expired authorization and cancelled callback cannot resurrect a connection", async () => {
  const f = fixture();
  const start = await f.service.begin(f.scope);
  const state = new URL(start.authorizationUrl).searchParams.get("state")!;
  f.db.knowledgeConnections[0].authorizationSession!.expiresAt = "2000-01-01T00:00:00Z";
  await assert.rejects(f.service.complete(state, "code"), /过期/);
  assert.equal(f.requests.length, 0);
  const next = await f.service.begin(f.scope); await f.service.disconnect(f.scope);
  await assert.rejects(f.service.complete(new URL(next.authorizationUrl).searchParams.get("state")!, "code"));
  assert.equal(f.db.knowledgeConnections[0].status, "revoked");
});
test("concurrent retrieval refreshes only once and keeps tokens encrypted", async () => {
  const f = fixture(); await f.connect(); f.db.knowledgeConnections[0].credentialExpiresAt = "2000-01-01T00:00:00Z";
  await Promise.all([f.service.search("wa", "项目", 1), f.service.search("wa", "项目", 1)]);
  assert.equal(f.requests.filter(r => r.body?.grant_type === "refresh_token").length, 1);
  assert.doesNotMatch(JSON.stringify(f.db), /secret-access|secret-refresh/);
});
