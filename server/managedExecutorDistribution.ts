import fs from 'node:fs';
import path from 'node:path';
import type { SignedRuntimeUpdate, RuntimeIdentity } from './runtimeUpdate.js';
import { verifyManagedExecutorCatalog, planManagedExecutorPreparation } from './managedExecutorCatalog.js';

// Deployment-owned signed metadata; absence keeps installation unavailable.
// No network lookup and no browser-supplied paths, keys or download hosts.
export class ManagedExecutorDistribution {
  constructor(private options = {
    manifest: process.env.ONE_EXECUTOR_MANIFEST_PATH || '',
    publicKey: process.env.ONE_EXECUTOR_PUBLIC_KEY || '',
    origins: (process.env.ONE_EXECUTOR_DOWNLOAD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  }) {}
  release(device: Pick<RuntimeIdentity, 'platform' | 'architecture'>) {
    if (!this.options.manifest || !this.options.publicKey || !this.options.origins.length) return undefined;
    if (fs.statSync(this.options.manifest).size > 256 * 1024) throw new Error('执行工具发布清单过大');
    const envelope: SignedRuntimeUpdate = JSON.parse(fs.readFileSync(this.options.manifest, 'utf8'));
    const catalog = verifyManagedExecutorCatalog(envelope, this.options.publicKey, this.options.origins);
    const plan = planManagedExecutorPreparation(catalog, device, { activeExecutions: 0 });
    if (plan.action !== 'prepare') return undefined;
    if (!/\.tar(?:\.gz)?$/.test(new URL(plan.release.url).pathname)) throw new Error('执行工具包格式未审核');
    return { envelope, version: plan.release.version, size: plan.release.size };
  }
  artifact(name: string) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.tar(?:\.gz)?$/.test(name) || !this.options.manifest) return undefined;
    const catalog = verifyManagedExecutorCatalog(JSON.parse(fs.readFileSync(this.options.manifest, 'utf8')), this.options.publicKey, this.options.origins);
    const release = catalog.releases.find(r => new URL(r.url).pathname === `/executor-downloads/${name}`);
    if (!release) return undefined;
    const file = path.join(path.dirname(this.options.manifest), name);
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size !== release.size) return undefined;
    return file;
  }
}
