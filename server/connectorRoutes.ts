import { Router } from "express";
import { ConnectorAccessError, type ConnectorService } from "./connectorService.js";
import type { ConnectorScope } from "./connectors/registry.js";

// Must be mounted after the existing session / ONE Key proof middleware.
// Request bodies, query strings and headers cannot override this identity.
export function connectorRoutes(service: ConnectorService) {
  const router = Router();
  router.use((req, res, next) => {
    if (!req.user || !req.workspaceId) return res.status(401).json({ error: "未登录", code: "AUTH_REQUIRED" });
    next();
  });
  router.get("/", async (req, res, next) => {
    try {
      const scope: ConnectorScope = { userId: req.user!.id, workspaceId: req.workspaceId!, deviceId: req.oneKeyDeviceId };
      res.json({ connectors: await service.list(scope) });
    } catch (error) { next(error); }
  });
  router.post("/:id/check", async (req, res, next) => {
    try {
      const scope: ConnectorScope = { userId: req.user!.id, workspaceId: req.workspaceId!, deviceId: req.oneKeyDeviceId };
      res.json(await service.check(scope, String(req.params.id)));
    } catch (error) { next(error); }
  });
  router.use((error: Error, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof ConnectorAccessError) return res.status(404).json({ error: "连接器不存在或无权访问", code: "CONNECTOR_NOT_FOUND" });
    next(error);
  });
  return router;
}
