import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Database } from "./types.js";
import { preparePayment, settlePayment } from "./payments.js";
import { verifyPaymentSignature } from "./wechatPay.js";
import { publishPricing, effectiveModel } from "./modelPricing.js";
function fixture() {
  return { users: [{ id: "u", enabled: true, role: "admin" }, { id: "v", enabled: true }],
    workspaces: [{ id: "w", status: "active" }, { id: "x", status: "active" }], workspaceMembers: [{ userId: "u", workspaceId: "w" }, { userId: "v", workspaceId: "x" }],
    rechargeOrders: [], powerLedger: [], auditLogs: [], powerAccounts: [{ id: "a", userId: "u", workspaceId: "w", balanceMicros: 0 }, { id: "b", userId: "v", workspaceId: "x", balanceMicros: 0 }],
    settings: { rechargeCnyPerPower: 7 }, models: [{ id: "m", kind: "chat", name: "test", inputPowerPerMillion: 10, outputPowerPerMillion: 20 }] } as unknown as Database;
}
test("payment replay freezes recharge exchange rate and settlement credits only the exact owner once", () => {
  const db = fixture(), scope = { userId: "u", workspaceId: "w" }, config = { appId: "app", mchId: "merchant" };
  const first = preparePayment(db, scope, "operation-123456789", 100, config);
  assert.match(first.order.id, /^ONE[0-9a-f]{29}$/);
  db.settings.rechargeCnyPerPower = 8;
  assert.equal(preparePayment(db, scope, "operation-123456789", 100, config).order.amountCny, 700);
  assert.throws(() => preparePayment(db, { userId: "u", workspaceId: "x" }, "operation-123456789", 100, config));
  assert.throws(() => preparePayment(db, scope, "operation-123456789", 50, config));
  const remote = { out_trade_no: first.order.id, appid: "app", mchid: "merchant", trade_state: "SUCCESS", amount: { total: 70000, currency: "CNY" }, transaction_id: "wx-transaction" };
  for (const change of [{ appid: "bad" }, { mchid: "bad" }, { amount: { total: 1, currency: "CNY" } }]) assert.throws(() => settlePayment(db, { ...remote, ...change }));
  settlePayment(db, remote);
  const restored = JSON.parse(JSON.stringify(db)); settlePayment(restored, remote);
  assert.equal(restored.powerLedger.length, 1); assert.deepEqual(restored.powerAccounts.map((a: any) => a.balanceMicros), [100e6, 0]);
  const second = preparePayment(db, { userId: "v", workspaceId: "x" }, "operation-123456789", 100, config);
  assert.throws(() => settlePayment(db, { ...remote, out_trade_no: second.order.id, amount: { total: 80000, currency: "CNY" } }), /已入账/);
});
test("custom yuan recharge freezes fen and micro-power, isolates owners, and settles once", () => {
  const db = fixture(), scope = { userId: "u", workspaceId: "w" }, config = { appId: "app", mchId: "merchant" };
  const op = "custom-operation-12345";
  const first = preparePayment(db, scope, op, { amountFen: 1 }, config).order;
  assert.equal(first.amountCny, 0.01); assert.equal(first.requestedMicros, 1428);
  db.settings.rechargeCnyPerPower = 8;
  assert.deepEqual(preparePayment(db, scope, op, { amountFen: 1 }, config).order, first);
  assert.throws(() => preparePayment(db, scope, op, { amountFen: 2 }, config));
  assert.throws(() => preparePayment(db, scope, op, 1, config));
  assert.throws(() => preparePayment(db, { userId: "u", workspaceId: "x" }, op, { amountFen: 1 }, config));
  const other = preparePayment(db, { userId: "v", workspaceId: "x" }, op, { amountFen: 1 }, config).order;
  assert.notEqual(first.id, other.id);
  const remote = { out_trade_no: first.id, appid: "app", mchid: "merchant", trade_state: "SUCCESS", amount: { total: 1, currency: "CNY" }, transaction_id: "wx-custom" };
  settlePayment(db, remote); settlePayment(db, remote);
  assert.deepEqual(db.powerAccounts.map(a => a.balanceMicros), [1428, 0]);
  assert.equal(db.powerLedger.length, 1);
});
test("custom recharge rejects malformed, out-of-range and zero-credit amounts", () => {
  const db = fixture(), scope = { userId: "u", workspaceId: "w" }, config = { appId: "app", mchId: "merchant" };
  for (const amountFen of [0, -1, 0.5, 1000001, NaN, Infinity, "1", true, null, undefined]) {
    assert.throws(() => preparePayment(db, scope, "invalid-operation-123", { amountFen: amountFen as number }, config));
  }
  db.settings.rechargeCnyPerPower = 100000;
  assert.throws(() => preparePayment(db, scope, "invalid-operation-123", { amountFen: 1 }, config));
  assert.equal(db.rechargeOrders.length, 0);
});
test("legacy ONE payment retries keep their merchant order number and do not create a second order", () => {
  const db = fixture(), scope = { userId: "u", workspaceId: "w" }, config = { appId: "app", mchId: "merchant" };
  const operationId = "operation-123456789";
  preparePayment(db, scope, operationId, 10, config);
  const legacyId = crypto.createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.userId, operationId])).digest("hex").slice(0, 32);
  db.rechargeOrders[0].id = legacyId;
  const retried = preparePayment(db, scope, operationId, 10, config);
  assert.equal(retried.created, false); assert.equal(retried.order.id, legacyId);
  assert.equal(db.rechargeOrders.length, 1);
});
test("payment signature rejects a modified body, untrusted key id, and stale notification", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), body = '{"event":"test"}', time = String(Math.floor(Date.now() / 1000));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${time}\nnonce\n${body}\n`), pair.privateKey).toString("base64");
  const headers = new Headers({ "wechatpay-timestamp": time, "wechatpay-nonce": "nonce", "wechatpay-signature": signature, "wechatpay-serial": "serial" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  verifyPaymentSignature(headers, body, publicKey, "serial");
  assert.throws(() => verifyPaymentSignature(headers, body + " ", publicKey, "serial"));
  assert.throws(() => verifyPaymentSignature(headers, body, publicKey, "other"));
  headers.set("wechatpay-timestamp", "1"); assert.throws(() => verifyPaymentSignature(headers, body, publicKey, "serial"));
});
test("price publication preserves prior request snapshot and never changes wallet balances", () => {
  const db = fixture();
  publishPricing(db, "m", "u", { referenceInput: 10, referenceOutput: 20, multiplier: 0.8, costInput: 2, costOutput: 4 });
  const first = effectiveModel(db.models[0]); assert.equal(first.inputPowerPerMillion, 8);
  publishPricing(db, "m", "u", { referenceInput: 10, referenceOutput: 20, multiplier: 1.2, costInput: 10, costOutput: 20 });
  assert.equal(first.pricing?.version, 1); assert.equal(first.inputPowerPerMillion, 8);
  assert.equal(effectiveModel(db.models[0]).inputPowerPerMillion, 12); assert.equal(db.models[0].pricing?.label, "含 20% 服务费");
  assert.equal(db.powerAccounts[0].balanceMicros, 0); assert.equal(db.auditLogs.length, 2);
  assert.throws(() => publishPricing(db, "m", "v", {}), /超管/);
});
