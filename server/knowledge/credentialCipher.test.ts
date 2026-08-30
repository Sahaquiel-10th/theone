import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredential, encryptCredential } from "./credentialCipher.js";

test("encrypts provider credentials with authenticated encryption", () => {
  const plain = "test_provider_secret";
  const encrypted = encryptCredential(plain);
  assert.notEqual(encrypted, plain);
  assert.match(encrypted, /^v1\./);
  assert.equal(decryptCredential(encrypted), plain);
});

test("rejects a modified credential", () => {
  const parts = encryptCredential("test_provider_secret").split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => decryptCredential(parts.join(".")));
});
