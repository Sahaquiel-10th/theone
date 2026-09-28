import type { Express, RequestHandler } from "express";
import { asyncRoute } from "./middleware.js";
import type { Store } from "./db.js";
import { FeatureConfigError } from "./officialFeatures.js";
import { runFeatureTrial, trialResult } from "./featureTrial.js";
import { ChatOperationError } from "./chatOperations.js";

export function installFeatureTrialRoutes(app: Express, admin: readonly RequestHandler[], store: Store, verifyKey: (req: any) => Promise<void>) {
  app.post("/api/admin/official-features/:id/trial", ...admin, asyncRoute(async (req, res) => {
    try {
      const result = await runFeatureTrial(store, { workspaceId: req.workspaceId!, userId: req.user!.id }, String(req.params.id), req.body, () => verifyKey(req));
      res.json(result);
    } catch (error) {
      if (error instanceof FeatureConfigError || error instanceof ChatOperationError) { res.status(error.status).json({ error: error.message }); return; }
      throw error;
    }
  }));
  app.get("/api/admin/official-features/:id/trial/:operationId", ...admin, asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(trialResult(await store.read(), { workspaceId: req.workspaceId!, userId: req.user!.id }, String(req.params.operationId))); }
    catch (error) { if (error instanceof FeatureConfigError || error instanceof ChatOperationError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
  }));
}
