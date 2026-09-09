import { Store } from "../db.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { getnoteConnector } from "../connectors/getnote.js";
import type { KnowledgeChunk } from "./provider.js";

const maxConnectorChunkChars = 24_000;

function safeFailure(provider: string, cause: unknown) {
  const value = cause instanceof Error ? cause.message : "";
  const label = provider === "notion" ? "Notion" : provider === "getnote" ? "得到大脑" : "知识来源";
  if (/授权|unauthori[sz]ed|invalid[_ -]?token|expired[_ -]?token|\b401\b/i.test(value)) return `${label}授权已失效，请重新连接`;
  if (/超时|timeout|timed out/i.test(value)) return `${label}响应超时，请稍后重试`;
  if (/会员/.test(value)) return `${label}当前账号权限不足`;
  return `${label}暂时不可用，请稍后重试`;
}

function boundedChunk(chunk: KnowledgeChunk): KnowledgeChunk | undefined {
  if (!chunk || typeof chunk.content !== "string" || !chunk.content.trim()) return undefined;
  return {
    provider: chunk.provider,
    id: typeof chunk.id === "string" ? chunk.id.slice(0, 500) : undefined,
    title: typeof chunk.title === "string" ? chunk.title.slice(0, 300) : "知识来源",
    sourceUrl: typeof chunk.sourceUrl === "string" ? chunk.sourceUrl.slice(0, 2_000) : undefined,
    content: chunk.content.slice(0, maxConnectorChunkChars),
    score: Number.isFinite(chunk.score) ? chunk.score : undefined
  };
}

export class KnowledgeConnectorError extends Error {
  constructor(readonly provider: string, cause: unknown) {
    super(safeFailure(provider, cause));
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
      try { resultSets.push((await adapter.recall(db, workspaceId, query, topK)).slice(0, topK).map(boundedChunk).filter((item): item is KnowledgeChunk => Boolean(item))); }
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
