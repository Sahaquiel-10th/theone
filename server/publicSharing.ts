import { publicSharingAllowed } from "./enterprisePolicy.js";
import { createHash, randomBytes } from "node:crypto";
import type { Database, KnowledgeConnection } from "./types.js";
import type { Publication, PublicSession, PublicRun } from "./publicSharingTypes.js";
import { resolveAiTask } from "./aiTaskConfig.js";
import { uid } from "./security.js";
import { checkApiBudget } from './publicApi.js';
import {publicationCommerceFields,publicationAccess,runCommerce,verifyRunCommerce} from './publicCommerce.js';
import type {VisitorIdentity} from './visitorAccounts.js';
import { avatarAuthorName, validatePublicAvatarService } from './publicAvatarConfig.js';
import { validateBusinessConfig, assignPublicServiceEntitlement, checkPublicServiceBudget, validateServiceCommitments } from './publicAvatarBusiness.js';

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
export class SharingError extends Error { constructor(message: string, readonly status = 400, readonly code?:string) { super(message); } }
export function sharingReady(db: Database) { return !!(db.publications && db.publicSessions && db.publicRuns); }
export function requireSharing(db: Database) { if (!sharingReady(db)) throw new SharingError("分享功能准备中：请管理员完成数据库升级", 503); }
export function sourceBinding(c: KnowledgeConnection) {
  // Account identity is preferable to rotating tokens. For adapters without a
  // verified account identity, fail closed when their credentials change.
  return digest(JSON.stringify([c.id, c.workspaceId, c.provider, c.clientId, c.providerUserId, c.providerSpaceId,
    c.providerUserId || c.providerSpaceId ? null : [c.encryptedApiKey, c.encryptedAccessToken]]));
}
export function ownerActive(db: Database, p: { workspaceId: string; userId: string }) {
  if(!publicSharingAllowed(db,p.workspaceId))throw new SharingError("企业空间暂不开放对外分享和 API",403);
  if (!db.users.some(u => u.id === p.userId && u.enabled) || !db.workspaces.some(w => w.id === p.workspaceId && w.status === "active") || !db.workspaceMembers.some(m => m.status !== "disabled" && m.workspaceId === p.workspaceId && m.userId === p.userId && m.role === "owner")) throw new SharingError("分享已停止", 410);
}
export function activePublication(db: Database, id: string): Publication {
  requireSharing(db);
  const p = db.publications!.find(p => p.id === id);
  if (!p || p.deletedAt || p.status !== "active" || Date.parse(p.expiresAt) <= Date.now()) throw new SharingError("分享已关闭或到期", 410);
  ownerActive(db, p);
  if (!db.models.some(m => m.id === p.modelId && m.enabled && m.kind === "chat" && m.apiKey)) throw new SharingError("分身暂不可用", 503);
  for (const s of p.sources) {
    const c = db.knowledgeConnections.find(c => c.id === s.id && c.workspaceId === p.workspaceId && c.provider === s.provider);
    if (!c || !["connected", "error"].includes(c.status) || sourceBinding(c) !== s.binding) throw new SharingError("分享知识授权已变更，请发布者重新发布", 410);
  }
  return p;
}
export function ownedPublication(db: Database, workspaceId: string, userId: string, id: string, options: {includeDeleted?: boolean} = {}) {
  requireSharing(db);
  const p = db.publications!.find(p => p.id === id && p.workspaceId === workspaceId && p.userId === userId);
  if (!p || p.deletedAt && !options.includeDeleted) throw new SharingError("分身不存在", 404);
  ownerActive(db, p); return p;
}
function text(value: unknown, max: number, required = true) {
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new SharingError("请检查必填内容和长度");
  return value.trim();
}
function power(value: unknown) { if (typeof value !== "number" || !Number.isFinite(value) || value < .01 || value > 10000) throw new SharingError("电力限额应为 0.01 至 10000"); return Math.round(value * 1e6); }
function publicationSnapshot(p: Publication) {
  const {history, ...snapshot} = structuredClone(p);
  if (snapshot.serviceBusiness) snapshot.serviceBusiness = {...snapshot.serviceBusiness, codes: [], entitlements: [], leads: []};
  return snapshot;
}
function retainPublicationSnapshot(p: Publication) { p.history = [...(p.history ?? []), publicationSnapshot(p)].slice(-20); }
function revokePublicationApi(p: Publication, at: string) {
  for (const grant of p.apiGrants ?? []) if (grant.workspaceId === p.workspaceId && grant.userId === p.userId && grant.status === 'active') {grant.status = 'revoked'; grant.revokedAt ??= at;}
}
function assertPublicationIdle(db: Database, p: Publication) {
  if (db.publicRuns!.some(r => r.publicationId === p.id && r.workspaceId === p.workspaceId && r.status === 'running')) throw new SharingError('还有问题正在回答，请等这一轮完成后再修改分享状态', 409, 'PUBLICATION_BUSY');
}
function assertPublicationVersion(p: Publication, version: unknown) {
  if (version !== (p.version ?? 1)) throw new SharingError('分身已被更新，请重新打开配置', 409, 'PUBLICATION_VERSION_CHANGED');
}
export function publicationConfiguredDays(p: Publication) { return p.draftDays ?? Math.max(1, Math.min(90, Math.ceil((Date.parse(p.expiresAt) - Date.now()) / 86400000))); }
export function publicationModel(db: Database, modelId: unknown) {
  const base = db.models.find(m => m.id === modelId && m.kind === 'chat' && m.enabled && m.apiKey);
  if (!base) throw new SharingError('请选择可用的问答模型');
  const config = resolveAiTask(db.settings, db.models, 'shared_answer', base);
  if (!config.model.apiKey) throw new SharingError('问答模型尚未配置');
  return config;
}
export function publicationSources(db: Database, scope: {workspaceId: string; userId: string}, sourceIds: unknown) {
  if (!Array.isArray(sourceIds) || sourceIds.length > 5 || sourceIds.some(id => typeof id !== 'string')) throw new SharingError('请选择最多 5 个已连接的知识来源');
  return [...new Set(sourceIds as string[])].map(id => {
    const c = db.knowledgeConnections.find(c => c.id === id && c.workspaceId === scope.workspaceId && c.status === 'connected');
    if (!c) throw new SharingError('知识来源不可用或不属于你');
    return {id, provider: c.provider, binding: sourceBinding(c), label: c.providerSpaceName || c.provider};
  });
}
export function publish(db: Database, scope: { workspaceId: string; userId: string }, input: Record<string, unknown>, updateId?: string) {
  requireSharing(db); ownerActive(db, scope);
  const old=updateId?ownedPublication(db,scope.workspaceId,scope.userId,updateId):undefined;
  const activate=input.intent==='activate';
  if(activate&&!['draft','closed'].includes(old?.status??''))throw new SharingError('请从未分享或已关闭分身的开放入口操作',409);
  if(old?.status==='active'&&input.intent==='draft')throw new SharingError('已开放的分享不能通过保存变成私有，请先关闭分享',409);
  const draft=(input.intent==='draft'||old?.status==='draft')&&!activate;
  const status=old?.status==='closed'&&!activate?'closed':draft?'draft':'active';
  const reopening=activate&&old?.status==='closed';
  if(old){
    assertPublicationVersion(old,input.version);
    assertPublicationIdle(db,old);
  }
  if (input.confirmed !== true || !Array.isArray(input.sourceIds) || input.sourceIds.length > 5 || input.sourceIds.some(x => typeof x !== "string")) throw new SharingError("请确认分享范围与费用");
  const config = publicationModel(db, input.modelId);
  const budgetMicros = power(input.budget), perRunMicros = power(input.perRun);
  if(old){const used=usageFor(db,old);if(budgetMicros<used.spent+used.held)throw new SharingError('总额度不能低于历史已用和预留电力');}
  if (perRunMicros > budgetMicros) throw new SharingError("单次限额不能大于总限额");
  const days = input.days;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 90) throw new SharingError("有效期应为 1 至 90 天");
  const expiresAt=new Date(Date.now() + Number(days) * 86400000).toISOString();
  if(old)validateServiceCommitments(db,old,budgetMicros,expiresAt);
  if (status==='active' && (!old||old.status!=='active') && db.publications!.filter(p => p.workspaceId === scope.workspaceId && p.userId === scope.userId && !p.deletedAt && p.status === "active").length >= 20) throw new SharingError("最多保留 20 个有效分享，请先关闭不需要的分享");
  if(status==='draft'&&!old&&db.publications!.filter(p=>p.workspaceId===scope.workspaceId&&p.userId===scope.userId&&!p.deletedAt&&p.status==='draft').length>=50)throw new SharingError('最多保留 50 个未分享分身，请先整理现有分身');
  const sources = publicationSources(db, scope, input.sourceIds);
  const service=validatePublicAvatarService(db,scope,input.service===undefined?old?.service:input.service);
  const serviceBusiness=validateBusinessConfig(db,scope,input.serviceBusiness,old?.serviceBusiness);
  const commerce=publicationCommerceFields(db,input);
  if(serviceBusiness?.access==='entitlement'&&(commerce.visitorMultiplier??0)>0)throw new SharingError('服务资格不能同时按访客电力收费，请选择一种收费方式');
  const p: Publication = { id: uid("pub"), ...scope, slug: randomBytes(18).toString("base64url"),
    ...commerce,authorName:avatarAuthorName(db,scope),service,serviceBusiness,
    ...(serviceBusiness?.access==='entitlement'?{requireLogin:true}:{}),
    version:old?(old.version??1)+1:1,userPrompt:text(input.prompt,12000,false),updatedAt:timestamp(),
    name: text(input.name, 60), description: text(input.description, 300, false),
    prompt: [config.model.systemPrompt, text(input.prompt, 12000, false)].filter(Boolean).join("\n\n"), modelId: config.model.id, taskVersion: config.version,
    sources, attachments: input.attachments === true, status, draftDays:Number(days), budgetMicros, perRunMicros, createdAt: timestamp(), expiresAt };
  if(old){p.id=old.id;p.slug=reopening?p.slug:old.slug;p.createdAt=old.createdAt;p.history=[...(old.history??[]),publicationSnapshot(old)].slice(-20);Object.assign(old,p);if(reopening)revokePublicationApi(old,p.updatedAt!);}
  else db.publications!.push(p);
  db.auditLogs.push({ id: uid("aud"), ...scope, actorUserId: scope.userId, action: reopening?'publication.reopened':status==='closed'?'publication.closed.updated':draft?(old?"publication.draft.updated":"publication.draft.created"):activate?"publication.activated":old?"publication.updated":"publication.created", targetType: "publication", targetId: p.id, details: {version:p.version, sources: sources.map(s => s.id), budgetMicros, perRunMicros }, createdAt: timestamp() });
  return p;
}
/** Explicit activation is separate from a private configuration save. */
export function activateSavedPublication(db:Database,scope:{workspaceId:string;userId:string},id:string,input:Record<string,unknown>) {
  const p=ownedPublication(db,scope.workspaceId,scope.userId,id);
  if(input.confirmed!==true)throw new SharingError('请确认开放的知识范围与费用规则');
  const previous=p.history?.at(-1),activationReceipt=p.status==='active'&&!!previous&&['draft','closed'].includes(previous.status)&&input.version===(previous.version??1)&&(p.version??1)===(previous.version??1)+1;
  if(p.status==='active'&&(input.version===(p.version??1)||activationReceipt))return activePublication(db,p.id); // A lost activation receipt is safe to query again.
  if(input.version!==(p.version??1))throw new SharingError('分身配置已变化，请重新核对后开放分享',409);
  if(!['draft','closed'].includes(p.status))throw new SharingError('请从未分享或已关闭分身的开放入口操作',409);
  if(p.userPrompt===undefined)throw new SharingError('这个旧版分身尚未单独保存你的回答要求。请先编辑、填写自己的提示词并保存，再开放分享；不会猜拆或丢弃原提示词。',409,'PUBLICATION_LEGACY_PROMPT');
  for(const source of p.sources){
    const current=db.knowledgeConnections.find(item=>item.id===source.id&&item.workspaceId===scope.workspaceId&&item.status==='connected');
    if(!current||sourceBinding(current)!==source.binding)throw new SharingError('知识连接已变化，请重新打开分身配置核对后再分享',409);
  }
  const allowedUsernames=(p.allowedUserIds??[]).map(userId=>{const user=db.users.find(item=>item.id===userId&&item.enabled);if(!user)throw new SharingError('允许访问的账号已变化，请重新核对配置',409);return user.username;});
  return publish(db,scope,{intent:'activate',version:p.version??1,name:p.name,description:p.description,prompt:p.userPrompt??'',modelId:p.modelId,sourceIds:p.sources.map(source=>source.id),attachments:p.attachments,budget:p.budgetMicros/1e6,perRun:p.perRunMicros/1e6,days:publicationConfiguredDays(p),visitorPercent:(p.visitorMultiplier??0)*100,requireLogin:p.requireLogin??false,allowedUsernames,confirmed:true},p.id);
}
/** Deleting is not a revocation workflow. Already-issued customer
 * rights must be explicitly resolved first, never silently discarded. */
function assertNoLivePublicationService(p: Publication) {
  const own = (item: {workspaceId: string; userId: string; publicationId: string}) => item.workspaceId === p.workspaceId && item.userId === p.userId && item.publicationId === p.id;
  const live = (item: {status: string; expiresAt: string}) => item.status === 'active' && Date.parse(item.expiresAt) > Date.now();
  if (p.serviceBusiness?.codes.some(code => own(code) && live(code)) || p.serviceBusiness?.entitlements.some(grant => own(grant) && live(grant))) throw new SharingError('还有有效的服务资格或未兑换的服务码。请先在服务管理里明确处理或撤销，再删除分身；不会自动取消客户权益。关闭分享仍然可用。', 409, 'PUBLICATION_SERVICE_COMMITMENT');
}
function auditPublicationLifecycle(db: Database, p: Publication, action: string) {
  db.auditLogs.push({id: uid('aud'), workspaceId: p.workspaceId, actorUserId: p.userId, action, targetType: 'publication', targetId: p.id, details: {version: p.version ?? 1, status: p.status}, createdAt: timestamp()});
}
export function closePublication(db: Database, scope: {workspaceId: string; userId: string}, id: string, input: Record<string, unknown>) {
  const p = ownedPublication(db, scope.workspaceId, scope.userId, id);
  if (input.confirmed !== true) throw new SharingError('请确认关闭分享', 400);
  const previous = p.history?.at(-1);
  if (p.status === 'closed' && (input.version === (p.version ?? 1) || previous?.status === 'active' && input.version === (previous.version ?? 1) && (p.version ?? 1) === (previous.version ?? 1) + 1)) return p;
  assertPublicationVersion(p, input.version);
  if (p.status !== 'active') throw new SharingError('这个分身尚未开放分享，不需要关闭', 409);
  // Privacy withdrawal must remain available even while a visitor is waiting
  // or a paid service entitlement exists. Stop future access, preserve every
  // service promise and admitted model usage; do not silently revoke rights.
  retainPublicationSnapshot(p); p.draftDays ??= publicationConfiguredDays(p); p.status = 'closed'; p.version = (p.version ?? 1) + 1; p.updatedAt = timestamp();
  revokePublicationApi(p, p.updatedAt);
  auditPublicationLifecycle(db, p, 'publication.closed');
  return p;
}
export function deletePublication(db: Database, scope: {workspaceId: string; userId: string}, id: string, input: Record<string, unknown>) {
  const p = ownedPublication(db, scope.workspaceId, scope.userId, id, {includeDeleted: true});
  if (input.confirmed !== true) throw new SharingError('请确认移入回收站；历史和账单会保留', 400);
  const previous = p.history?.at(-1);
  if (p.deletedAt && (input.version === (p.version ?? 1) || !!previous && !previous.deletedAt && input.version === (previous.version ?? 1) && (p.version ?? 1) === (previous.version ?? 1) + 1)) return p;
  if (p.deletedAt) throw new SharingError('分身已在回收站，请刷新列表', 409, 'PUBLICATION_VERSION_CHANGED');
  assertPublicationVersion(p, input.version); assertPublicationIdle(db, p); assertNoLivePublicationService(p);
  retainPublicationSnapshot(p); p.draftDays ??= publicationConfiguredDays(p);
  p.status = p.status === 'draft' ? 'draft' : 'closed'; p.deletedAt = timestamp(); p.updatedAt = p.deletedAt; p.version = (p.version ?? 1) + 1;
  revokePublicationApi(p, p.deletedAt);
  auditPublicationLifecycle(db, p, 'publication.deleted');
  return p;
}
export function restorePublication(db: Database, scope: {workspaceId: string; userId: string}, id: string, input: Record<string, unknown>) {
  const p = ownedPublication(db, scope.workspaceId, scope.userId, id, {includeDeleted: true});
  if (input.confirmed !== true) throw new SharingError('请确认从回收站恢复；恢复后不会自动公开', 400);
  const previous = p.history?.at(-1);
  if (!p.deletedAt && !!previous?.deletedAt && input.version === (previous.version ?? 1) && (p.version ?? 1) === (previous.version ?? 1) + 1) return p;
  if (!p.deletedAt) throw new SharingError('这个分身不在回收站', 409);
  assertPublicationVersion(p, input.version);
  if (p.status === 'draft' && db.publications!.filter(item => item.workspaceId === scope.workspaceId && item.userId === scope.userId && !item.deletedAt && item.status === 'draft').length >= 50) throw new SharingError('最多保留 50 个未分享分身，请先整理现有分身');
  retainPublicationSnapshot(p); delete p.deletedAt; p.status = p.status === 'draft' ? 'draft' : 'closed'; p.updatedAt = timestamp(); p.version = (p.version ?? 1) + 1;
  auditPublicationLifecycle(db, p, 'publication.restored');
  return p;
}
export function createGuest(db: Database, publicationId: string,identity?:VisitorIdentity,internalApi=false) {
  const p = activePublication(db, publicationId);
  if(!internalApi)publicationAccess(db,p,identity);
  const sessions = db.publicSessions!.filter(s => s.publicationId === p.id);
  if (sessions.length >= 500 || sessions.filter(s => Date.now() - Date.parse(s.createdAt) < 60000).length >= 10) throw new SharingError("访问较多，请稍后再试或联系发布者", 429);
  const token = randomBytes(32).toString("base64url"), id = uid("gst");
  const session: PublicSession = { id, workspaceId: p.workspaceId, userId: id, publicationId: p.id, tokenHash: digest(token), uploadBytes: 0, uploadCount: 0, createdAt: timestamp(), expiresAt: new Date(Math.min(Date.parse(p.expiresAt), Date.now() + 7 * 86400000)).toISOString() };
  session.publicationVersion=p.version??1;
  if(identity){session.accountUserId=identity.userId;session.accountWorkspaceId=identity.workspaceId;}
  db.publicSessions!.push(session); return { session, token };
}
export function guest(db: Database, slug: string, token: string) {
  requireSharing(db);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SharingError("访客会话已失效，请重新打开", 401);
  const p = db.publications!.find(p => p.slug === slug);
  if (!p) throw new SharingError("分享不存在", 404);
  const s = db.publicSessions!.find(s => s.publicationId === p.id && s.workspaceId === p.workspaceId && s.tokenHash === digest(token) && Date.parse(s.expiresAt) > Date.now());
  if (!s) throw new SharingError("访客会话已失效，请重新打开", 401);
  activePublication(db, p.id);
  if((s.publicationVersion??1)!==(p.version??1))throw new SharingError('分身已更新，请重新开始；旧会话资料不会带入新版',409,'PUBLICATION_UPDATED');
  return { publication: p, session: s };
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
  if((r.publicationVersion??1)!==(p.version??1))throw new SharingError('分身版本已变化，请重新开始',409);
  if(r.apiGrantId){const g=p.apiGrants?.find(g=>g.id===r.apiGrantId&&g.workspaceId===p.workspaceId&&g.userId===p.userId);if(!g)throw new SharingError('API 授权不可用',403);checkApiBudget(db,p,g,r.id,amount);}
  verifyRunCommerce(db,p,r,amount);
  checkPublicServiceBudget(db,p,r,amount);
  if (all.spent + all.held + amount > p.budgetMicros || own.spent + own.held + amount > p.perRunMicros) throw new SharingError("本次问题预计用量超过分享额度，请缩小问题范围或联系发布者", 402);
}
export function beginPublicRun(db: Database, p: Publication, s: PublicSession, input: Record<string, unknown>) {
  p=activePublication(db, p.id);
  if((s.publicationVersion??1)!==(p.version??1))throw new SharingError('分身已更新，请重新开始',409,'PUBLICATION_UPDATED');
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
  run.publicationVersion=p.version??1;
  run.apiGrantId=s.apiGrantId;run.entryPoint=s.apiGrantId?'published_api':'published_web';
  run.commerce=runCommerce(db,p,s);
  assignPublicServiceEntitlement(db,p,s,run);
  if((run.commerce?.multiplier??0)>0&&(input.confirmedPriceVersion!==(p.version??1)||input.confirmedPayment!==true))throw new SharingError('请确认当前版本的访客费用',409);
  db.publicRuns!.push(run); checkRunBudget(db, run.id, 1); return { run, created: true };
}
export function publicRun(run: PublicRun,db?:Database) {
  const rows=db?.modelUsageRecords.filter(r=>r.workspaceId===run.workspaceId&&r.conversationId===run.id)??[];
  const chargedMicros=rows.reduce((n,r)=>n+(r.commercial?.payerChargedMicros??0),0);
  const heldMicros=rows.reduce((n,r)=>n+(r.commercial?.payerReservedMicros??0),0);
  return { id: run.id, operationId: run.operationId, content: run.content, response: run.response, status: run.status, finishReason: run.finishReason, error: run.error, warning: run.warning, createdAt: run.createdAt,version:run.publicationVersion??1,chargedMicros,heldMicros,stage:run.stage,artifacts:run.artifacts??[] };
}
