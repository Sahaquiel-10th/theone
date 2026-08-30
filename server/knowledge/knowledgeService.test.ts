import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
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
