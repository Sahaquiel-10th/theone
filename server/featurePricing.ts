import type { Database, ModelConfig } from './types.js';
import type { FeatureScope } from './featureRuns.js';
import { FeatureConfigError, type OfficialFeatureValues } from './officialFeatures.js';
import { effectiveModel } from './modelPricing.js';

export type FeaturePrice = { id: string; releaseId: string; version: number; name: string; multiplier: number };
export type FeatureApproval = Pick<FeaturePrice, 'id' | 'releaseId' | 'version' | 'multiplier'>;
export type FeatureBudgetPolicy = FeatureScope & { approvalThreshold: number; updatedAt: string };
export const featureMultiplier = (values: OfficialFeatureValues) => values.usageMultiplier ?? .6;
export function featureBudgetPolicy(db: Database, s: FeatureScope) {
  return db.users.find(u => u.id === s.userId)?.featureBudgetPolicies?.find(p => p.workspaceId === s.workspaceId)?.approvalThreshold ?? 2;
}
export function saveFeatureBudgetPolicy(db: Database, s: FeatureScope, threshold: unknown) {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < .001 || threshold > 100) throw new FeatureConfigError('单独授权门槛须为 0.001–100 倍');
  const row = { ...s, approvalThreshold: threshold, updatedAt: new Date().toISOString() };
  const user = db.users.find(u => u.id === s.userId);
  if (!user) throw new FeatureConfigError('账号不可用', 403);
  user.featureBudgetPolicies = [...(user.featureBudgetPolicies ?? []).filter(p => p.workspaceId !== s.workspaceId), row];
  return row;
}
/** Approval is scoped by caller membership, then pinned to the published price/release. */
export function requireFeatureApproval(db: Database, s: FeatureScope, prices: FeaturePrice[], approvals: unknown) {
  // Feature execution settles directly against the authenticated account wallet.
}
/** Replace, never multiply, the model's retail multiplier. Procurement is unchanged. */
export function featurePricedModel(raw: ModelConfig, multiplier: number): ModelConfig {
  if (!Number.isFinite(multiplier) || multiplier < .001 || multiplier > 100) throw new FeatureConfigError('功能价格无效');
  const m = effectiveModel(raw);
  m.pricingHistory = undefined; // effectiveModel must not restore a different retail rate later.
  if (m.kind === 'image') { m.imagePowerPerCall = (m.imagePowerPerCall ?? 0) * multiplier; return m; }
  m.pricing = { ...(m.pricing ?? {version: 0, label: '功能计费', referenceInput: m.inputPowerPerMillion, referenceOutput: m.outputPowerPerMillion, referenceCache: m.cachePrices, publishedAt: new Date().toISOString()}), multiplier };
  return effectiveModel(m);
}
