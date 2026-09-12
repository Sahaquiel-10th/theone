import assert from "node:assert/strict";
import test from "node:test";
import type { Database, ModelConfig } from "./types.js";
import type { Store } from "./db.js";
import { modelReservationMicros, reconcileInterruptedBilling, resolveBillingReview, runBilledModel, settleBillingRecord } from "./modelBilling.js";

function fixture() {
  const model = { id: "model", kind: "chat", name: "Test", enabled: true, systemPrompt: "rule", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 2 } as ModelConfig;
  let db = { users: [{ id: "a", enabled: true }, { id: "b", enabled: true }], workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }], models: [model], modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "pa", userId: "a", workspaceId: "wa", balanceMicros: 1_000_000 }, { id: "pb", userId: "b", workspaceId: "wb", balanceMicros: 1_000_000 }] } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(change: (data: Database) => T) => {
    const next = queue.then(() => { const before = structuredClone(db); try { return change(db); } catch (error) { db = before; throw error; } });
    queue = next.catch(() => undefined); return next;
  } };
  const params = { workspaceId: "wa", userId: "a", conversationId: "conversation", model, input: "hello", activity: "chat", requestId: "server-request" };
  return { store, params, model, db: () => db };
}
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" };
const scope = (id: string) => ({ usageId: id, workspaceId: "wa", userId: "a" });

test("durable billing charges once and freezes prices while the model runs", async () => {
  const f = fixture();
  await runBilledModel(f.store, f.params, async (model) => {
    assert.equal(model.inputPowerPerMillion, 2);
    f.model.inputPowerPerMillion = 100;
    return { usage, content: "done" };
  });
  const row = f.db().modelUsageRecords[0];
  assert.equal(row.chargedMicros, 40);
  assert.equal(row.costMicros, 20);
  assert.equal(row.inputPowerPerMillionSnapshot, 2);
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  settleBillingRecord(f.db(), scope(row.id), usage, 1);
  assert.equal(f.db().powerLedger.length, 1);
  assert.equal(f.db().powerAccounts[0].balanceMicros, 999_960);
});

test("simultaneous calls cannot both reserve the last available balance", async () => {
  const f = fixture(); const hold = modelReservationMicros(f.model, f.params.input);
  f.db().powerAccounts[0].balanceMicros = hold;
  let resume!: () => void; let entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  const first = runBilledModel(f.store, f.params, async () => { entered(); await wait; return { usage }; });
  await began;
  let secondCalled = false;
  await assert.rejects(runBilledModel(f.store, f.params, async () => { secondCalled = true; return { usage }; }), /电力不足/);
  assert.equal(secondCalled, false);
  resume(); await first;
  assert.equal(f.db().powerLedger.length, 1);
});

test("unknown usage retains a review hold; another tenant and duplicate resolution cannot spend it", async () => {
  const f = fixture();
  const result = await runBilledModel(f.store, f.params, async () => ({ content: "answer", usage: undefined }));
  assert.equal(result.content, "answer");
  const row = f.db().modelUsageRecords[0]; const held = row.reservedMicros!;
  assert.equal(row.status, "needs_review"); assert.ok(held > 0);
  assert.equal(f.db().powerLedger.length, 0);
  await assert.rejects(runBilledModel(f.store, f.params, async () => ({ usage })), /核对/);
  assert.throws(() => resolveBillingReview(f.db(), { ...scope(row.id), workspaceId: "wb", userId: "b", action: "waive" }), /不属于/);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 10, outputTokens: 5 });
  resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 10, outputTokens: 5 });
  assert.equal(f.db().powerLedger.length, 1);
  assert.equal(f.db().powerAccounts[1].balanceMicros, 1_000_000);
});

test("provider failure records duration and releases its own reservation without charging", async () => {
  const f = fixture();
  await assert.rejects(runBilledModel(f.store, f.params, async () => { throw Error("upstream secret body"); }), /upstream/);
  assert.equal(f.db().modelUsageRecords[0].status, "failed");
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  assert.equal(f.db().powerLedger.length, 0);
  assert.ok(!JSON.stringify(f.db()).includes("secret body"));
});

test("a transient DB failure while releasing a failed call leaves a reviewable hold", async () => {
  const f = fixture();
  const mutate = f.store.mutate.bind(f.store);
  let writes = 0;
  f.store.mutate = async <T>(change: (db: Database) => T): Promise<T> => {
    if (++writes === 2) throw Error("transient storage failure");
    return mutate(change);
  };
  await assert.rejects(runBilledModel(f.store, f.params, async () => { throw Error("upstream failed"); }), /upstream failed/);
  const row = f.db().modelUsageRecords[0];
  assert.equal(row.status, "needs_review");
  assert.equal(row.reviewReason, "failure_release_storage_failed");
  assert.ok(f.db().powerAccounts[0].reservedMicros! > 0);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  assert.equal(f.db().powerAccounts[0].balanceMicros, 1_000_000);
});

test("a provider overrun returns the answer, caps retail and records full modeled cost", async () => {
  const f = fixture(); const hold = modelReservationMicros(f.model, f.params.input);
  const result = await runBilledModel(f.store, f.params, async () => ({ content: "done", usage: { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, source: "provider" } }));
  const row = f.db().modelUsageRecords[0];
  assert.equal(result.content, "done"); assert.equal(row.chargedMicros, hold); assert.equal(row.billingCapped, true);
  assert.equal(row.costMicros, 300_000); assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
});

test("restart preserves uncertain holds and explicit waiver releases them idempotently", async () => {
  const f = fixture();
  await runBilledModel(f.store, f.params, async () => ({ usage: undefined }));
  const row = f.db().modelUsageRecords[0]; row.status = "pending";
  const hold = row.reservedMicros;
  reconcileInterruptedBilling(f.db()); reconcileInterruptedBilling(f.db());
  assert.equal(row.status, "needs_review"); assert.equal(f.db().powerAccounts[0].reservedMicros, hold);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0); assert.equal(f.db().powerAccounts[0].balanceMicros, 1_000_000);
});

test("image calls require explicit fixed prices and do not silently become free", async () => {
  const f = fixture(); f.model.kind = "image";
  let called = false;
  await assert.rejects(runBilledModel(f.store, f.params, async () => { called = true; return { usage }; }), /尚未配置/);
  assert.equal(called, false);
  f.model.imagePowerPerCall = 0.2; f.model.costImagePowerPerCall = 0.1;
  await runBilledModel(f.store, f.params, async () => ({ usage: undefined }));
  assert.equal(f.db().modelUsageRecords[0].source, "fixed");
  assert.equal(f.db().modelUsageRecords[0].chargedMicros, 200_000);
  assert.equal(f.db().modelUsageRecords[0].costMicros, 100_000);
});

test("disabled accounts and forged workspace bindings never call the upstream", async () => {
  const f = fixture(); let called = false;
  const call = async () => { called = true; return { usage }; };
  await assert.rejects(runBilledModel(f.store, { ...f.params, workspaceId: "wb" }, call), /不可用/);
  f.db().users[0].enabled = false;
  await assert.rejects(runBilledModel(f.store, f.params, call), /不可用/);
  assert.equal(called, false); assert.equal(f.db().modelUsageRecords.length, 0);
});
