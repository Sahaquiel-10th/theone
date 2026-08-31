import assert from "node:assert/strict";
import test from "node:test";
import { calculateModelPower, chargePower, creditPower } from "./powerBilling.js";
import { Database, ModelConfig } from "./types.js";

function database(): Database {
  return {
    users: [], workspaces: [], workspaceMembers: [], conversationFolders: [], models: [], conversations: [], messages: [], userSavedMemories: [], retrievalLogs: [], contextTraces: [], modelUsageRecords: [], knowledgeConnections: [], oneKeyDevices: [], deviceChallenges: [], oneTimeLoginCodes: [],
    powerAccounts: [
      { id: "a", workspaceId: "workspace-a", userId: "user-a", balanceMicros: 5_000_000, createdAt: "now", updatedAt: "now" },
      { id: "b", workspaceId: "workspace-b", userId: "user-b", balanceMicros: 8_000_000, createdAt: "now", updatedAt: "now" }
    ],
    powerLedger: [], rechargeOrders: [], auditLogs: [], agents: [], attachments: [], settings: { safetyRules: "", rechargeCnyPerPower: 7 }
  };
}

test("calculates customer charge and private upstream cost independently", () => {
  const model = { inputPowerPerMillion: 2, outputPowerPerMillion: 8, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 3 } as ModelConfig;
  assert.deepEqual(calculateModelPower(model, 500_000, 250_000), { chargedMicros: 3_000_000, costMicros: 1_250_000 });
});

test("power mutations cannot fall through to another workspace account", () => {
  const db = database();
  assert.throws(() => chargePower(db, { workspaceId: "workspace-a", userId: "user-b", amountMicros: 1_000_000, modelId: "m", usageRecordId: "u", title: "wrong tenant" }), /电力账户不存在/);
  assert.equal(db.powerAccounts[0].balanceMicros, 5_000_000);
  assert.equal(db.powerAccounts[1].balanceMicros, 8_000_000);
});

test("credit and charge append immutable balance snapshots", () => {
  const db = database();
  creditPower(db, { workspaceId: "workspace-a", userId: "user-a", amountMicros: 2_000_000, type: "gift", title: "trial" });
  chargePower(db, { workspaceId: "workspace-a", userId: "user-a", amountMicros: 500_000, modelId: "m", usageRecordId: "u", title: "chat" });
  assert.equal(db.powerAccounts[0].balanceMicros, 6_500_000);
  assert.deepEqual(db.powerLedger.map((item) => [item.amountMicros, item.balanceBeforeMicros, item.balanceAfterMicros]), [[2_000_000, 5_000_000, 7_000_000], [-500_000, 7_000_000, 6_500_000]]);
});
