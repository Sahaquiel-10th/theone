import { AdminModel, AuditLog, ModelConfig, ModelUsageRecord, PublicModel, PublicUser, User } from "./types.js";
import { effectiveModel } from "./modelPricing.js";

export function publicUser(user: User): PublicUser {
  const { passwordHash, featureCredentials, visitorAuthVersion, ...safe } = user;
  return safe;
}

export function publicModel(model: ModelConfig): PublicModel {
  const { id, name, kind, isDefault } = model;
  return { id, name, kind, isDefault };
}

export function adminModel(model: ModelConfig): AdminModel {
  const { apiKey, encryptedApiKey, ...safe } = effectiveModel(model);
  return { ...safe, hasApiKey: Boolean(apiKey || encryptedApiKey) };
}

/** User billing exposes their charged amount, never our supplier procurement rates. */
export function publicUsageRecord(record: ModelUsageRecord) {
  const { id, workspaceId, userId, conversationId, modelId, inputTokens, outputTokens, totalTokens,
    source, inputPowerPerMillionSnapshot, outputPowerPerMillionSnapshot, requestId, status, createdAt,
    activity, durationMs, completedAt, billingCapped, imagePowerPerCallSnapshot, pricingSnapshot, modelNameSnapshot, cacheUsage, cachePricesSnapshot } = record;
  const c=record.commercial,samePayer=c?.snapshot.payerUserId===userId&&c?.snapshot.payerWorkspaceId===workspaceId;
  const chargedMicros=c?(c.publisherChargedMicros??0)+(samePayer?(c.payerChargedMicros??0):0):record.chargedMicros;
  const reservedMicros=c?c.publisherReservedMicros+(samePayer?c.payerReservedMicros:0):record.reservedMicros;
  return { id, workspaceId, userId, conversationId, modelId, inputTokens, outputTokens, totalTokens,
    source, chargedMicros, inputPowerPerMillionSnapshot, outputPowerPerMillionSnapshot, requestId, status, createdAt,
    reservedMicros, activity, durationMs, completedAt, billingCapped, imagePowerPerCallSnapshot, pricingSnapshot, modelNameSnapshot, cacheUsage, cachePricesSnapshot, contextPriceTier: record.contextPriceTier, promptTokens: record.promptTokens };
}

/** Operational telemetry is deliberately content-free, including third-party error details. */
export function safeAdminAuditLog(log: AuditLog) {
  const { id, workspaceId, actorUserId, action, targetType, targetId, requestId, createdAt } = log;
  return { id, workspaceId, actorUserId, action, targetType, targetId, requestId, createdAt };
}
