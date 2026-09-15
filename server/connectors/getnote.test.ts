import assert from "node:assert/strict";
import test from "node:test";
import type { Database, KnowledgeConnection } from "../types.js";
import { encryptCredential, knowledgeCredentialContext } from "../knowledge/credentialCipher.js";
import { getnoteConnector } from "./getnote.js";

function database(patch: Partial<KnowledgeConnection> = {}) {
  const connection: KnowledgeConnection = {
    id: "connection-a", workspaceId: "workspace-a", provider: "getnote", status: "connected", clientId: "mock-client-a",
    encryptedApiKey: encryptCredential("mock-token-a", knowledgeCredentialContext("workspace-a", "getnote", "api_key")),
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...patch
  };
  return { knowledgeConnections: [connection] } as Database;
}

test("a stored transient GetNote error permits recall and an explicit connection check", async () => {
  const db = database({ status: "error", lastError: "得到大脑响应超时，请稍后重试" });
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async (_input, init) => {
    called++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer mock-token-a");
    return Response.json({ data: { results: [{ title: "Mock note", content: "recovered knowledge" }] } });
  }) as typeof fetch;
  try {
    assert.equal(getnoteConnector.status(db, { workspaceId: "workspace-a", userId: "user-a" }).code, "CONNECTION_RETRY_AVAILABLE");
    assert.equal((await getnoteConnector.recall(db, "workspace-a", "question", 5))[0].content, "recovered knowledge");
    assert.equal((await getnoteConnector.check!(db, { workspaceId: "workspace-a", userId: "user-a" })).state, "verified");
    assert.equal(called, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("expired and malformed-expiry GetNote credentials do not trigger remote requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected remote call"); }) as typeof fetch;
  try {
    for (const credentialExpiresAt of ["2000-01-01T00:00:00.000Z", "invalid-expiry"]) {
      const db = database({ status: "error", credentialExpiresAt });
      await assert.rejects(getnoteConnector.recall(db, "workspace-a", "question", 5), /授权已过期/);
      assert.equal((await getnoteConnector.check!(db, { workspaceId: "workspace-a", userId: "user-a" })).state, "expired");
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("pending, revoked, missing and cross-workspace GetNote credentials stay disconnected", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected remote call"); }) as typeof fetch;
  try {
    for (const patch of [{ status: "pending" }, { status: "revoked" }, { status: "error", encryptedApiKey: undefined }] as Partial<KnowledgeConnection>[]) {
      assert.deepEqual(await getnoteConnector.recall(database(patch), "workspace-a", "question", 5), []);
    }
    assert.deepEqual(await getnoteConnector.recall(database(), "workspace-b", "question", 5), []);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("GetNote diagnostics never return a remote response body containing secrets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: { message: "Bearer mock-secret-a" } }, { status: 401 })) as typeof fetch;
  try {
    const health = await getnoteConnector.check!(database(), { workspaceId: "workspace-a", userId: "user-a" });
    assert.equal(health.state, "error");
    assert.doesNotMatch(JSON.stringify(health), /mock-secret-a|Bearer/);
  } finally { globalThis.fetch = originalFetch; }
});
