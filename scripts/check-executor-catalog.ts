import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { verifyManagedExecutorCatalog } from "../server/managedExecutorCatalog.js";

// Offline release preflight; no download, install, supplier call or secret output.
const manifestPath = process.argv[2];
const publicKey = process.env.ONE_EXECUTOR_PUBLIC_KEY?.trim() || "";
const origins = (process.env.ONE_EXECUTOR_DOWNLOAD_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
try {
  if (!manifestPath || !publicKey || !origins.length) throw new Error("ONE_EXECUTOR_CHECK_CONFIGURATION_REQUIRED");
  if (fs.statSync(manifestPath).size > 256 * 1024) throw new Error("ONE_EXECUTOR_CATALOG_TOO_LARGE");
  const catalog = verifyManagedExecutorCatalog(JSON.parse(fs.readFileSync(manifestPath, "utf8")), publicKey, origins);
  if (process.argv.includes('--verify-packages')) {
    for (const release of catalog.releases) {
      const name = new URL(release.url).pathname;
      if (!/^\/executor-downloads\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.tar(?:\.gz)?$/.test(name)) throw Error('Invalid public artifact path');
      const file = path.join(path.dirname(manifestPath), path.basename(name));
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size !== release.size) throw Error('Invalid package size');
      if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== release.sha256) throw Error('Invalid package hash');
    }
  }
  console.log(`Verified executor metadata${process.argv.includes('--verify-packages') ? ' and package bytes' : ''}: ${catalog.releases.length} release(s). License materials and actual launch must be checked separately.`);
} catch {
  console.error("Executor catalog rejected. Check signature, trusted download origins, source, license metadata and platform fields.");
  process.exitCode = 1;
}
