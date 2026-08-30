import assert from "node:assert/strict";
import test from "node:test";
import { GetNoteProvider } from "./getnoteProvider.js";

test("uses GetNote device authorization and global knowledge search", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { data: { code: "device-code", verification_uri: "https://www.biji.com/auth", user_code: "ABCD", expires_in: 600, interval: 5 } },
    { data: { client_id: "cli_one", api_key: "test_provider_key", expires_at: 2_000_000_000 } },
    { data: { results: [{ note_id: "note-1", title: "说明", content: "租户知识", score: 0.9 }] } },
    { data: { results: [] } }
  ];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = new GetNoteProvider();
    const device = await provider.startDeviceFlow("cli_one");
    assert.equal(device.userCode, "ABCD");
    const token = await provider.pollDeviceFlow("cli_one", device.code);
    assert.equal(token.status, "connected");
    const credentials = { clientId: "cli_one", apiKey: "test_provider_key" };
    assert.equal((await provider.search(credentials, "问题", 5))[0]?.content, "租户知识");
    await provider.verify(credentials);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      "/open/api/v1/oauth/device/code",
      "/open/api/v1/oauth/token",
      "/open/api/v1/resource/recall",
      "/open/api/v1/resource/recall"
    ]);
    assert.equal((calls[2]?.init?.headers as Record<string, string>)["X-Client-ID"], "cli_one");
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { query: "问题", top_k: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
