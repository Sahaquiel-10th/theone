import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import { asyncRoute } from "./middleware.js";
import { runOfficialFeaturePilot, type PilotBinding } from "./officialFeaturePilot.js";
import { StandardToolError } from "./connectors/standardHttp.js";

// Empty until an actual zero-cost service has passed code/security review and
// the corresponding feature version is approved. Never populate from HTTP body.
const reviewedPilots: readonly PilotBinding[] = [];
export function installOfficialFeaturePilotRoutes(app: Express, admin: readonly RequestHandler[], store: Store, bindings = reviewedPilots) {
  const approved = structuredClone(bindings);
  const router = express.Router({ mergeParams: true }); router.use(...admin);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.post("/", asyncRoute(async (req, res) => {
    const binding = approved.find(b => b.featureId === req.params.id);
    if (!binding) { res.status(409).json({ error: "尚未登记通过技术验收的测试接口", code: "PILOT_NOT_READY" }); return; }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["operationId", "input"].includes(k)) || typeof body.operationId !== "string") {
      res.status(400).json({ code: "INVALID_PILOT_REQUEST" }); return;
    }
    const result = await runOfficialFeaturePilot(store, { workspaceId: req.workspaceId!, userId: req.user!.id }, binding, body.operationId, body.input);
    res.json(result);
  }));
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof StandardToolError) { res.status(error.code === "PILOT_NOT_AUTHORIZED" ? 403 : error.code === "PILOT_RATE_LIMITED" ? 429 : 400).json({ code: error.code }); return; }
    next(error);
  });
  app.use("/api/admin/official-features/:id/pilot", router);
}
