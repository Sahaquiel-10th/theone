import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import type { KnowledgeService } from "./knowledge/knowledgeService.js";
import { asyncRoute } from "./middleware.js";
import { CoordinatorService } from "./coordinatorService.js";
import {
  CoordinatorError,
  executorDefaults,
  updateExecutor,
} from "./executorProfiles.js";
import {
  ChatOperationError,
  getChatOperationResult,
} from "./chatOperations.js";
import type { FeatureRunDependencies } from "./featureRuns.js";
export function installCoordinatorRoutes(
  app: Express,
  keyAuth: readonly RequestHandler[],
  admin: readonly RequestHandler[],
  store: Store,
  verifyKey: (req: express.Request) => Promise<void>,
  knowledge: Pick<KnowledgeService, "recallWithDiagnostics">,
  deps: FeatureRunDependencies & {
    webSearch?: (query: string) => Promise<unknown>;
  } = {},
) {
  const service = new CoordinatorService(store, knowledge, deps),
    router = express.Router(),
    settings = express.Router();
  const page = (n: unknown) =>
    Math.max(1, Math.min(100000, Math.floor(Number(n) || 1)));
  const scope = (r: express.Request) => ({
    workspaceId: r.workspaceId!,
    userId: r.user!.id,
  });
  router.use(...keyAuth);
  settings.use(...admin);
  for (const r of [router, settings])
    r.use((_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
  router.get(
    "/",
    asyncRoute(async (req, res) =>
      res.json(await service.state(scope(req), page(req.query.page))),
    ),
  );
  router.get(
    "/tasks/:id",
    asyncRoute(async (req, res) =>
      res.json(await service.task(scope(req), String(req.params.id))),
    ),
  );
  router.get(
    "/messages/:operationId",
    asyncRoute(async (req, res) => {
      const s = scope(req),
        db = await store.read();
      const operation = db.chatOperations?.find(
        (o) =>
          o.operationId === req.params.operationId &&
          o.workspaceId === s.workspaceId &&
          o.userId === s.userId &&
          o.requestId.startsWith("coord_"),
      );
      if (!operation) throw new CoordinatorError("消息不存在", 404);
      if (operation.status !== "completed")
        return res.json({
          status: operation.status,
          operationId: operation.operationId,
          requestId: operation.requestId,
          error: operation.status === "failed" ? db.contextTraces.find(t => t.workspaceId === s.workspaceId && t.userId === s.userId && t.requestId === operation.requestId)?.responsePreview.slice(0, 500) : undefined,
          taskId: operation.dispatchedTaskId,
        });
      res.json({
        status: "completed",
        ...getChatOperationResult(db, {
          ...s,
          operationId: operation.operationId,
        }),
        taskId: operation.dispatchedTaskId,
      });
    }),
  );
  router.post(
    "/messages",
    asyncRoute(async (req, res) => {
      const s = scope(req),
        verify = () => verifyKey(req);
      const result = await service.dispatch(s, req.body, verify, () =>
        res
          .status(202)
          .json({ status: "pending", operationId: req.body.operationId }),
      );
      if (!res.headersSent) res.json({ status: "completed", ...result });
      void service.resume(s, verify).catch(() => {});
    }),
  );
  router.post(
    "/tasks/:id/messages",
    asyncRoute(async (req, res) => {
      const s = scope(req),
        verify = () => verifyKey(req);
      res
        .status(202)
        .json(await service.direct(s, String(req.params.id), req.body, verify));
      void service.resume(s, verify).catch(() => {});
    }),
  );
  router.post(
    "/resume",
    asyncRoute(async (req, res) => {
      const taskId = req.body?.continueTaskId;
      if (
        taskId !== undefined &&
        (typeof taskId !== "string" || req.body?.confirmed !== true)
      )
        throw new CoordinatorError("继续失败后的补充需明确确认", 400);
      res.json(await service.resume(scope(req), () => verifyKey(req), taskId));
    }),
  );
  router.post(
    "/notices/read",
    asyncRoute(async (req, res) => {
      await verifyKey(req);
      await service.acknowledge(scope(req), req.body?.ids);
      res.json({ ok: true });
    }),
  );
  settings.get(
    "/",
    asyncRoute(async (req, res) => {
      const records = (await store.read()).settings.executorProfiles ?? [],
        q = String(req.query.q ?? "")
          .slice(0, 100)
          .toLowerCase(),
        all = records.filter((p) =>
          `${p.draft.name} ${p.draft.description}`.toLowerCase().includes(q),
        ),
        p = page(req.query.page);
      res.json({
        items: all
          .slice((p - 1) * 10, p * 10)
          .map((x) => ({
            id: x.id,
            name: x.draft.name,
            description: x.draft.description,
            enabled: x.enabled,
            version: x.published?.version ?? 0,
            revision: x.revision,
          })),
        total: all.length,
        defaults: executorDefaults(),
      });
    }),
  );
  settings.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const record = (await store.read()).settings.executorProfiles?.find(
        (p) => p.id === req.params.id,
      );
      if (!record) throw new CoordinatorError("执行器不存在", 404);
      const p = page(req.query.page);
      res.json({
        ...record,
        history: record.history
          .slice()
          .reverse()
          .slice((p - 1) * 5, p * 5),
        total: record.history.length,
        defaults: executorDefaults(),
      });
    }),
  );
  settings.post(
    "/",
    asyncRoute(async (req, res) => {
      const record = await store.mutate((db) =>
        updateExecutor(db, req.user!.id, undefined, req.body),
      );
      res.json({ id: record.id });
    }),
  );
  settings.post(
    "/:id",
    asyncRoute(async (req, res) => {
      const record = await store.mutate((db) =>
        updateExecutor(db, req.user!.id, String(req.params.id), req.body),
      );
      res.json({ id: record.id });
    }),
  );
  const errors = (
    e: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      return;
    }
    if (e instanceof CoordinatorError || e instanceof ChatOperationError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    res
      .status(400)
      .json({ error: "配置或执行未完成，请查看任务和用量；不要重复提交。" });
  };
  router.use(errors);
  settings.use(errors);
  app.use("/api/coordinator", router);
  app.use("/api/admin/executors", settings);
  return service;
}
