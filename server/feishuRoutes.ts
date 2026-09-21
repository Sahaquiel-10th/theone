import type { Express, RequestHandler } from "express";
import type { Store } from "./db.js";
import { asyncRoute } from "./middleware.js";
import type { FeishuService } from "./knowledge/feishuService.js";
export function installFeishuRoutes(app: Express, keyAuth: readonly RequestHandler[], store: Store, service: FeishuService, enabled: () => boolean) {
  const base = "/api/knowledge/connections/feishu";
  const gate: RequestHandler = (_req, res, next) => enabled() ? next() : res.status(403).json({ error: "飞书连接已停用" });
  app.get(base, ...keyAuth, asyncRoute(async (req, res) => {
    const c = (await store.read()).knowledgeConnections.find(c => c.workspaceId === req.workspaceId && c.provider === "feishu" && c.status !== "revoked");
    res.json({ ...service.setup(), configured: enabled() && service.configured(), connection: { provider: "feishu", status: c?.status || "disconnected", providerSpaceName: c?.providerSpaceName, accountId: c?.providerUserId } });
  }));
  app.post(base + "/oauth/start", ...keyAuth, gate, asyncRoute(async (req, res) => { res.json(await service.begin({ workspaceId: req.workspaceId!, userId: req.user!.id })); }));
  app.get(base + "/oauth/callback", asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    const state = typeof req.query.state === "string" && req.query.state.length <= 512 ? req.query.state : "";
    const code = typeof req.query.code === "string" && req.query.code.length <= 4096 ? req.query.code : "";
    let status = "failed";
    try { if (!enabled() || req.query.error || !state || !code) { await service.cancel(state); } else { await service.complete(state, code); status = "connected"; } } catch { /* Never log authorization codes or provider bodies. */ }
    res.redirect(303, `/?knowledge=feishu&status=${status}`);
  }));
  app.delete(base, ...keyAuth, asyncRoute(async (req, res) => { await service.disconnect({ workspaceId: req.workspaceId!, userId: req.user!.id }); res.json({ ok: true }); }));
  app.post(base + "/documents", ...keyAuth, gate, asyncRoute(async (req, res) => {
    if (req.body.confirmed !== true || ["operationId", "sourceMessageId", "title", "expectedAccount"].some(k => typeof req.body[k] !== "string")) { res.status(400).json({ error: "请先预览并确认保存内容及飞书账号" }); return; }
    const receipt = await service.saveAnswer({ workspaceId: req.workspaceId!, userId: req.user!.id }, req.body);
    res.json({ receipt });
  }));
}
