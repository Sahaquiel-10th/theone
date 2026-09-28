import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once, EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callReadOnlyHttp, createFixedHttpsJson, fixedHttpsJson, importReadOnlyOperation, publicIpv4 } from "./connectors/standardHttp.js";
import { runOfficialFeaturePilot, type PilotBinding } from "./officialFeaturePilot.js";
import { installOfficialFeaturePilotRoutes } from "./officialFeaturePilotRoutes.js";
import { installOfficialFeatureRoutes } from "./officialFeatureRoutes.js";
import type { Database } from "./types.js";
import type { Store } from "./db.js";

function spec(name = "lookup", field = "query", type = "string") {
  return { openapi: "3.1.1", info: { title: "Synthetic", version: "1" }, servers: [{ url: "https://approved.example" }], paths: {
    "/lookup": { get: { operationId: name, parameters: [{ name: field, in: "query", required: true, schema: { type } }], responses: {
      "200": { description: "ok", content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { answer: { type: "string" } }, required: ["answer"] } } } }
    } } }
  } };
}
const tool = () => importReadOnlyOperation(spec(), "lookup", ["https://approved.example/lookup"]);
function fixture() {
  const binding: PilotBinding = { featureId: "test-feature", featureVersion: 1, tool: tool(), approvedDigest: tool().digest, cost: "free_test_only" };
  let db = { users: [{ id: "admin", role: "admin", enabled: true }, { id: "other", role: "admin", enabled: true }, { id: "member", role: "user", enabled: true }],
    workspaces: [{ id: "a", status: "active" }, { id: "b", status: "active" }],
    workspaceMembers: [{ workspaceId: "a", userId: "admin" }, { workspaceId: "b", userId: "other" }, { workspaceId: "a", userId: "member" }],
    settings: { officialFeatures: [{ id: "test-feature", status: "approved", current: { version: 1, values: { integration: "openapi" } } }] }, auditLogs: [] } as unknown as Database;
  const store: Store = { read: async () => structuredClone(db), mutate: async fn => { const next = structuredClone(db); const result = fn(next); db = next; return result; } };
  return { store, binding, scope: { workspaceId: "a", userId: "admin" } };
}
test("two different OpenAPI parameter shapes use the same adapter; query is encoded; result is checked", async () => {
  const a = tool(), b = importReadOnlyOperation(spec("count", "limit", "integer"), "count", ["https://approved.example/lookup"]);
  assert.deepEqual(await callReadOnlyHttp(a, { query: "中文 & a=b" }, async url => { assert.equal(url.searchParams.get("query"), "中文 & a=b"); return { answer: "found" }; }), { answer: "found" });
  assert.deepEqual(await callReadOnlyHttp(b, { limit: 3 }, async url => { assert.equal(url.searchParams.get("limit"), "3"); return { answer: "three" }; }), { answer: "three" });
  await assert.rejects(callReadOnlyHttp(b, { limit: "3" }), /INVALID_FIELD_TYPE/);
  await assert.rejects(callReadOnlyHttp(a, { query: "ok", workspaceId: "victim" }), /UNSUPPORTED_DEFINITION/);
  await assert.rejects(callReadOnlyHttp(a, { query: "ok" }, async () => ({ answer: "ok", secret: "hidden" })), /UNSUPPORTED_DEFINITION/);
  await assert.rejects(callReadOnlyHttp(a, { query: "ok" }, async () => ({})), /MISSING_FIELD/);
});
test("unsupported specs never silently weaken auth, schema or endpoint restrictions", () => {
  const mutations = [
    (d: any) => { d.security = [{ apiKey: [] }]; },
    (d: any) => { d.servers[0].url = "http://approved.example"; },
    (d: any) => { d.paths["/lookup"].post = d.paths["/lookup"].get; },
    (d: any) => { d.paths["/lookup"].get.parameters[0].schema.$ref = "http://internal/schema"; },
    (d: any) => { d.paths["/lookup"].get.servers = [{ url: "https://evil.example" }]; },
    (d: any) => { d.paths["/lookup"].get.parameters[0].schema.enum = ["restricted"]; },
    (d: any) => { d.paths["/lookup"].get.parameters[0].name = "constructor"; }
  ];
  for (const mutate of mutations) { const d = spec(); mutate(d); assert.throws(() => importReadOnlyOperation(d, "lookup", ["https://approved.example/lookup"])); }
  assert.throws(() => importReadOnlyOperation(spec(), "lookup", []), /ENDPOINT_NOT_APPROVED/);
});
test("egress blocks private, reserved, metadata and IPv6; no redirect fallback or secret-bearing errors", async () => {
  for (const ip of ["0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.2", "169.254.169.254", "100.100.100.200", "198.18.0.1", "224.1.1.1", "::1", "::ffff:127.0.0.1"]) assert.equal(publicIpv4(ip), false, ip);
  assert.equal(publicIpv4("8.8.8.8"), true);
  await assert.rejects(fixedHttpsJson(new URL("https://127.0.0.1"), new AbortController().signal), /UNSAFE_ENDPOINT/);
  await assert.rejects(fixedHttpsJson(new URL("https://localhost"), new AbortController().signal), /UNSAFE_ADDRESS/);
  await assert.rejects(callReadOnlyHttp(tool(), { query: "private" }, async () => { throw new Error("secret remote body"); }), /^Error: TOOL_UNAVAILABLE$/);
  await assert.rejects(callReadOnlyHttp(tool(), { query: "ok" }, async () => new Promise(() => {}), 5), /TOOL_TIMEOUT/);
  const changed = tool(); changed.endpoint = "https://evil.example/lookup";
  await assert.rejects(callReadOnlyHttp(changed, { query: "ok" }), /TOOL_DEFINITION_CHANGED/);
});
test("pilot claims once, isolates accounts, omits contents from audit and rejects stale approval", async () => {
  const { store, scope, binding } = fixture(); let calls = 0;
  const transport = async () => { calls++; return { answer: "private-result" }; };
  const id = "operation_123456789";
  const first = await runOfficialFeaturePilot(store, scope, binding, id, { query: "private-query" }, transport);
  assert.equal(first.status, "completed"); assert.equal(calls, 1);
  const replay = await runOfficialFeaturePilot(store, scope, binding, id, { query: "private-query" }, transport);
  assert.equal(replay.replay, true); assert.equal(calls, 1); assert.equal("result" in replay, false);
  await assert.rejects(runOfficialFeaturePilot(store, scope, binding, id, { query: "different" }, transport), /OPERATION_CONFLICT/);
  for (const forbidden of [{ workspaceId: "b", userId: "admin" }, { workspaceId: "a", userId: "other" }, { workspaceId: "a", userId: "member" }]) await assert.rejects(runOfficialFeaturePilot(store, forbidden, binding, id, { query: "private-query" }, transport), /PILOT_NOT_AUTHORIZED/);
  const other = await runOfficialFeaturePilot(store, { workspaceId: "b", userId: "other" }, binding, id, { query: "private-query" }, transport);
  assert.notEqual(first.runId, other.runId); assert.equal(calls, 2);
  const logs = JSON.stringify((await store.read()).auditLogs); assert.ok(!logs.includes("private-query") && !logs.includes("private-result"));
  await store.mutate(db => { db.settings.officialFeatures![0].status = "paused"; });
  await assert.rejects(runOfficialFeaturePilot(store, scope, binding, id, { query: "private-query" }, transport), /PILOT_NOT_AUTHORIZED/);
});
test("HTTPS transport pins checked DNS and rejects redirects, non-JSON, oversized and malformed responses", async () => {
  for (const scenario of ["ok", "redirect", "html", "large", "bad-json", "mixed-dns"]) {
    let requested = false;
    const transport = createFixedHttpsJson({
      resolve4: (async () => scenario === "mixed-dns" ? ["8.8.8.8", "127.0.0.1"] : ["8.8.8.8"]) as any,
      request: ((url: URL, options: any, receive: any) => {
        requested = true; assert.equal(url.hostname, "approved.example"); assert.equal(options.agent, false);
        options.lookup("approved.example", {}, (error: unknown, ip: string) => { assert.equal(error, null); assert.equal(ip, "8.8.8.8"); });
        const req = new EventEmitter() as any;
        req.end = () => {
          const body = scenario === "large" ? "a".repeat(262145) : scenario === "bad-json" ? "not-json" : '{"answer":"ok"}';
          const res = Readable.from([Buffer.from(body)]) as any;
          res.statusCode = scenario === "redirect" ? 302 : 200;
          res.headers = { "content-type": scenario === "html" ? "text/html" : "application/json", location: "http://169.254.169.254" };
          receive(res);
        };
        return req;
      }) as any
    });
    if (scenario === "ok") assert.deepEqual(await callReadOnlyHttp(tool(), { query: "q" }, transport), { answer: "ok" });
    else await assert.rejects(callReadOnlyHttp(tool(), { query: "q" }, transport), /UNSAFE_ADDRESS|INVALID_HTTP_RESPONSE|RESULT_TOO_LARGE|INVALID_JSON/);
    assert.equal(requested, scenario !== "mixed-dns");
  }
});
test("concurrent repeat never calls twice; revocation during execution suppresses output", async () => {
  const { store, scope, binding } = fixture(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }); let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const first = runOfficialFeaturePilot(store, scope, binding, "operation_123456789", { query: "q" }, async () => { started(); await gate; return { answer: "must-not-return" }; });
  await ready;
  const repeat = await runOfficialFeaturePilot(store, scope, binding, "operation_123456789", { query: "q" }, async () => { throw new Error("duplicate"); });
  assert.equal(repeat.status, "running");
  await assert.rejects(runOfficialFeaturePilot(store, scope, binding, "operation_987654321", { query: "q" }), /PILOT_RATE_LIMITED/);
  await store.mutate(db => { db.users[0].enabled = false; }); release();
  const result = await first; assert.equal(result.status, "failed"); assert.equal("result" in result, false);
});
test("HTTP pilot remains Key/admin gated and unavailable without reviewed server registration", async t => {
  const { store } = fixture(); const app = express(); app.use(express.json());
  let proofs = 0;
  const guard: import("express").RequestHandler = (req, res, next) => { proofs++; if (req.headers["x-key"] !== "yes") { res.sendStatus(428); return; } if (req.headers["x-role"] !== "admin") { res.sendStatus(403); return; } next(); };
  installOfficialFeaturePilotRoutes(app, [guard], store);
  installOfficialFeatureRoutes(app, [guard], store);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/admin/official-features/test-feature/pilot`;
  assert.equal((await fetch(url, { method: "POST" })).status, 428);
  assert.equal((await fetch(url, { method: "POST", headers: { "x-key": "yes" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { "x-key": "yes", "x-role": "admin" } })).status, 409);
  assert.equal(proofs, 3, "one Key proof per request, no duplicate router authentication");
});
test("persisted pilot claim survives a real store restart; unfinished operation is never repeated", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "one-pilot-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, DB_PROVIDER: "json", ONE_DATA_DIR: directory, ADMIN_INITIAL_PASSWORD: "isolated-fixture-password", YYLX_API_KEY: "", NODE_ENV: "test" };
  const run = async (code: string) => (await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env })).stdout;
  const setup = `const {store}=await import('./server/db.ts');const {runOfficialFeaturePilot}=await import('./server/officialFeaturePilot.ts');const binding=${JSON.stringify(fixture().binding)};const db=await store.read();const scope={workspaceId:db.workspaces[0].id,userId:db.users[0].id};`;
  await run(setup + `await store.mutate(db=>{db.settings.officialFeatures=[{id:'test-feature',status:'approved',current:{version:1,values:{integration:'openapi'}},history:[],revision:1,draft:{}}]});await runOfficialFeaturePilot(store,scope,binding,'operation_123456789',{query:'q'},async()=>({answer:'ok'}));await store.mutate(db=>{db.auditLogs=db.auditLogs.filter(r=>r.action!=='official_feature.pilot.finished');for(const r of db.auditLogs)if(r.action==='official_feature.pilot.started')r.createdAt='2020-01-01T00:00:00Z';});`);
  const recovered = JSON.parse(await run(setup + `let calls=0;const result=await runOfficialFeaturePilot(store,scope,binding,'operation_123456789',{query:'q'},async()=>{calls++;return {answer:'duplicate'}});console.log(JSON.stringify({result,calls}));`));
  assert.equal(recovered.calls, 0); assert.equal(recovered.result.status, "unknown"); assert.equal(recovered.result.replay, true);
});
