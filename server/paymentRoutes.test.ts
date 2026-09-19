import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { Database } from "./types.js";
import { installPaymentRoutes } from "./paymentRoutes.js";

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
