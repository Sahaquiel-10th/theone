import type { AiTaskValues } from "./aiTaskConfig.js";
import type { Database, Message, ModelConfig } from "./types.js";
import { callModel } from "./modelGateway.js";
import { callChatImage } from "./responsesImageGateway.js";
import type {ProviderRetryOptions} from './providerRetry.js';

export type ImageTaskRoute = "images" | "responses";
export type ImageTaskFields = {
  imageRoute?: ImageTaskRoute;
  imageServiceModel?: string;
  imagePowerPerCall?: number;
  costImagePowerPerCall?: number;
};
export type ImageTaskConfiguration = {
  values: AiTaskValues;
  version: number;
  route: ImageTaskRoute;
  serviceModel: string;
  /** Server-only credential record. Never send this object through an API. */
  credentialModel: ModelConfig;
  /** Fixed-per-image billing snapshot, independent of the chat model's token prices. */
  billingModel: ModelConfig;
};
export class ImageTaskConfigurationError extends Error {
  constructor(message: string) { super(message); }
}

export function validateImageTaskFields(input: Record<string, unknown>): ImageTaskFields {
  if (input.imageRoute !== undefined && !["images", "responses"].includes(String(input.imageRoute)))
    throw new ImageTaskConfigurationError("请选择已接入的图片接口");
  if (input.imageServiceModel !== undefined && (typeof input.imageServiceModel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.imageServiceModel)))
    throw new ImageTaskConfigurationError("图片服务模型标识无效");
  for (const field of ["imagePowerPerCall", "costImagePowerPerCall"] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e6))
      throw new ImageTaskConfigurationError("每张图片的售价与成本须为有效的非负电力");
  }
  return {
    ...(input.imageRoute !== undefined ? { imageRoute: input.imageRoute as ImageTaskRoute } : {}),
    ...(input.imageServiceModel !== undefined ? { imageServiceModel: input.imageServiceModel as string } : {}),
    ...(input.imagePowerPerCall !== undefined ? { imagePowerPerCall: input.imagePowerPerCall as number } : {}),
    ...(input.costImagePowerPerCall !== undefined ? { costImagePowerPerCall: input.costImagePowerPerCall as number } : {}),
  };
}

/** Read-only resolution: the selected chat credential's ordinary prices never change. */
export function resolveImageTask(
  db: Database,
  storageAvailable: boolean,
  snapshot?: { values: AiTaskValues; version: number },
): ImageTaskConfiguration {
  const published = db.settings.aiTasks?.image_generation?.published;
  const source = snapshot?.values ?? published;
  if (!source?.modelId) throw new ImageTaskConfigurationError("请发布图片生成配置并选择图片接口所用模型");
  const fields = validateImageTaskFields(source as unknown as Record<string, unknown>);
  const credential = db.models.find((model) => model.id === source.modelId && model.enabled && !!model.apiKey);
  if (!credential || credential.protocol !== "openai" || !["chat", "image"].includes(credential.kind))
    throw new ImageTaskConfigurationError("图片接口所用模型不可用，请检查能力配置");
  const route = fields.imageRoute ?? "images";
  if (route === "responses" && credential.kind !== "chat")
    throw new ImageTaskConfigurationError("聊天工具作图需要选择已启用的 GPT 聊天模型");
  const serviceModel = fields.imageServiceModel ?? (credential.kind === "image" ? credential.model : "gpt-image-2");
  const price = fields.imagePowerPerCall ?? (credential.kind === "image" ? credential.imagePowerPerCall : undefined);
  const cost = fields.costImagePowerPerCall ?? (credential.kind === "image" ? credential.costImagePowerPerCall : undefined);
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    throw new ImageTaskConfigurationError("图片按张额度尚未配置，请先确认每张图片的售价与成本");
  if (!storageAvailable) throw new ImageTaskConfigurationError("图片结果存储尚未就绪");
  const values = structuredClone(source);
  const credentialModel = structuredClone(credential);
  const billingModel: ModelConfig = {
    ...structuredClone(credential), kind: "image", model: serviceModel,
    name: `${credential.name} · 图片生成`,
    systemPrompt: [credential.kind === "image" ? credential.systemPrompt : "", values.prompt].filter(Boolean).join("\n\n"),
    inputPowerPerMillion: 0, outputPowerPerMillion: 0, costInputPowerPerMillion: 0, costOutputPowerPerMillion: 0,
    pricing: undefined, pricingHistory: undefined, cachePrices: undefined, cacheCostPrices: undefined, longContextCostPrices: undefined,
    imagePowerPerCall: price, costImagePowerPerCall: cost,
  };
  return { values, version: snapshot?.version ?? published!.version, route, serviceModel, credentialModel, billingModel };
}

/** The caller reserves one picture, then privately persists returned pixels before completing the task. */
export async function callImageTask(
  config: ImageTaskConfiguration,
  selectedBillingModel: ModelConfig,
  messages: Message[],
  safetyRules = "",
  requestId = "unknown",
  imageCall?: typeof callModel,
  retry?: ProviderRetryOptions,
): Promise<Awaited<ReturnType<typeof callModel>>> {
  if (selectedBillingModel.id !== config.credentialModel.id || selectedBillingModel.kind !== "image")
    throw new ImageTaskConfigurationError("图片执行与计费配置不一致");
  if (imageCall) return imageCall(selectedBillingModel, messages, safetyRules, requestId);
  if (config.route === "images") return callModel({ ...selectedBillingModel, model: config.serviceModel }, messages, safetyRules, requestId);
  return callChatImage({ ...structuredClone(config.credentialModel), systemPrompt: [safetyRules, selectedBillingModel.systemPrompt].filter(Boolean).join("\n\n") }, messages, { imageModel: config.serviceModel, retry });
}
