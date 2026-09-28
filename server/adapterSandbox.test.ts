import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { installAdapterSandbox, sandboxBase, sandboxDefinition, sandboxEndpoints } from "./adapterSandbox.js";
import { callReadOnlyHttp, importReadOnlyOperation, type JsonTransport } from "./connectors/standardHttp.js";

async function start(t: test.TestContext, options?: Parameters<typeof installAdapterSandbox>[1]) {
  const app = express(); installAdapterSandbox(app, options);
  app.get("/normal-health", (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
test("public synthetic service has no account-specific data and ignores auth/cookies rather than exposing it", async t => {
  const origin = await start(t), url = origin + sandboxBase;
  const expected = { synthetic: true, found: true, title: "虚构会议室使用规则", answer: "测试园区会议室提前 15 分钟开放，每次可预约 60 分钟。" };
  for (const headers of [{}, { "x-workspace-id": "a", cookie: "one_session=syntheticA" }, { "x-workspace-id": "b", authorization: "Bearer syntheticB" }]) {
    const result = await fetch(url + "/lookup?topic=meeting", { headers: headers as Record<string, string> });
    assert.equal(result.headers.get("x-one-synthetic"), "true");
    assert.deepEqual(await result.json(), expected);
  }
  assert.deepEqual(await (await fetch(url + "/lookup?topic=missing")).json(), { synthetic: true, found: false, title: "", answer: "" });
  assert.deepEqual(await (await fetch(url + "/inventory?itemId=101")).json(), { synthetic: true, itemId: 101, available: 12, name: "虚构白板笔" });
  assert.deepEqual(await (await fetch(url + "/openapi.json")).json(), sandboxDefinition);
});
test("sandbox rejects arbitrary fields, reflection, duplicates, URLs, mutations and oversized queries", async t => {
  const url = await start(t) + sandboxBase;
  for (const suffix of ["/lookup?topic=meeting&workspaceId=victim", "/lookup?topic=meeting&topic=printer", "/lookup?topic=https://internal", "/lookup?topic=secret-content", "/inventory?itemId=1e2", "/inventory?itemId=-1", "/probe?scenario=sleep", "/openapi.json?url=https://internal"]) {
    const response = await fetch(url + suffix); assert.equal(response.status, 400, suffix);
    assert.ok(!(await response.text()).includes("secret-content"));
  }
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) assert.equal((await fetch(url + "/lookup?topic=meeting", { method })).status, 405);
  assert.equal((await fetch(url + "/lookup?topic=" + "x".repeat(1100))).status, 414);
  assert.equal((await fetch(url + "/unknown")).status, 404);
});
test("sandbox throttling and disable switch do not affect unrelated routes", async t => {
  let now = 0;
  const origin = await start(t, { now: () => now, perMinute: 2 });
  const url = origin + sandboxBase + "/lookup?topic=meeting";
  assert.equal((await fetch(url)).status, 200); assert.equal((await fetch(url)).status, 200);
  const throttled = await fetch(url); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get("retry-after"), "60");
  assert.equal((await fetch(origin + "/normal-health")).status, 200);
  now = 60000; assert.equal((await fetch(url)).status, 200);
  const disabled = await start(t, { enabled: false });
  assert.equal((await fetch(disabled + sandboxBase + "/openapi.json")).status, 404);
});
test("published schemas exercise the adapter against actual local HTTP handlers, not fixture return stubs", async t => {
  const origin = await start(t);
  // Local tests ONLY replace HTTPS transport, never relax production SSRF/TLS.
  // The deployment smoke script uses the default pinned-DNS HTTPS transport.
  const transport: JsonTransport = async (url, signal) => {
    const response = await fetch(origin + url.pathname + url.search, { signal });
    if (!response.ok) throw new Error("remote failure");
    return response.json();
  };
  const lookup = importReadOnlyOperation(sandboxDefinition, "sandboxLookup", sandboxEndpoints);
  assert.equal((await callReadOnlyHttp(lookup, { topic: "printer" }, transport)).found, true);
  const inventory = importReadOnlyOperation(sandboxDefinition, "sandboxInventory", sandboxEndpoints);
  assert.equal((await callReadOnlyHttp(inventory, { itemId: 102 }, transport)).available, 0);
  const probe = importReadOnlyOperation(sandboxDefinition, "sandboxProbe", sandboxEndpoints);
  for (const scenario of ["unavailable", "invalid-json", "wrong-schema"]) await assert.rejects(callReadOnlyHttp(probe, { scenario }, transport));
  assert.equal((await callReadOnlyHttp(probe, { scenario: "ok" }, transport)).status, "ok");
});
