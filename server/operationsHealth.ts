import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "./db.js";

export function backupFreshness(lastSuccessMs: number | undefined, currentTime = Date.now()) {
  return { status: lastSuccessMs === undefined ? "unverified" : currentTime - lastSuccessMs > 36 * 60 * 60 * 1000 ? "stale" : "ok",
    lastSuccessAt: lastSuccessMs === undefined ? undefined : new Date(lastSuccessMs).toISOString() };
}

export async function operationsHealth(store: Store, dataPath: string, backupPath = "/srv/theone/shared/backups/mysql") {
  const marker = async (name: string) => backupFreshness(await fs.stat(path.join(backupPath, name)).then((stat) => stat.mtimeMs).catch(() => undefined));
  const [database, disk, localBackup, offsiteBackup] = await Promise.all([
    (store.health ? store.health() : store.read()).then(() => "ok", () => "error"),
    fs.statfs(dataPath).then((stat) => ({ freePercent: stat.blocks ? Math.round(stat.bavail / stat.blocks * 100) : undefined })).catch(() => ({ freePercent: undefined })),
    marker(".last-local-success"), marker(".last-offsite-success")
  ]);
  return { database, diskFreePercent: disk.freePercent, localBackup, offsiteBackup, checkedAt: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) };
}
