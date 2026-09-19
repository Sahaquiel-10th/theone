import express, { type Express, type RequestHandler } from "express";
import QRCode from "qrcode";
import type { Store } from "./db.js";
import { preparePayment, publicPayment, settlePayment } from "./payments.js";
import { decodePaymentNotification, wechatConfig, wechatReady, wechatRequest } from "./wechatPay.js";
import { publicUsageRecord } from "./serializers.js";

export function installPaymentCallback(app: Express, store: Store) {
  app.post("/api/pay/wechat/notify", express.raw({ type: "application/json", limit: "128kb" }), async (req, res) => {
    try {
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const remote = decodePaymentNotification(headers, req.body.toString("utf8"));
      if (remote) await store.mutate(db => settlePayment(db, remote));
      res.status(204).end();
    } catch { res.status(400).json({ code: "FAIL", message: "支付通知未完成核验" }); }
  });
}
export function installPaymentRoutes(app: Express, keyAuth: readonly RequestHandler[], store: Store) {
  app.post("/api/me/payments/wechat", ...keyAuth, async (req, res) => {
    try {
      if (!wechatReady()) return res.status(503).json({ error: "微信支付尚未配置" });
      const scope = { workspaceId: req.workspaceId!, userId: req.user!.id }, c = wechatConfig();
      const prepared = await store.mutate(db => preparePayment(db, scope, String(req.body.operationId ?? ""), Number(req.body.power), c));
      const order = prepared.order, p = order.payment!;
      if (prepared.created) {
        try {
          const remote = await wechatRequest("POST", "/v3/pay/transactions/native", { appid: p.appId, mchid: p.mchId, description: `ONE ${order.requestedMicros / 1e6} 电力`,
            out_trade_no: order.id, time_expire: p.expiresAt, notify_url: c.notifyUrl, amount: { total: p.amountFen, currency: "CNY" } });
          if (typeof remote.code_url !== "string" || !remote.code_url.startsWith("weixin://wxpay/")) throw new Error("无效二维码");
          await store.mutate(db => { const current = db.rechargeOrders.find(o => o.id === order.id)!; if (current.status === "pending") { current.payment!.codeUrl = remote.code_url; current.payment!.state = "pending"; } });
        } catch {
          await store.mutate(db => { const current = db.rechargeOrders.find(o => o.id === order.id)!; if (current.status === "pending") current.payment!.state = "uncertain"; });
        }
      }
      const saved = (await store.read()).rechargeOrders.find(o => o.id === order.id)!;
      res.json({ order: publicPayment(saved), qrCode: saved.status === "pending" && saved.payment?.codeUrl && Date.parse(saved.payment.expiresAt) > Date.now() ? await QRCode.toDataURL(saved.payment.codeUrl) : null });
    } catch { res.status(400).json({ error: "未能创建支付订单，请检查金额或已有订单" }); }
  });
  app.post("/api/me/payments/:id/check", ...keyAuth, async (req, res) => {
    const order = (await store.read()).rechargeOrders.find(o => o.id === req.params.id && o.workspaceId === req.workspaceId && o.userId === req.user!.id);
    if (!order?.payment) return res.status(404).json({ error: "订单不存在" });
    try {
      if (order.status !== "paid") {
        const remote = await wechatRequest("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.id)}?mchid=${encodeURIComponent(order.payment.mchId)}`);
        if (remote.trade_state === "SUCCESS") await store.mutate(db => settlePayment(db, remote));
      }
      res.json({ order: publicPayment((await store.read()).rechargeOrders.find(o => o.id === order.id)!) });
    } catch { res.status(502).json({ error: "暂时无法核对微信订单，请稍后重试" }); }
  });
  app.get("/api/me/billing/history", ...keyAuth, async (req, res) => {
    const db = await store.read(), kind = req.query.kind;
    const page = Math.max(1, Math.min(1000000, Math.floor(Number(req.query.page) || 1))), pageSize = 10;
    const own = (r: { workspaceId: string; userId: string }) => r.workspaceId === req.workspaceId && r.userId === req.user!.id;
    const records = kind === "orders" ? db.rechargeOrders.filter(own).map(publicPayment)
      : kind === "usage" ? db.modelUsageRecords.filter(own).map(publicUsageRecord) : db.powerLedger.filter(own);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    res.json({ items: records.slice((page - 1) * pageSize, page * pageSize), page, total: records.length, pageSize });
  });
}
