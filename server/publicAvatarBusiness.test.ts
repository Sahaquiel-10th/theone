import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { Store } from './db.js';
import type { Database, ModelConfig, ModelUsageRecord } from './types.js';
import type { Publication, PublicRun } from './publicSharingTypes.js';
import { createGuest, guest, publish, SharingError } from './publicSharing.js';
import { installPublicAvatarBusinessRoutes } from './publicAvatarBusinessRoutes.js';
import { registerVisitor } from './visitorAccounts.js';
import {
  assignPublicServiceEntitlement, checkPublicServiceBudget, issueServiceCode, listAvatarLeads,
  redeemServiceCode, revokeServiceGrant, serviceManagement, servicePublicSnapshot,
  submitAvatarLead, validateBusinessConfig, type AvatarBusinessState,
  validateServiceCommitments,
} from './publicAvatarBusiness.js';

function fixture() {
  const model = { id: 'model', name: 'Fixture', apiKey: 'synthetic-not-real', enabled: true, kind: 'chat', systemPrompt: '' } as ModelConfig;
  const db = { users: [], workspaces: [], workspaceMembers: [], powerAccounts: [], powerLedger: [], rechargeOrders: [], auditLogs: [], models: [model], settings: { safetyRules: 'safe', rechargeCnyPerPower: 7 }, publications: [], publicSessions: [], publicRuns: [], attachments: [], knowledgeConnections: [], messages: [], modelUsageRecords: [] } as unknown as Database;
  const owner = registerVisitor(db, { username: 'teacher', password: 'synthetic-password' });
  const visitor = registerVisitor(db, { username: 'learner', password: 'synthetic-password' });
  const other = registerVisitor(db, { username: 'another', password: 'synthetic-password' });
  const scope = { userId: owner.id, workspaceId: owner.defaultWorkspaceId };
  const identity = { userId: visitor.id, workspaceId: visitor.defaultWorkspaceId };
  const otherIdentity = { userId: other.id, workspaceId: other.defaultWorkspaceId };
  const input = { name: 'Synthetic teacher', description: '', prompt: '', modelId: model.id, sourceIds: [], attachments: false, budget: 10, perRun: 1, days: 90, confirmed: true };
  const p = publish(db, scope, input) as Publication & { serviceBusiness?: AvatarBusinessState };
  p.serviceBusiness = validateBusinessConfig(db, scope, {
    access: 'entitlement',
    plans: [{ name: '30 天咨询', kind: 'monthly', quota: 1, priceCny: 99 }],
    intakeFields: [{ id: 'name', label: '称呼', type: 'text', required: true }, { id: 'budget', label: '预算', type: 'number' }, { id: 'email', label: '邮箱', type: 'email' }],
  });
  const s = createGuest(db, p.id, identity).session;
  const otherSession = createGuest(db, p.id, otherIdentity).session;
  return { db, p, scope, identity, otherIdentity, s, otherSession, input };
}
function issue(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return issueServiceCode(f.db, f.scope, f.p, { planId: f.p.serviceBusiness!.plans[0].id, source: 'manual_fulfillment', confirmed: true, ...extra });
}
function run(f: ReturnType<typeof fixture>, id = 'run-one'): PublicRun {
  return { id, workspaceId: f.p.workspaceId, userId: f.s.userId, publicationId: f.p.id, sessionId: f.s.id, operationId: 'synthetic-operation', payloadHash: 'hash', content: 'synthetic question', attachmentIds: [], status: 'running', createdAt: new Date().toISOString() };
}
function cost(f: ReturnType<typeof fixture>, id: string, spent: number, held = 0, extra: Partial<ModelUsageRecord> = {}) {
  f.db.modelUsageRecords.push({ id: `usage-${f.db.modelUsageRecords.length}`, workspaceId: f.p.workspaceId, userId: f.p.userId, conversationId: id, chargedMicros: spent, reservedMicros: held, ...extra } as ModelUsageRecord);
}

test('avatar service config preserves only server-owned history and validates public terms', () => {
  const f = fixture(), previous = f.p.serviceBusiness!;
  assert.equal(previous.plans[0].validDays, 30);
  assert.equal(previous.plans[0].workspaceId, f.scope.workspaceId);
  assert.equal(validateBusinessConfig(f.db, f.scope, undefined, previous), previous);
  const saved = validateBusinessConfig(f.db, f.scope, { access: 'open', plans: [], intakeFields: [], codes: [{ tokenHash: 'ATTACK' }], leads: [{ fields: 'PRIVATE' }] }, previous)!;
  assert.equal(saved.codes, previous.codes);
  assert.equal(saved.leads.length, 0);
  for (const bad of [
    { access: 'open', plans: [{ name: 'Bad', kind: 'credits', quota: -1, priceCny: 1, validDays: 5 }], intakeFields: [] },
    { access: 'open', plans: [{ name: 'Bad', kind: 'credits', quota: 1, priceCny: 1.001, validDays: 5 }], intakeFields: [] },
    { access: 'open', plans: [{ name: 'Bad', kind: 'credits', quota: 1, priceCny: 1, validDays: 366 }], intakeFields: [] },
    { access: 'open', plans: [{ id: 'foreign-plan', name: 'Bad', kind: 'monthly', quota: 1, priceCny: 1 }], intakeFields: [] },
    { access: 'open', plans: [], intakeFields: [{ id: 'name', type: 'script', label: 'Bad' }] },
  ]) assert.throws(() => validateBusinessConfig(f.db, f.scope, bad, previous));
});

test('business configuration authorizes an exact owner workspace, not only the default workspace', () => {
  const f = fixture(), anotherWorkspace = 'owner-second-workspace';
  f.db.workspaces.push({ id: anotherWorkspace, name: 'Synthetic second space', slug: anotherWorkspace, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  f.db.workspaceMembers.push({ id: 'owner-second-member', workspaceId: anotherWorkspace, userId: f.scope.userId, role: 'owner', createdAt: new Date().toISOString() });
  assert.doesNotThrow(() => validateBusinessConfig(f.db, { workspaceId: anotherWorkspace, userId: f.scope.userId }, { access: 'open', plans: [], intakeFields: [] }));
  f.db.workspaceMembers.find(m => m.workspaceId === anotherWorkspace)!.role = 'member';
  assert.throws(() => validateBusinessConfig(f.db, { workspaceId: anotherWorkspace, userId: f.scope.userId }, { access: 'open', plans: [], intakeFields: [] }), /所有者/);
  assert.equal(validateBusinessConfig(f.db, { workspaceId: 'legacy-noop', userId: 'legacy-noop' }, undefined), undefined);
});

test('service codes are high entropy, hashed, confirmed, owner scoped and immutable plan snapshots', () => {
  const f = fixture(), raw = issue(f);
  assert.match(raw.code, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(f.p), new RegExp(raw.code));
  assert.doesNotMatch(JSON.stringify(serviceManagement(f.db, f.scope, f.p)), /tokenHash/);
  assert.throws(() => issue(f, { confirmed: false }));
  assert.throws(() => issueServiceCode(f.db, f.otherIdentity, f.p, { planId: f.p.serviceBusiness!.plans[0].id, source: 'gift', confirmed: true }));
  f.p.serviceBusiness!.plans[0].quotaMicros = 900_000;
  f.p.serviceBusiness!.plans[0].priceCny = 199;
  const receipt = redeemServiceCode(f.db, f.p, f.s, raw.code);
  assert.equal(receipt.quotaMicros, 1_000_000);
  assert.equal(f.p.serviceBusiness!.entitlements[0].plan.priceCny, 99);
  assert.equal(f.p.serviceBusiness!.entitlements[0].source, 'manual_fulfillment');
  assert.equal(f.db.rechargeOrders.length, 0, 'manual service fulfillment must not fabricate payment');
  assert.equal(f.db.powerLedger.length, 0, 'issuing service rights never creates ONE credits');
});

test('redemption requires canonical logged identity, is idempotent and cannot cross publications/accounts', () => {
  const f = fixture(), { code } = issue(f);
  const anonymous = createGuest(f.db, f.p.id).session;
  assert.throws(() => redeemServiceCode(f.db, f.p, anonymous, code), /登录/);
  const receipt = redeemServiceCode(f.db, f.p, f.s, code);
  assert.deepEqual(redeemServiceCode(f.db, f.p, f.s, code), receipt);
  assert.equal(f.p.serviceBusiness!.entitlements.length, 1);
  assert.throws(() => redeemServiceCode(f.db, f.p, f.otherSession, code), /已被使用/);
  const forged = { ...anonymous, accountUserId: f.identity.userId, accountWorkspaceId: f.identity.workspaceId };
  assert.throws(() => redeemServiceCode(f.db, f.p, forged, code), /登录/);
  const foreignPublication = publish(f.db, f.otherIdentity, f.input);
  foreignPublication.serviceBusiness = validateBusinessConfig(f.db, f.otherIdentity, { access: 'entitlement', plans: [], intakeFields: [] });
  const foreignSession = createGuest(f.db, foreignPublication.id, f.identity).session;
  assert.throws(() => redeemServiceCode(f.db, foreignPublication, foreignSession, code), /不可用/);
  assert.throws(() => redeemServiceCode(f.db, f.p, foreignSession, code), /会话/);
});

test('rights survive a new session but never another visitor; snapshots expose only own service rights', () => {
  const f = fixture(), { code } = issue(f);
  const entitlement = redeemServiceCode(f.db, f.p, f.s, code);
  const later = createGuest(f.db, f.p.id, f.identity).session;
  assert.equal((servicePublicSnapshot(f.db, f.p, later) as { entitlement: { id: string } }).entitlement.id, entitlement.id);
  assert.equal('entitlement' in servicePublicSnapshot(f.db, f.p, f.otherSession), true);
  assert.equal((servicePublicSnapshot(f.db, f.p, f.otherSession) as { entitlement?: unknown }).entitlement, undefined);
  const anonymous = servicePublicSnapshot(f.db, f.p);
  assert.equal('entitlement' in anonymous, false);
  assert.doesNotMatch(JSON.stringify(anonymous), /tokenHash|visitorUserId|workspaceId|entitlements|leads/);
});

test('every actual child call and held amount counts toward one independent service allowance', () => {
  const f = fixture();
  redeemServiceCode(f.db, f.p, f.s, issue(f).code);
  const r = run(f);
  assignPublicServiceEntitlement(f.db, f.p, f.s, r);
  f.db.publicRuns!.push(r);
  cost(f, r.id, 200_000);
  cost(f, r.id, 100_000, 400_000);
  cost(f, r.id, 9_000_000, 0, { workspaceId: f.otherIdentity.workspaceId });
  cost(f, r.id, 9_000_000, 0, { userId: f.otherIdentity.userId });
  cost(f, 'unrelated-run', 9_000_000);
  assert.doesNotThrow(() => checkPublicServiceBudget(f.db, f.p, r, 300_000));
  assert.throws(() => checkPublicServiceBudget(f.db, f.p, r, 300_001), /额度已不足/);
  const own = (servicePublicSnapshot(f.db, f.p, f.s) as { entitlement: { spentMicros: number; heldMicros: number; remainingMicros: number } }).entitlement;
  assert.deepEqual([own.spentMicros, own.heldMicros, own.remainingMicros], [300_000, 400_000, 300_000]);
  const second = run(f, 'second-run');
  assignPublicServiceEntitlement(f.db, f.p, f.s, second);
  f.db.publicRuns!.push(second);
  cost(f, second.id, 0, 300_000);
  assert.throws(() => checkPublicServiceBudget(f.db, f.p, r, 1), /额度已不足/);
});

test('a dusty old allowance never traps an account that has redeemed a fresh service grant', () => {
  const f = fixture();
  const oldGrant = redeemServiceCode(f.db, f.p, f.s, issue(f).code);
  const oldRun = run(f, 'old-dust-run');
  assignPublicServiceEntitlement(f.db, f.p, f.s, oldRun);
  f.db.publicRuns!.push(oldRun);
  cost(f, oldRun.id, 999_999);
  oldRun.status = 'completed';
  const freshGrant = redeemServiceCode(f.db, f.p, f.s, issue(f).code);
  assert.notEqual(freshGrant.id, oldGrant.id);
  const newRun = run(f, 'new-funded-run');
  assignPublicServiceEntitlement(f.db, f.p, f.s, newRun);
  f.db.publicRuns!.push(newRun);
  assert.equal(newRun.serviceEntitlement?.id, freshGrant.id);
  assert.doesNotThrow(() => checkPublicServiceBudget(f.db, f.p, newRun, 500_000));
  const snapshot = servicePublicSnapshot(f.db, f.p, f.s) as { entitlement: { id: string } };
  assert.equal(snapshot.entitlement.id, freshGrant.id);
});

test('expired or revoked service rights stop future calls; repeated redemption cannot revive them', () => {
  const f = fixture(), issued = issue(f);
  const receipt = redeemServiceCode(f.db, f.p, f.s, issued.code), r = run(f);
  assignPublicServiceEntitlement(f.db, f.p, f.s, r);
  f.db.publicRuns!.push(r);
  revokeServiceGrant(f.db, f.scope, f.p, receipt.id);
  assert.throws(() => checkPublicServiceBudget(f.db, f.p, r, 1), /撤销/);
  assert.equal(redeemServiceCode(f.db, f.p, f.s, issued.code).status, 'revoked');
  assert.throws(() => assignPublicServiceEntitlement(f.db, f.p, f.s, run(f, 'new')), /兑换/);
  const another = issue(f), row = f.p.serviceBusiness!.codes.find(c => c.id === another.grant.id)!;
  row.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.throws(() => redeemServiceCode(f.db, f.p, f.s, another.code), /过期/);
  const third = issue(f), thirdReceipt = redeemServiceCode(f.db, f.p, f.s, third.code);
  f.p.serviceBusiness!.entitlements.find(e => e.id === thirdReceipt.id)!.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.throws(() => assignPublicServiceEntitlement(f.db, f.p, f.s, run(f, 'expired')), /兑换/);
});

test('quota is not silently bypassed by anonymous sessions, API grants or legacy visitor billing', () => {
  const f = fixture(), r = run(f);
  assert.throws(() => assignPublicServiceEntitlement(f.db, f.p, f.s, r), /兑换/);
  redeemServiceCode(f.db, f.p, f.s, issue(f).code);
  f.s.apiGrantId = 'api-grant';
  assert.throws(() => assignPublicServiceEntitlement(f.db, f.p, f.s, r), /混用/);
  delete f.s.apiGrantId;
  f.p.visitorMultiplier = 0.6;
  assert.throws(() => assignPublicServiceEntitlement(f.db, f.p, f.s, r), /混用/);
  assert.throws(() => issue(f), /按次/);
  f.p.visitorMultiplier = 0;
  assignPublicServiceEntitlement(f.db, f.p, f.s, r);
  const forged = { ...r, sessionId: f.otherSession.id };
  assert.throws(() => checkPublicServiceBudget(f.db, f.p, forged, 1), /撤销/);
});

test('creator cannot issue promises exceeding remaining publisher budget', () => {
  const f = fixture();
  f.p.budgetMicros = 2_000_000;
  const first = issue(f), second = issue(f);
  assert.throws(() => issue(f), /总限额/);
  const entitlement = redeemServiceCode(f.db, f.p, f.s, first.code), r = run(f);
  assignPublicServiceEntitlement(f.db, f.p, f.s, r);
  f.db.publicRuns!.push(r);
  cost(f, r.id, 500_000);
  assert.throws(() => issue(f), /总限额/);
  revokeServiceGrant(f.db, f.scope, f.p, second.grant.id);
  assert.doesNotThrow(() => issue(f));
  assert.equal(f.p.serviceBusiness!.entitlements.find(e => e.id === entitlement.id)!.quotaMicros, 1_000_000);
});

test('service validity is not silently shortened to the publication expiry', () => {
  const f = fixture();
  f.p.expiresAt = new Date(Date.now() + 40 * 86_400_000).toISOString();
  const issued = issue(f);
  assert.ok(Date.parse(issued.grant.expiresAt) <= Date.parse(f.p.expiresAt) - 30 * 86_400_000);
  const receipt = redeemServiceCode(f.db, f.p, f.s, issued.code);
  assert.ok(Date.parse(receipt.expiresAt) >= Date.now() + 30 * 86_400_000 - 1000);
  f.p.expiresAt = new Date(Date.now() + 29 * 86_400_000).toISOString();
  assert.throws(() => issue(f), /有效期不足/);
});

test('settings cannot underfund or shorten active unredeemed and redeemed service promises', () => {
  const f = fixture(), issued = issue(f);
  const code = f.p.serviceBusiness!.codes[0];
  const completeTerm = new Date(Date.parse(code.expiresAt) + code.plan.validDays * 86_400_000).toISOString();
  assert.doesNotThrow(() => validateServiceCommitments(f.db, f.p, 1_000_000, completeTerm));
  assert.throws(() => validateServiceCommitments(f.db, f.p, 999_999, completeTerm), /总限额不足/);
  assert.throws(() => validateServiceCommitments(f.db, f.p, 1_000_000, new Date(Date.parse(completeTerm) - 1).toISOString()), /服务期限/);
  const entitlement = redeemServiceCode(f.db, f.p, f.s, issued.code);
  const r = run(f, 'commitments-spent-and-held'); assignPublicServiceEntitlement(f.db, f.p, f.s, r); f.db.publicRuns!.push(r);
  cost(f, r.id, 200_000, 100_000);
  assert.doesNotThrow(() => validateServiceCommitments(f.db, f.p, 1_000_000, entitlement.expiresAt));
  assert.throws(() => validateServiceCommitments(f.db, f.p, 999_999, entitlement.expiresAt), /总限额不足/);
  assert.throws(() => validateServiceCommitments(f.db, f.p, 1_000_000, new Date(Date.parse(entitlement.expiresAt) - 1).toISOString()), /服务期限/);
  revokeServiceGrant(f.db, f.scope, f.p, entitlement.id);
  assert.doesNotThrow(() => validateServiceCommitments(f.db, f.p, 300_000, new Date(Date.now() + 86_400_000).toISOString()));
  const legacy = { ...f.p, id: 'legacy-no-commitment', serviceBusiness: undefined };
  f.db.publications!.push(legacy);
  assert.doesNotThrow(() => validateServiceCommitments(f.db, legacy, 10_000, new Date(Date.now() + 86_400_000).toISOString()));
});

test('publish rejects reducing outstanding service commitments until they are explicitly revoked', () => {
  const f = fixture(), issued = issue(f), version = f.p.version;
  const change = { ...f.input, version, perRun: 0.1 };
  assert.throws(() => publish(f.db, f.scope, { ...change, budget: 0.5 }, f.p.id), /总限额不足/);
  assert.throws(() => publish(f.db, f.scope, { ...change, days: 7 }, f.p.id), /服务期限/);
  assert.equal(f.p.version, version);
  assert.equal(f.p.budgetMicros, 10_000_000);
  const entitlement = redeemServiceCode(f.db, f.p, f.s, issued.code);
  assert.throws(() => publish(f.db, f.scope, { ...change, days: 7 }, f.p.id), /服务期限/);
  revokeServiceGrant(f.db, f.scope, f.p, entitlement.id);
  const saved = publish(f.db, f.scope, { ...change, budget: 0.5, days: 7 }, f.p.id);
  assert.equal(saved.budgetMicros, 500_000);
  assert.equal(saved.version, (version ?? 1) + 1);
  assert.equal(saved.serviceBusiness!.entitlements[0].status, 'revoked');
});

test('opening free access cannot consume budget promised to existing service rights', () => {
  const f = fixture(), issued = issue(f);
  const makeOpen = () => validateBusinessConfig(f.db, f.scope, { access: 'open', plans: [], intakeFields: [] }, f.p.serviceBusiness);
  assert.throws(makeOpen, /先明确撤销/);
  const entitlement = redeemServiceCode(f.db, f.p, f.s, issued.code);
  assert.throws(makeOpen, /先明确撤销/);
  revokeServiceGrant(f.db, f.scope, f.p, entitlement.id);
  assert.equal(makeOpen()!.access, 'open');
  const remainingCode = issue(f);
  assert.throws(makeOpen, /先明确撤销/);
  revokeServiceGrant(f.db, f.scope, f.p, remainingCode.grant.id);
  assert.equal(makeOpen()!.access, 'open');
});

test('changing configuration cannot rewrite issued promises or copy another owner plan', () => {
  const f = fixture(), issued = issue(f), previous = f.p.serviceBusiness!;
  const newState = validateBusinessConfig(f.db, f.scope, { access: 'entitlement', plans: [], intakeFields: [] }, previous)!;
  f.p.serviceBusiness = newState;
  assert.equal(redeemServiceCode(f.db, f.p, f.s, issued.code).quotaMicros, 1_000_000);
  assert.throws(() => validateBusinessConfig(f.db, f.otherIdentity, { access: 'entitlement', plans: [{ ...previous.plans[0], quota: 1 }], intakeFields: [] }, previous), /不属于/);
});

test('consented intake contains exactly visitor editable fields, is idempotent, and never exposes chat', () => {
  const f = fixture();
  const r = run(f); r.content = 'PRIVATE_CHAT_DO_NOT_EXPORT'; f.db.publicRuns!.push(r);
  const payload = { operationId: 'lead-operation-00001', consent: true, fields: { name: '小林', budget: 3000, email: 'test@example.com' } };
  const lead = submitAvatarLead(f.db, f.p, f.s, payload);
  assert.deepEqual(submitAvatarLead(f.db, f.p, f.s, payload), lead);
  assert.equal(f.p.serviceBusiness!.leads.length, 1);
  const list = listAvatarLeads(f.db, f.scope, f.p);
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.items[0].fields.map(field => field.value), ['小林', 3000, 'test@example.com']);
  assert.doesNotMatch(JSON.stringify(list), /PRIVATE_CHAT|sessionId|visitorUserId|payloadHash|tokenHash/);
  assert.doesNotMatch(JSON.stringify(f.db.auditLogs.filter(l => l.action === 'publication.lead.consented')), /小林|3000|test@example/);
  assert.throws(() => listAvatarLeads(f.db, f.otherIdentity, f.p), /不存在/);
  assert.throws(() => submitAvatarLead(f.db, f.p, f.s, { ...payload, fields: { name: 'changed' } }), /提交已收到/);
});

test('intake rejects missing consent, inferred unknown fields, invalid values and cross-session identities', () => {
  const f = fixture(), base = { operationId: 'lead-operation-00001', consent: true, fields: { name: '小林' } };
  for (const input of [
    { ...base, consent: false },
    { ...base, fields: { name: '小林', aiSummary: 'PRIVATE_CHAT' } },
    { ...base, fields: { budget: 10 } },
    { ...base, fields: { name: '小林', budget: '10' } },
    { ...base, fields: { name: '小林', email: 'invalid' } },
    { ...base, fields: { name: '<'.repeat(1001) } },
  ]) assert.throws(() => submitAvatarLead(f.db, f.p, f.s, input));
  assert.throws(() => submitAvatarLead(f.db, f.p, { ...f.s, tokenHash: 'stolen' }, base), /会话/);
  assert.equal(f.p.serviceBusiness!.leads.length, 0);
});

test('anonymous intake remains explicit, bounded, and cannot retrieve another visitor submissions', () => {
  const f = fixture(), anonymous = createGuest(f.db, f.p.id).session;
  for (let i = 0; i < 5; i++) submitAvatarLead(f.db, f.p, anonymous, { operationId: `lead-operation-0000${i}`, consent: true, fields: { name: '来访者' } });
  assert.throws(() => submitAvatarLead(f.db, f.p, anonymous, { operationId: 'lead-operation-00009', consent: true, fields: { name: '来访者' } }), /较多/);
  assert.equal(f.p.serviceBusiness!.leads[0].visitorUserId, undefined);
  assert.doesNotMatch(JSON.stringify(servicePublicSnapshot(f.db, f.p, f.otherSession)), /来访者|leads/);
});

test('legacy public avatars remain open without introducing a new wallet or service requirement', () => {
  const f = fixture(); delete f.p.serviceBusiness;
  const anonymous = createGuest(f.db, f.p.id).session;
  const r = { ...run(f), userId: anonymous.userId, sessionId: anonymous.id };
  assert.doesNotThrow(() => assignPublicServiceEntitlement(f.db, f.p, anonymous, r));
  assert.doesNotThrow(() => checkPublicServiceBudget(f.db, f.p, r, 500_000));
  assert.equal(servicePublicSnapshot(f.db, f.p).access, 'open');
  assert.equal('serviceEntitlement' in r, false);
});

test('business HTTP management and consent routes preserve owner and visitor isolation', async t => {
  const f = fixture();
  const store = { read: async () => f.db, mutate: async <T>(fn: (db: Database) => T) => fn(f.db) } as Store;
  const app = express(); app.use(express.json()); const router = express.Router();
  const key: express.RequestHandler = (req, res, next) => {
    if (req.headers['x-key'] !== 'present') { res.sendStatus(428); return; }
    const identity = req.headers['x-owner'] === 'another' ? f.otherIdentity : f.scope;
    req.workspaceId = identity.workspaceId; req.user = f.db.users.find(u => u.id === identity.userId); next();
  };
  const authGuest = async (req: express.Request) => {
    const result = guest(f.db, String(req.params.slug), req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (result.session.accountUserId && req.headers['x-visitor'] !== result.session.accountUserId) throw new SharingError('请登录创建会话的账号', 401);
    return result;
  };
  installPublicAvatarBusinessRoutes(router, [key], store, authGuest);
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof SharingError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'error' }));
  app.use('/api/sharing', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sharing`;
  const ownerHeaders = { 'x-key': 'present', 'Content-Type': 'application/json' };
  const path = `/manage/${f.p.id}`;
  assert.equal((await fetch(base + path + '/service')).status, 428);
  assert.equal((await fetch(base + path + '/service', { headers: { ...ownerHeaders, 'x-owner': 'another' } })).status, 404);
  const issueResponse = await fetch(base + path + '/service/codes', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ planId: f.p.serviceBusiness!.plans[0].id, source: 'gift', confirmed: true }) });
  assert.equal(issueResponse.status, 200);
  const issued = await issueResponse.json() as { code: string; grant: { id: string } };
  assert.match(issued.code, /^[A-Za-z0-9_-]{43}$/);
  const publicMeta = await (await fetch(`${base}/${f.p.slug}/service`)).text();
  assert.doesNotMatch(publicMeta, /tokenHash|codes|entitlements|visitorName/);
  const session = createGuest(f.db, f.p.id, f.identity);
  const publicHeaders = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', 'x-visitor': f.identity.userId };
  assert.equal((await fetch(`${base}/${f.p.slug}/service/redeem`, { method: 'POST', headers: { ...publicHeaders, 'x-visitor': f.otherIdentity.userId }, body: JSON.stringify({ code: issued.code }) })).status, 401);
  assert.equal((await fetch(`${base}/${f.p.slug}/service/redeem`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ code: issued.code }) })).status, 200);
  const leadInput = { operationId: 'http-consent-lead-0001', consent: true, fields: { name: '仅同意的称呼' } };
  assert.equal((await fetch(`${base}/${f.p.slug}/leads`, { method: 'POST', headers: publicHeaders, body: JSON.stringify({ ...leadInput, consent: false }) })).status, 400);
  assert.equal((await fetch(`${base}/${f.p.slug}/leads`, { method: 'POST', headers: publicHeaders, body: JSON.stringify(leadInput) })).status, 200);
  const ownerLeads = await (await fetch(base + path + '/leads', { headers: ownerHeaders })).json() as { items: { fields: { value: string }[] }[] };
  assert.equal(ownerLeads.items[0].fields[0].value, '仅同意的称呼');
  assert.equal((await fetch(base + path + '/leads', { headers: { ...ownerHeaders, 'x-owner': 'another' } })).status, 404);
  assert.equal((await fetch(base + path + `/service/grants/${issued.grant.id}/revoke`, { method: 'POST', headers: ownerHeaders })).status, 200);
  const current = await (await fetch(`${base}/${f.p.slug}/service`, { headers: publicHeaders })).json() as { entitlement: { status: string } };
  assert.equal(current.entitlement.status, 'revoked');
});
