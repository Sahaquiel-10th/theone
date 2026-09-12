import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { callModelWithTools, fetchWithTimeout, parseProviderUsage } from "./modelGateway.js";
import type { ModelConfig } from "./types.js";

test("passes OpenAI function tools and returns tool calls", async () => {
  let received: any;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const model = {
    id: "model-a", name: "Test", provider: "test", kind: "chat", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "server-only-key", model: "test-model", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString()
  } satisfies ModelConfig;
  try {
    const result = await callModelWithTools(model, [{ role: "user", content: "查看文件" }], [{
      type: "function", function: { name: "list_files", description: "list", parameters: { type: "object" } }
    }], "tool-test");
    assert.equal(received.tool_choice, "auto");
    assert.equal(received.tools[0].function.name, "list_files");
    assert.equal(result.toolCalls[0].function.name, "list_files");
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16, source: "provider" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("translates Anthropic tool use and tool results", async () => {
  let received: any;
  let requestPath = "";
  let apiKey = "";
  const server = createServer((request, response) => {
    requestPath = request.url || "";
    apiKey = String(request.headers["x-api-key"] || "");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        content: [
          { type: "text", text: "继续检查。" },
          { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "README.md" } }
        ],
        usage: { input_tokens: 18, output_tokens: 7 }
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const model = {
    id: "model-b", name: "Claude", provider: "test", kind: "chat", protocol: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "anthropic-server-key", model: "claude-test", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString()
  } satisfies ModelConfig;
  try {
    const result = await callModelWithTools(model, [
      { role: "system", content: "只操作授权目录" },
      { role: "user", content: "查看文件" },
      { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }] },
      { role: "tool", tool_call_id: "tool-1", content: "README.md" }
    ], [{
      type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }
    }], "anthropic-tool-test");
    assert.equal(requestPath, "/messages");
    assert.equal(apiKey, "anthropic-server-key");
    assert.equal(received.system, "只操作授权目录");
    assert.equal(received.tool_choice.type, "auto");
    assert.equal(received.tools[0].name, "read_file");
    assert.equal(received.tools[0].input_schema.type, "object");
    assert.equal(received.messages[1].content[0].type, "tool_use");
    assert.equal(received.messages[2].content[0].type, "tool_result");
    assert.equal(received.messages[2].content[0].tool_use_id, "tool-1");
    assert.equal(result.content, "继续检查。");
    assert.equal(result.toolCalls[0].function.name, "read_file");
    assert.equal(result.toolCalls[0].function.arguments, "{\"path\":\"README.md\"}");
    assert.deepEqual(result.usage, { inputTokens: 18, outputTokens: 7, totalTokens: 25, source: "provider" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("leaves usage unknown when a gateway omits token counts instead of inventing a charge", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "完成", tool_calls: [] } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const model = {
    id: "model-c", name: "No usage", provider: "test", kind: "chat", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "server-only-key", model: "test-model", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString()
  } satisfies ModelConfig;
  try {
    const result = await callModelWithTools(model, [{ role: "user", content: "做一件事" }], [], "estimated-usage-test");
    assert.equal(result.usage, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("invalid and partial provider usage cannot become billable zero or negative tokens", () => {
  for (const usage of [undefined, {}, { prompt_tokens: null, completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: "12", completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 2 }]) {
    assert.equal(parseProviderUsage(usage), undefined);
  }
  assert.deepEqual(parseProviderUsage({ input_tokens: 0, output_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, source: "provider" });
});

test("the gateway deadline also covers a stalled response body", async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  try { await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, 80), /超时/); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("provider error bodies do not leak echoed credentials or prompts into user errors and logs", async () => {
  const secret = "DO_NOT_EXPOSE_PRIVATE_PROMPT_OR_KEY";
  const server = createServer((_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: secret } })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  const errors: unknown[] = []; const original = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    await assert.rejects(callModelWithTools({ id: "test", enabled: true, apiKey: secret, kind: "chat", protocol: "openai", baseUrl: `http://127.0.0.1:${address.port}`, model: "test" } as ModelConfig, [{ role: "user", content: secret }], []), (error: Error) => !error.message.includes(secret) && error.message.includes("403"));
    assert.equal(JSON.stringify(errors).includes(secret), false);
  } finally { console.error = original; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
