import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { ImaError, ImaService, imaSearchQuery } from "./imaService.js";
import { decryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import { imaConnector } from "../connectors/ima.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { KnowledgeService } from "./knowledgeService.js";
import { knowledgePolicy } from "../taskContract.js";

const credentials = { clientId: "client-test-a", apiKey: "ima-api-secret-a" };
function fixture() {
  const now = new Date().toISOString();
  const db = { users: ["a", "b", "member"].map(id => ({ id, enabled: true, defaultWorkspaceId: id === "member" ? "a" : id })), workspaces: ["a", "b"].map(id => ({ id, status: "active" })), workspaceMembers: [{ userId: "a", workspaceId: "a", role: "owner" }, { userId: "b", workspaceId: "b", role: "owner" }, { userId: "member", workspaceId: "a", role: "member" }], knowledgeConnections: [], auditLogs: [] } as unknown as Database;
  const store = { async read() { return db; }, async mutate<T>(fn: (db: Database) => T) { return fn(db); } } as Store;
  const calls: { path: string; body: Record<string, unknown>; client: string; key: string }[] = [];
  const options: { libraries?: number; file?: Buffer; beforeFile?: () => void; override?: (path: string, body: Record<string, unknown>) => unknown | Promise<unknown> } = {};
  const fetcher = (async (url, init) => {
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (init?.method === "GET") {
      assert.equal(new URL(String(url)).origin, "https://pkb.ima.myqcloud.com");
      assert.equal(new URL(String(url)).pathname, "/official-file.txt"); assert.ok(options.file);
      assert.equal(new Headers(init.headers).get("ima-openapi-apikey"), null); assert.equal(new Headers(init.headers).get("ima-openapi-clientid"), null);
      options.beforeFile?.(); return new Response(new Uint8Array(options.file!));
    }
    assert.equal(new URL(String(url)).origin, "https://ima.qq.com");
    assert.equal(init?.method, "POST");
    const path = new URL(String(url)).pathname.split("/").at(-1)!, body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers); calls.push({ path, body, client: headers.get("ima-openapi-clientid")!, key: headers.get("ima-openapi-apikey")! });
    const override = await options.override?.(path, body);
    if (override instanceof Response) return override;
    if (override !== undefined) return Response.json(override);
    let data: unknown;
    if (path === "search_knowledge_base") data = { info_list: Array.from({ length: options.libraries ?? 2 }, (_, i) => ({ id: `kb-${i}`, name: `资料库 ${i}` })), is_end: true };
    else if (path === "get_addable_knowledge_base_list") data = { addable_knowledge_base_list: [], is_end: true };
    else if (path === "list_notebook") data = { note_folder_infos: [] };
    else if (path === "search_note") data = { search_note_infos: [{ note_book_info: { note_id: "own-note", title: "采购计划", summary: "摘要不是正文" } }], is_end: true };
    else if (path === "search_knowledge") data = { info_list: [{ media_id: "file-1", title: "采购资料", highlight_content: "<em>采购</em>资料命中片段" }], is_end: true };
    else if (path === "get_doc_content") data = { content: "采购计划正文" };
    else if (path === "get_media_info") data = { media_type: 1, url_info: { url: "http://127.0.0.1/private", headers: { Authorization: "secret-upstream-header" } } };
    else throw Error("unreviewed endpoint called");
    return Response.json({ code: 0, data });
  }) as typeof fetch;
  return { db, store, calls, options, service: new ImaService(store, fetcher), now };
}
const scope = { workspaceId: "a", userId: "a" };

test("ima verifies official read endpoints before encrypting credentials; state never returns credentials", async () => {
  const f = fixture(), result = await f.service.connect(scope, credentials);
  assert.equal(result.connection.status, "connected"); assert.deepEqual(f.calls.map(c => c.path), ["search_knowledge_base", "list_notebook"]);
  const c = f.db.knowledgeConnections[0];
  assert.equal(c.clientId, "ima-openapi");
  assert.equal(decryptCredential(c.encryptedApiKey!, knowledgeCredentialContext("a", "ima", "api_key")), credentials.apiKey);
  assert.equal(decryptCredential(c.encryptedClientId!, knowledgeCredentialContext("a", "ima", "client_id")), credentials.clientId);
  assert.throws(() => decryptCredential(c.encryptedApiKey!, knowledgeCredentialContext("b", "ima", "api_key")));
  assert.throws(() => decryptCredential(c.encryptedApiKey!, knowledgeCredentialContext("a", "ima", "client_id")));
  assert.doesNotMatch(JSON.stringify(f.db), /ima-api-secret-a|client-test-a/);
  assert.doesNotMatch(JSON.stringify(await f.service.state(scope)), /encrypted|apiKey|clientId|ima-api-secret-a|client-test-a/);
  assert.deepEqual(result.connection.retrievalScope?.selectedIds, ["kb-0", "kb-1"]);
});

test("ima rejects wrong workspace/member/disabled owner before any upstream request", async () => {
  const f = fixture();
  for (const denied of [{ workspaceId: "b", userId: "a" }, { workspaceId: "a", userId: "member" }, { workspaceId: "a", userId: "missing" }]) {
    await assert.rejects(f.service.connect(denied, credentials), (e: unknown) => e instanceof ImaError && e.status === 403);
    await assert.rejects(f.service.state(denied));
    await assert.rejects(f.service.disconnect(denied));
  }
  f.db.users[0].enabled = false;
  await assert.rejects(f.service.connect(scope, credentials));
  assert.equal(f.calls.length, 0); assert.equal(f.db.knowledgeConnections.length, 0);
});

test("ima searches only selected libraries and own notes; denied content does not leak metadata as evidence", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  await f.service.updateScope(scope, ["kb-1"]); f.calls.length = 0;
  let chunks = await f.service.search("a", "采购", 5);
  assert.equal(chunks.length, 2); assert.ok(chunks.some(c => c.content === "采购计划正文")); assert.ok(chunks.some(c => c.content === "采购 资料命中片段"));
  assert.deepEqual(f.calls.filter(c => c.path === "search_knowledge").map(c => c.body.knowledge_base_id), ["kb-1"]);
  assert.equal(f.calls.filter(c => c.path === "get_doc_content").length, 1);
  assert.ok(f.calls.every(c => !/create|import|append|upload|add_/.test(c.path)));
  f.options.override = path => path === "get_doc_content" ? { code: 210005, msg: "private upstream secret" } : undefined;
  chunks = await f.service.search("a", "采购", 5);
  assert.equal(chunks.length, 1); assert.doesNotMatch(JSON.stringify(chunks), /摘要不是正文|secret/);
  await assert.rejects(f.service.search("b", "采购", 5));
});

test("ima does not follow unreviewed returned media URLs or forward upstream headers", async () => {
  const f = fixture(); await f.service.connect(scope, credentials); f.calls.length = 0;
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : path === "search_knowledge" ? { code: 0, data: { info_list: [{ media_id: "private-file", title: "资料标题" }] } } : undefined;
  await assert.rejects(f.service.search("a", "资料", 5), /未取得可读正文/);
  assert.ok(f.calls.some(c => c.path === "get_media_info"));
  assert.ok(f.calls.every(c => c.client === credentials.clientId && c.key === credentials.apiKey));
});

test("ima fails closed on HTTP 200 provider error, oversized responses and malformed lists without exposing msg", async () => {
  for (const response of [{ code: 20004, msg: "Bearer ima-api-secret-a client-test-a" }, { code: 0, data: { info_list: "not-an-array", is_end: true } }, new Response("x", { headers: { "content-length": String(1024 * 1024) } })]) {
    const f = fixture(); f.options.override = () => response;
    await assert.rejects(f.service.connect(scope, credentials), (e: unknown) => e instanceof Error && !/Bearer|ima-api-secret-a|client-test-a/.test(e.message));
    const c = f.db.knowledgeConnections[0]; assert.notEqual(c.status, "connected"); assert.equal(c.encryptedApiKey, undefined);
    assert.doesNotMatch(JSON.stringify(f.db), /ima-api-secret-a|client-test-a/);
  }
});

test("ima preserves a working account when replacement credentials fail and redacts echoed credentials", async () => {
  const f = fixture(); await f.service.connect(scope, credentials); const before = f.db.knowledgeConnections[0].encryptedApiKey;
  f.options.override = () => ({ code: 20004, msg: "replacement invalid" });
  await assert.rejects(f.service.connect(scope, { clientId: "new-client", apiKey: "new-key-secret" }));
  assert.equal(f.db.knowledgeConnections[0].encryptedApiKey, before); assert.equal(f.db.knowledgeConnections[0].status, "connected");
  f.options.override = path => path === "get_doc_content" ? { code: 0, data: { content: `资料 ${credentials.apiKey} ${credentials.clientId}` } } : undefined;
  const result = await f.service.search("a", "资料", 5);
  assert.doesNotMatch(JSON.stringify(result), /ima-api-secret-a|client-test-a/);
  assert.match(JSON.stringify(result), /凭据已隐藏/);
});

test("ima bounds library scope, rejects foreign IDs and cannot read after owner revocation", async () => {
  const f = fixture(); f.options.libraries = 7; await f.service.connect(scope, credentials);
  assert.deepEqual(f.db.knowledgeConnections[0].retrievalScope?.selectedIds, []);
  await assert.rejects(f.service.updateScope(scope, ["foreign-library"]));
  await assert.rejects(f.service.updateScope(scope, ["kb-0", "kb-1", "kb-2", "kb-3", "kb-4", "kb-5"]));
  await assert.rejects(f.service.updateScope(scope, ["kb-0", "kb-0"]));
  await f.service.updateScope(scope, ["kb-2"]); f.calls.length = 0;
  await f.service.search("a", "采购", 1);
  assert.equal(f.calls.filter(c => c.path === "search_knowledge").length, 1);
  f.db.users[0].enabled = false; f.calls.length = 0;
  await assert.rejects(f.service.search("a", "采购", 5)); assert.equal(f.calls.length, 0);
});

test("ima disconnect wins over delayed credential verification and retrieval", async () => {
  const f = fixture(); let enter!: () => void, release!: () => void;
  const started = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
  f.options.override = async path => { if (path === "list_notebook") { enter(); await gate; } return undefined; };
  const connecting = f.service.connect(scope, credentials); await started; await f.service.disconnect(scope); release();
  await assert.rejects(connecting, /取消|替换/);
  assert.equal(f.db.knowledgeConnections[0].status, "revoked"); assert.equal(f.db.knowledgeConnections[0].encryptedApiKey, undefined);
  f.options.override = undefined; await f.service.connect(scope, credentials);
  let readEnter!: () => void, readRelease!: () => void;
  const readStarted = new Promise<void>(r => { readEnter = r; }), readGate = new Promise<void>(r => { readRelease = r; });
  f.options.override = async path => { if (path === "get_doc_content") { readEnter(); await readGate; } return undefined; };
  const reading = f.service.search("a", "采购", 5); await readStarted; await f.service.disconnect(scope); readRelease();
  await assert.rejects(reading); assert.equal(f.db.knowledgeConnections[0].status, "revoked");
});

test("ima registration uses the reviewed connector and knowledge recall shares no other workspace", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  const adapter = imaConnector(f.service), registry = new ConnectorRegistry([adapter]);
  assert.equal(adapter.manifest.auth, "api_key"); assert.equal(adapter.manifest.security.access, "read_only");
  assert.deepEqual(adapter.manifest.security.allowedHosts, ["ima.qq.com", "pkb.ima.myqcloud.com"]);
  const service = new KnowledgeService(f.store, registry);
  assert.ok((await service.recall("a", "采购", 1)).length === 1);
  f.calls.length = 0; assert.equal((await service.recall("b", "采购", 5)).length, 0); assert.equal(f.calls.length, 0);
  const disabled = new KnowledgeService(f.store, new ConnectorRegistry([adapter], ["ima"]));
  assert.equal((await disabled.recall("a", "采购", 5)).length, 0); assert.equal(f.calls.length, 0);
});

test("ima bounds concurrent requests per workspace and releases capacity after completion", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  let release!: () => void, enter!: () => void, waiting = 0;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { enter = r; });
  f.options.override = async path => { if (path === "search_note") { if (++waiting === 4) enter(); await gate; } return undefined; };
  const first = f.service.search("a", "采购", 1), second = f.service.search("a", "采购", 1);
  await started;
  await assert.rejects(f.service.search("a", "采购", 1), (error: unknown) => error instanceof ImaError && error.status === 429);
  release(); await Promise.all([first, second]); f.options.override = undefined;
  assert.equal((await f.service.search("a", "采购", 1)).length, 1);
});

test("ima library refresh reuses encrypted credentials without implicitly adding new sources", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  await f.service.updateScope(scope, ["kb-1"]); f.options.libraries = 4; f.calls.length = 0;
  const result = await f.service.refreshLibraries(scope);
  assert.equal(result.connection.retrievalScope?.knowledgeBases.length, 4);
  assert.deepEqual(result.connection.retrievalScope?.selectedIds, ["kb-1"]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].key, credentials.apiKey);
  await assert.rejects(f.service.refreshLibraries({ workspaceId: "a", userId: "b" }));
  await f.service.disconnect(scope); await assert.rejects(f.service.refreshLibraries(scope));
});

test("ima strips simple search commands without claiming semantic expansion", () => {
  assert.equal(imaSearchQuery("请帮我在 ima 中查找采购的相关笔记？"), "采购");
  assert.equal(imaSearchQuery("search ima for procurement"), "procurement");
  assert.equal(imaSearchQuery("2026 年采购计划"), "2026 年采购计划");
  assert.equal(imaSearchQuery("采购"), "采购");
});

test("ima is an explicit knowledge source without matching image or animal", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  assert.deepEqual(knowledgePolicy(f.db, scope, "在腾讯 ima 中查找采购资料").requested, ["ima"]);
  for (const text of ["查找 image 示例", "查找 animal 资料"]) assert.deepEqual(knowledgePolicy(f.db, scope, text).requested, []);
});

test("ima bounds malformed markup without repeatedly rescanning nested angle brackets", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  f.options.override = path => path === "get_doc_content" ? { code: 0, data: { content: "<".repeat(60_000) + "采购" } } : undefined;
  const chunks = await f.service.search("a", "采购", 5);
  assert.ok(chunks.every(chunk => chunk.content.length <= 24_000));
  assert.ok(chunks.some(chunk => chunk.content.endsWith("采购")));
});

test("ima discovers a personal library omitted by empty-query search through an official read-only list", async () => {
  const f = fixture(); f.options.libraries = 0;
  f.options.override = path => path === "get_addable_knowledge_base_list" ? { code: 0, data: { addable_knowledge_base_list: [{ id: "encoded-personal-library=", name: "个人知识库" }], is_end: true } } : undefined;
  const result = await f.service.connect(scope, credentials);
  assert.deepEqual(result.connection.retrievalScope?.selectedIds, ["encoded-personal-library="]);
  assert.deepEqual(f.calls.map(call => call.path), ["search_knowledge_base", "get_addable_knowledge_base_list", "list_notebook"]);
  assert.deepEqual(f.calls[1].body, { cursor: "", limit: 20 });
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : undefined;
  f.calls.length = 0;
  const chunks = await f.service.search("a", "采购", 5);
  assert.equal(chunks.length, 1);
  assert.equal(f.calls.find(call => call.path === "search_knowledge")?.body.knowledge_base_id, "encoded-personal-library=");
  assert.ok(f.calls.every(call => !/create|import|append|upload/.test(call.path)));
});

test("ima refresh repairs an older empty catalog without widening selection, and named lookup preserves existing sources", async () => {
  const f = fixture(); f.options.libraries = 0; await f.service.connect(scope, credentials);
  f.options.override = path => path === "get_addable_knowledge_base_list" ? { code: 0, data: { addable_knowledge_base_list: [{ id: "personal", name: "个人知识库" }], is_end: true } } : undefined;
  const refreshed = await f.service.refreshLibraries(scope);
  assert.deepEqual(refreshed.connection.retrievalScope?.knowledgeBases, [{ id: "personal", name: "个人知识库" }]);
  assert.deepEqual(refreshed.connection.retrievalScope?.selectedIds, []);
  await f.service.updateScope(scope, ["personal"]);
  f.options.override = (path, body) => path === "search_knowledge_base" ? { code: 0, data: { info_list: body.query === "项目资料" ? [{ id: "project", name: "项目资料" }] : [], is_end: true } } : undefined;
  f.calls.length = 0;
  const named = await f.service.refreshLibraries(scope, "项目资料");
  assert.equal(named.matchedCount, 1);
  assert.deepEqual(named.connection.retrievalScope?.knowledgeBases.map(item => item.id), ["personal", "project"]);
  assert.deepEqual(named.connection.retrievalScope?.selectedIds, ["personal"]);
  assert.deepEqual(f.calls.map(call => call.path), ["search_knowledge_base"]);
  await assert.rejects(f.service.refreshLibraries({ workspaceId: "b", userId: "a" }, "个人知识库"));
  await assert.rejects(f.service.refreshLibraries(scope, " "));
  await assert.rejects(f.service.refreshLibraries(scope, "x".repeat(101)));
  assert.equal(f.calls.length, 1);
});

test("ima notes-only empty search reports missing library coverage, never a whole-library no_match", async () => {
  const f = fixture(); f.options.libraries = 0; await f.service.connect(scope, credentials);
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : undefined;
  const service = new KnowledgeService(f.store, new ConnectorRegistry([imaConnector(f.service)]));
  const result = await service.recallWithDiagnostics("a", "采购", 5, undefined, "a", { retry: true });
  assert.equal(result.status, "failed");
  assert.equal(result.coverage?.[0].status, "failed");
  assert.equal(result.coverage?.[0].attempts, 1);
  assert.match(result.failures[0].message, /未查询库内文件/);
  assert.equal(result.failures[0].authorizationValid, true);
  assert.equal(f.db.knowledgeConnections[0].status, "connected");
  assert.equal(f.calls.filter(call => call.path === "search_knowledge").length, 0);
  assert.equal(f.db.knowledgeConnections[0].encryptedApiKey !== undefined, true);
});

test("ima fallback permission errors do not impersonate a whole-library search, and failed refresh preserves the catalog", async () => {
  const f = fixture(); f.options.libraries = 0;
  f.options.override = path => path === "get_addable_knowledge_base_list" ? { code: 210011, msg: "secret permission detail" } : undefined;
  await f.service.connect(scope, credentials);
  assert.deepEqual(f.db.knowledgeConnections[0].retrievalScope?.knowledgeBases, []);
  f.options.libraries = 1; f.options.override = undefined; await f.service.refreshLibraries(scope);
  await f.service.updateScope(scope, ["kb-0"]);
  const before = structuredClone(f.db.knowledgeConnections[0]);
  f.options.libraries = 0; f.options.override = path => path === "get_addable_knowledge_base_list" ? new Response("private provider failure", { status: 500 }) : undefined;
  await assert.rejects(f.service.refreshLibraries(scope), /暂时无法连接/);
  assert.deepEqual(f.db.knowledgeConnections[0], before);
});

test("ima owner search diagnostics return only authorized excerpts and distinguish an actual empty query result", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  f.db.knowledgeConnections[0].status = "error";
  f.db.knowledgeConnections[0].lastError = "上次检索需要检查";
  const result = await f.service.checkSearch(scope, "采购");
  assert.equal(result.count, 2); assert.match(result.message, /实际返回/);
  assert.equal(result.connection.status, "connected"); assert.equal(result.connection.lastError, undefined);
  assert.doesNotMatch(JSON.stringify(result), /ima-api-secret-a|client-test-a|encrypted|Authorization/);
  f.calls.length = 0;
  for (const denied of [{ workspaceId: "b", userId: "a" }, { workspaceId: "a", userId: "member" }]) await assert.rejects(f.service.checkSearch(denied, "采购"));
  await assert.rejects(f.service.checkSearch(scope, "x".repeat(401)));
  assert.equal(f.calls.length, 0);
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : path === "search_knowledge" ? { code: 0, data: { info_list: [] } } : undefined;
  const empty = await f.service.checkSearch(scope, "不存在的词");
  assert.equal(empty.count, 0); assert.match(empty.message, /本次关键词/);
});

test("ima diagnostic reauthorizes its caller after reading instead of relying on another credential owner", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  f.db.workspaceMembers.push({ userId: "b", workspaceId: "a", role: "owner" } as never);
  f.options.override = path => { if (path === "get_doc_content") f.db.workspaceMembers.find(member => member.workspaceId === "a" && member.userId === "b")!.role = "member"; return undefined; };
  await assert.rejects(f.service.checkSearch({ workspaceId: "a", userId: "b" }, "采购"), /所有者/);
  assert.equal(f.db.workspaceMembers.find(member => member.userId === "a")!.role, "owner");
});

test("ima diagnostic atomically rechecks the credential owner before restoring connection health", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  f.db.workspaceMembers.push({ userId: "b", workspaceId: "a", role: "owner" } as never);
  f.db.knowledgeConnections[0].status = "error";
  const originalMutate = f.store.mutate.bind(f.store);
  f.store.mutate = async fn => {
    f.db.workspaceMembers.find(member => member.workspaceId === "a" && member.userId === "a")!.role = "member";
    return originalMutate(fn);
  };
  await assert.rejects(f.service.checkSearch({ workspaceId: "a", userId: "b" }, "采购"), /所有者/);
  assert.equal(f.db.knowledgeConnections[0].status, "error");
});

test("ima reports matching files without readable excerpts separately from no_match and retains valid credentials", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : path === "search_knowledge" ? { code: 0, data: { info_list: [{ media_id: "file-only", title: "采购资料.pdf" }] } } : undefined;
  const check = await f.service.checkSearch(scope, "采购");
  assert.equal(check.status, "content_unavailable"); assert.equal(check.count, 0);
  assert.deepEqual(check.fileMatches, [{ title: "采购资料.pdf", mediaType: 1 }]);
  const result = await new KnowledgeService(f.store, new ConnectorRegistry([imaConnector(f.service)])).recallWithDiagnostics("a", "采购", 5);
  assert.equal(result.status, "failed"); assert.match(result.failures[0].message, /已命中资料.*本次未取得可读正文片段/);
  assert.equal(result.failures[0].authorizationValid, true); assert.equal(f.db.knowledgeConnections[0].status, "connected");
  assert.equal((await f.service.state(scope)).connection.credentialsStored, true);
});

test("ima file diagnostics expose only a sanitized hostname, never signed URLs or access headers", async () => {
  const f = fixture(); await f.service.connect(scope, credentials);
  let fileUrl = "https://files.ima.example/private/document.pdf?token=private-signed-token";
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : path === "search_knowledge" ? { code: 0, data: { info_list: [{ media_id: "file-only", title: "采购资料.pdf" }] } } : path === "get_media_info" ? { code: 0, data: { media_type: 1, url_info: { url: fileUrl, headers: { Authorization: "private-header-token" } } } } : undefined;
  const result = await f.service.checkSearch(scope, "采购");
  assert.equal(result.fileMatches[0].downloadHost, "files.ima.example");
  assert.doesNotMatch(JSON.stringify(result), /private-signed-token|private-header-token|document.pdf|https:|Authorization|ima-api-secret-a|client-test-a/);
  for (const unsafe of ["http://files.ima.example/a", "https://user:secret@files.ima.example/a", `https://${credentials.apiKey}.example/a`]) {
    fileUrl = unsafe;
    assert.equal((await f.service.checkSearch(scope, "采购")).fileMatches[0].downloadHost, undefined);
  }
  assert.ok(f.calls.every(call => !call.path.includes("document.pdf")));
});

test("ima reads an original file only through a reviewed host and rechecks workspace ownership after parsing", async () => {
  const f = fixture(); await f.service.connect(scope, credentials); let files = 0;
  f.options.file = Buffer.from("杭州位于钱塘江下游，这是文件原文。");
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : path === "search_knowledge" ? { code: 0, data: { info_list: [{ media_id: "original-file", title: "杭州.txt" }] } } : path === "get_media_info" ? { code: 0, data: { media_type: 13, url_info: { url: "https://pkb.ima.myqcloud.com/official-file.txt", headers: {} } } } : undefined;
  f.options.beforeFile = () => { files++; };
  const result = await f.service.checkSearch(scope, "杭州");
  assert.equal(files, 1); assert.equal(result.status, "used"); assert.match(result.chunks[0].content, /这是文件原文/); assert.deepEqual(result.fileMatches, []);
  const before = files;
  await assert.rejects(f.service.checkSearch({ userId: "a", workspaceId: "b" }, "杭州")); assert.equal(files, before);
  f.options.beforeFile = () => { files++; f.db.workspaceMembers.find(member => member.userId === "a")!.role = "member"; };
  await assert.rejects(f.service.search("a", "杭州", 5), /所有者/);
});

test("ima never forwards API credentials echoed into an object URL or access header", async () => {
  const f = fixture(); await f.service.connect(scope, credentials); let files = 0;
  f.options.file = Buffer.from("private body"); f.options.beforeFile = () => { files++; };
  let link = { url: "https://pkb.ima.myqcloud.com/official-file.txt", headers: { Authorization: credentials.apiKey } };
  f.options.override = path => path === "search_note" ? { code: 0, data: { search_note_infos: [] } } : path === "search_knowledge" ? { code: 0, data: { info_list: [{ media_id: "original-file", title: "杭州.txt" }] } } : path === "get_media_info" ? { code: 0, data: { media_type: 13, url_info: link } } : undefined;
  assert.equal((await f.service.checkSearch(scope, "杭州")).status, "content_unavailable");
  link = { url: `https://pkb.ima.myqcloud.com/official-file.txt?key=${credentials.apiKey}`, headers: { Authorization: "object-token" } };
  assert.equal((await f.service.checkSearch(scope, "杭州")).status, "content_unavailable"); assert.equal(files, 0);
});
