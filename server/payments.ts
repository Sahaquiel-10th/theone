import crypto from "node:crypto";
import type { Database, RechargeOrder } from "./types.js";
import { creditPower } from "./powerBilling.js";
import { uid } from "./security.js";

export function preparePayment(db: Database, scope: { workspaceId: string; userId: string }, operationId: string, intent: number | { amountFen: number }, config: { appId: string; mchId: string }) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw new Error("订单编号无效");
  const custom = typeof intent === "object" && intent !== null;
  const power = typeof intent === "number" ? intent : 0;
  const fen = custom ? intent.amountFen : 0;
  if (custom ? !Number.isSafeInteger(fen) || fen < 1 || fen > 1000000 : !Number.isInteger(power) || power < 1 || power > 10000) throw new Error("请输入 ¥0.01 至 ¥10000，或选择 1 至 10000 整数电力");
  if (!db.users.some(u => u.id === scope.userId && u.enabled) || !db.workspaceMembers.some(m => m.userId === scope.userId && m.workspaceId === scope.workspaceId)
    || !db.workspaces.some(w => w.id === scope.workspaceId && w.status === "active")) throw new Error("电力账户不可用");
  const digest = crypto.createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.userId, operationId])).digest("hex");
  // WeChat merchant order numbers share a namespace across our applications.
  // Keep old ONE retries valid, but issue all new orders in ONE's own namespace.
  const id = `ONE${digest.slice(0, 29)}`;
  const existing = db.rechargeOrders.find(o => (o.id === id || o.id === digest.slice(0, 32))
    && o.workspaceId === scope.workspaceId && o.userId === scope.userId);
  if (existing) {
    if (custom ? existing.payment?.amountMode !== "cny" || existing.payment.amountFen !== fen : existing.payment?.amountMode === "cny" || existing.requestedMicros !== power * 1e6) throw new Error("订单重试金额不一致");
    return { order: structuredClone(existing), created: false };
  }
  const rate = db.settings.rechargeCnyPerPower, amountFen = custom ? fen : Math.round(power * rate * 100);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(amountFen) || amountFen < 1) throw new Error("充值汇率无效");
  // Round down to the ledger's micro-power precision; never credit more than purchased.
  const requestedMicros = custom ? Math.floor(amountFen * 10000 / rate) : power * 1e6;
  if (!Number.isSafeInteger(requestedMicros) || requestedMicros < 1) throw new Error("充值金额过小或汇率无效");
  if (db.rechargeOrders.filter(o => o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.status === "pending" && o.payment && Date.parse(o.payment.expiresAt) > Date.now()).length >= 3) throw new Error("请先完成已有订单");
  const order: RechargeOrder = { id, ...scope, requestedMicros, amountCny: amountFen / 100, cnyPerPowerSnapshot: rate, status: "pending", createdAt: new Date().toISOString(),
    payment: { channel: "wechat", amountMode: custom ? "cny" : "power", appId: config.appId, mchId: config.mchId, amountFen, expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), state: "creating" } };
  db.rechargeOrders.push(order); return { order: structuredClone(order), created: true };
}

// Both verified callbacks and signed active reconciliation use this one idempotent transaction.
export function settlePayment(db: Database, remote: any) {
  const order = db.rechargeOrders.find(o => o.id === remote?.out_trade_no), p = order?.payment;
  if (!order || !p || remote.trade_state !== "SUCCESS" || remote.appid !== p.appId || remote.mchid !== p.mchId
    || remote.amount?.total !== p.amountFen || remote.amount?.currency !== "CNY" || typeof remote.transaction_id !== "string" || !remote.transaction_id) throw new Error("支付通知与订单不匹配");
  if (order.status === "paid") { if (p.transactionId !== remote.transaction_id) throw new Error("交易号不匹配"); return; }
  if (db.rechargeOrders.some(o => o.id !== order.id && o.payment?.transactionId === remote.transaction_id)) throw new Error("交易号已入账");
  const entry = creditPower(db, { workspaceId: order.workspaceId, userId: order.userId, amountMicros: order.requestedMicros, type: "recharge", title: "微信充值", batchId: order.id });
  order.status = "paid"; order.paidAt = entry.createdAt; p.state = "paid"; p.transactionId = remote.transaction_id;
  db.auditLogs.push({ id: uid("aud"), workspaceId: order.workspaceId, action: "payment.credited", targetType: "recharge_order", targetId: order.id,
    details: { ledgerId: entry.id, amountFen: p.amountFen, amountMicros: entry.amountMicros }, createdAt: entry.createdAt });
}

export function publicPayment(order: RechargeOrder) {
  return { id: order.id, requestedMicros: order.requestedMicros, amountCny: order.amountCny, status: order.status,
    cnyPerPowerSnapshot: order.cnyPerPowerSnapshot, createdAt: order.createdAt, paidAt: order.paidAt, expiresAt: order.payment?.expiresAt };
}
