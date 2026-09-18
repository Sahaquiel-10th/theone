import assert from "node:assert/strict";
import test from "node:test";
import { GETNOTE_CLI_OAUTH_CLIENT_ID, getNoteOAuthClientId } from "./getnoteOAuth.js";

test("legacy personal application cannot override the CLI authorization entry", () => {
  assert.equal(getNoteOAuthClientId({ GETNOTE_CLIENT_ID: "cli_personal", GETNOTE_TEST_API_KEY: "test-secret" }), GETNOTE_CLI_OAUTH_CLIENT_ID);
  assert.equal(getNoteOAuthClientId({ GETNOTE_OAUTH_CLIENT_ID: "  " }), GETNOTE_CLI_OAUTH_CLIENT_ID);
});

test("an explicit OAuth application override is independent from legacy test credentials", () => {
  assert.equal(getNoteOAuthClientId({ GETNOTE_CLIENT_ID: "cli_personal", GETNOTE_OAUTH_CLIENT_ID: " cli_approved " }), "cli_approved");
});
