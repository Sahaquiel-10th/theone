import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { ConnectorRegistry, type KnowledgeAdapter } from "../connectors/registry.js";
import { encryptCredential } from "./credentialCipher.js";
import { KnowledgeService } from "./knowledgeService.js";

function storeWithConnection(workspaceId: string): Store {
  const database = {
    knowledgeConnections: [{
      id: "connection-a",
      workspaceId,
      provider: "getnote",
      status: "connected",
      clientId: "client-a",
      encryptedApiKey: encryptCredential("secret-a"),
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z"
    }]
  } as Database;
  return {
    async read() { return database; },
    async mutate<T>(fn: (db: Database) => T) { return fn(database); }
  };
}

test("searches the connected workspace globally without requiring a knowledge-space binding", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: { results: [{ note_id: "note-a", title: "A", content: "workspace A knowledge" }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const service = new KnowledgeService(storeWithConnection("workspace-a"));
    const result = await service.recall("workspace-a", "question", 5);
    assert.equal(result[0]?.content, "workspace A knowledge");
    assert.equal(new URL(calls[0]).pathname, "/open/api/v1/resource/recall");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not call a provider with another workspace's connection", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("must not be called");
  }) as typeof fetch;

  try {
    const service = new KnowledgeService(storeWithConnection("workspace-a"));
    assert.deepEqual(await service.recall("workspace-b", "question", 5), []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sanitizes hostile provider errors and bounds returned context", async () => {
  const store = storeWithConnection("workspace-a");
  const manifest = {
    id: "hostile", name: "Hostile", version: "1.0.0", kind: "knowledge" as const, capabilities: ["knowledge.read"], auth: "oauth_pkce" as const,
    security: { trust: "untrusted_reference" as const, transport: "fixed_https" as const, access: "read_only" as const, allowedHosts: ["example.com"] }
  };
  const hostile: KnowledgeAdapter = {
    kind: "knowledge" as const,
    manifest,
    status: () => ({ state: "configured" as const, code: "OK", message: "ok", evidence: "stored" as const }),
    async recall() { throw new Error("Bearer private-token database-password"); }
  };
  await assert.rejects(new KnowledgeService(store, new ConnectorRegistry([hostile])).recall("workspace-a", "test"), (error: unknown) => {
    assert.doesNotMatch(error instanceof Error ? error.message : String(error), /private-token|database-password/);
    return true;
  });

  const verbose: KnowledgeAdapter = { ...hostile, async recall() { return [{ provider: "notion", title: "t".repeat(500), content: "x".repeat(100_000) }]; } };
  const result = await new KnowledgeService(store, new ConnectorRegistry([verbose])).recall("workspace-a", "test");
  assert.equal(result[0].title.length, 300);
  assert.equal(result[0].content.length, 24_000);
});

test("a transient recall error recovers on the next request and only updates the owning connection", async () => {
  const store = storeWithConnection("workspace-a");
  const db = await store.read();
  db.knowledgeConnections.push({ ...structuredClone(db.knowledgeConnections[0]), id: "connection-b", workspaceId: "workspace-b" });
  const originalB = structuredClone(db.knowledgeConnections[1]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return Response.json({ error: { message: "temporary failure private-token" } }, { status: 503 });
    return Response.json({ data: { results: [{ content: "recovered" }] } });
  }) as typeof fetch;
  try {
    const service = new KnowledgeService(store);
    const failed = await service.recallWithDiagnostics("workspace-a", "question");
    assert.equal(failed.status, "failed");
    assert.equal(failed.failures[0].code, "UNAVAILABLE");
    assert.equal(failed.failures[0].retryable, true);
    assert.equal(db.knowledgeConnections[0].status, "error");
    assert.doesNotMatch(JSON.stringify(failed), /private-token/);
    assert.doesNotMatch(db.knowledgeConnections[0].lastError!, /private-token/);
    const recovered = await service.recallWithDiagnostics("workspace-a", "question");
    assert.equal(recovered.status, "used");
    assert.equal(recovered.chunks[0].content, "recovered");
    assert.equal(db.knowledgeConnections[0].status, "connected");
    assert.equal(db.knowledgeConnections[0].lastError, undefined);
    assert.deepEqual(db.knowledgeConnections[1], originalB);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("knowledge diagnostics distinguish authorization, permissions, quota and timeout without leaking remote errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, providerCode, code, retryable] of [
      [401, undefined, "AUTHORIZATION_REQUIRED", false], [403, undefined, "PERMISSION_REQUIRED", false], [429, undefined, "RATE_LIMITED", true],
      [200, 10001, "AUTHORIZATION_REQUIRED", false], [200, 10201, "PERMISSION_REQUIRED", false], [200, 42900, "RATE_LIMITED", true]
    ] as const) {
      globalThis.fetch = (async () => Response.json({ success: false, code: providerCode, error: { message: "hostile private-token" } }, { status })) as typeof fetch;
      const result = await new KnowledgeService(storeWithConnection("workspace-a")).recallWithDiagnostics("workspace-a", "question");
      assert.equal(result.failures[0].code, code);
      assert.equal(result.failures[0].retryable, retryable);
      assert.doesNotMatch(JSON.stringify(result), /hostile|private-token/);
    }
    globalThis.fetch = (async () => { throw new DOMException("test abort", "AbortError"); }) as typeof fetch;
    const timeout = await new KnowledgeService(storeWithConnection("workspace-a")).recallWithDiagnostics("workspace-a", "question");
    assert.equal(timeout.failures[0].code, "TIMEOUT");
    assert.equal(timeout.failures[0].retryable, true);
  } finally { globalThis.fetch = originalFetch; }
});

function adapter(id: string, recall: KnowledgeAdapter["recall"], state: "configured" | "not_connected" = "configured"): KnowledgeAdapter {
  return {
    kind: "knowledge", manifest: { id, name: id, version: "1.0.0", kind: "knowledge", capabilities: ["knowledge.search"], auth: "oauth_pkce", security: { trust: "untrusted_reference", transport: "fixed_https", access: "read_only", allowedHosts: ["example.com"] } },
    status: () => ({ state, code: "TEST", message: "test", evidence: "stored" }), recall
  };
}

test("explicit public source selection never widens to other connected sources or workspaces", async () => {
  const store=storeWithConnection("workspace-a"), db=await store.read();
  db.knowledgeConnections.push({...structuredClone(db.knowledgeConnections[0]),id:"notion-a",provider:"notion"},{...structuredClone(db.knowledgeConnections[0]),id:"other-workspace",workspaceId:"workspace-b"});
  let getnoteCalls=0,notionCalls=0;
  const service=new KnowledgeService(store,new ConnectorRegistry([adapter("getnote",async()=>{getnoteCalls++;return [{title:"getnote",content:"allowed"}];}),adapter("notion",async()=>{notionCalls++;return [{title:"notion",content:"unselected"}];})]));
  assert.deepEqual((await service.recallWithDiagnostics("workspace-a","q",5,[])).chunks,[]);
  assert.equal(getnoteCalls+notionCalls,0);
  assert.equal((await service.recallWithDiagnostics("workspace-a","q",5,["connection-a"])).chunks[0].content,"allowed");
  assert.equal(notionCalls,0);
  await assert.rejects(service.recallWithDiagnostics("workspace-a","q",5,["other-workspace"]));
  db.knowledgeConnections[0].status="revoked";
  await assert.rejects(service.recallWithDiagnostics("workspace-a","q",5,["connection-a"]));
  assert.equal(getnoteCalls,1);
});

test("partial provider failures remain visible alongside successful retrievals", async () => {
  const registry = new ConnectorRegistry([
    adapter("source_a", async () => [{ title: "A", content: "source A knowledge" }]),
    adapter("source_b", async () => { throw new Error("request timeout with private-token"); })
  ]);
  const service = new KnowledgeService(storeWithConnection("workspace-a"), registry);
  const result = await service.recallWithDiagnostics("workspace-a", "question");
  assert.equal(result.status, "partial");
  assert.equal(result.chunks[0].content, "source A knowledge");
  assert.deepEqual(result.failures.map(item => item.provider), ["source_b"]);
  assert.equal(result.failures[0].code, "TIMEOUT");
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  assert.equal((await service.recall("workspace-a", "question")).length, 1);
});

test("an empty successful provider and a failed provider are a partial search, not an all-provider outage", async () => {
  const registry = new ConnectorRegistry([adapter("source_a", async () => []), adapter("source_b", async () => { throw new Error("timeout"); })]);
  const result = await new KnowledgeService(storeWithConnection("workspace-a"), registry).recallWithDiagnostics("workspace-a", "question");
  assert.equal(result.status, "partial");
  assert.equal(result.chunks.length, 0);
  assert.equal(result.failures.length, 1);
});

test("database persistence errors are not mislabeled as provider failures or retried writes", async () => {
  const store = storeWithConnection("workspace-a");
  let writes = 0;
  store.mutate = async () => { writes++; throw new Error("mock database unavailable"); };
  const registry = new ConnectorRegistry([adapter("getnote", async () => [])]);
  await assert.rejects(new KnowledgeService(store, registry).recallWithDiagnostics("workspace-a", "question"), /mock database unavailable/);
  assert.equal(writes, 1);
});

test("unconnected providers are not queried and are different from a successful empty search", async () => {
  const unconnected = adapter("source_a", async () => { throw new Error("must not be called"); }, "not_connected");
  const noConnections = await new KnowledgeService(storeWithConnection("workspace-a"), new ConnectorRegistry([unconnected])).recallWithDiagnostics("workspace-a", "question");
  assert.deepEqual(noConnections, { chunks: [], failures: [], status: "not_connected" });
  const empty = adapter("source_b", async () => []);
  const noMatch = await new KnowledgeService(storeWithConnection("workspace-a"), new ConnectorRegistry([unconnected, empty])).recallWithDiagnostics("workspace-a", "question");
  assert.deepEqual(noMatch, { chunks: [], failures: [], status: "no_match" });
});

test("parallel provider results preserve round-robin fairness and bounded topK", async () => {
  const registry = new ConnectorRegistry([
    adapter("source_a", async () => Array.from({ length: 10 }, (_, i) => ({ title: `A${i}`, content: "a" }))),
    adapter("source_b", async () => Array.from({ length: 10 }, (_, i) => ({ title: `B${i}`, content: "b" })))
  ]);
  const result = await new KnowledgeService(storeWithConnection("workspace-a"), registry).recallWithDiagnostics("workspace-a", "question", 3);
  assert.deepEqual(result.chunks.map(item => item.title), ["A0", "B0", "A1"]);
});

test("a completed old-credential request cannot undo a disconnect or overwrite a newer authorization", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const change of ["disconnect", "replace"] as const) {
      const store = storeWithConnection("workspace-a");
      const db = await store.read();
      globalThis.fetch = (async () => {
        if (change === "disconnect") db.knowledgeConnections[0].status = "revoked";
        else { db.knowledgeConnections[0].encryptedApiKey = encryptCredential("new-mock-token"); db.knowledgeConnections[0].lastError = "new-connection-state"; }
        return Response.json({ data: { results: [] } });
      }) as typeof fetch;
      await new KnowledgeService(store).recallWithDiagnostics("workspace-a", "question");
      if (change === "disconnect") assert.equal(db.knowledgeConnections[0].status, "revoked");
      else assert.equal(db.knowledgeConnections[0].lastError, "new-connection-state");
    }
  } finally { globalThis.fetch = originalFetch; }
});
