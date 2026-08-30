import { AdminModel, ModelConfig, PublicModel, PublicUser, User } from "./types.js";

export function publicUser(user: User): PublicUser {
  const { passwordHash, ...safe } = user;
  return safe;
}

export function publicModel(model: ModelConfig): PublicModel {
  const { apiKey, encryptedApiKey, systemPrompt, costInputPowerPerMillion, costOutputPowerPerMillion, ...safe } = model;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey)
  };
}

export function adminModel(model: ModelConfig): AdminModel {
  return { ...publicModel(model), systemPrompt: model.systemPrompt, costInputPowerPerMillion: model.costInputPowerPerMillion, costOutputPowerPerMillion: model.costOutputPowerPerMillion };
}
