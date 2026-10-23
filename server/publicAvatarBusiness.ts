import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './types.js';
import type { Publication, PublicRun, PublicSession } from './publicSharingTypes.js';
import { activePublication, ownedPublication, SharingError } from './publicSharing.js';
import { visitorUser, type VisitorIdentity } from './visitorAccounts.js';
import { uid } from './security.js';

/** Retail service terms are not a ONE membership, wallet credit, or proof of payment. */
export type AvatarServicePlan = {
  id: string; workspaceId: string; userId: string; name: string;
  kind: 'monthly' | 'credits'; quotaMicros: number; priceCny: number; validDays: number;
  status: 'active' | 'archived';
};
type OwnedRecord = { id: string; workspaceId: string; userId: string; publicationId: string; createdAt: string };
export type AvatarRedemptionCode = OwnedRecord & {
  tokenHash: string; plan: AvatarServicePlan; source: 'manual_fulfillment' | 'gift';
  status: 'active' | 'redeemed' | 'revoked'; expiresAt: string; revokedAt?: string;
  redeemedAt?: string; visitorUserId?: string; visitorWorkspaceId?: string; entitlementId?: string;
};
export type AvatarEntitlement = OwnedRecord & {
  visitorUserId: string; visitorWorkspaceId: string; codeId: string; plan: AvatarServicePlan;
  source: AvatarRedemptionCode['source']; quotaMicros: number;
  status: 'active' | 'revoked'; expiresAt: string; revokedAt?: string;
};
export type AvatarIntakeField = { id: string; label: string; type: 'text' | 'number' | 'email' | 'phone'; required: boolean };
export type AvatarLead = OwnedRecord & {
  sessionId: string; visitorUserId?: string; visitorWorkspaceId?: string; operationId: string;
  payloadHash: string; publicationVersion: number; consentedAt: string;
  fields: { id: string; label: string; type: AvatarIntakeField['type']; value: string | number }[];
};
export type AvatarBusinessState = {
  access: 'open' | 'entitlement'; plans: AvatarServicePlan[];
  codes: AvatarRedemptionCode[]; entitlements: AvatarEntitlement[];
  intakeFields: AvatarIntakeField[]; leads: AvatarLead[];
};
export type AvatarRunEntitlement = { id: string; visitorUserId: string };

type BusinessPublication = Publication & { serviceBusiness?: AvatarBusinessState };
type BusinessRun = PublicRun & { serviceEntitlement?: AvatarRunEntitlement };
const now = () => new Date().toISOString();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const day = 86_400_000;
const empty = (): AvatarBusinessState => ({ access: 'open', plans: [], codes: [], entitlements: [], intakeFields: [], leads: [] });
const business = (p: Publication) => (p as BusinessPublication).serviceBusiness;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function label(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new SharingError('请检查名称和内容长度');
  return value.trim();
}
function assertOwner(db: Database, scope: VisitorIdentity, p: Publication) {
  return ownedPublication(db, scope.workspaceId, scope.userId, p.id);
}
function assertSession(db: Database, p: Publication, supplied: PublicSession) {
  const s = db.publicSessions?.find(s => s.id === supplied.id && s.publicationId === p.id && s.workspaceId === p.workspaceId && s.userId === s.id && s.tokenHash === supplied.tokenHash);
  if (!s || Date.parse(s.expiresAt) <= Date.now()) throw new SharingError('会话已结束，请重新打开', 401);
  if ((s.publicationVersion ?? 1) !== (p.version ?? 1)) throw new SharingError('分身已更新，请重新打开后继续', 409, 'PUBLICATION_UPDATED');
  return s;
}
function account(db: Database, s: PublicSession) {
  if (!s.accountUserId || !s.accountWorkspaceId) throw new SharingError('请先登录，服务资格会保留在你的账号中', 401, 'VISITOR_LOGIN_REQUIRED');
  const identity = { userId: s.accountUserId, workspaceId: s.accountWorkspaceId };
  visitorUser(db, identity);
  return identity;
}
function audit(db: Database, p: Publication, action: string, targetId: string, details?: Record<string, unknown>) {
  db.auditLogs.push({ id: uid('aud'), workspaceId: p.workspaceId, actorUserId: p.userId, action, targetType: 'publication_service', targetId, details, createdAt: now() });
}
function scoped(p: Publication, record: OwnedRecord) {
  return record.workspaceId === p.workspaceId && record.userId === p.userId && record.publicationId === p.id;
}
function publicPlan(p: AvatarServicePlan) {
  return { id: p.id, name: p.name, kind: p.kind, quotaMicros: p.quotaMicros, priceCny: p.priceCny, validDays: p.validDays, status: p.status };
}

/** Validate only owner-authored terms. Never accept entitlements, codes or leads from the browser. */
export function validateBusinessConfig(db: Database, scope: VisitorIdentity, input: unknown, previous?: AvatarBusinessState): AvatarBusinessState | undefined {
  if (input === undefined) return previous;
  if (!db.users.some(u => u.id === scope.userId && u.enabled) || !db.workspaces.some(w => w.id === scope.workspaceId && w.status === 'active') || !db.workspaceMembers.some(m => m.workspaceId === scope.workspaceId && m.userId === scope.userId && m.role === 'owner' && m.status !== 'disabled')) throw new SharingError('只有此空间的所有者可以配置服务', 403);
  if (!plain(input) || !['open', 'entitlement'].includes(String(input.access)) || !Array.isArray(input.plans) || input.plans.length > 6 || !Array.isArray(input.intakeFields) || input.intakeFields.length > 6) throw new SharingError('请检查服务方案和联系表单，最多各 6 项');
  if (previous?.access === 'entitlement' && input.access === 'open') {
    const owned = (record: OwnedRecord) => record.workspaceId === scope.workspaceId && record.userId === scope.userId;
    if (previous.codes.some(c => owned(c) && c.status === 'active' && Date.parse(c.expiresAt) > Date.now()) || previous.entitlements.some(e => owned(e) && e.status === 'active' && Date.parse(e.expiresAt) > Date.now())) throw new SharingError('仍有已发出的服务资格；请先明确撤销相关兑换码和资格，再改为开放试聊', 409);
  }
  const seen = new Set<string>();
  const plans: AvatarServicePlan[] = input.plans.map(value => {
    if (!plain(value) || !['monthly', 'credits'].includes(String(value.kind))) throw new SharingError('请选择按月含额度或额度包');
    const old = typeof value.id === 'string' ? previous?.plans.find(p => p.id === value.id && p.workspaceId === scope.workspaceId && p.userId === scope.userId) : undefined;
    if (value.id !== undefined && !old) throw new SharingError('服务方案不属于此分身', 403);
    const id = old?.id ?? uid('asp');
    if (seen.has(id)) throw new SharingError('服务方案重复');
    seen.add(id);
    const quota = value.quota ?? (typeof value.quotaMicros === 'number' ? value.quotaMicros / 1e6 : undefined);
    const micros = typeof quota === 'number' ? Math.round(quota * 1e6) : NaN;
    const price = value.priceCny;
    const validDays = value.kind === 'monthly' ? 30 : value.validDays;
    if (!Number.isSafeInteger(micros) || micros < 10_000 || micros > 10_000 * 1e6 || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1e6 || Math.abs(Math.round(price * 100) - price * 100) > 1e-6 || !Number.isInteger(validDays) || Number(validDays) < 1 || Number(validDays) > 89 || value.status !== undefined && !['active', 'archived'].includes(String(value.status))) throw new SharingError('服务额度为 0.01–10000，价格最多两位小数；额度包有效期为 1–89 天');
    return { id, ...scope, name: label(value.name, 60), kind: value.kind as AvatarServicePlan['kind'], quotaMicros: micros, priceCny: Math.round(price * 100) / 100, validDays: Number(validDays), status: value.status === 'archived' ? 'archived' : 'active' };
  });
  const fieldIds = new Set<string>();
  const intakeFields: AvatarIntakeField[] = input.intakeFields.map(value => {
    if (!plain(value) || typeof value.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value.id) || fieldIds.has(value.id) || !['text', 'number', 'email', 'phone'].includes(String(value.type)) || value.required !== undefined && typeof value.required !== 'boolean') throw new SharingError('联系表单字段无效或重复');
    fieldIds.add(value.id);
    return { id: value.id, label: label(value.label, 40), type: value.type as AvatarIntakeField['type'], required: value.required === true };
  });
  return { access: input.access as AvatarBusinessState['access'], plans, intakeFields,
    codes: previous?.codes ?? [], entitlements: previous?.entitlements ?? [], leads: previous?.leads ?? [] };
}

function entitlementUsage(db: Database, p: Publication, id: string) {
  const runs = new Set((db.publicRuns ?? []).filter(r => r.workspaceId === p.workspaceId && r.publicationId === p.id && (r as BusinessRun).serviceEntitlement?.id === id).map(r => r.id));
  const rows = db.modelUsageRecords.filter(r => r.workspaceId === p.workspaceId && r.userId === p.userId && runs.has(r.conversationId));
  return { spentMicros: rows.reduce((n, r) => n + (r.chargedMicros ?? 0), 0), heldMicros: rows.reduce((n, r) => n + (r.reservedMicros ?? 0), 0) };
}

/** Publishing new settings cannot silently retract already-issued promises.
 * Revoke a code/grant explicitly first when its commitment must be withdrawn. */
export function validateServiceCommitments(db: Database, supplied: Publication, nextBudgetMicros: number, nextExpiresAt: string): void {
  const p = ownedPublication(db, supplied.workspaceId, supplied.userId, supplied.id), state = business(p);
  if (!state) return;
  const activeCodes = state.codes.filter(c => scoped(p, c) && c.status === 'active' && Date.parse(c.expiresAt) > Date.now());
  const activeEntitlements = state.entitlements.filter(e => scoped(p, e) && e.status === 'active' && Date.parse(e.expiresAt) > Date.now());
  if (!activeCodes.length && !activeEntitlements.length) return;
  const runIds = new Set((db.publicRuns ?? []).filter(r => r.workspaceId === p.workspaceId && r.publicationId === p.id).map(r => r.id));
  const spentAndHeld = db.modelUsageRecords.filter(r => r.workspaceId === p.workspaceId && r.userId === p.userId && runIds.has(r.conversationId)).reduce((n, r) => n + (r.chargedMicros ?? 0) + (r.reservedMicros ?? 0), 0);
  const minimumBudget = spentAndHeld + activeCodes.reduce((n, c) => n + c.plan.quotaMicros, 0)
    + activeEntitlements.reduce((n, e) => n + entitlementView(db, p, e).remainingMicros, 0);
  if (!Number.isSafeInteger(nextBudgetMicros) || nextBudgetMicros < minimumBudget) throw new SharingError('总限额不足以保留已发出的服务资格；请保留相应额度，或先明确撤销不再提供的资格', 409);
  const promisedUntil = Math.max(...activeCodes.map(c => Date.parse(c.expiresAt) + c.plan.validDays * day), ...activeEntitlements.map(e => Date.parse(e.expiresAt)));
  if (!Number.isFinite(Date.parse(nextExpiresAt)) || Date.parse(nextExpiresAt) < promisedUntil) throw new SharingError('分身有效期不能短于已发出的服务期限；请保留完整期限，或先明确撤销相关资格', 409);
}
function entitlementView(db: Database, p: Publication, e: AvatarEntitlement) {
  const usage = entitlementUsage(db, p, e.id);
  return { id: e.id, planName: e.plan.name, kind: e.plan.kind, source: e.source, status: e.status, quotaMicros: e.quotaMicros, ...usage, remainingMicros: Math.max(0, e.quotaMicros - usage.spentMicros - usage.heldMicros), expiresAt: e.expiresAt, createdAt: e.createdAt, expired: Date.parse(e.expiresAt) <= Date.now() };
}
function ownEntitlements(db: Database, p: Publication, identity: VisitorIdentity) {
  return (business(p)?.entitlements ?? []).filter(e => scoped(p, e) && e.visitorUserId === identity.userId && e.visitorWorkspaceId === identity.workspaceId);
}
function availableEntitlement(db: Database, p: Publication, identity: VisitorIdentity) {
  // A tiny remainder must not trap an account after it receives a fresh quota.
  // One run keeps one grant; select the largest usable balance up front, then
  // prefer the earlier expiry only when balances are equal.
  return ownEntitlements(db, p, identity)
    .filter(e => e.status === 'active' && Date.parse(e.expiresAt) > Date.now())
    .map(e => ({ entitlement: e, remaining: entitlementView(db, p, e).remainingMicros }))
    .filter(e => e.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || Date.parse(a.entitlement.expiresAt) - Date.parse(b.entitlement.expiresAt))[0]?.entitlement;
}

/** Issue one high-entropy code; only its hash is retained. Source describes fulfillment, not a payment claim. */
export function issueServiceCode(db: Database, scope: VisitorIdentity, supplied: Publication, input: unknown) {
  const p = assertOwner(db, scope, supplied);
  activePublication(db, p.id);
  const state = business(p);
  if (!state || state.access !== 'entitlement' || (p.visitorMultiplier ?? 0) > 0) throw new SharingError('请先选择独立服务资格，并关闭按次访客收费');
  if (!plain(input) || input.confirmed !== true || !['manual_fulfillment', 'gift'].includes(String(input.source))) throw new SharingError('请确认此资格由老师安排，实际使用费用由老师承担');
  const plan = state.plans.find(v => v.id === input.planId && v.workspaceId === p.workspaceId && v.userId === p.userId && v.status === 'active');
  if (!plan) throw new SharingError('服务方案不可用', 404);
  const expiresDays = input.expiresDays ?? 30;
  if (!Number.isInteger(expiresDays) || Number(expiresDays) < 1 || Number(expiresDays) > 90 || state.codes.length >= 100 || state.entitlements.length >= 100) throw new SharingError('每个分身最多 100 份服务资格，兑换有效期为 1–90 天');
  const latestRedemptionAt = Date.parse(p.expiresAt) - plan.validDays * day;
  if (latestRedemptionAt <= Date.now()) throw new SharingError('分身的剩余有效期不足以交付这份服务，请先延长分身有效期', 409);
  // Do not promise more independent allowances than the publisher's remaining total cap.
  const runIds = new Set((db.publicRuns ?? []).filter(r => r.workspaceId === p.workspaceId && r.publicationId === p.id).map(r => r.id));
  const spentAndHeld = db.modelUsageRecords.filter(r => r.workspaceId === p.workspaceId && r.userId === p.userId && runIds.has(r.conversationId)).reduce((n, r) => n + (r.chargedMicros ?? 0) + (r.reservedMicros ?? 0), 0);
  const committed = state.codes.filter(c => scoped(p, c) && c.status === 'active' && Date.parse(c.expiresAt) > Date.now()).reduce((n, c) => n + c.plan.quotaMicros, 0)
    + state.entitlements.filter(e => scoped(p, e) && e.status === 'active' && Date.parse(e.expiresAt) > Date.now()).reduce((n, e) => n + entitlementView(db, p, e).remainingMicros, 0);
  if (spentAndHeld + committed + plan.quotaMicros > p.budgetMicros) throw new SharingError('已安排的服务额度接近分身总限额，请先提高总限额或减少新资格额度', 402);
  const code = randomBytes(32).toString('base64url');
  const grant: AvatarRedemptionCode = { id: uid('asc'), workspaceId: p.workspaceId, userId: p.userId, publicationId: p.id, tokenHash: hash(code), plan: structuredClone(plan), source: input.source as AvatarRedemptionCode['source'], status: 'active', createdAt: now(), expiresAt: new Date(Math.min(latestRedemptionAt, Date.now() + Number(expiresDays) * day)).toISOString() };
  state.codes.push(grant);
  audit(db, p, 'publication.service.code.created', grant.id, { planId: plan.id, quotaMicros: plan.quotaMicros, source: grant.source });
  return { code, grant: codeView(grant) };
}
function codeView(c: AvatarRedemptionCode) {
  return { id: c.id, planName: c.plan.name, source: c.source, status: c.status, expiresAt: c.expiresAt, createdAt: c.createdAt, redeemedAt: c.redeemedAt, entitlementId: c.entitlementId };
}

export function redeemServiceCode(db: Database, supplied: Publication, suppliedSession: PublicSession, inputCode: unknown) {
  const p = activePublication(db, supplied.id), s = assertSession(db, p, suppliedSession), identity = account(db, s), state = business(p);
  if (!state || state.access !== 'entitlement' || (p.visitorMultiplier ?? 0) > 0 || s.apiGrantId) throw new SharingError('这个分身暂不接受服务资格兑换', 409);
  if (typeof inputCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(inputCode.trim())) throw new SharingError('兑换码不正确，请核对老师发给你的兑换码', 400);
  const c = state.codes.find(c => scoped(p, c) && c.tokenHash === hash(inputCode.trim()));
  if (!c) throw new SharingError('兑换码不可用，请核对或联系老师', 404);
  if (c.status === 'redeemed') {
    const e = state.entitlements.find(e => scoped(p, e) && e.id === c.entitlementId && e.visitorUserId === identity.userId && e.visitorWorkspaceId === identity.workspaceId);
    if (!e || c.visitorUserId !== identity.userId || c.visitorWorkspaceId !== identity.workspaceId) throw new SharingError('这个兑换码已被使用', 409);
    return entitlementView(db, p, e);
  }
  if (c.status !== 'active' || Date.parse(c.expiresAt) <= Date.now()) throw new SharingError('兑换码已过期或撤销，请联系老师', 410);
  if (Date.parse(p.expiresAt) < Date.now() + c.plan.validDays * day) throw new SharingError('老师需要先延长分身有效期，才能开通完整服务期限', 409);
  if (state.entitlements.length >= 100) throw new SharingError('服务资格暂时无法开通，请联系老师', 429);
  const e: AvatarEntitlement = { id: uid('ase'), workspaceId: p.workspaceId, userId: p.userId, publicationId: p.id, visitorUserId: identity.userId, visitorWorkspaceId: identity.workspaceId, codeId: c.id, plan: structuredClone(c.plan), source: c.source, quotaMicros: c.plan.quotaMicros, status: 'active', createdAt: now(), expiresAt: new Date(Date.now() + c.plan.validDays * day).toISOString() };
  c.status = 'redeemed'; c.redeemedAt = e.createdAt; c.visitorUserId = identity.userId; c.visitorWorkspaceId = identity.workspaceId; c.entitlementId = e.id;
  state.entitlements.push(e);
  audit(db, p, 'publication.service.redeemed', e.id, { codeId: c.id, planId: c.plan.id });
  return entitlementView(db, p, e);
}

export function revokeServiceGrant(db: Database, scope: VisitorIdentity, supplied: Publication, id: string) {
  const p = assertOwner(db, scope, supplied), state = business(p);
  const code = state?.codes.find(c => scoped(p, c) && c.id === id);
  const entitlement = state?.entitlements.find(e => scoped(p, e) && (e.id === id || e.id === code?.entitlementId));
  if (!code && !entitlement) throw new SharingError('服务资格不存在', 404);
  if (code && code.status !== 'redeemed') { code.status = 'revoked'; code.revokedAt ??= now(); }
  if (entitlement) { entitlement.status = 'revoked'; entitlement.revokedAt ??= now(); }
  audit(db, p, 'publication.service.revoked', id);
  return { ok: true };
}

export function serviceManagement(db: Database, scope: VisitorIdentity, supplied: Publication) {
  const p = assertOwner(db, scope, supplied), state = business(p) ?? empty();
  return { access: state.access, paymentMode: 'external_manual' as const, plans: state.plans.map(publicPlan), intakeFields: state.intakeFields,
    codes: state.codes.filter(c => scoped(p, c)).map(codeView).reverse(),
    entitlements: state.entitlements.filter(e => scoped(p, e)).map(e => ({ ...entitlementView(db, p, e), visitorName: db.users.find(u => u.id === e.visitorUserId && u.defaultWorkspaceId === e.visitorWorkspaceId)?.username ?? '不可用账号' })).reverse() };
}

export function servicePublicSnapshot(db: Database, supplied: Publication, suppliedSession?: PublicSession) {
  const p = activePublication(db, supplied.id), state = business(p) ?? empty();
  const result = { access: state.access, paymentMode: 'external_manual' as const, plans: state.plans.filter(p => p.status === 'active').map(publicPlan), intakeFields: state.intakeFields };
  if (!suppliedSession) return result;
  const s = assertSession(db, p, suppliedSession);
  if (!s.accountUserId || !s.accountWorkspaceId) return result;
  const identity = account(db, s), own = ownEntitlements(db, p, identity);
  const current = availableEntitlement(db, p, identity) ?? own.at(-1);
  return { ...result, entitlement: current ? entitlementView(db, p, current) : undefined };
}

/** Attach immutable identity at run creation, before any model/tool invocation. */
export function assignPublicServiceEntitlement(db: Database, supplied: Publication, suppliedSession: PublicSession, run: PublicRun) {
  const p = activePublication(db, supplied.id), s = assertSession(db, p, suppliedSession);
  if (run.workspaceId !== p.workspaceId || run.publicationId !== p.id || run.sessionId !== s.id || run.userId !== s.userId) throw new SharingError('任务不属于此会话', 403);
  if (business(p)?.access !== 'entitlement') return;
  if ((p.visitorMultiplier ?? 0) > 0 || s.apiGrantId || run.commerce?.multiplier) throw new SharingError('独立服务资格不能与按次收费或 API 授权混用', 403);
  const identity = account(db, s), e = availableEntitlement(db, p, identity);
  if (!e) throw new SharingError('请先兑换服务资格；已有资格用完或过期时可联系老师续接', 402, 'SERVICE_ENTITLEMENT_REQUIRED');
  (run as BusinessRun).serviceEntitlement = { id: e.id, visitorUserId: identity.userId };
}

/** All actual child model/tool records use the same public run ID and count once. */
export function checkPublicServiceBudget(db: Database, supplied: Publication, run: PublicRun, amount: number) {
  const p = activePublication(db, supplied.id), marker = (run as BusinessRun).serviceEntitlement;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new SharingError('服务用量无效');
  if (!marker && business(p)?.access !== 'entitlement') return;
  if (!marker || run.workspaceId !== p.workspaceId || run.publicationId !== p.id || run.status !== 'running' || run.apiGrantId || (p.visitorMultiplier ?? 0) > 0 || run.commerce?.multiplier) throw new SharingError('服务资格已变化，请重新打开后继续', 409);
  const s = db.publicSessions?.find(s => s.id === run.sessionId && s.publicationId === p.id && s.workspaceId === p.workspaceId);
  if (!s) throw new SharingError('会话已结束', 401);
  const canonical = assertSession(db, p, s), identity = account(db, canonical);
  const e = business(p)?.entitlements.find(e => scoped(p, e) && e.id === marker.id && e.visitorUserId === marker.visitorUserId && e.visitorUserId === identity.userId && e.visitorWorkspaceId === identity.workspaceId);
  if (!e || e.status !== 'active' || Date.parse(e.expiresAt) <= Date.now()) throw new SharingError('服务资格已过期或撤销，请联系老师', 402, 'SERVICE_ENTITLEMENT_REQUIRED');
  const usage = entitlementUsage(db, p, e.id);
  if (usage.spentMicros + usage.heldMicros + amount > e.quotaMicros) throw new SharingError('这份服务资格的额度已不足，请联系老师续接；已完成内容会保留', 402, 'SERVICE_ALLOWANCE_EXHAUSTED');
}

/** Visitor-authored values only. No chat text, model summary, attachment or inferred profile is copied. */
export function submitAvatarLead(db: Database, supplied: Publication, suppliedSession: PublicSession, input: unknown) {
  const p = activePublication(db, supplied.id), s = assertSession(db, p, suppliedSession), state = business(p);
  if (!state?.intakeFields.length) throw new SharingError('这个分身尚未开放联系表单', 404);
  if (!plain(input) || input.consent !== true || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.operationId) || !plain(input.fields)) throw new SharingError('请确认要发送给老师的资料后再提交');
  if (Object.keys(input.fields).some(id => !state.intakeFields.some(field => field.id === id))) throw new SharingError('表单字段已变化，请重新填写', 409);
  const values = input.fields;
  const fields: AvatarLead['fields'] = [];
  for (const field of state.intakeFields) {
    const value = values[field.id];
    if (value === undefined || value === null || typeof value === 'string' && !value.trim()) {
      if (field.required) throw new SharingError(`请填写${field.label}`);
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) throw new SharingError(`${field.label}请填写有效数字`);
      fields.push({ ...field, value });
    } else {
      if (typeof value !== 'string' || value.trim().length > 1000) throw new SharingError(`${field.label}最多 1000 字`);
      const trimmed = value.trim();
      if (field.type === 'email' && (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) || field.type === 'phone' && !/^[+\d][\d ()+.-]{5,29}$/.test(trimmed)) throw new SharingError(`请检查${field.label}的格式`);
      fields.push({ ...field, value: trimmed });
    }
  }
  if (!fields.length) throw new SharingError('请至少填写一项要发送的资料');
  const payloadHash = hash(JSON.stringify(fields));
  const old = state.leads.find(l => scoped(p, l) && l.sessionId === s.id && l.operationId === input.operationId);
  if (old) {
    if (old.payloadHash !== payloadHash) throw new SharingError('这次提交已收到；修改资料请另行提交', 409);
    return { id: old.id, submittedAt: old.consentedAt, fields: old.fields };
  }
  if (state.leads.length >= 200 || state.leads.filter(l => scoped(p, l) && l.sessionId === s.id).length >= 5 || state.leads.filter(l => scoped(p, l) && Date.now() - Date.parse(l.createdAt) < 60_000).length >= 10) throw new SharingError('联系请求较多，请稍后再试', 429);
  const createdAt = now();
  const lead: AvatarLead = { id: uid('asl'), workspaceId: p.workspaceId, userId: p.userId, publicationId: p.id, sessionId: s.id, visitorUserId: s.accountUserId, visitorWorkspaceId: s.accountWorkspaceId, operationId: input.operationId, payloadHash, publicationVersion: p.version ?? 1, consentedAt: createdAt, fields, createdAt };
  state.leads.push(lead);
  audit(db, p, 'publication.lead.consented', lead.id, { fieldIds: fields.map(f => f.id) });
  return { id: lead.id, submittedAt: lead.consentedAt, fields: lead.fields };
}

export function listAvatarLeads(db: Database, scope: VisitorIdentity, supplied: Publication) {
  const p = assertOwner(db, scope, supplied);
  return { items: (business(p)?.leads ?? []).filter(l => scoped(p, l)).slice().reverse().map(l => ({ id: l.id, submittedAt: l.consentedAt, fields: l.fields, version: l.publicationVersion })) };
}
