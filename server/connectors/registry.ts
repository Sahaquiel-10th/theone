import type { Database, ExecutionTask } from "../types.js";
import type { KnowledgeChunk } from "../knowledge/provider.js";

export type ConnectorScope = { workspaceId: string; userId: string; deviceId?: string };
export type ConnectorState = "not_connected" | "pending" | "configured" | "expired" | "error" | "offline" | "transport_ready" | "unavailable" | "disabled" | "verified";
export type ConnectorHealth = { state: ConnectorState; code: string; message: string; evidence: "stored" | "transport" | "remote" };
export type ConnectorManifest = {
  id: string; name: string; version: string; kind: "knowledge" | "execution";
  capabilities: readonly string[]; auth: "device_authorization" | "local_runtime";
};
type BaseAdapter = {
  manifest: ConnectorManifest;
  status(db: Database, scope: ConnectorScope): ConnectorHealth;
  check?(db: Database, scope: ConnectorScope): Promise<ConnectorHealth>;
};
export type KnowledgeAdapter = BaseAdapter & {
  kind: "knowledge";
  recall(db: Database, workspaceId: string, query: string, topK: number): Promise<KnowledgeChunk[]>;
};
export type ExecutionAdapter = BaseAdapter & {
  kind: "execution";
  provider: ExecutionTask["provider"];
  dispatch(action: "start" | "continue" | "cancel", task: ExecutionTask, instruction?: string): Promise<void>;
};
export type ConnectorAdapter = KnowledgeAdapter | ExecutionAdapter;

// Server-owned, reviewed adapters only. No URL, script, module path or model
// output can register an adapter through an HTTP request.
export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();
  private readonly disabled: ReadonlySet<string>;

  constructor(adapters: readonly ConnectorAdapter[], disabled: readonly string[] = []) {
    for (const adapter of adapters) {
      const { id, version, kind } = adapter.manifest;
      if (!/^[a-z][a-z0-9_]*$/.test(id) || !/^\d+\.\d+\.\d+$/.test(version) || kind !== adapter.kind || this.adapters.has(id)) throw new Error("连接器登记无效或重复");
      if (adapter.kind === "execution" && [...this.adapters.values()].some(item => item.kind === "execution" && item.provider === adapter.provider)) throw new Error("执行提供方重复登记");
      const manifest = Object.freeze({ ...adapter.manifest, capabilities: Object.freeze([...adapter.manifest.capabilities]) });
      this.adapters.set(id, Object.freeze({ ...adapter, manifest }));
    }
    for (const id of disabled) if (!this.adapters.has(id)) throw new Error("停用的连接器未登记");
    this.disabled = new Set(disabled);
  }

  list() { return [...this.adapters.values()]; }
  get(id: string) { return this.adapters.get(id); }
  enabled(id: string) { return this.adapters.has(id) && !this.disabled.has(id); }
  execution(provider: ExecutionTask["provider"]) {
    return this.list().find((adapter): adapter is ExecutionAdapter => adapter.kind === "execution" && adapter.provider === provider);
  }
}
