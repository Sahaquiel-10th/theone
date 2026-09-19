import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "./types.js";
import { batchGift } from "./batchGift.js";

function fixture() {
  return { users: ["a", "b", "c"].map(id => ({ id, role: id === "a" ? "admin" : "user", enabled: id !== "c", defaultWorkspaceId: id })),
    workspaces: ["a", "b", "c"].map(id => ({ id, status: "active" })), workspaceMembers: ["a", "b", "c"].map(id => ({ userId: id, workspaceId: id })),
    powerAccounts: ["a", "b", "c"].map(id => ({ id, userId: id, workspaceId: id, balanceMicros: 5 })), powerLedger: [], auditLogs: [] } as unknown as Database;
}
test("batch gifts commit exact scoped receipts, skip disabled users, and replay after restart without another credit", () => {
  const db = fixture(); const id = "operation-123456789";
  const result = batchGift(db, "a", id, 100, "test");
  assert.equal(result.recipientCount, 2);
  assert.deepEqual(db.powerAccounts.map(a => a.balanceMicros), [105, 105, 5]);
  assert.deepEqual(db.powerLedger.map(a => [a.workspaceId, a.userId]), [["a", "a"], ["b", "b"]]);
  const restored = JSON.parse(JSON.stringify(db));
  assert.deepEqual(batchGift(restored, "a", id, 100, "test"), result);
  assert.equal(restored.powerLedger.length, 2);
  assert.throws(() => batchGift(db, "a", id, 200, "test"), /不一致/);
});
test("nonadmins and corrupt memberships/accounts cannot receive partial batch writes", () => {
  const db = fixture();
  assert.throws(() => batchGift(db, "b", "operation-123456789", 100, "test"), /超管/);
  db.powerAccounts[1].workspaceId = "a";
  assert.throws(() => batchGift(db, "a", "operation-123456789", 100, "test"), /异常/);
  assert.equal(db.powerAccounts[0].balanceMicros, 5); assert.equal(db.powerLedger.length, 0);
});
