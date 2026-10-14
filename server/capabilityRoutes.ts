import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import { asyncRoute } from "./middleware.js";
import { adminCapabilityCatalog, type CapabilityRuntimeOptions } from "./capabilityCatalog.js";
import { CoordinatorError, defaultExecutorDefinitions, executorDefaults, setupDefaultExecutors } from "./executorProfiles.js";

export function installCapabilityRoutes(app: Express, admin: readonly RequestHandler[], store: Store, runtime: CapabilityRuntimeOptions = {}) {
  const router = express.Router();
  router.use(...admin);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", asyncRoute(async (_req, res) => {
    const db = await store.read();
    res.json({ items: adminCapabilityCatalog(db, runtime), executorDefaults: executorDefaults(), defaultPlan: defaultExecutorDefinitions.map((definition) => ({ id: definition.id, name: definition.name, family: definition.family, installed: !!db.settings.executorProfiles?.some((profile) => profile.id === definition.id || profile.draft.routingRole === definition.id) })) });
  }));
  router.post("/defaults/setup", asyncRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.publish !== true || Object.keys(body).some((key) => !["publish", "logicModelId", "writingModelId"].includes(key))
      || [body.logicModelId, body.writingModelId].some((id) => id !== undefined && (typeof id !== "string" || id.length > 100)))
      throw new CoordinatorError("请确认创建并启用默认能力方案", 400);
    res.json(await store.mutate((db) => setupDefaultExecutors(db, req.user!.id, body)));
  }));
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof CoordinatorError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
  app.use("/api/admin/capabilities", router);
}
