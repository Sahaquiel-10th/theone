import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { installAiTaskRoutes } from "./aiTaskRoutes.js";
import { requireRole } from "./middleware.js";
import { defaultTaskValues } from "./aiTaskConfig.js";
import type { Store } from "./db.js";
import type { Database } from "./types.js";

test("AI task routes gate all reads/writes by Key and role; no workspace data or secrets exposed", async t => {
  const db = { settings: { safetyRules: "rules", rechargeCnyPerPower: 7 }, models: [{ id: "m", enabled: true, kind: "chat", apiKey: "SECRET" }], auditLogs: [], messages: [{ workspaceId: "other", content: "PRIVATE" }] } as unknown as Database;
  const store = { read: async () => structuredClone(db), mutate: async (fn: (db: Database) => unknown) => fn(db) } as unknown as Store;
  const app = express(); app.use(express.json());
  installAiTaskRoutes(app, [(req, res, next) => { if (req.headers["x-key"] !== "present") { res.sendStatus(428); return; } req.user = { id: "admin", role: req.headers["x-role"] === "admin" ? "admin" : "user" } as any; next(); }, requireRole("admin")], store);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: err.message }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/ai-tasks`;
  for (const method of ["GET", "POST"]) {
    const url = method === "GET" ? base : base + "/chat";
    assert.equal((await fetch(url, { method })).status, 428);
    assert.equal((await fetch(url, { method, headers: { "x-key": "present", "x-role": "user" } })).status, 403);
  }
  const headers = { "x-key": "present", "x-role": "admin", "Content-Type": "application/json" };
  const post = (body: unknown) => fetch(base + "/chat", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await post({ action: "draft", revision: 0, values: { ...defaultTaskValues("chat"), modelId: "m" }, workspaceId: "other" })).status, 200);
  assert.equal((await post({ action: "publish", revision: 1 })).status, 200);
  const detail = await (await fetch(base + "/chat?workspaceId=other", { headers })).text();
  assert.doesNotMatch(detail, /SECRET|PRIVATE/);
  assert.equal(JSON.parse(detail).published.version, 1);
  assert.equal(db.auditLogs.length, 2);
  assert.equal((await post({ action: "publish", revision: 0 })).status, 400);
});
