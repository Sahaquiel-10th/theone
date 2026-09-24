import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { callModel, callModelWithTools, modelFinishReason } from "./modelGateway.js";
import type { ModelConfig } from "./types.js";

test("unknown end reasons are not invented; known truncation and filtering are normalized", () => {
  assert.equal(modelFinishReason(undefined), "unknown");
  assert.equal(modelFinishReason("provider_custom"), "unknown");
  assert.equal(modelFinishReason("length"), "length");
  assert.equal(modelFinishReason("max_tokens"), "length");
  assert.equal(modelFinishReason("content_filter"), "filtered");
  assert.equal(modelFinishReason("end_turn"), "stop");
});

for (const protocol of ["openai", "anthropic"] as const) test(`${protocol}: both text and tool APIs keep partial content, usage and length flag`, async t => {
  const server = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(protocol === "openai" ? {
        choices: [{ message: { content: "unfinished **" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      } : { content: [{ type: "text", text: "unfinished **" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 20 } }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const model = { id: "test", protocol, kind: "chat", enabled: true, apiKey: "fixture", model: "fixture", systemPrompt: "", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` } as ModelConfig;
  const normal = await callModel(model, [{ role: "user", content: "test", createdAt: "today" }]);
  const tool = await callModelWithTools(model, [{ role: "user", content: "test" }], []);
  for (const result of [normal, tool]) {
    assert.equal(result.finishReason, "length");
    assert.equal(result.content, "unfinished **");
    assert.equal(result.usage?.totalTokens, 30);
  }
});
