import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedConnectorUrl, readBoundedJson } from "./securityPolicy.js";

test("connector endpoints require exact allowlisted HTTPS hosts", () => {
  assert.equal(assertAllowedConnectorUrl("https://mcp.notion.com/token", ["mcp.notion.com"]).hostname, "mcp.notion.com");
  for (const url of [
    "http://mcp.notion.com/token", "https://mcp.notion.com.attacker.example/token",
    "https://127.0.0.1/internal", "https://user:secret@mcp.notion.com/token", "https://mcp.notion.com:8443/token"
  ]) assert.throws(() => assertAllowedConnectorUrl(url, ["mcp.notion.com"]));
});

test("connector JSON responses are bounded even without content-length", async () => {
  assert.deepEqual(await readBoundedJson<{ ok: boolean }>(new Response('{"ok":true}'), 64), { ok: true });
  await assert.rejects(readBoundedJson(new Response(JSON.stringify({ value: "x".repeat(100) })), 32), /安全限制/);
  await assert.rejects(readBoundedJson(new Response("{}", { headers: { "content-length": "100" } }), 32), /安全限制/);
});
