import assert from "node:assert/strict";
import test from "node:test";
import { GetNoteProvider, GetNoteProviderError } from "./getnoteProvider.js";

test("real HTTP 200 pending response remains pending until a credential arrives", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    { success: true, data: { msg: "authorization_pending" } },
    { success: true, data: { msg: "slow_down" } },
    { success: true, data: { api_key: "test-key", client_id: "one" } },
    { success: true, data: {} }
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch;
  try {
    const provider = new GetNoteProvider();
    assert.deepEqual(await provider.pollDeviceFlow("one", "test-code"), { status: "pending" });
    assert.deepEqual(await provider.pollDeviceFlow("one", "test-code"), { status: "pending", retryAfterSeconds: 10 });
    assert.equal((await provider.pollDeviceFlow("one", "test-code")).status, "connected");
    await assert.rejects(provider.pollDeviceFlow("one", "test-code"), error => error instanceof GetNoteProviderError && error.code === "GETNOTE_RESPONSE_INVALID");
  } finally { globalThis.fetch = originalFetch; }
});

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
    assert.equal((calls[2]?.init?.headers as Record<string, string>).Authorization, "Bearer test_provider_key");
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { query: "问题", top_k: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not duplicate an already-prefixed Bearer credential", async () => {
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = (async (_input, init) => {
    authorization = (init?.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ success: true, data: { results: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    await new GetNoteProvider().verify({ clientId: "one", apiKey: "Bearer test-key" });
    assert.equal(authorization, "Bearer test-key");
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects a provider-supplied authorization link outside the approved domain", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: { code: "device-code", verification_uri: "https://biji.com.attacker.example/login", user_code: "ABCD", expires_in: 600, interval: 5 }
  }))) as typeof fetch;
  try {
    await assert.rejects(new GetNoteProvider().startDeviceFlow("cli_one"), /未获准/);
  } finally { globalThis.fetch = originalFetch; }
});

test("recognizes every terminal device authorization state without polling forever", async () => {
  const originalFetch = globalThis.fetch;
  const responses = ["access_denied", "rejected", "expired_token", "already_consumed"];
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { msg: responses.shift() } }), { status: 200 })) as typeof fetch;
  try {
    const provider = new GetNoteProvider();
    assert.deepEqual(await provider.pollDeviceFlow("one", "code-1"), { status: "ended", reason: "denied" });
    assert.deepEqual(await provider.pollDeviceFlow("one", "code-2"), { status: "ended", reason: "denied" });
    assert.deepEqual(await provider.pollDeviceFlow("one", "code-3"), { status: "ended", reason: "expired" });
    assert.deepEqual(await provider.pollDeviceFlow("one", "code-4"), { status: "ended", reason: "consumed" });
  } finally { globalThis.fetch = originalFetch; }
});

test("recognizes pending device authorization states in provider error envelopes", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    { success: false, error: { message: "authorization_pending" } },
    { success: false, error: { reason: "slow_down", retryable: true } }
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), { status: 400 })) as typeof fetch;
  try {
    const provider = new GetNoteProvider();
    assert.deepEqual(await provider.pollDeviceFlow("one", "code-1"), { status: "pending" });
    assert.deepEqual(await provider.pollDeviceFlow("one", "code-2"), { status: "pending", retryAfterSeconds: 10 });
  } finally { globalThis.fetch = originalFetch; }
});

test("reads provider codes from the nested error envelope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: false,
    request_id: "req_nested_member",
    error: { code: 10201, message: "PRIVATE_MEMBER_DETAIL" }
  }), { status: 403 })) as typeof fetch;
  try {
    await assert.rejects(new GetNoteProvider().verify({ clientId: "one", apiKey: "private-key" }), error => {
      assert.ok(error instanceof GetNoteProviderError);
      assert.equal(error.code, "GETNOTE_MEMBER_REQUIRED");
      assert.equal(error.providerRequestId, "req_nested_member");
      assert.ok(!error.message.includes("PRIVATE_MEMBER_DETAIL"));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("maps membership and scope failures to safe actionable errors", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response(JSON.stringify({ success: false, code: 10201, request_id: "req_member", error: { message: "PRIVATE_UPSTREAM_DETAIL" } }), { status: 403 }),
    new Response(JSON.stringify({ success: false, request_id: "req_scope", error: { message: "permission denied: note.recall.read PRIVATE_SCOPE_DETAIL" } }), { status: 403 })
  ];
  globalThis.fetch = (async () => responses.shift()!) as typeof fetch;
  try {
    const provider = new GetNoteProvider();
    await assert.rejects(provider.verify({ clientId: "one", apiKey: "private-key" }), error => {
      assert.ok(error instanceof GetNoteProviderError);
      assert.equal(error.code, "GETNOTE_MEMBER_REQUIRED");
      assert.equal(error.providerRequestId, "req_member");
      assert.ok(!error.message.includes("PRIVATE_UPSTREAM_DETAIL"));
      return true;
    });
    await assert.rejects(provider.verify({ clientId: "one", apiKey: "private-key" }), error => {
      assert.ok(error instanceof GetNoteProviderError);
      assert.equal(error.code, "GETNOTE_SCOPE_REQUIRED");
      assert.equal(error.phase, "credential_verify");
      assert.ok(!error.message.includes("PRIVATE_SCOPE_DETAIL"));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("marks provider outages retryable without exposing a response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, error: { message: "PRIVATE_PROVIDER_BODY" } }), { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(new GetNoteProvider().pollDeviceFlow("one", "device-code"), error => {
      assert.ok(error instanceof GetNoteProviderError);
      assert.equal(error.code, "GETNOTE_UNAVAILABLE");
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes("PRIVATE_PROVIDER_BODY"));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("unknown token errors are not reported as user rejection", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, request_id: "req_unknown", error: { code: -1, message: "PRIVATE_UNKNOWN_DETAIL" } }))) as typeof fetch;
  try {
    await assert.rejects(new GetNoteProvider().pollDeviceFlow("one", "code"), error => {
      assert.ok(error instanceof GetNoteProviderError);
      assert.equal(error.code, "GETNOTE_RESPONSE_INVALID");
      assert.equal(error.providerCode, -1);
      assert.equal(error.providerRequestId, "req_unknown");
      assert.ok(!error.message.includes("PRIVATE_UNKNOWN_DETAIL"));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("terminal token errors retain upstream diagnostics for authorization audits", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [reason, expected] of [["access_denied", "GETNOTE_AUTHORIZATION_REJECTED"], ["expired_token", "GETNOTE_AUTHORIZATION_EXPIRED"], ["already_consumed", "GETNOTE_AUTHORIZATION_CONSUMED"]]) {
      globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, request_id: "req_terminal", error: { code: 10000, reason } }), { status: 400 })) as typeof fetch;
      await assert.rejects(new GetNoteProvider().pollDeviceFlow("one", "code"), error => {
        assert.ok(error instanceof GetNoteProviderError);
        assert.equal(error.code, expected);
        assert.equal(error.providerCode, 10000);
        assert.equal(error.providerRequestId, "req_terminal");
        return true;
      });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("HTTP 200 server_error token state remains retryable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { msg: "server_error" } }))) as typeof fetch;
  try {
    await assert.rejects(new GetNoteProvider().pollDeviceFlow("one", "code"), error => error instanceof GetNoteProviderError && error.code === "GETNOTE_UNAVAILABLE" && error.retryable);
  } finally { globalThis.fetch = originalFetch; }
});
