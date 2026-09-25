import { createHash, randomBytes } from "node:crypto";
import type { Database, KnowledgeConnection } from "./types.js";
import type { Publication, PublicSession, PublicRun } from "./publicSharingTypes.js";
import { resolveAiTask } from "./aiTaskConfig.js";
import { uid } from "./security.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
export class SharingError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function sharingReady(db: Database) { return !!(db.publications && db.publicSessions && db.publicRuns); }
export function requireSharing(db: Database) { if (!sharingReady(db)) throw new SharingError("分享功能准备中：请管理员完成数据库升级", 503); }
export function sourceBinding(c: KnowledgeConnection) {
  // Account identity is preferable to rotating tokens. For adapters without a
  // verified account identity, fail closed when their credentials change.
  return digest(JSON.stringify([c.id, c.workspaceId, c.provider, c.clientId, c.providerUserId, c.providerSpaceId,
    c.providerUserId || c.providerSpaceId ? null : [c.encryptedApiKey, c.encryptedAccessToken]]));
}
function ownerActive(db: Database, p: { workspaceId: string; userId: string }) {
  if (!db.users.some(u => u.id === p.userId && u.enabled) || !db.workspaces.some(w => w.id === p.workspaceId && w.status === "active") || !db.workspaceMembers.some(m => m.workspaceId === p.workspaceId && m.userId === p.userId && m.role === "owner")) throw new SharingError("分享已停止", 410);
}
export function activePublication(db: Database, id: string): Publication {
  requireSharing(db);
  const p = db.publications!.find(p => p.id === id);
  if (!p || p.status !== "active" || Date.parse(p.expiresAt) <= Date.now()) throw new SharingError("分享已关闭或到期", 410);
  ownerActive(db, p);
  if (!db.models.some(m => m.id === p.modelId && m.enabled && m.kind === "chat" && m.apiKey)) throw new SharingError("分身暂不可用", 503);
  for (const s of p.sources) {
    const c = db.knowledgeConnections.find(c => c.id === s.id && c.workspaceId === p.workspaceId && c.provider === s.provider);
    if (!c || !["connected", "error"].includes(c.status) || sourceBinding(c) !== s.binding) throw new SharingError("分享知识授权已变更，请发布者重新发布", 410);
  }
  return p;
}
export function ownedPublication(db: Database, workspaceId: string, userId: string, id: string) {
  requireSharing(db);
  const p = db.publications!.find(p => p.id === id && p.workspaceId === workspaceId && p.userId === userId);
  if (!p) throw new SharingError("分身不存在", 404);
  ownerActive(db, p); return p;
}
function text(value: unknown, max: number, required = true) {
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new SharingError("请检查必填内容和长度");
  return value.trim();
}
function power(value: unknown) { if (typeof value !== "number" || !Number.isFinite(value) || value < .01 || value > 10000) throw new SharingError("电力限额应为 0.01 至 10000"); return Math.round(value * 1e6); }
export function publish(db: Database, scope: { workspaceId: string; userId: string }, input: Record<string, unknown>) {
  requireSharing(db); ownerActive(db, scope);
  if (input.confirmed !== true || !Array.isArray(input.sourceIds) || input.sourceIds.length > 5 || input.sourceIds.some(x => typeof x !== "string")) throw new SharingError("请确认分享范围与费用");
  const base = db.models.find(m => m.id === input.modelId && m.kind === "chat" && m.enabled && m.apiKey);
  if (!base) throw new SharingError("请选择可用的问答模型");
  const config = resolveAiTask(db.settings, db.models, "shared_answer", base);
  if (!config.model.apiKey) throw new SharingError("问答模型尚未配置");
  const budgetMicros = power(input.budget), perRunMicros = power(input.perRun);
  if (perRunMicros > budgetMicros) throw new SharingError("单次限额不能大于总限额");
  const days = input.days;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 90) throw new SharingError("有效期应为 1 至 90 天");
  if (db.publications!.filter(p => p.workspaceId === scope.workspaceId && p.userId === scope.userId && p.status === "active").length >= 20) throw new SharingError("最多保留 20 个有效分享，请先关闭不需要的分享");
  const sources = [...new Set(input.sourceIds as string[])].map(id => {
    const c = db.knowledgeConnections.find(c => c.id === id && c.workspaceId === scope.workspaceId && c.status === "connected");
    if (!c) throw new SharingError("知识来源不可用或不属于你");
    return { id, provider: c.provider, binding: sourceBinding(c), label: c.providerSpaceName || c.provider };
  });
  const p: Publication = { id: uid("pub"), ...scope, slug: randomBytes(18).toString("base64url"),
    name: text(input.name, 60), description: text(input.description, 300, false),
    prompt: [config.model.systemPrompt, text(input.prompt, 12000, false)].filter(Boolean).join("\n\n"), modelId: config.model.id, taskVersion: config.version,
    sources, attachments: input.attachments === true, status: "active", budgetMicros, perRunMicros, createdAt: timestamp(), expiresAt: new Date(Date.now() + Number(days) * 86400000).toISOString() };
  db.publications!.push(p);
  db.auditLogs.push({ id: uid("aud"), ...scope, actorUserId: scope.userId, action: "publication.created", targetType: "publication", targetId: p.id, details: { sources: sources.map(s => s.id), budgetMicros, perRunMicros }, createdAt: p.createdAt });
  return p;
}
export function createGuest(db: Database, publicationId: string) {
  const p = activePublication(db, publicationId);
  const sessions = db.publicSessions!.filter(s => s.publicationId === p.id);
  if (sessions.length >= 500 || sessions.filter(s => Date.now() - Date.parse(s.createdAt) < 60000).length >= 10) throw new SharingError("访问较多，请稍后再试或联系发布者", 429);
  const token = randomBytes(32).toString("base64url"), id = uid("gst");
  const session: PublicSession = { id, workspaceId: p.workspaceId, userId: id, publicationId: p.id, tokenHash: digest(token), uploadBytes: 0, uploadCount: 0, createdAt: timestamp(), expiresAt: new Date(Math.min(Date.parse(p.expiresAt), Date.now() + 7 * 86400000)).toISOString() };
  db.publicSessions!.push(session); return { session, token };
}
export function guest(db: Database, slug: string, token: string) {
  requireSharing(db);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SharingError("访客会话已失效，请重新打开", 401);
  const p = db.publications!.find(p => p.slug === slug);
  if (!p) throw new SharingError("分享不存在", 404);
  const s = db.publicSessions!.find(s => s.publicationId === p.id && s.workspaceId === p.workspaceId && s.tokenHash === digest(token) && Date.parse(s.expiresAt) > Date.now());
  if (!s) throw new SharingError("访客会话已失效，请重新打开", 401);
  activePublication(db, p.id); return { publication: p, session: s };
}
export function usageFor(db: Database, p: Publication, runId?: string) {
  const ids = new Set(db.publicRuns!.filter(r => r.publicationId === p.id && r.workspaceId === p.workspaceId && (!runId || r.id === runId)).map(r => r.id));
  const rows = db.modelUsageRecords.filter(r => r.workspaceId === p.workspaceId && r.userId === p.userId && ids.has(r.conversationId));
  return { spent: rows.reduce((n,r) => n + (r.chargedMicros ?? 0), 0), held: rows.reduce((n,r) => n + (r.reservedMicros ?? 0), 0) };
}
export function checkRunBudget(db: Database, runId: string, amount: number) {
  const r = db.publicRuns?.find(r => r.id === runId);
  if (!r || r.status !== "running") throw new SharingError("任务已停止", 409);
  const p = activePublication(db, r.publicationId), all = usageFor(db, p), own = usageFor(db, p, r.id);
  if (all.spent + all.held + amount > p.budgetMicros || own.spent + own.held + amount > p.perRunMicros) throw new SharingError("本次问题预计用量超过分享额度，请缩小问题范围或联系发布者", 402);
}
export function beginPublicRun(db: Database, p: Publication, s: PublicSession, input: Record<string, unknown>) {
  activePublication(db, p.id);
  if (s.publicationId !== p.id || s.workspaceId !== p.workspaceId || s.userId !== s.id || !db.publicSessions!.some(current => current.id === s.id && current.publicationId === p.id && current.tokenHash === s.tokenHash && Date.parse(current.expiresAt) > Date.now())) throw new SharingError("访客会话不属于此分身", 403);
  const content = text(input.content, 6000), operationId = text(input.operationId, 80);
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(operationId)) throw new SharingError("请求标识无效");
  if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 5 || input.attachmentIds.some(id => typeof id !== "string")) throw new SharingError("每条消息最多 5 个附件");
  const attachmentIds = [...new Set(input.attachmentIds as string[])];
  if (attachmentIds.length && !p.attachments) throw new SharingError("这个分身未开放附件");
  for (const id of attachmentIds) if (!db.attachments.some(a => a.id === id && a.workspaceId === s.workspaceId && a.userId === s.id && a.status === "ready")) throw new SharingError("附件未就绪或无权访问");
  const payloadHash = digest(JSON.stringify([content, attachmentIds]));
  const existing = db.publicRuns!.find(r => r.sessionId === s.id && r.publicationId === p.id && r.operationId === operationId);
  if (existing) { if (existing.payloadHash !== payloadHash) throw new SharingError("请勿更改已提交的问题", 409); return { run: existing, created: false }; }
  const runs = db.publicRuns!.filter(r => r.publicationId === p.id);
  if (runs.filter(r => r.sessionId === s.id).length >= 100 || runs.filter(r => Date.now() - Date.parse(r.createdAt) < 60000).length >= 20 || runs.filter(r => r.status === "running").length >= 2 || runs.some(r => r.sessionId === s.id && r.status === "running")) throw new SharingError("任务较多，请稍后再试", 429);
  const run: PublicRun = { id: uid("pqr"), workspaceId: s.workspaceId, userId: s.id, publicationId: p.id, sessionId: s.id, operationId, payloadHash, content, attachmentIds, status: "running", createdAt: timestamp() };
  db.publicRuns!.push(run); checkRunBudget(db, run.id, 1); return { run, created: true };
}
export function publicRun(run: PublicRun) { return { id: run.id, operationId: run.operationId, content: run.content, response: run.response, status: run.status, finishReason: run.finishReason, error: run.error, warning: run.warning, createdAt: run.createdAt }; }
