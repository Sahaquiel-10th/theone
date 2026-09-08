import { Store } from "../db.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { getnoteConnector } from "../connectors/getnote.js";

export class KnowledgeConnectorError extends Error {
  constructor(readonly provider: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : "知识来源暂时不可用");
  }
}

export class KnowledgeService {
  constructor(private store: Store, private registry = new ConnectorRegistry([getnoteConnector])) {}

  async recall(workspaceId: string, query: string, topK = 5) {
    topK = Number.isFinite(topK) ? Math.max(1, Math.min(10, Math.floor(topK))) : 5;
    const db = await this.store.read();
    // A reviewed adapter owns provider-specific credentials and authorization.
    // Missing/failing connections never fall back to another workspace.
    const resultSets = [];
    const failures: KnowledgeConnectorError[] = [];
    for (const adapter of this.registry.list()) {
      if (adapter.kind !== "knowledge" || !this.registry.enabled(adapter.manifest.id)) continue;
      try { resultSets.push(await adapter.recall(db, workspaceId, query, topK)); }
      catch (error) { failures.push(new KnowledgeConnectorError(adapter.manifest.id, error)); }
    }
    // Round-robin keeps an earlier-registered provider from starving all other
    // connected sources when each one returns a full page of results.
    const results = [];
    for (let index = 0; results.length < topK; index++) {
      let found = false;
      for (const set of resultSets) {
        if (set[index]) { results.push(set[index]); found = true; }
        if (results.length >= topK) break;
      }
      if (!found) break;
    }
    if (!results.length && failures.length) throw failures[0];
    return results;
  }
}
