import { normalizedAvatarBusiness, normalizedAvatarService } from './AvatarService';
import type { PublicationDraft } from './sharingWorkspaceState';

/** Copy author-authored configuration, never a publication identity or issued
 * customer rights. Existing release/source references stay explicit: the
 * server will revalidate them, and unavailable references need user removal. */
export function copyAvatarDraft(config: PublicationDraft): PublicationDraft & {intent: 'draft'} {
  const service = normalizedAvatarService(config.service);
  const business = normalizedAvatarBusiness(config.serviceBusiness);
  return {
    intent: 'draft', name: `${config.name.slice(0, 55)} · 副本`, description: config.description,
    prompt: config.prompt, modelId: config.modelId, sourceIds: [...config.sourceIds],
    attachments: config.attachments, budget: config.budget, perRun: config.perRun, days: config.days,
    confirmed: false, visitorPercent: config.visitorPercent ?? 0, requireLogin: config.requireLogin ?? false,
    allowedUsernames: [...(config.allowedUsernames ?? [])],
    service: {mode: service.mode, welcome: service.welcome, method: service.method,
      starterQuestions: [...service.starterQuestions], features: service.features.map(feature => ({featureId: feature.featureId, releaseId: feature.releaseId, when: feature.when, workflow: feature.workflow}))},
    serviceBusiness: {access: business.access,
      plans: business.plans.map(plan => ({name: plan.name, kind: plan.kind, quota: plan.quota, priceCny: plan.priceCny, validDays: plan.validDays, status: plan.status})),
      intakeFields: business.intakeFields.map(field => ({id: field.id, label: field.label, type: field.type, required: field.required}))}
  };
}
