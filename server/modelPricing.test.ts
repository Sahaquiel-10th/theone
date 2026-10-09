import test from "node:test";
import assert from "node:assert/strict";
import { publishPricing, effectiveModel, publicPrices, cancelScheduledPricing } from "./modelPricing.js";
import type { Database } from "./types.js";
import { calculateModelPower } from "./powerBilling.js";
const fixture = () => ({ users: [{ id: "admin", enabled: true, role: "admin" }, { id: "u", enabled: true, role: "user" }], models: [{ id: "m", kind: "chat", name: "Test", apiKey: "secret", enabled: true, inputPowerPerMillion: 10, outputPowerPerMillion: 20, costInputPowerPerMillion: 2, costOutputPowerPerMillion: 4 }], auditLogs: [] }) as unknown as Database;
const draft = { referenceInput: 10, referenceOutput: 20, multiplier: 0.8, costInput: 1, costOutput: 2, explanation: "内测优惠八折" };
const tierDraft = { referenceInput: 2, referenceOutput: 10, referenceCache: { read: .1, write: 2.5, write1h: 2.5 }, multiplier: .6, procurementMultiplier: .1, explanation: "上下文分档", longContext: { thresholdInputTokens: 272000, referenceInput: 4, referenceOutput: 15, referenceCache: { read: .2, write: 5, write1h: 5 } } };
test("272K boundary prices the full request including cached input, never output", () => {
  const db = fixture(); publishPricing(db, "m", "admin", tierDraft);
  const model = effectiveModel(db.models[0]);
  for (const input of [271999, 272000, 272001]) {
    const actual = calculateModelPower(model, input, 100);
    assert.equal(actual.chargedMicros, Math.ceil(input * (input > 272000 ? 2.4 : 1.2) + 100 * (input > 272000 ? 9 : 6) - 1e-7));
    assert.equal(actual.costMicros, Math.ceil(input * (input > 272000 ? .4 : .2) + 100 * (input > 272000 ? 1.5 : 1) - 1e-7));
  }
  const cached = { read: 271900, write: 100, write1h: 40, write5m: 60 };
  assert.equal(calculateModelPower(model, 1, 100, cached).chargedMicros, Math.ceil(2.4 + 900 + 271900 * .12 + 100 * 3 - 1e-7));
  assert.equal(calculateModelPower(model, 1, 300000).chargedMicros, 1800002);
  assert.ok(!JSON.stringify(publicPrices(db.models)).includes("longContextCostPrices"));
});
test("tier schedules preserve original flat rates and costs and cancellation", () => {
  const db = fixture(), when = Date.now() + 3600000;
  publishPricing(db, "m", "admin", { ...tierDraft, effectiveAt: new Date(when).toISOString() });
  const restored = JSON.parse(JSON.stringify(db)) as Database;
  assert.equal(effectiveModel(restored.models[0], when - 1).pricing?.longContext, undefined);
  assert.equal(calculateModelPower(effectiveModel(restored.models[0], when - 1), 272001, 0).chargedMicros, 2720010);
  assert.equal(effectiveModel(restored.models[0], when).longContextCostPrices?.input, .4);
  cancelScheduledPricing(db, "m", "admin");
  assert.equal(effectiveModel(db.models[0], when).pricing?.longContext, undefined);
  for (const invalid of [null, {}, { ...tierDraft.longContext, thresholdInputTokens: 272.1 }, { ...tierDraft.longContext, referenceInput: -1 }, { ...tierDraft.longContext, referenceCache: undefined }]) assert.throws(() => publishPricing(fixture(), "m", "admin", { ...tierDraft, longContext: invalid }));
});
test("one supplier factor derives every cost privately without rewriting previous versions", () => {
  const db = fixture();
  const old = structuredClone(db.models[0]);
  publishPricing(db, "m", "admin", { referenceInput: 10, referenceOutput: 20, referenceCache: { read: 1, write: 12.5, write1h: 20 }, multiplier: .8, procurementMultiplier: .2, explanation: "优惠继续" });
  const active = effectiveModel(db.models[0]);
  assert.equal(active.costInputPowerPerMillion, 2);
  assert.equal(active.costOutputPowerPerMillion, 4);
  assert.deepEqual(active.cacheCostPrices, { read: .2, write: 2.5, write1h: 4 });
  assert.deepEqual(active.cachePrices, { read: .8, write: 10, write1h: 16 });
  assert.equal(db.models[0].pricingHistory![0].pricing.referenceInput, old.inputPowerPerMillion);
  const publicJson = JSON.stringify(publicPrices(db.models));
  for (const privateField of ["procurementMultiplier", "cacheCostPrices", "costInput", "previousInput", "previousOutput"]) assert.ok(!publicJson.includes(privateField));
  assert.throws(() => publishPricing(fixture(), "m", "u", { ...draft, procurementMultiplier: .2 }), /超管/);
  for (const invalid of [-1, NaN, Infinity, 101, "0.2", null]) assert.throws(() => publishPricing(fixture(), "m", "admin", { ...draft, procurementMultiplier: invalid }));
});
test("cache price publication applies retail multiplier but keeps costs private and scheduled", () => {
  const db = fixture(), when = Date.now() + 3600000;
  publishPricing(db, "m", "admin", { ...draft, effectiveAt: new Date(when).toISOString(), referenceCache: { read: .5, write: 6.25, write1h: 10 }, cacheCostPrices: { read: .1, write: 1.25, write1h: 2 } });
  assert.equal(effectiveModel(db.models[0], when - 1).cachePrices, undefined);
  assert.deepEqual(effectiveModel(db.models[0], when).cachePrices, { read: .4, write: 5, write1h: 8 });
  assert.deepEqual(effectiveModel(db.models[0], when).cacheCostPrices, { read: .1, write: 1.25, write1h: 2 });
  assert.ok(!JSON.stringify(publicPrices(db.models, when)).includes("cacheCostPrices"));
});
test("scheduled pricing, procurement and notice share the exact effective boundary after restart", () => {
  const db = fixture(), when = Date.now() + 3600000;
  publishPricing(db, "m", "admin", { ...draft, effectiveAt: new Date(when).toISOString() });
  const restored = JSON.parse(JSON.stringify(db)) as Database;
  const before = effectiveModel(restored.models[0], when - 1), after = effectiveModel(restored.models[0], when);
  assert.equal(before.inputPowerPerMillion, 10); assert.equal(before.costInputPowerPerMillion, 2);
  assert.equal(after.inputPowerPerMillion, 8); assert.equal(after.costInputPowerPerMillion, 1);
  assert.equal(after.pricing?.explanation, draft.explanation);
  assert.equal(publicPrices(restored.models, when - 1)[0].notices[0].status, "scheduled");
  assert.equal(publicPrices(restored.models, when)[0].input, 8);
  assert.equal(publicPrices(restored.models, when)[0].notices[0].status, "active");
  assert.equal(before.inputPowerPerMillion, 10);
  const safe = JSON.stringify(publicPrices(restored.models));
  assert.ok(!safe.includes("secret")); assert.ok(!safe.includes("costInput")); assert.ok(!safe.includes("costOutput"));
});
test("only admins publish/cancel, pending schedules block replacement, cancellation retains history", () => {
  const db = fixture(), when = new Date(Date.now() + 3600000).toISOString();
  assert.throws(() => publishPricing(db, "m", "u", draft), /超管/);
  assert.throws(() => publishPricing(db, "m", "admin", { ...draft, effectiveAt: "invalid" }));
  assert.throws(() => publishPricing(db, "m", "admin", { ...draft, effectiveAt: "2000-01-01" }));
  publishPricing(db, "m", "admin", { ...draft, effectiveAt: when });
  assert.throws(() => publishPricing(db, "m", "admin", draft), /撤回/);
  assert.throws(() => cancelScheduledPricing(db, "m", "u"), /超管/);
  cancelScheduledPricing(db, "m", "admin");
  assert.equal(effectiveModel(db.models[0], Date.parse(when)).inputPowerPerMillion, 10);
  assert.equal(publicPrices(db.models)[0].notices[0].status, "cancelled");
  publishPricing(db, "m", "admin", draft);
  assert.equal(db.models[0].pricing?.version, 2);
  assert.equal(effectiveModel(db.models[0]).inputPowerPerMillion, 8);
  assert.equal(db.models[0].pricingHistory?.length, 3);
});
