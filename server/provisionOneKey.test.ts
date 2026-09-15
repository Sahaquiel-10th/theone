import assert from "node:assert/strict";
import test from "node:test";
import { containsExistingOnePayload, readCredential, unexpectedFactoryEntries, validVolumePath } from "../scripts/provision-one-key-dual.js";

const credential = {
  version: 1,
  deviceId: "device-a",
  publicKeyRaw: "public-a",
  privateKeyRaw: "private-a",
  serverBaseUrl: "https://theone.aiarrival.cn"
};

test("factory provisioning accepts only a complete production credential", () => {
  assert.deepEqual(readCredential(JSON.stringify(credential)), credential);
  assert.throws(() => readCredential("not-json"), /有效的 JSON/);
  assert.throws(() => readCredential(JSON.stringify({ ...credential, privateKeyRaw: "" })), /privateKeyRaw/);
  assert.throws(() => readCredential(JSON.stringify({ ...credential, version: 2 })), /V1/);
  assert.throws(() => readCredential(JSON.stringify({ ...credential, serverBaseUrl: "http://localhost:5173" })), /生产环境/);
  assert.throws(() => readCredential(JSON.stringify({ ...credential, serverBaseUrl: "https://theone.aiarrival.cn/path" })), /生产环境/);
});

test("factory provisioning refuses old ONE payloads and unrelated user files", () => {
  assert.equal(containsExistingOnePayload([".one"]), true);
  assert.equal(containsExistingOnePayload(["ONE.exe"]), true);
  assert.equal(containsExistingOnePayload(["ONE for Windows.exe"]), true);
  assert.equal(containsExistingOnePayload(["System Volume Information"]), false);
  assert.deepEqual(unexpectedFactoryEntries([".Trashes", "$RECYCLE.BIN", "System Volume Information"]), []);
  assert.deepEqual(unexpectedFactoryEntries(["客户资料.docx", ".secret"]), ["客户资料.docx", ".secret"]);
});

test("factory provisioning only accepts one explicit child of Volumes", () => {
  assert.equal(validVolumePath("/Volumes/ONE-001"), true);
  assert.equal(validVolumePath("/Volumes/Macintosh HD"), false);
  assert.equal(validVolumePath("/Volumes/ONE-001/nested"), false);
  assert.equal(validVolumePath("/"), false);
});
