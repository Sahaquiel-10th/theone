import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import { RemoteMcpKnowledgeService } from "./remoteMcpKnowledgeService.js";
import { flowusConfig } from "./remoteMcpProviders.js";

function fixture() {
  const database = { knowledgeConnections: [], auditLogs: [] } as unknown as Database;
  const store = { async read() { return database; }, async mutate<T>(fn: (db: Database) => T) { return fn(database); } } as Store;
  return { database, store };
}

test("reviewed MCP adapters ignore write tools and never cross workspaces", async () => {
  const f = fixture();
  f.database.knowledgeConnections.push({ id: "flowus-a", workspaceId: "workspace-a", provider: "flowus", status: "connected", clientId: "flowus-client", encryptedAccessToken: encryptCredential("token-a", knowledgeCredentialContext("workspace-a", "flowus", "access_token")), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const service = new RemoteMcpKnowledgeService(f.store, flowusConfig, { createClient: async token => {
    assert.equal(token, "token-a");
    return {
      async listTools() { return { tools: [{ name: "search" }, { name: "get_page" }, { name: "create_page" }, { name: "delete_page" }] }; },
      async callTool(params) { calls.push(params); if (params.name === "search") return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "page-a", title: "计划", url: "https://flowus.cn/page-a", excerpt: "只作为资料" }] }) }] }; if (params.name === "get_page") return { content: [{ type: "text", text: JSON.stringify({ title: "计划", url: "https://flowus.cn/page-a", content: "完整只读内容" }) }] }; throw new Error("write tool called"); },
      async close() {}
    };
  } });
  const chunks = await service.search("workspace-a", "计划", 5);
  assert.deepEqual(calls.map(item => item.name), ["search", "get_page"]);
  assert.deepEqual(calls.map(item => item.arguments), [{ query: "计划" }, { id: "page-a" }]);
  assert.equal(chunks[0].provider, "flowus");
  assert.equal(chunks[0].content, "完整只读内容");
  await assert.rejects(service.search("workspace-b", "计划", 5), /连接.*息流 FlowUs/);
});
