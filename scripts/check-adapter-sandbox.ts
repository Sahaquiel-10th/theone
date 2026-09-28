import assert from "node:assert/strict";
import { sandboxDefinition, sandboxEndpoints } from "../server/adapterSandbox.js";
import { importReadOnlyOperation } from "../server/connectors/standardHttp.js";
import { runOfficialFeaturePilot, type PilotBinding } from "../server/officialFeaturePilot.js";
import type { Database } from "../server/types.js";
import type { Store } from "../server/db.js";

// Opt-in only; real HTTPS to a fixed, public synthetic service. No production
// Store import, login, API keys, private data, model use or production writes.
if (!process.argv.includes("--live")) throw new Error("请加 --live：仅请求 ONE 公网合成测试接口，不操作生产数据库");
const cases = [
  { tool: "sandboxLookup", input: { topic: "meeting" }, status: "completed", expected: { found: true } },
  { tool: "sandboxLookup", input: { topic: "missing" }, status: "completed", expected: { found: false } },
  { tool: "sandboxInventory", input: { itemId: 101 }, status: "completed", expected: { available: 12 } },
  { tool: "sandboxProbe", input: { scenario: "unavailable" }, status: "failed", code: "INVALID_HTTP_RESPONSE" },
  { tool: "sandboxProbe", input: { scenario: "invalid-json" }, status: "failed", code: "INVALID_JSON" },
  { tool: "sandboxProbe", input: { scenario: "wrong-schema" }, status: "failed", code: "UNSUPPORTED_DEFINITION" }
];
const db = { users: [{ id: "synthetic-admin", role: "admin", enabled: true }],
  workspaces: [{ id: "synthetic-space", status: "active" }], workspaceMembers: [{ workspaceId: "synthetic-space", userId: "synthetic-admin" }],
  settings: { officialFeatures: [{ id: "synthetic-feature", status: "approved", current: { version: 1, values: { integration: "openapi" } } }] }, auditLogs: [] } as unknown as Database;
const store: Store = { read: async () => db, mutate: async fn => fn(db) };
const scope = { workspaceId: "synthetic-space", userId: "synthetic-admin" };
for (const [index, item] of cases.entries()) {
  const tool = importReadOnlyOperation(sandboxDefinition, item.tool, sandboxEndpoints);
  const binding: PilotBinding = { featureId: "synthetic-feature", featureVersion: 1, tool, approvedDigest: tool.digest, cost: "free_test_only" };
  const id = `synthetic_operation_${index}`;
  const result = await runOfficialFeaturePilot(store, scope, binding, id, item.input);
  assert.equal(result.status, item.status, `${item.tool}: ${JSON.stringify(result)}`);
  if (item.code) assert.equal("code" in result ? result.code : undefined, item.code);
  if (item.expected) {
    assert.ok("result" in result && result.result?.synthetic === true);
    for (const [key, value] of Object.entries(item.expected)) assert.equal(result.result![key], value);
  }
  const replay = await runOfficialFeaturePilot(store, scope, binding, id, item.input);
  assert.equal(replay.replay, true);
  assert.equal(replay.status, result.status);
  console.log(`PASS ${index + 1}: ${item.tool} ${item.status}; replay did not re-execute`);
}
console.log("LIVE_SANDBOX_OK: real HTTPS transport; synthetic local execution identity and audit only; no production account/billing changes.");
