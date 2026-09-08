import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { callModelWithTools } from "./modelGateway.js";
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
