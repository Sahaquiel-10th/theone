import type { Express, Request, Response, RequestHandler } from "express";
import { ImaError, type ImaService } from "./knowledge/imaService.js";

export function installImaRoutes(app: Express, keyAuth: readonly RequestHandler[], service: ImaService, enabled: () => boolean) {
  const base = "/api/knowledge/connections/ima";
  const handle = (action: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void action(req, res).catch(error => {
      if (error instanceof ImaError) res.status(error.status).json({ error: error.message, code: error.code });
      else res.status(502).json({ error: "ima 连接暂不可用，请稍后重试", code: "IMA_UNAVAILABLE" });
    });
  };
  const gate: RequestHandler = (_req, res, next) => enabled() ? next() : res.status(503).json({ error: "ima 连接暂未开通", code: "CONNECTOR_DISABLED" });
  const scope = (req: Request) => ({ workspaceId: req.workspaceId!, userId: req.user!.id });
  app.get(base, ...keyAuth, handle(async (req, res) => {
    try { const result = await service.state(scope(req)); res.json({ ...result, configured: enabled() }); }
    catch (error) {
      // A normal company member must not see owner configuration, nor a global
      // application error merely because the knowledge catalog was opened.
      if (error instanceof ImaError && error.code === "IMA_ACCESS_DENIED") { res.json({ configured: false, managementRestricted: true, connection: { provider: "ima", status: "disconnected" } }); return; }
      throw error;
    }
  }));
  app.put(base, ...keyAuth, gate, handle(async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => !["clientId", "apiKey"].includes(key)) || typeof req.body.clientId !== "string" || typeof req.body.apiKey !== "string") throw new ImaError("IMA_CREDENTIAL_INVALID", "请填写 ima 官网生成的 Client ID 和 API Key", 400);
    res.json(await service.connect(scope(req), { clientId: req.body.clientId, apiKey: req.body.apiKey }));
  }));
  app.patch(base + "/scope", ...keyAuth, gate, handle(async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => key !== "selectedIds")) throw new ImaError("IMA_SCOPE_INVALID", "请选择要检索的知识库", 400);
    res.json(await service.updateScope(scope(req), req.body.selectedIds));
  }));
  app.post(base + "/check", ...keyAuth, gate, handle(async (req, res) => {
    await service.state(scope(req)); await service.verify(req.workspaceId!);
    res.json({ ok: true, message: "ima 读取接口检查通过" });
  }));
  app.post(base + "/libraries/refresh", ...keyAuth, gate, handle(async (req, res) => {
    if (req.body && (Object.keys(req.body).some(key => key !== "query") || (req.body.query !== undefined && typeof req.body.query !== "string"))) throw new ImaError("IMA_QUERY_INVALID", "请输入知识库名称", 400);
    res.json(await service.refreshLibraries(scope(req), req.body?.query));
  }));
  app.post(base + "/search/check", ...keyAuth, gate, handle(async (req, res) => {
    if (!req.body || Object.keys(req.body).some(key => key !== "query") || typeof req.body.query !== "string") throw new ImaError("IMA_QUERY_INVALID", "请输入检索关键词", 400);
    res.json(await service.checkSearch(scope(req), req.body.query));
  }));
  app.delete(base, ...keyAuth, handle(async (req, res) => { await service.disconnect(scope(req)); res.json({ ok: true }); }));
}
