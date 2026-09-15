#!/usr/bin/env node
// Read-only deployment gate. This script never issues DDL/DML or prints credentials.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--env" || !path.isAbsolute(args[1]))) {
  console.error("Usage: node deploy/check-mysql-schema.mjs [--env /absolute/path/to/ONE/.env]");
  process.exit(2);
}

let connection;
try {
  const envFile = args[1] || "/srv/theone/shared/.env";
  const config = dotenv.parse(fs.readFileSync(envFile, "utf8"));
  if (config.DB_PROVIDER === "json") {
    console.log("ONE uses JSON storage; MySQL schema gate is not applicable.");
  } else {
    if (config.DB_PROVIDER !== "mysql" || config.MYSQL_DATABASE !== "theone_prod") throw new Error("ONE_DATABASE_SCOPE_INVALID");
    const port = Number(config.MYSQL_PORT || "3306");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("ONE_DATABASE_PORT_INVALID");
    connection = await mysql.createConnection({
      host: config.MYSQL_HOST || "127.0.0.1", port,
      user: config.MYSQL_USER, password: config.MYSQL_PASSWORD,
      database: "theone_prod", connectTimeout: 5000, multipleStatements: false
    });
    const [versions] = await connection.execute({ sql: "SELECT version FROM schema_migrations WHERE version = 2 LIMIT 1", timeout: 5000 });
    if (!versions.length) throw new Error("ONE_SCHEMA_V2_REQUIRED");
    // LIMIT 0 validates the exact application-readable column shape without reading users' data.
    await connection.execute({ sql: "SELECT id, workspace_id, user_id, parent_id, lookup_key, record_json, created_at, updated_at FROM chat_operations LIMIT 0", timeout: 5000 });
    const [operations] = await connection.execute({ sql: "SELECT COUNT(*) AS pending FROM chat_operations WHERE JSON_UNQUOTE(JSON_EXTRACT(record_json, '$.status')) = 'pending'", timeout: 5000 });
    const [usage] = await connection.execute({ sql: "SELECT JSON_UNQUOTE(JSON_EXTRACT(record_json, '$.status')) AS state, COUNT(*) AS total FROM model_usage_records WHERE JSON_UNQUOTE(JSON_EXTRACT(record_json, '$.status')) IN ('pending', 'needs_review') GROUP BY state", timeout: 5000 });
    const pendingOperations = Number(operations[0].pending);
    const pendingModels = Number(usage.find(row => row.state === "pending")?.total || 0);
    const reviews = Number(usage.find(row => row.state === "needs_review")?.total || 0);
    console.log(`ONE schema v2: ready; pending chat operations: ${pendingOperations}; pending model calls: ${pendingModels}; billing reviews: ${reviews}.`);
    if (pendingOperations > 0 || pendingModels > 0) throw new Error("ONE_ACTIVE_REQUESTS_WAIT_BEFORE_RESTART");
    if (reviews > 0) console.log("Review unresolved billing records in the ONE admin usage panel; this gate does not modify them.");
    console.log("Read-only preflight passed. No database records or schema were changed.");
  }
} catch (error) {
  const safeCode = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : typeof error?.message === "string" && /^ONE_[A-Z0-9_]+$/.test(error.message) ? error.message : "ONE_PREFLIGHT_FAILED";
  console.error(`ONE MySQL preflight blocked: ${safeCode}. Keep the current service running; verify the migration and pending requests with the operator.`);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => undefined);
}
