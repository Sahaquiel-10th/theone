import type { Store } from "./db.js";
import type { Database } from "./types.js";
import { resolveWorkspaceAccess } from "./workspaceAccess.js";
import { ConnectorRegistry, type ConnectorScope, type ConnectorHealth } from "./connectors/registry.js";

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
    // Explicit POST only. No hidden provider calls or file writes on list.
    const health = this.registry.enabled(id) && adapter.check ? await adapter.check(db, scope) : this.health(id, db, scope);
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
    const task = db.executionTasks.find(item => item.id === taskId && item.workspaceId === scope.workspaceId && item.userId === scope.userId && item.deviceId === scope.deviceId);
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
