import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { api, apiForUser, ApiError, announceSessionChange, expectUser, SESSION_EVENT, SESSION_STORAGE_KEY } from "./oneApi";

function browserFor(t: TestContext, fetcher: typeof fetch) {
  const events: Event[] = [];
  const storage = new Map<string, string>();
  const globals: Record<string, unknown> = {
    window: { dispatchEvent(event: Event) { events.push(event); return true; } },
    localStorage: { setItem(key: string, value: string) { storage.set(key, value); } },
    fetch: fetcher
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  expectUser("");
  t.after(() => {
    expectUser("");
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { events, storage };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers });

test("private requests send the expected account and preserve same-origin credentials", async t => {
  let sent: RequestInit | undefined;
  browserFor(t, async (_path, options) => { sent = options; return json({ ok: true }); });
  expectUser("user-a");
  assert.deepEqual(await api("/api/conversations", { method: "POST", body: "{}", headers: { "X-Custom": "test" } }), { ok: true });
  const headers = new Headers(sent!.headers);
  assert.equal(headers.get("X-ONE-User"), "user-a");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-Custom"), "test");
  assert.equal(sent!.credentials, "same-origin");
});

test("identity probes and authentication requests do not inherit the previous account header", async t => {
  const calls: RequestInit[] = [];
  browserFor(t, async (_path, options) => { calls.push(options!); return json({ ok: true }); });
  expectUser("previous-user");
  await api("/api/me");
  await api("/api/auth/one-key/redeem", { method: "POST", body: "{}" });
  for (const call of calls) assert.equal(new Headers(call.headers).get("X-ONE-User"), null);
});

test("FormData uploads leave the content type boundary to the browser", async t => {
  let sent: RequestInit | undefined;
  browserFor(t, async (_path, options) => { sent = options; return json({ ok: true }); });
  expectUser("user-a");
  const body = new FormData(); body.set("file", "test");
  await api("/api/attachments", { method: "POST", body });
  const headers = new Headers(sent!.headers);
  assert.equal(headers.get("Content-Type"), null);
  assert.equal(headers.get("X-ONE-User"), "user-a");
  assert.equal(sent!.body, body);
});

test("a late response from the previous account is discarded and requests a session refresh", async t => {
  let finish!: (response: Response) => void;
  const browser = browserFor(t, () => new Promise(resolve => { finish = resolve; }));
  expectUser("user-a");
  const pending = api("/api/conversations");
  expectUser("user-b");
  finish(json({ privateText: "USER_A_PRIVATE_SENTINEL" }));
  await assert.rejects(pending, error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "SESSION_CHANGED");
    assert.ok(!error.message.includes("USER_A_PRIVATE_SENTINEL"));
    return true;
  });
  assert.deepEqual(browser.events.map(event => event.type), [SESSION_EVENT]);
});

test("the server SESSION_CHANGED code refreshes the browser even without a local account change", async t => {
  const browser = browserFor(t, async () => json({ code: "SESSION_CHANGED", error: "stale cookie" }, 409));
  expectUser("user-a");
  await assert.rejects(api("/api/models"), error => error instanceof ApiError && error.code === "SESSION_CHANGED");
  assert.deepEqual(browser.events.map(event => event.type), [SESSION_EVENT]);
});

test("HTTP errors preserve explicit retry safety and request identifiers without inferring safety from status", async t => {
  const responses = [
    json({ error: "插入 Key", code: "ONE_KEY_REQUIRED" }, 428, { "x-request-id": "req-key" }),
    json({ error: "请重新登录" }, 401),
    json({ error: "尚未找到请求" }, 404),
    json({ error: "确认没有执行", retryable: true, requestId: "req-body" }, 503, { "x-request-id": "req-header" }),
    json({ error: "执行结果待确认", retryable: false }, 500)
  ];
  const browser = browserFor(t, async () => responses.shift()!);
  expectUser("user-a");
  const errors: ApiError[] = [];
  for (let index = 0; index < 5; index++) {
    await assert.rejects(api("/api/chat"), error => { assert.ok(error instanceof ApiError); errors.push(error); return true; });
  }
  assert.deepEqual(errors.map(error => error.status), [428, 401, 404, 503, 500]);
  assert.deepEqual(errors.map(error => error.retryable), [undefined, undefined, undefined, true, false]);
  assert.equal(errors[0].code, "ONE_KEY_REQUIRED");
  assert.equal(errors[0].requestId, "req-key");
  assert.match(errors[0].message, /req-key/);
  assert.equal(errors[3].requestId, "req-body");
  assert.equal(browser.events.length, 0);
});

test("non-JSON gateway timeout remains ambiguous rather than authorizing a new paid request", async t => {
  browserFor(t, async () => new Response("<html>Gateway timeout</html>", { status: 504, headers: { "x-request-id": "req-timeout" } }));
  expectUser("user-a");
  await assert.rejects(api("/api/chat"), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 504);
    assert.equal(error.retryable, undefined);
    assert.equal(error.requestId, "req-timeout");
    assert.match(error.message, /查看这条消息的处理结果/);
    return true;
  });
});

test("session announcements contain an opaque revision and tolerate disabled storage", t => {
  const browser = browserFor(t, async () => { throw new Error("No network expected"); });
  expectUser("PRIVATE_USER_SENTINEL");
  announceSessionChange();
  assert.equal(browser.storage.size, 1);
  assert.match(browser.storage.get(SESSION_STORAGE_KEY)!, /^[a-f0-9-]{36}$/);
  assert.ok(!browser.storage.get(SESSION_STORAGE_KEY)!.includes("PRIVATE_USER_SENTINEL"));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() { throw new Error("Storage disabled"); } } });
  assert.doesNotThrow(announceSessionChange);
});

test("an old component continuation cannot send its payload after the account changed before fetch", async t => {
  let calls = 0;
  browserFor(t, async () => { calls++; return json({ ok: true }); });
  expectUser("user-a");
  const oldComponentApi = apiForUser("user-a");
  await Promise.resolve();
  expectUser("user-b");
  await assert.rejects(oldComponentApi("/api/chat", { method: "POST", body: JSON.stringify({ content: "A private draft" }) }), error => error instanceof ApiError && error.code === "SESSION_CHANGED");
  assert.equal(calls, 0);
  await apiForUser("user-b")("/api/models");
  assert.equal(calls, 1);
});

test("a scoped private request cannot override the owning account through custom headers", async t => {
  let sent: RequestInit | undefined;
  browserFor(t, async (_path, options) => { sent = options; return json({ ok: true }); });
  expectUser("user-a");
  await apiForUser("user-a")("/api/chat", { headers: new Headers({ "X-ONE-User": "user-b", "X-Custom": "kept" }) });
  assert.equal(new Headers(sent!.headers).get("X-ONE-User"), "user-a");
  assert.equal(new Headers(sent!.headers).get("X-Custom"), "kept");
});

test("an account-bound request discards its response when the account changes in flight", async t => {
  let finish!: (response: Response) => void;
  const browser = browserFor(t, () => new Promise(resolve => { finish = resolve; }));
  expectUser("user-a");
  const pending = apiForUser("user-a")("/api/conversations");
  expectUser("user-b");
  finish(json({ content: "ACCOUNT_A_PRIVATE_SENTINEL" }));
  await assert.rejects(pending, error => error instanceof ApiError && error.code === "SESSION_CHANGED");
  assert.deepEqual(browser.events.map(event => event.type), [SESSION_EVENT]);
});
