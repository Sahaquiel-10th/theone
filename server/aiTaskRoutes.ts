import type { Express, RequestHandler } from "express";
import type { Store } from "./db.js";
import { asyncRoute } from "./middleware.js";
import { uid } from "./security.js";
import { findAiTaskDefinition } from "./aiTaskCatalog.js";
import { defaultTaskValues, editableTaskValues, taskSummaries, updateTaskConfig } from "./aiTaskConfig.js";
import { taskToolDescriptions, taskToolNames } from "./aiTaskPresets.js";

export function installAiTaskRoutes(app: Express, admin: readonly RequestHandler[], store: Store) {
  app.get("/api/admin/ai-tasks", ...admin, asyncRoute(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ tasks: taskSummaries((await store.read()).settings) });
  }));
  app.get("/api/admin/ai-tasks/:id", ...admin, asyncRoute(async (req, res) => {
    const definition = findAiTaskDefinition(String(req.params.id));
    if (!definition) { res.status(404).json({ error: "任务不存在" }); return; }
    const db = await store.read();
    const record = db.settings.aiTasks?.[definition.id];
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    res.setHeader("Cache-Control", "no-store");
    res.json({ definition, revision: record?.revision ?? 0, draft: editableTaskValues(definition.id, record?.draft), defaults: defaultTaskValues(definition.id), published: record?.published,
      tools: taskToolNames(definition.id), toolDefaults: taskToolDescriptions,
      history: (record?.history ?? []).slice().reverse().slice((page - 1) * 5, page * 5), total: record?.history.length ?? 0 });
  }));
  app.post("/api/admin/ai-tasks/:id", ...admin, asyncRoute(async (req, res) => {
    await store.mutate(db => {
      const record = updateTaskConfig(db.settings, db.models, String(req.params.id), req.body, req.user!.id, new Date().toISOString());
      db.auditLogs.push({ id: uid("aud"), actorUserId: req.user!.id, action: `admin.ai_task.${req.body.action}`, targetType: "ai_task", targetId: String(req.params.id),
        details: { revision: record.revision, version: record.published?.version ?? 0 }, createdAt: new Date().toISOString(), requestId: res.locals.requestId });
    });
    res.json({ ok: true });
  }));
}
