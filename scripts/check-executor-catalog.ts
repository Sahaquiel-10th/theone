import fs from "node:fs";
import { verifyManagedExecutorCatalog } from "../server/managedExecutorCatalog.js";

// Offline release preflight; no download, install, supplier call or secret output.
const manifestPath = process.argv[2];
const publicKey = process.env.ONE_EXECUTOR_PUBLIC_KEY?.trim() || "";
const origins = (process.env.ONE_EXECUTOR_DOWNLOAD_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
try {
  if (!manifestPath || !publicKey || !origins.length) throw new Error("ONE_EXECUTOR_CHECK_CONFIGURATION_REQUIRED");
  if (fs.statSync(manifestPath).size > 256 * 1024) throw new Error("ONE_EXECUTOR_CATALOG_TOO_LARGE");
  const catalog = verifyManagedExecutorCatalog(JSON.parse(fs.readFileSync(manifestPath, "utf8")), publicKey, origins);
  console.log(`Verified executor metadata: ${catalog.releases.length} release(s). Package bytes and license contents still require verification.`);
} catch {
  console.error("Executor catalog rejected. Check signature, trusted download origins, source, license metadata and platform fields.");
  process.exitCode = 1;
}
