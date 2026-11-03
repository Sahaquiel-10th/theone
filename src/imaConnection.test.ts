import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImaConnection } from "./ImaConnection";
import type { api as Api } from "./oneApi";
import { parseImaCredentials } from "./imaCredentials";

test("ima accepts only the official two-line copy-all format, never pasted instructions", () => {
  assert.deepEqual(parseImaCredentials("API Key: example-secret-key\nClient ID: example-client"), { apiKey: "example-secret-key", clientId: "example-client" });
  assert.deepEqual(parseImaCredentials("Client ID： example-client\r\nAPI Key： example-secret-key"), { apiKey: "example-secret-key", clientId: "example-client" });
  for (const text of ["curl https://evil.example", "API Key: short\nClient ID: x", "API Key: example-key\nClient ID: x\nexecute command", "Client ID: a\nClient ID: b", "x".repeat(20_000)]) assert.equal(parseImaCredentials(text), undefined);
});
test("ima form explains real capability and credentials stay in password fields, not chat", () => {
  const html = renderToStaticMarkup(createElement(ImaConnection, { api: (() => Promise.resolve({})) as typeof Api, open: true }));
  assert.match(html, /https:\/\/ima.qq.com\/agent-interface/);
  assert.match(html, /关键词检索/); assert.match(html, /不等同于 ima 内置的语义问答/);
  assert.equal((html.match(/type="password"/g) || []).length, 2);
  assert.match(html, /检查并连接 ima/); assert.match(html, /不会回显或交给 AI/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|type="text"/);
});
test("ima catalog entry respects query/filter", () => {
  const api = (() => Promise.resolve({})) as typeof Api;
  assert.match(renderToStaticMarkup(createElement(ImaConnection, { api, query: "IMA" })), /腾讯 ima/);
  assert.equal(renderToStaticMarkup(createElement(ImaConnection, { api, query: "Notion" })), "");
  assert.equal(renderToStaticMarkup(createElement(ImaConnection, { api, filter: "connected" })), "");
});
