import assert from "node:assert/strict";
import test from "node:test";
import { getNotePollFailureAction, prepareGetNoteAuthorizationWindow, type PreparedAuthorizationWindow } from "./getNoteAuthorization.js";

test("GetNote polling keeps the transaction through Key reinsertion and retryable provider failures", () => {
  assert.equal(getNotePollFailureAction({ status: 428, code: "ONE_KEY_REQUIRED" }), "retry_key");
  assert.equal(getNotePollFailureAction({ status: 503, code: "GETNOTE_UNAVAILABLE", retryable: true }), "retry_provider");
  assert.equal(getNotePollFailureAction({ status: 429, code: "POLL_TOO_FAST" }), "retry_provider");
  assert.equal(getNotePollFailureAction({ status: 403, code: "GETNOTE_MEMBER_REQUIRED" }), "end");
  assert.equal(getNotePollFailureAction({ status: 410, code: "FLOW_EXPIRED" }), "end");
});

test("the authorization window is opened during the click and safely falls back when blocked", () => {
  const calls: string[][] = [];
  let replaced = "";
  const popup: PreparedAuthorizationWindow = {
    closed: false,
    opener: { unsafe: true },
    location: { replace(url) { replaced = url; } },
    close() { this.closed = true; }
  };
  const prepared = prepareGetNoteAuthorizationWindow((...args) => { calls.push(args); return popup; });
  assert.deepEqual(calls, [["about:blank", "one-getnote-authorization"]]);
  assert.equal(prepared?.opener, null);
  prepared?.location.replace("https://www.biji.com/openapi/oauth/authorize");
  assert.equal(replaced, "https://www.biji.com/openapi/oauth/authorize");
  assert.equal(prepareGetNoteAuthorizationWindow(() => null), null);
});
