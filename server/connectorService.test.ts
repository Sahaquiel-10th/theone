import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Store } from "./db.js";
import type { Database } from "./types.js";
import { ConnectorAccessError, ConnectorService } from "./connectorService.js";
import { connectorRoutes } from "./connectorRoutes.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { getnoteConnector } from "./connectors/getnote.js";
import { executionConnectors, type ExecutionPresence } from "./connectors/execution.js";
import { encryptCredential } from "./knowledge/credentialCipher.js";
import { KnowledgeService } from "./knowledge/knowledgeService.js";

const scope = { workspaceId: "a", userId: "ua", deviceId: "da" };
function fixture(disabled: string[] = []) {
  const db = {
    users: ["a", "b"].map(id => ({ id: `u${id}`, defaultWorkspaceId: id, enabled: true })),
    workspaces: ["a", "b"].map(id => ({ id, status: "active" })),
    workspaceMembers: ["a", "b"].map(id => ({ workspaceId: id, userId: `u${id}`, role: "owner" })),
    oneKeyDevices: ["a", "b"].map(id => ({ id: `d${id}`, workspaceId: id, userId: `u${id}`, status: "active" })),
    knowledgeConnections: [{ id: "ka", workspaceId: "a", provider: "getnote", status: "connected", clientId: "private-client", encryptedApiKey: encryptCredential("private-key"), lastError: "private-provider-error" }],
    executionTasks: [{ id: "ta", workspaceId: "a", userId: "ua", deviceId: "da", provider: "codex", status: "queued", instruction: "private-instruction" }]
  } as unknown as Database;
  const calls: string[] = [];
  let online = true, localEnabled = false;
  const presence: ExecutionPresence = {
    isConnected: () => online,
    supportsLocalAgent: () => localEnabled,
    async startExecution(device, task) { calls.push(`start:${device}:${task}`); },
    async continueExecution(device, task) { calls.push(`continue:${device}:${task}`); },
    async cancelExecution(device, task) { calls.push(`cancel:${device}:${task}`); }
  };
  const store = { async read() { return db; }, async mutate<T>(fn: (db: Database) => T) { return fn(db); } } as Store;
  const registry = new ConnectorRegistry([getnoteConnector, ...executionConnectors(presence, { start(id) { calls.push(`local:${id}`); }, async cancel(id) { calls.push(`local-cancel:${id}`); } })], disabled);
  return { db, calls, store, registry, service: new ConnectorService(store, registry), online(value: boolean) { online = value; }, local(value: boolean) { localEnabled = value; } };
}

test("connector registry rejects duplicates and unknown disable targets", () => {
  assert.throws(() => new ConnectorRegistry([getnoteConnector, getnoteConnector]));
  assert.throws(() => new ConnectorRegistry([getnoteConnector], ["unknown"]));
  assert.throws(() => new ConnectorRegistry([{ ...getnoteConnector, manifest: { ...getnoteConnector.manifest, version: "latest" } }]));
  assert.throws(() => new ConnectorRegistry([{ ...getnoteConnector, manifest: { ...getnoteConnector.manifest, security: { ...getnoteConnector.manifest.security, allowedHosts: [] } } }]));
  assert.throws(() => new ConnectorRegistry([{ ...getnoteConnector, manifest: { ...getnoteConnector.manifest, security: { ...getnoteConnector.manifest.security, allowedHosts: ["https://attacker.example"] } } }]));
  const registry = new ConnectorRegistry([getnoteConnector]);
  assert.throws(() => { registry.get("getnote")!.manifest.id = "changed"; });
});

test("connector list is scoped, secret-free and does not claim runtime readiness", async () => {
  const { service } = fixture();
  const list = await service.list(scope);
  assert.deepEqual(list.map(item => item.id), ["getnote", "codex", "local_agent"]);
  assert.equal(list[0].health.state, "configured");
  assert.equal(list[1].health.state, "transport_ready");
  assert.equal(list[2].health.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(list), /private-|encryptedApiKey|deviceId|providerThreadId/);
  await assert.rejects(service.list({ ...scope, workspaceId: "b" }), ConnectorAccessError);
  const other = await service.list({ workspaceId: "b", userId: "ub", deviceId: "da" });
  assert.equal(other[0].health.state, "not_connected");
  assert.equal(other[1].health.state, "offline");
});

test("connector status distinguishes pending, revoked, expired, missing credentials and errors", async () => {
  const { db, service } = fixture();
  const connection = db.knowledgeConnections[0];
  for (const [stored, expected] of [["pending", "pending"], ["revoked", "not_connected"], ["error", "error"]] as const) {
    connection.status = stored;
    assert.equal((await service.check(scope, "getnote")).health.state, expected);
  }
  connection.status = "connected";
  connection.credentialExpiresAt = "2000-01-01";
  assert.equal((await service.check(scope, "getnote")).health.state, "expired");
  connection.credentialExpiresAt = "invalid";
  assert.equal((await service.check(scope, "getnote")).health.state, "expired");
  connection.credentialExpiresAt = undefined;
  connection.encryptedApiKey = undefined;
  assert.equal((await service.check(scope, "getnote")).health.state, "not_connected");
});

test("explicit knowledge check uses only authorized credentials and sanitizes failures", async () => {
  const { service } = fixture();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "private-key");
    return new Response(JSON.stringify({ success: true, data: { results: [] } }));
  }) as typeof fetch;
  try {
    await service.list(scope);
    assert.equal(requests, 0);
    await assert.rejects(service.check({ ...scope, workspaceId: "b" }, "getnote"));
    assert.equal(requests, 0);
    assert.equal((await service.check(scope, "getnote")).health.state, "verified");
    globalThis.fetch = async () => { throw new Error("private-key private-provider-error"); };
    const failed = await service.check(scope, "getnote");
    assert.equal(failed.health.code, "REMOTE_CHECK_FAILED");
    assert.doesNotMatch(JSON.stringify(failed), /private-/);
  } finally { globalThis.fetch = original; }
});

test("execution dispatch enforces membership, owner, device and original runtime", async () => {
  const f = fixture();
  assert.equal(await f.service.selectExecution(scope), "codex");
  for (const wrong of [{ ...scope, workspaceId: "b" }, { ...scope, userId: "ub" }, { ...scope, deviceId: "db" }, { ...scope, deviceId: undefined }]) {
    for (const action of ["start", "continue", "cancel"] as const) await assert.rejects(f.service.dispatch(wrong, "ta", action, "test"));
  }
  assert.deepEqual(f.calls, []);
  for (const action of ["start", "continue", "cancel"] as const) await f.service.dispatch(scope, "ta", action, "test");
  assert.deepEqual(f.calls, ["start:da:ta", "continue:da:ta", "cancel:da:ta"]);
  f.online(false);
  await assert.rejects(f.service.dispatch(scope, "ta", "continue", "test"));
  f.online(true); f.local(true);
  assert.equal(await f.service.selectExecution(scope), "local_agent");
  await assert.rejects(f.service.dispatch(scope, "ta", "continue", "test"));
  f.db.executionTasks[0].provider = "local_agent";
  await f.service.dispatch(scope, "ta", "start");
  await f.service.dispatch(scope, "ta", "cancel");
  assert.deepEqual(f.calls.slice(-2), ["local:ta", "local-cancel:ta"]);
  f.db.oneKeyDevices[0].status = "revoked";
  await assert.rejects(f.service.selectExecution(scope));
});

test("disabled adapters cannot check, recall, dispatch or silently select a fallback", async () => {
  const f = fixture(["getnote", "codex"]);
  assert.equal((await f.service.check(scope, "getnote")).health.state, "disabled");
  assert.deepEqual(await new KnowledgeService(f.store, f.registry).recall("a", "test"), []);
  await assert.rejects(f.service.selectExecution(scope));
  await assert.rejects(f.service.dispatch(scope, "ta", "start"));
  assert.deepEqual(f.calls, []);
  await f.service.dispatch(scope, "ta", "cancel");
  assert.deepEqual(f.calls, ["cancel:da:ta"]);
});

test("connector HTTP routes reject anonymous access and ignore client identity overrides", async () => {
  const f = fixture();
  const app = express();
  app.use(express.json());
  // Test-only stand-in for the production auth + live device proof middleware.
  app.use((req, _res, next) => {
    if (req.headers.authorization === "test-identity") { req.user = f.db.users[0]; req.workspaceId = "a"; req.oneKeyDeviceId = "da"; }
    next();
  });
  app.use("/api/connectors", connectorRoutes(f.service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: "test-identity", "Content-Type": "application/json", "x-workspace-id": "b" };
    const response = await fetch(url + "?workspaceId=b", { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).connectors[0].health.state, "configured");
    const check = await fetch(url + "/codex/check", { method: "POST", headers, body: JSON.stringify({ workspaceId: "b", deviceId: "db", url: "http://internal", command: "untrusted" }) });
    assert.equal((await check.json()).health.state, "transport_ready");
    assert.deepEqual(f.calls, []);
    assert.equal((await fetch(url + "/unknown/check", { method: "POST", headers })).status, 404);
    f.db.workspaceMembers = [];
    assert.equal((await fetch(url, { headers })).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
