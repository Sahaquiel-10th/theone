import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { Database } from "./types.js";
import { installAdminPaymentRoutes, installPaymentRoutes } from "./paymentRoutes.js";

test("admin payment check verifies exact order and credits only its owner once", async t => {
  const db = { rechargeOrders: [{ id: "one-a", workspaceId: "wa", userId: "a", status: "pending", requestedMicros: 1000000, payment: { mchId: "merchant", appId: "app", amountFen: 700 } }], powerAccounts: [{ userId: "a", workspaceId: "wa", balanceMicros: 0 }, { userId: "b", workspaceId: "wb", balanceMicros: 0 }], powerLedger: [], auditLogs: [] } as unknown as Database;
  let calls = 0;
  let remote: any = { out_trade_no: "one-a", trade_state: "NOTPAY" };
  const app = express(); app.use(express.json());
  installAdminPaymentRoutes(app, [(req, res, next) => { if (req.headers.authorization !== "admin-key") return res.sendStatus(403); next(); }], { read: async () => db, mutate: async f => f(db) }, async () => { calls++; return remote; });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/admin/recharge-orders/one-a/check`;
  const check = (auth = "admin-key") => fetch(url, { method: "POST", headers: { authorization: auth } });
  assert.equal((await check("user-key")).status, 403); assert.equal(calls, 0);
  assert.equal((await check()).status, 200); assert.equal(db.powerLedger.length, 0);
  remote = { out_trade_no: "other", trade_state: "SUCCESS", appid: "app", mchid: "merchant", amount: { total: 700, currency: "CNY" }, transaction_id: "transaction" };
  assert.equal((await check()).status, 502); assert.equal(db.powerLedger.length, 0);
  remote.out_trade_no = "one-a"; remote.amount.total = 1;
  assert.equal((await check()).status, 502); assert.equal(db.powerLedger.length, 0);
  remote.amount.total = 700;
  assert.equal((await check()).status, 200); assert.equal((await check()).status, 200);
  assert.deepEqual(db.powerAccounts.map(a => a.balanceMicros), [1000000, 0]); assert.equal(db.powerLedger.length, 1);
});

test("billing HTTP pagination is owner-scoped and rejects a foreign payment before contacting WeChat", async t => {
  const db = { rechargeOrders: [ { id: "foreign", workspaceId: "w2", userId: "b", payment: { channel: "wechat" } } ],
    modelUsageRecords: Array.from({ length: 25 }, (_, i) => ({ id: String(i), workspaceId: i === 24 ? "w2" : "w", userId: i === 24 ? "b" : "a", createdAt: new Date(1000 + i).toISOString(), costMicros: 777, chargedMicros: 1 })), powerLedger: [
      { workspaceId: "w", userId: "a", type: "usage", amountMicros: -123 },
      { workspaceId: "w2", userId: "a", type: "usage", amountMicros: -999 },
      { workspaceId: "w", userId: "b", type: "usage", amountMicros: -999 },
      { workspaceId: "w", userId: "a", type: "gift", amountMicros: 1000 }
    ] } as unknown as Database;
  const app = express(); app.use(express.json());
  installPaymentRoutes(app, [(req, res, next) => { if (req.headers.authorization !== "test-key") return res.sendStatus(401); req.user = { id: "a" } as any; req.workspaceId = "w"; next(); }], { read: async () => db, mutate: async f => f(db) });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal((await fetch(`${base}/api/me/billing/history`)).status, 401);
  assert.equal((await fetch(`${base}/api/me/billing/summary`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/me/billing/summary?workspaceId=w2`, { headers: { authorization: "test-key" } })).json(), { spentMicros: 123 });
  const result = await (await fetch(`${base}/api/me/billing/history?kind=usage&page=2&workspaceId=w2`, { headers: { authorization: "test-key" } })).json() as any;
  assert.equal(result.total, 24); assert.equal(result.items.length, 10); assert.ok(result.items.every((i: any) => i.workspaceId === "w" && i.userId === "a" && !("costMicros" in i)));
  assert.equal((await fetch(`${base}/api/me/payments/foreign/check`, { method: "POST", headers: { authorization: "test-key" } })).status, 404);
});
