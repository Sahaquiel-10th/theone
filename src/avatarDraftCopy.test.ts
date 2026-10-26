import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../server/types';
import { publish } from '../server/publicSharing';
import { copyAvatarDraft } from './avatarDraftCopy';
import type { PublicationDraft } from './sharingWorkspaceState';

function draft(): PublicationDraft {
  return {name: '林老师', description: '知识服务', prompt: '按资料回答', modelId: 'model', sourceIds: ['source'], attachments: false, budget: 1, perRun: .1, days: 7, confirmed: true, visitorPercent: 0, requireLogin: true, allowedUsernames: ['visitor'], service: {mode: 'knowledge', welcome: '你好', method: '先理解再建议', starterQuestions: ['从哪开始'], features: [{featureId: 'table', releaseId: 'released-v1', when: '需要测算', workflow: '核对参数再计算'}]}, serviceBusiness: {access: 'entitlement', plans: [{id: 'old-plan', name: '月服务', kind: 'monthly', quota: .5, priceCny: 99, validDays: 30, status: 'active'}], intakeFields: [{id: 'phone', label: '联系方式', type: 'phone', required: true}]}};
}

test('closed-avatar copy is a new private draft without old plan identities or publication/customer state', () => {
  const source = {...draft(), id: 'old-publication', slug: 'closed-public-link', status: 'closed', version: 7, history: ['private-old-snapshot'], serviceBusiness: {...draft().serviceBusiness!, codes: [{id: 'issued-code'}], entitlements: [{id: 'issued-grant'}], leads: [{id: 'private-customer-lead'}]}};
  const copy = copyAvatarDraft(source);
  assert.equal(copy.intent, 'draft'); assert.equal(copy.confirmed, false); assert.equal(copy.name, '林老师 · 副本');
  assert.equal(copy.serviceBusiness!.plans[0].id, undefined);
  for (const key of ['id', 'slug', 'status', 'version', 'history', 'codes', 'entitlements', 'leads']) assert.ok(!(key in copy));
  for (const key of ['codes', 'entitlements', 'leads']) assert.ok(!(key in copy.serviceBusiness!));
  assert.deepEqual(copy.service!.features, source.service!.features); assert.deepEqual(copy.sourceIds, source.sourceIds);
  assert.equal(source.serviceBusiness.plans[0].id, 'old-plan'); assert.equal(source.status, 'closed');
  assert.ok(copyAvatarDraft({...draft(), name: '长'.repeat(60)}).name.length <= 60);
});

test('editing every nested copied field cannot change the original author configuration', () => {
  const source = draft(), before = structuredClone(source), copy = copyAvatarDraft(source);
  copy.sourceIds.push('unavailable-kept-explicit'); copy.allowedUsernames.push('another');
  copy.service!.starterQuestions[0] = '新问题'; copy.service!.features[0].when = '新条件'; copy.service!.features[0].workflow = '新流程';
  copy.serviceBusiness!.plans[0].priceCny = 299; copy.serviceBusiness!.intakeFields[0].label = '新字段';
  assert.deepEqual(source, before);
  assert.notEqual(copy.service, source.service); assert.notEqual(copy.serviceBusiness, source.serviceBusiness);
});

test('copy normalizes server quotaMicros without retaining old service IDs', () => {
  const source = draft(); source.serviceBusiness!.plans = [{id: 'old-plan', name: '服务', kind: 'credits', quotaMicros: 500000, priceCny: 20, validDays: 7, status: 'active'}] as unknown as NonNullable<PublicationDraft['serviceBusiness']>['plans'];
  const copy = copyAvatarDraft(source); assert.equal(copy.serviceBusiness!.plans[0].quota, .5); assert.equal(copy.serviceBusiness!.plans[0].id, undefined);
});

test('a real new-publication validation accepts copied service plans while the original link remains closed', () => {
  const source = draft(); source.sourceIds = []; source.allowedUsernames = []; source.service!.features = [];
  const db = {users: [{id: 'owner', username: 'teacher', enabled: true}], workspaces: [{id: 'ws', status: 'active'}], workspaceMembers: [{workspaceId: 'ws', userId: 'owner', role: 'owner'}], models: [{id: 'model', enabled: true, kind: 'chat', apiKey: 'FIXTURE_ONLY', systemPrompt: ''}], settings: {safetyRules: '', rechargeCnyPerPower: 7}, publications: [], publicSessions: [], publicRuns: [], knowledgeConnections: [], auditLogs: [], modelUsageRecords: [], attachments: []} as unknown as Database;
  const scope = {workspaceId: 'ws', userId: 'owner'};
  const initial = {...source, intent: 'draft', serviceBusiness: {...source.serviceBusiness!, plans: source.serviceBusiness!.plans.map(({id, ...plan}) => plan)}};
  const old = publish(db, scope, initial); old.status = 'closed'; const oldPlanId = old.serviceBusiness!.plans[0].id;
  const copy = copyAvatarDraft({...source, serviceBusiness: {...source.serviceBusiness!, plans: [{...source.serviceBusiness!.plans[0], id: oldPlanId}]}});
  const saved = publish(db, scope, {...copy, confirmed: true});
  assert.equal(saved.status, 'draft'); assert.equal(old.status, 'closed'); assert.notEqual(saved.id, old.id); assert.notEqual(saved.slug, old.slug); assert.notEqual(saved.serviceBusiness!.plans[0].id, oldPlanId);
  assert.equal(saved.serviceBusiness!.codes.length, 0); assert.equal(saved.serviceBusiness!.entitlements.length, 0); assert.equal(saved.serviceBusiness!.leads.length, 0);
  assert.equal(db.publicRuns!.length, 0); assert.equal(db.modelUsageRecords.length, 0);
});
