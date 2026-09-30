import express, { type Express } from "express";
import { installMcpSandbox } from './mcpSandbox.js';

/** Public synthetic fixtures only. Deliberately no Store, credentials, filesystem,
 * model calls, arbitrary reflection, redirects or user-configurable delays.
 */
export const sandboxOrigin = "https://theone.aiarrival.cn";
export const sandboxBase = "/api/adapter-sandbox/v1";
const field = (name: string, type: string) => ({ name, in: "query", required: true, schema: { type } });
function operation(operationId: string, parameters: ReturnType<typeof field>[], properties: Record<string, { type: string }>) {
  return { get: { operationId, parameters, responses: { "200": {
    description: "Synthetic test data only", content: { "application/json": { schema: {
      type: "object", additionalProperties: false, properties, required: Object.keys(properties)
    } } }
  } } } };
}
export const sandboxDefinition = {
  openapi: "3.1.1", info: { title: "ONE synthetic adapter sandbox", version: "1.0.0" },
  servers: [{ url: sandboxOrigin }], paths: {
    [`${sandboxBase}/lookup`]: operation("sandboxLookup", [field("topic", "string")], {
      synthetic: { type: "boolean" }, found: { type: "boolean" }, title: { type: "string" }, answer: { type: "string" }
    }),
    [`${sandboxBase}/inventory`]: operation("sandboxInventory", [field("itemId", "integer")], {
      synthetic: { type: "boolean" }, itemId: { type: "integer" }, available: { type: "integer" }, name: { type: "string" }
    }),
    [`${sandboxBase}/probe`]: operation("sandboxProbe", [field("scenario", "string")], {
      synthetic: { type: "boolean" }, status: { type: "string" }
    })
  }
};
export const sandboxEndpoints = Object.keys(sandboxDefinition.paths).map(path => sandboxOrigin + path);

export function installAdapterSandbox(app: Express, options: { enabled?: boolean; now?: () => number; perMinute?: number } = {}) {
  if (options.enabled === false) return;
  installMcpSandbox(app);
  const router = express.Router();
  const now = options.now ?? Date.now;
  let windowStarted = now(), requests = 0;
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-ONE-Synthetic", "true");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Bounded global counter: no attacker-controlled IP/session maps. This limit
    // only affects the sandbox, never chat, billing or normal admin routes.
    if (now() - windowStarted >= 60000) { windowStarted = now(); requests = 0; }
    if (++requests > (options.perMinute ?? 120)) { res.setHeader("Retry-After", "60"); res.status(429).json({ code: "SANDBOX_RATE_LIMITED" }); return; }
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ code: "SANDBOX_READ_ONLY" }); return; }
    if (req.originalUrl.length > 1024) { res.status(414).json({ code: "SANDBOX_REQUEST_TOO_LARGE" }); return; }
    next();
  });
  const parameter = (req: express.Request, res: express.Response, name: string): string | undefined => {
    // No workspace/user IDs, headers, URLs or free-form payloads accepted.
    const value = req.query[name];
    if (Object.keys(req.query).length !== 1 || typeof value !== "string" || value.length > 64) {
      res.status(400).json({ code: "INVALID_SANDBOX_INPUT" }); return;
    }
    return value;
  };
  router.get("/openapi.json", (req, res) => {
    if (Object.keys(req.query).length) { res.status(400).json({ code: "INVALID_SANDBOX_INPUT" }); return; }
    res.json(sandboxDefinition);
  });
  router.get("/lookup", (req, res) => {
    const topic = parameter(req, res, "topic"); if (topic === undefined) return;
    if (!["meeting", "printer", "missing"].includes(topic)) { res.status(400).json({ code: "UNKNOWN_SANDBOX_TOPIC" }); return; }
    const notes = {
      meeting: { title: "虚构会议室使用规则", answer: "测试园区会议室提前 15 分钟开放，每次可预约 60 分钟。" },
      printer: { title: "虚构打印机使用规则", answer: "测试园区打印机放在二楼，每人每天可打印 20 页。" }
    };
    const note = notes[topic as keyof typeof notes];
    res.json({ synthetic: true, found: !!note, title: note?.title ?? "", answer: note?.answer ?? "" });
  });
  router.get("/inventory", (req, res) => {
    const raw = parameter(req, res, "itemId"); if (raw === undefined) return;
    if (!["101", "102", "999"].includes(raw)) { res.status(400).json({ code: "UNKNOWN_SANDBOX_ITEM" }); return; }
    const items = { "101": { name: "虚构白板笔", available: 12 }, "102": { name: "虚构笔记本", available: 0 }, "999": { name: "", available: 0 } };
    res.json({ synthetic: true, itemId: Number(raw), ...items[raw as keyof typeof items] });
  });
  router.get("/probe", (req, res) => {
    const scenario = parameter(req, res, "scenario"); if (scenario === undefined) return;
    if (scenario === "unavailable") { res.status(503).json({ code: "SYNTHETIC_UNAVAILABLE" }); return; }
    if (scenario === "invalid-json") { res.type("application/json").send("{synthetic-invalid-json"); return; }
    if (scenario === "wrong-schema") { res.json({ synthetic: true, unexpected: "synthetic field" }); return; }
    if (scenario !== "ok") { res.status(400).json({ code: "UNKNOWN_SANDBOX_SCENARIO" }); return; }
    res.json({ synthetic: true, status: "ok" });
  });
  router.use((_req, res) => { res.status(404).json({ code: "SANDBOX_NOT_FOUND" }); });
  app.use(sandboxBase, router);
}
