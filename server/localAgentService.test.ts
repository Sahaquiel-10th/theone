import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { LocalAgentService } from "./localAgentService.js";
import type { Database, ModelConfig } from "./types.js";

for (const unplugAfterFirstTool of [false, true]) test(unplugAfterFirstTool ? "unplugging stops Local Agent before the next paid model step" : "runs a model tool loop through the workspace-bound local device", async () => {
  let modelCalls = 0;
  const modelServer = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      modelCalls++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(modelCalls === 1 ? {
        choices: [{ message: { content: null, tool_calls: [{ id: "call-list", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\",\"maxDepth\":2}" } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      } : {
        choices: [{ message: { content: "已检查授权文件夹。" } }],
        usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 }
      }));
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address();
  if (!address || typeof address === "string") throw new Error("测试模型未启动");
  const timestamp = new Date().toISOString();
  const model: ModelConfig = {
    id: "model-a", name: "Test", provider: "test", kind: "chat", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret", model: "test-model", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 0.5, costOutputPowerPerMillion: 0.5, createdAt: timestamp
  };
  const database = {
    users: [{ id: "user-a", enabled: true }], workspaces: [{ id: "workspace-a", status: "active" }], workspaceMembers: [{ userId: "user-a", workspaceId: "workspace-a" }], auditLogs: [],
    models: [model], conversations: [{ id: "conversation-a", workspaceId: "workspace-a", userId: "user-a", modelId: model.id }],
    executionTasks: [{ id: "task-a", workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a", sourceMessageId: "message-a", provider: "local_agent", status: "queued", instruction: "查看文件", deviceId: "device-a", createdAt: timestamp, updatedAt: timestamp }],
    executionEvents: [], powerAccounts: [{ id: "power-a", workspaceId: "workspace-a", userId: "user-a", balanceMicros: 10_000_000, createdAt: timestamp, updatedAt: timestamp }],
    powerLedger: [], modelUsageRecords: []
  } as unknown as Database;
  const store = { read: async () => database, mutate: async (change: (db: Database) => unknown) => change(database) } as any;
  const toolRequests: unknown[] = [];
  let present = true;
  let proofCount = 0;
  const presence = {
    requireProof: async (scope: { userId: string; workspaceId: string }) => { proofCount++; assert.equal(scope.userId, "user-a"); assert.equal(scope.workspaceId, "workspace-a"); if (!present) throw new Error("请插入 ONE Key"); },
    prepareLocalExecution: async () => ({ targetName: "project-a" }),
    executeLocalTool: async (_deviceId: string, _taskId: string, tool: string, args: unknown) => { toolRequests.push({ tool, args }); if (unplugAfterFirstTool) present = false; return { output: "README.md" }; },
    cancelExecution: async () => undefined
  } as any;
  const service = new LocalAgentService(store, presence);
  try {
    service.start("task-a");
    for (let attempt = 0; attempt < 200 && !["completed", "failed"].includes(database.executionTasks[0].status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.executionTasks[0].status, unplugAfterFirstTool ? "failed" : "completed");
    assert.equal(database.executionTasks[0].targetName, "project-a");
    assert.deepEqual(toolRequests, [{ tool: "list_files", args: { path: ".", maxDepth: 2 } }]);
    assert.equal(database.modelUsageRecords.length, unplugAfterFirstTool ? 1 : 2);
    assert.equal(modelCalls, unplugAfterFirstTool ? 1 : 2);
    assert.equal(proofCount, 2);
    assert.equal(database.powerAccounts[0].reservedMicros, 0);
    assert.match(database.executionEvents.at(-1)?.text ?? "", unplugAfterFirstTool ? /请插入 ONE Key/ : /已检查授权文件夹/);
  } finally {
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
  }
});
