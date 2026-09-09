import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredential, encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";

test("encrypts provider credentials with authenticated encryption", () => {
  const plain = "test_provider_secret";
  const encrypted = encryptCredential(plain);
  assert.notEqual(encrypted, plain);
  assert.match(encrypted, /^v1\./);
  assert.equal(decryptCredential(encrypted), plain);
});

test("binds new provider credentials to the exact workspace and field", () => {
  const own = knowledgeCredentialContext("workspace-a", "notion", "access_token");
  const otherWorkspace = knowledgeCredentialContext("workspace-b", "notion", "access_token");
  const wrongField = knowledgeCredentialContext("workspace-a", "notion", "refresh_token");
  const encrypted = encryptCredential("secret", own);
  assert.equal(decryptCredential(encrypted, own), "secret");
  assert.throws(() => decryptCredential(encrypted, otherWorkspace));
  assert.throws(() => decryptCredential(encrypted, wrongField));
});

test("rejects a modified credential", () => {
  const parts = encryptCredential("test_provider_secret").split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => decryptCredential(parts.join(".")));
});
