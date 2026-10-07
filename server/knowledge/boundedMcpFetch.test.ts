import assert from "node:assert/strict";
import test from "node:test";
import { boundedMcpFetch } from "./boundedMcpFetch.js";

test("MCP transport rejects unreviewed hosts, redirects configuration and unexpected paths before sending credentials", async () => {
  let calls = 0;
  const fetcher = boundedMcpFetch((async (_url, init) => { calls++; assert.equal(init?.redirect, "error"); assert.ok(init?.signal); return new Response("{}"); }) as typeof fetch, "https://flomoapp.com/mcp", ["flomoapp.com"], 1000);
  for (const url of ["https://evil.example/mcp", "https://flomoapp.com/other", "https://flomoapp.com/mcp?token=bad", "http://flomoapp.com/mcp", "https://user@flomoapp.com/mcp"]) await assert.rejects(fetcher(url));
  assert.equal(calls, 0);
  assert.equal(await (await fetcher("https://flomoapp.com/mcp")).text(), "{}");
  assert.equal(calls, 1);
});

test("MCP transport bounds both declared and streaming payloads", async () => {
  const declared = boundedMcpFetch((async () => new Response("body", { headers: { "content-length": "2097152" } })) as typeof fetch, "https://flomoapp.com/mcp", ["flomoapp.com"], 1000);
  await assert.rejects(declared("https://flomoapp.com/mcp"), /安全限制/);
  let cancelled = false;
  const streaming = boundedMcpFetch((async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; } }))) as typeof fetch, "https://flomoapp.com/mcp", ["flomoapp.com"], 1000);
  await assert.rejects((await streaming("https://flomoapp.com/mcp")).text(), /安全限制/);
  assert.equal(cancelled, true);
});
