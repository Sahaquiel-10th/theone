import type { Store } from "./db.js";
import type { Database } from "./types.js";
import { resolveWorkspaceAccess } from "./workspaceAccess.js";
import { ConnectorRegistry, type ConnectorScope, type ConnectorHealth } from "./connectors/registry.js";
import { validInstallationId } from "./oneKeyInstallation.js";

export class ConnectorAccessError extends Error {}

export class ConnectorService {
  constructor(private store: Store, private registry: ConnectorRegistry) {}

  private async authorized(scope: ConnectorScope): Promise<Database> {
    const db = await this.store.read();
    const user = db.users.find(item => item.id === scope.userId && item.enabled);
    if (!user || !resolveWorkspaceAccess(db, user, scope.workspaceId)) throw new ConnectorAccessError("连接器不存在或无权访问");
    return db;
  }

  private health(id: string, db: Database, scope: ConnectorScope): ConnectorHealth {
    if (!this.registry.enabled(id)) return { state: "disabled", code: "CONNECTOR_DISABLED", message: "连接器已停用", evidence: "stored" };
    return this.registry.get(id)!.status(db, scope);
  }

  async list(scope: ConnectorScope) {
    const db = await this.authorized(scope);
    return this.registry.list().map(adapter => ({ ...adapter.manifest, enabled: this.registry.enabled(adapter.manifest.id), health: this.health(adapter.manifest.id, db, scope) }));
  }

  async check(scope: ConnectorScope, id: string) {
    const db = await this.authorized(scope);
    const adapter = this.registry.get(id);
    if (!adapter) throw new ConnectorAccessError("连接器不存在或无权访问");
    const startedAt = new Date().toISOString();
    const connection = adapter.kind === "knowledge" ? db.knowledgeConnections.find(item => item.workspaceId === scope.workspaceId && item.provider === id) : undefined;
    const snapshot = connection ? structuredClone(connection) : undefined;
    // Explicit POST only. No hidden provider calls or file writes on list.
    const health = this.registry.enabled(id) && adapter.check ? await adapter.check(db, scope) : this.health(id, db, scope);
    if (snapshot && health.evidence === "remote" && (health.state === "verified" || health.state === "error" || health.state === "expired")) await this.store.mutate(mutable => {
      const target = mutable.knowledgeConnections.find(item => item.id === snapshot.id && item.workspaceId === scope.workspaceId && item.provider === id);
      if (!target || target.status === "revoked" || target.status === "pending" || target.clientId !== snapshot.clientId || target.encryptedApiKey !== snapshot.encryptedApiKey || target.encryptedAccessToken !== snapshot.encryptedAccessToken || (target.lastCheckedAt && target.lastCheckedAt > startedAt)) return;
      target.status = health.state === "verified" ? "connected" : "error";
      // Connector health is a reviewed, sanitized surface; never persist the
      // raw thrown provider error in a browser-visible connection field.
      target.lastError = health.state === "verified" ? undefined : health.message;
      target.lastCheckedAt = new Date().toISOString();
      target.updatedAt = target.lastCheckedAt;
    });
    return { connectorId: id, version: adapter.manifest.version, checkedAt: new Date().toISOString(), health };
  }

  async selectExecution(scope: ConnectorScope) {
    const db = await this.authorized(scope);
    const adapter = this.registry.list().find(item => item.kind === "execution" && this.health(item.manifest.id, db, scope).state === "transport_ready");
    if (!adapter || adapter.kind !== "execution") throw new Error("本机执行连接不可用，请检查 ONE Key 和启动器");
    return adapter.provider;
  }

  async dispatch(scope: ConnectorScope, taskId: string, action: "start" | "continue" | "cancel", instruction?: string) {
    const db = await this.authorized(scope);
    if (!validInstallationId(scope.installationId)) throw new ConnectorAccessError("请更新 ONE Key 并在原电脑创建新的执行任务");
    const task = db.executionTasks.find(item => item.id === taskId && item.workspaceId === scope.workspaceId && item.userId === scope.userId && item.deviceId === scope.deviceId && item.installationId === scope.installationId);
    if (!task) throw new ConnectorAccessError("执行任务不存在或无权访问");
    const adapter = this.registry.execution(task.provider);
    // Never silently move an existing task to another runtime or device.
    // Disabling new work must not remove the user's ability to stop running work.
    const health = adapter && (action === "cancel" ? adapter.status(db, scope) : this.health(adapter.manifest.id, db, scope));
    if (!adapter || health?.state !== "transport_ready") throw new Error("任务原执行连接不可用，请恢复原连接后重试");
    if (action === "continue" && !instruction?.trim()) throw new Error("执行消息不能为空");
    await adapter.dispatch(action, task, instruction);
  }
}
