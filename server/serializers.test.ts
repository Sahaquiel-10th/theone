import assert from "node:assert/strict";
import test from "node:test";
import { adminModel, publicModel, publicUsageRecord, safeAdminAuditLog } from "./serializers.js";
import type { ModelConfig, ModelUsageRecord } from "./types.js";

const model: ModelConfig = {
  id: "model-a", name: "ONE Assistant", provider: "private-gateway", kind: "chat", protocol: "anthropic",
  baseUrl: "https://private-provider.example/v1", apiKey: "plain-secret", encryptedApiKey: "encrypted-secret",
  model: "upstream-model-id", systemPrompt: "private platform prompt", enabled: true, isDefault: true,
  inputPowerPerMillion: 3, outputPowerPerMillion: 15, costInputPowerPerMillion: 2, costOutputPowerPerMillion: 10,
  createdAt: "2026-09-12T00:00:00Z"
};

test("user model choices expose only display data and cannot reveal supplier configuration", () => {
  assert.deepEqual(publicModel(model), { id: "model-a", name: "ONE Assistant", kind: "chat", isDefault: true });
});

test("admin model editor gets configuration but never credentials", () => {
  const result = adminModel(model);
  assert.equal(result.baseUrl, model.baseUrl);
  assert.equal(result.model, model.model);
  assert.equal(result.costInputPowerPerMillion, 2);
  assert.equal(result.hasApiKey, true);
  assert.equal("apiKey" in result, false);
  assert.equal("encryptedApiKey" in result, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("personal billing contains charged usage but no procurement cost or future private fields", () => {
  const result = publicUsageRecord({ id: "usage-a", chargedMicros: 500, costMicros: 200,
    inputPowerPerMillionSnapshot: 3, costInputPowerPerMillionSnapshot: 2, costOutputPowerPerMillionSnapshot: 10,
    privatePrompt: "do not expose" } as unknown as ModelUsageRecord);
  assert.equal(result.chargedMicros, 500);
  assert.equal(result.inputPowerPerMillionSnapshot, 3);
  assert.equal("costMicros" in result, false);
  assert.equal("costInputPowerPerMillionSnapshot" in result, false);
  assert.equal("costOutputPowerPerMillionSnapshot" in result, false);
  assert.equal("privatePrompt" in result, false);
});

test("operational audits cannot include provider error bodies or private document details", () => {
  const result = safeAdminAuditLog({ id: "audit-a", action: "knowledge.recall.failed", targetType: "knowledge_connection",
    details: { error: "private knowledge body", token: "secret" }, requestId: "req-a", createdAt: "2026-09-12T00:00:00Z" });
  assert.equal(result.action, "knowledge.recall.failed");
  assert.equal(result.requestId, "req-a");
  assert.equal("details" in result, false);
});
