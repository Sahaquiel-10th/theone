import { Store } from "../db.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { getnoteConnector } from "../connectors/getnote.js";

export class KnowledgeService {
  constructor(private store: Store, private registry = new ConnectorRegistry([getnoteConnector])) {}

  async recall(workspaceId: string, query: string, topK = 5) {
    topK = Number.isFinite(topK) ? Math.max(1, Math.min(10, Math.floor(topK))) : 5;
    const db = await this.store.read();
    // A reviewed adapter owns provider-specific credentials and authorization.
    // Missing/failing connections never fall back to another workspace.
    const results = [];
    for (const adapter of this.registry.list()) {
      if (adapter.kind === "knowledge" && this.registry.enabled(adapter.manifest.id)) results.push(...await adapter.recall(db, workspaceId, query, topK));
    }
    return results.slice(0, topK);
  }
}
