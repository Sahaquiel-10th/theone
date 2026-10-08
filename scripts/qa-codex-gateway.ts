import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import { CodexGateway, installCodexGatewayRoutes } from "../server/codexGateway.js";
import { decryptCredential } from "../server/knowledge/credentialCipher.js";
import type { Database, ExecutionTask, ModelConfig } from "../server/types.js";
import type { Store } from "../server/db.js";

// Opt-in integration test: real supplier + real CLI, isolated files and an
// in-memory ledger. Not a production Key/UI/update acceptance test.
async function main() {
  if (process.env.ONE_CODEX_QA_ALLOW_SUPPLIER !== "true" || !process.argv[2] || !process.argv[3]) throw Error("Explicit opt-in, CLI path and model ID required");
  const raw = JSON.parse(fs.readFileSync("data/db.json", "utf8"));
  const model = structuredClone((raw.models as ModelConfig[]).find(item => item.id === process.argv[3] && item.enabled && item.kind === "chat" && item.protocol === "openai"));
  if (!model) throw Error("Configured model unavailable");
  model.apiKey = model.encryptedApiKey ? decryptCredential(model.encryptedApiKey) : model.apiKey;
  // Synthetic ledger only; never publish these prices or change production.
  model.cachePrices = { read: 0, write: 0, write1h: 0 };
  model.cacheCostPrices = { read: 0, write: 0, write1h: 0 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "one-codex-gateway-qa-"));
  const home = path.join(directory, "codex-home"), project = path.join(directory, "project");
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  const cert = path.join(directory, "localhost.crt"), key = path.join(directory, "localhost.key");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  fs.chmodSync(key, 0o600);
  const task = { id: "qa-codex", workspaceId: "qa-workspace", userId: "qa-user", deviceId: "qa-device", installationId: "a".repeat(32), conversationId: "qa-conversation", status: "running", provider: "codex" } as ExecutionTask;
  const db = { settings: {}, models: [model], executionTasks: [task], users: [{ id: task.userId, enabled: true }],
    workspaces: [{ id: task.workspaceId, status: "active" }], workspaceMembers: [{ workspaceId: task.workspaceId, userId: task.userId }],
    oneKeyDevices: [{ id: task.deviceId, workspaceId: task.workspaceId, userId: task.userId, status: "active" }],
    modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "qa-power", workspaceId: task.workspaceId, userId: task.userId, balanceMicros: 100_000_000 }]
  } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async change => change(db) };
  const app = express(); app.use(express.json({ limit: "2mb" }));
  // Only record field names for protocol diagnostics, never request content.
  const fieldSets = new Set<string>(); const shapes: unknown[] = []; app.use((req, _res, next) => {
    fieldSets.add(Object.keys(req.body || {}).sort().join(","));
    shapes.push({ modelAliasMatches: req.body?.model === "one-executor", inputArray: Array.isArray(req.body?.input), stream: req.body?.stream, store: req.body?.store, toolTypes: [...new Set((req.body?.tools || []).map((tool: any) => tool.type))] }); next();
  });
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, app);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("No test listener");
  const gateway = new CodexGateway(store, async () => {}, { enabled: true, modelId: model.id, baseUrl: `https://127.0.0.1:${address.port}/api/executor-gateway/v1` });
  installCodexGatewayRoutes(app, gateway);
  const config = await gateway.prepare(task);
  const environment = { ...process.env, CODEX_HOME: home, ONE_EXECUTOR_TOKEN: config.token, SSL_CERT_FILE: cert, NO_PROXY: "127.0.0.1,localhost" };
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const) delete (environment as Record<string, string | undefined>)[name];
  const settings = ["model=\"one-executor\"", "model_provider=\"one\"", "web_search=\"disabled\"", "model_providers.one.name=\"ONE\"",
    `model_providers.one.base_url=${JSON.stringify(config.baseUrl)}`, "model_providers.one.env_key=\"ONE_EXECUTOR_TOKEN\"", "model_providers.one.requires_openai_auth=false",
    "model_providers.one.wire_api=\"responses\"", "model_providers.one.request_max_retries=0", "model_providers.one.stream_max_retries=0"];
  const child = spawn(process.argv[2], [...settings.flatMap(value => ["-c", value]), "exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", project, "-"], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end('Create only index.html in this empty authorized project. It must be a complete minimal HTML page with title ONE_QA_CODEX_REAL and body text ONE_QA_CODEX_REAL. No dependencies, no network access, do not read other folders or overwrite existing files. Read back the file to verify. Report the actual path and verification.');
  let output = ""; child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-32_000); }); child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  let code: unknown;
  try { [code] = await once(child, "close"); }
  finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  const artifact = path.join(project, "index.html");
  const content = fs.existsSync(artifact) ? fs.readFileSync(artifact, "utf8") : "";
  const passed = code === 0 && content.includes("<title>ONE_QA_CODEX_REAL</title>") && db.modelUsageRecords.length > 0 && db.modelUsageRecords.every(row => row.status === "success");
  console.log(JSON.stringify({ stage: "real_codex_gateway", directory, modelId: model.id, exitCode: code, artifactCreated: Boolean(content), verifiedMarker: content.includes("ONE_QA_CODEX_REAL"), supplierCalls: db.modelUsageRecords.length,
    billingStates: db.modelUsageRecords.map(row => row.status), syntheticCachePrices: true, requestFields: [...fieldSets], shapes, cliReportedCompletion: output.includes("turn.completed"), passed }));
  if (!passed) process.exitCode = 1;
}
main().catch(() => { console.error("Isolated Codex integration failed; no retry and no user files or production ledger changed."); process.exitCode = 1; });
