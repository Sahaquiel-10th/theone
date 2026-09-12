import { AdminModel, AuditLog, ModelConfig, ModelUsageRecord, PublicModel, PublicUser, User } from "./types.js";

export function publicUser(user: User): PublicUser {
  const { passwordHash, ...safe } = user;
  return safe;
}

export function publicModel(model: ModelConfig): PublicModel {
  const { id, name, kind, isDefault } = model;
  return { id, name, kind, isDefault };
}

export function adminModel(model: ModelConfig): AdminModel {
  const { apiKey, encryptedApiKey, ...safe } = model;
  return { ...safe, hasApiKey: Boolean(apiKey || encryptedApiKey) };
}

/** User billing exposes their charged amount, never our supplier procurement rates. */
export function publicUsageRecord(record: ModelUsageRecord) {
  const { id, workspaceId, userId, conversationId, modelId, inputTokens, outputTokens, totalTokens,
    source, chargedMicros, inputPowerPerMillionSnapshot, outputPowerPerMillionSnapshot, requestId, status, createdAt,
    reservedMicros, activity, durationMs, completedAt, billingCapped, imagePowerPerCallSnapshot } = record;
  return { id, workspaceId, userId, conversationId, modelId, inputTokens, outputTokens, totalTokens,
    source, chargedMicros, inputPowerPerMillionSnapshot, outputPowerPerMillionSnapshot, requestId, status, createdAt,
    reservedMicros, activity, durationMs, completedAt, billingCapped, imagePowerPerCallSnapshot };
}

/** Operational telemetry is deliberately content-free, including third-party error details. */
export function safeAdminAuditLog(log: AuditLog) {
  const { id, workspaceId, actorUserId, action, targetType, targetId, requestId, createdAt } = log;
  return { id, workspaceId, actorUserId, action, targetType, targetId, requestId, createdAt };
}
