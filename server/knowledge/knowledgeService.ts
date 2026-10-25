import type { Store } from "../db.js";
import type { KnowledgeConnection } from "../types.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { getnoteConnector } from "../connectors/getnote.js";
import type { KnowledgeChunk } from "./provider.js";
import { canReadKnowledge, companyWorkspace } from "../enterprisePolicy.js";
import { datedKnowledgeChunks, dateSearchQuery, validKnowledgeDateRange, type KnowledgeDateRange, type KnowledgeDateSearch } from './temporal.js';

const maxConnectorChunkChars = 24_000;

export type KnowledgeFailure = {
  provider: string;
  code: "AUTHORIZATION_REQUIRED" | "PERMISSION_REQUIRED" | "RATE_LIMITED" | "TIMEOUT" | "UNAVAILABLE";
  message: string;
  retryable: boolean;
};

export type KnowledgeRecallResult = {
  coverage?:{connectionId?:string;provider:string;status:'used'|'no_match'|'failed'|'unavailable';attempts:number}[];
  chunks: KnowledgeChunk[];
  status: "used" | "no_match" | "not_connected" | "partial" | "failed";
  failures: KnowledgeFailure[];
  temporal?: {
    range: KnowledgeDateRange;
    complete: false;
    sources: Array<{ provider: string; method: KnowledgeDateSearch['method']; filterApplied: boolean; filterDropped?: boolean; field?: 'created' | 'updated';partial?:true;secondaryFailure?:KnowledgeDateSearch['secondaryFailure'] }>;
    contentDateCandidates: number;
    metadataCandidates: number;
    excludedOutsideRange: number;
    excludedUnverified: number;
    note: string;
  };
};

function safeFailure(provider: string, cause: unknown): KnowledgeFailure {
  const value = cause instanceof Error ? cause.message : "";
  const status = typeof cause === "object" && cause !== null && "status" in cause ? Number(cause.status) : undefined;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  const providerCode = provider === "getnote" && typeof cause === "object" && cause !== null && "providerCode" in cause ? Number(cause.providerCode) : undefined;
  const label = provider === "notion" ? "Notion" : provider === "getnote" ? "得到大脑" : provider === "yinxiang" ? "印象笔记" : provider === "flowus" ? "息流 FlowUs" : provider === "flomo" ? "flomo" : "知识来源";
  const failure = (code: KnowledgeFailure["code"], message: string, retryable: boolean): KnowledgeFailure => ({ provider, code, message, retryable });
  if (code === "GETNOTE_CREDENTIAL_EXPIRED" || status === 401 || providerCode === 10001 || /授权.*(?:失效|过期)|未授权|unauthori[sz]ed|invalid[_ -]?token|expired[_ -]?token|\b401\b/i.test(value)) return failure("AUTHORIZATION_REQUIRED", `${label}授权已失效，请重新连接`, false);
  if (["GETNOTE_MEMBER_REQUIRED", "GETNOTE_SCOPE_REQUIRED"].includes(code) || status === 403 || providerCode === 10201 || /会员|权限不足|forbidden|\b403\b/i.test(value)) return failure("PERMISSION_REQUIRED", `${label}当前账号权限不足，请检查会员和授权范围`, false);
  if (code === "GETNOTE_RATE_LIMITED" || status === 429 || providerCode === 42900 || providerCode === 10202 || /额度|频率|rate.?limit|too many requests|\b429\b/i.test(value)) return failure("RATE_LIMITED", `${label}调用额度或频率已达上限，请稍后重试`, true);
  if (/超时|timeout|timed out/i.test(value)) return failure("TIMEOUT", `${label}响应超时，请稍后重试`, true);
  return failure("UNAVAILABLE", `${label}暂时不可用，请稍后重试`, true);
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
    ,createdAt:typeof chunk.createdAt==='string'?chunk.createdAt.slice(0,40):undefined,
    updatedAt:typeof chunk.updatedAt==='string'?chunk.updatedAt.slice(0,40):undefined
  };
}

export class KnowledgeConnectorError extends Error {
  readonly failure: KnowledgeFailure;
  constructor(readonly provider: string, cause: unknown) {
    const failure = safeFailure(provider, cause);
    super(failure.message);
    this.failure = failure;
  }
}

export class KnowledgeService {
  constructor(private store: Store, private registry = new ConnectorRegistry([getnoteConnector])) {}

  async recall(workspaceId: string, query: string, topK = 5) {
    const result = await this.recallWithDiagnostics(workspaceId, query, topK);
    if (!result.chunks.length && result.failures.length) {
      const failure = result.failures[0];
      throw new KnowledgeConnectorError(failure.provider, new Error(failure.message));
    }
    return result.chunks;
  }

  async recallWithDiagnostics(workspaceId: string, query: string, topK = 5, allowedConnectionIds?: readonly string[], userId?: string, options?:{retry?:boolean;dateRange?:KnowledgeDateRange}): Promise<KnowledgeRecallResult> {
    topK = Number.isFinite(topK) ? Math.max(1, Math.min(10, Math.floor(topK))) : 5;
    if (options?.dateRange && !validKnowledgeDateRange(options.dateRange)) throw new Error('知识检索日期范围无效');
    const dateRange = options?.dateRange;
    const db = await this.store.read();
    if (companyWorkspace(db, workspaceId)) {
      if (!userId) throw new Error("企业知识检索缺少员工身份");
      const permitted = db.knowledgeConnections.filter(c => c.workspaceId === workspaceId && ["connected", "error"].includes(c.status) && canReadKnowledge(db, {workspaceId,userId}, c.id)).map(c => c.id);
      if (allowedConnectionIds?.some(id => !permitted.includes(id))) throw new Error("无权访问所选企业知识");
      allowedConnectionIds = allowedConnectionIds === undefined ? permitted : allowedConnectionIds;
    }
    const selected = allowedConnectionIds === undefined ? undefined : db.knowledgeConnections.filter(c => c.workspaceId === workspaceId && allowedConnectionIds.includes(c.id) && ["connected", "error"].includes(c.status));
    if (selected && (new Set(allowedConnectionIds).size !== selected.length)) throw new Error("授权知识来源已失效");
    // A reviewed adapter owns provider-specific credentials and authorization.
    // Missing/failing connections never fall back to another workspace.
    const adapters = this.registry.list().filter(adapter => adapter.kind === "knowledge" && this.registry.enabled(adapter.manifest.id) && (!selected || selected.some(c => c.provider === adapter.manifest.id)));
    if (selected && adapters.length !== selected.length) throw new Error("授权知识来源暂不可用");
    const outcomes = await Promise.all(adapters.map(async adapter => {
      if (adapter.kind !== "knowledge") return { chunks: [], attempted: false };
      const health = adapter.status(db, { workspaceId, userId: "" });
      // No connection is normal, not a failed retrieval. This also avoids
      // invoking Notion's remote/token path before it has been connected.
      const connection=db.knowledgeConnections.find(c=>c.workspaceId===workspaceId&&c.provider===adapter.manifest.id);
      if (["not_connected", "pending", "disabled", "unavailable"].includes(health.state)) return { chunks: [], attempted: false,coverage:connection?{connectionId:connection.id,provider:adapter.manifest.id,status:'unavailable' as const,attempts:0}:undefined };
      const startedAt = new Date().toISOString();
      const stored = db.knowledgeConnections.find(item => item.workspaceId === workspaceId && item.provider === adapter.manifest.id);
      const snapshot = stored ? structuredClone(stored) : undefined;
      let chunks: KnowledgeChunk[] = [];
      let failure: KnowledgeFailure | undefined;
      let dateSearch: KnowledgeDateSearch | undefined;
      let attempts=0;
      for(;;){
        attempts++;
        const fresh=await this.store.read();
        if(snapshot&&userId&&(!fresh.knowledgeConnections.some(c=>c.id===snapshot.id&&c.workspaceId===workspaceId&&['connected','error'].includes(c.status)&&c.clientId===snapshot.clientId&&c.encryptedApiKey===snapshot.encryptedApiKey&&c.encryptedAccessToken===snapshot.encryptedAccessToken)||!canReadKnowledge(fresh,{workspaceId,userId},snapshot.id)))throw new Error('知识授权已撤销');
        try {
          const count=dateRange?10:topK;
          if (dateRange && adapter.recallWithDiagnostics) {
            const found=await adapter.recallWithDiagnostics(fresh,workspaceId,query,count,{dateRange});
            chunks=found.chunks;dateSearch=found.dateSearch;
          } else {
            chunks=await adapter.recall(fresh,workspaceId,dateRange?dateSearchQuery(query,dateRange):query,count);
            if(dateRange)dateSearch={method:'semantic_date_hint',filterApplied:false,complete:false};
          }
          chunks=chunks.slice(0,dateRange?20:topK).map(boundedChunk).filter((item):item is KnowledgeChunk=>Boolean(item));failure=undefined;break;
        }
        catch(error){failure=safeFailure(adapter.manifest.id,error);if(!options?.retry||!failure.retryable||attempts>=3)break;await new Promise(resolve=>setTimeout(resolve,attempts*250));}
      }
      if(snapshot){
        const after=await this.store.read(),current=after.knowledgeConnections.find(c=>c.id===snapshot.id&&c.workspaceId===workspaceId&&c.provider===snapshot.provider);
        if(!current||!['connected','error'].includes(current.status)||current.clientId!==snapshot.clientId||current.encryptedApiKey!==snapshot.encryptedApiKey||current.providerSpaceId!==snapshot.providerSpaceId||current.providerUserId!==snapshot.providerUserId||(userId&&!canReadKnowledge(after,{workspaceId,userId},snapshot.id)))throw new Error('知识授权已撤销');
      }
      if (userId && companyWorkspace(db, workspaceId) && (!snapshot || !canReadKnowledge(await this.store.read(), {workspaceId,userId}, snapshot.id))) throw new Error("企业知识授权已撤销");
      // A persistence failure is an application failure, not a knowledge-provider
      // error. Let the chat request abort before model billing in that case.
      await this.recordOutcome(snapshot, startedAt, failure);
      const dated=dateRange?datedKnowledgeChunks(chunks,dateRange):undefined;
      if(dated)chunks=dated.chunks;
      return { chunks, attempted: true, failure,dateSearch,dated,provider:adapter.manifest.id,coverage:{connectionId:stored?.id,provider:adapter.manifest.id,status:failure?'failed' as const:chunks.length?'used' as const:'no_match' as const,attempts} };
    }));
    const resultSets = outcomes.map(outcome => outcome.chunks);
    const failures = outcomes.flatMap(outcome => outcome.failure ? [outcome.failure] : 'dateSearch' in outcome&&outcome.dateSearch?.partial?[{
      provider:outcome.provider!,code:outcome.dateSearch.secondaryFailure==='rate_limited'?'RATE_LIMITED' as const:outcome.dateSearch.secondaryFailure==='timeout'?'TIMEOUT' as const:'UNAVAILABLE' as const,
      message:`${outcome.provider==='notion'?'Notion':'知识来源'}已取回日期候选，但补充内容搜索暂时没查成；请先核对已取得的资料。`,retryable:true
    }]:[]);
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
    const attempted = outcomes.filter(outcome => outcome.attempted).length;
    const coverage=outcomes.flatMap(o=>'coverage' in o&&o.coverage?[o.coverage]:[]);
    const temporal=dateRange?{
      range:dateRange,complete:false as const,
      sources:outcomes.flatMap(outcome=>'dateSearch' in outcome&&outcome.dateSearch?[{provider:outcome.provider!,method:outcome.dateSearch.method,filterApplied:outcome.dateSearch.filterApplied,...(outcome.dateSearch.filterDropped?{filterDropped:true}:{}),...(outcome.dateSearch.field?{field:outcome.dateSearch.field}:{}),...(outcome.dateSearch.partial?{partial:true as const,secondaryFailure:outcome.dateSearch.secondaryFailure}:{})}]:[]),
      contentDateCandidates:outcomes.reduce((n,o)=>n+('dated' in o?o.dated?.confirmed??0:0),0),
      metadataCandidates:outcomes.reduce((n,o)=>n+('dated' in o?o.dated?.candidates??0:0),0),
      excludedOutsideRange:outcomes.reduce((n,o)=>n+('dated' in o?o.dated?.outsideRange??0:0),0),
      excludedUnverified:outcomes.reduce((n,o)=>n+('dated' in o?o.dated?.unverified??0:0),0),
      note:'本次仅为有限候选检索，不保证该时段资料查全。创建/编辑日期只证明资料时间；正文提到日期也需核对是否是所问事件。无可核对结果时应说明未找到可确认的素材，不能断言当天没有资料，也不要擅自新建占位文档。'
    }:undefined;
    return { chunks: results, failures, status: outcomes.some(outcome=>'dateSearch' in outcome&&outcome.dateSearch?.partial)?'partial':failures.length ? failures.length < attempted ? "partial" : "failed" : results.length ? "used" : attempted ? "no_match" : "not_connected",...(coverage.length?{coverage}:{}),...(temporal?{temporal}:{}) };
  }

  private async recordOutcome(snapshot: KnowledgeConnection | undefined, startedAt: string, failure?: KnowledgeFailure) {
    if (!snapshot) return;
    await this.store.mutate(db => {
      const connection = db.knowledgeConnections.find(item => item.id === snapshot.id && item.workspaceId === snapshot.workspaceId && item.provider === snapshot.provider);
      // A request begun with old credentials must not undo a disconnect, newer
      // connection, OAuth refresh, or more recent check that completed meanwhile.
      if (!connection || connection.status === "revoked" || connection.status === "pending" || connection.clientId !== snapshot.clientId || connection.encryptedApiKey !== snapshot.encryptedApiKey || connection.encryptedAccessToken !== snapshot.encryptedAccessToken || (connection.lastCheckedAt && connection.lastCheckedAt > startedAt)) return;
      const checkedAt = new Date().toISOString();
      connection.status = failure ? "error" : "connected";
      connection.lastError = failure?.message;
      connection.lastCheckedAt = checkedAt;
      connection.updatedAt = checkedAt;
    });
  }
}
