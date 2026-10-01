import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import type { KnowledgeService } from "./knowledge/knowledgeService.js";
import { asyncRoute } from "./middleware.js";
import { FeatureConfigError } from "./officialFeatures.js";
import { ChatOperationError } from "./chatOperations.js";
import { availableFeature, executeFeatureRun, featureMember, featureRunResult, featureSummary, startFeatureRun, type FeatureRunDependencies } from "./featureRuns.js";
import {featureCategories} from './featureCategories.js';

export function installFeatureRunRoutes(app: Express, keyAuth: readonly RequestHandler[], store: Store, verifyKey: (req: express.Request) => Promise<void>, knowledge: Pick<KnowledgeService, "recallWithDiagnostics">, deps: FeatureRunDependencies = {}) {
  const router = express.Router();
  router.use(...keyAuth);
  router.use((_req,res,next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const scope = (req: express.Request) => ({ workspaceId: req.workspaceId!, userId: req.user!.id });
  const pageOf = (n: unknown) => Math.max(1, Math.min(100000, Math.floor(Number(n) || 1)));
  router.get("/", asyncRoute(async (req,res) => {
    const db = await store.read(), s = scope(req); featureMember(db, s);
    const q = String(req.query.q ?? "").slice(0,100).toLowerCase(), page = pageOf(req.query.page);
    const category=String(req.query.category??'all');if(category!=='all'&&!featureCategories.some(c=>c.id===category))throw new FeatureConfigError('功能分类无效');
    const items = (db.settings.officialFeatures ?? []).filter(f => f.status === "approved" && f.release?.userIds.includes(s.userId)).map(featureSummary).filter(f => `${f.name} ${f.description} ${f.author}`.toLowerCase().includes(q)&&(category==='all'||f.category===category));
    res.json({ items: items.slice((page-1)*10,page*10), total: items.length });
  }));
  router.get("/runs", asyncRoute(async (req,res) => {
    const db = await store.read(), s = scope(req); featureMember(db, s);
    const page = pageOf(req.query.page);
    const rows = (db.chatOperations ?? []).filter(o => o.workspaceId === s.workspaceId && o.userId === s.userId && o.featureRun).slice().reverse();
    res.json({ items: rows.slice((page-1)*10,page*10).map(o => featureRunResult(db,s,o.operationId,false)), total: rows.length });
  }));
  router.get("/runs/:operationId", asyncRoute(async (req,res) => { res.json(featureRunResult(await store.read(),scope(req),String(req.params.operationId))); }));
  router.get("/:id", asyncRoute(async (req,res) => {
    const db = await store.read(), s = scope(req), { record } = availableFeature(db,s,String(req.params.id));
    res.json({ ...featureSummary(record), sources: db.knowledgeConnections.filter(c => c.workspaceId === s.workspaceId && c.status === "connected").map(c => ({ id: c.id, name: c.providerSpaceName || c.provider })) });
  }));
  router.post("/:id/runs", asyncRoute(async (req,res) => {
    const s = scope(req), started = await startFeatureRun(store,s,String(req.params.id),req.body,() => verifyKey(req));
    if (started.created) {
      // Errors are persisted by the runner. No raw provider exception is logged.
      void executeFeatureRun(store,s,started.result.operationId,() => verifyKey(req),knowledge,deps).catch(() => {});
    }
    res.status(started.created || started.result.status === "pending" ? 202 : 200).json(started.result);
  }));
  router.use((error: unknown,_req: express.Request,res: express.Response,_next: express.NextFunction) => {
    if (error instanceof FeatureConfigError || error instanceof ChatOperationError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(500).json({ error: "功能暂不可用，请稍后查看任务记录；不要重复提交" });
  });
  app.use("/api/features",router);
}
