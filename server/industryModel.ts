import type { Database, Message, ModelConfig } from './types.js';
import { callModel, callModelWithTools } from './modelGateway.js';
import { runBilledModel } from './modelBilling.js';
import { callImageTask, resolveImageTask } from './imageTaskConfiguration.js';
import { activeMember } from './enterprisePolicy.js';
import { assertIndustryBudget, industryDatabase, type IndustryDatabase, type IndustryStore, type IndustryTool } from './industryState.js';
import { effectiveModel } from './modelPricing.js';

export type IndustryModelResult = Awaited<ReturnType<typeof callModel>>;
export type IndustryModelScope = { workspaceId: string; userId: string };
export type IndustryModelInput = {
  operationId: string;
  stepId: string;
  usageSessionId: string;
  tool: IndustryTool;
  conversationId?: string;
  kind: 'chat' | 'vision' | 'image';
  messages: Message[];
  modelId?: string;
  maxOutputTokens?: number;
  /** Server-owned edit policy. This is never copied from arbitrary model JSON. */
  imageSize?: 'auto';
  verify: (db: IndustryDatabase) => void;
  beforeReserve?: (db: IndustryDatabase, amountMicros: number) => void;
};
export type IndustryModelRunner = (scope: IndustryModelScope, input: IndustryModelInput) => Promise<IndustryModelResult>;
export class IndustryModelError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) { super(message); }
}

export function industryRequestId(usageSessionId: string, operationId: string, stepId: string) {
  for (const id of [usageSessionId, operationId, stepId]) if (typeof id !== 'string' || !/^[\w.-]{1,160}$/.test(id)) throw new IndustryModelError('任务标识无效，请刷新后重试', 'INDUSTRY_OPERATION_INVALID', 400);
  return `industry_${usageSessionId}_${operationId}_${stepId}`;
}
/** Retail-only readiness for the authorization screen; never returns credentials or procurement prices. */
export function industryRetailPricing(db: Database, scope: IndustryModelScope, imageStorageAvailable: boolean) {
  let chat: { name: string; inputPowerPerMillion: number; outputPowerPerMillion: number } | undefined;
  let image: { powerPerImage: number } | undefined;
  try { const model = effectiveModel(industryChatModel(db, scope)); chat = { name: model.name, inputPowerPerMillion: model.inputPowerPerMillion, outputPowerPerMillion: model.outputPowerPerMillion }; } catch { /* unavailable */ }
  try { image = { powerPerImage: resolveImageTask(db, imageStorageAvailable).billingModel.imagePowerPerCall! }; } catch { /* unavailable */ }
  return { chatReady: !!chat, imageReady: !!image, chat, image };
}
export function industryChatModel(db: Database, scope: IndustryModelScope, modelId?: string) {
  const user = db.users.find(u => u.id === scope.userId && u.enabled);
  const available = db.models.filter(m => m.enabled && m.apiKey && m.kind === 'chat' && ['openai', 'anthropic'].includes(m.protocol));
  const model = modelId ? available.find(m => m.id === modelId) : available.find(m => m.id === user?.preferredModelId) ?? available.find(m => m.isDefault) ?? available[0];
  if (!model) throw new IndustryModelError('当前文字或图片理解模型不可用，请联系管理员', 'INDUSTRY_MODEL_UNAVAILABLE');
  return structuredClone(model);
}
function sameCredential(a: ModelConfig | undefined, b: ModelConfig) {
  return !!a && a.enabled && a.apiKey === b.apiKey && a.baseUrl === b.baseUrl && a.protocol === b.protocol && a.provider === b.provider && a.model === b.model;
}

/** All workbench calls use ONE's existing wallet and published model prices.
 * A usage row is a durable once-only receipt, including failed/uncertain calls.
 * Domain code owns result read-back and creates a new step only for an explicit retry. */
export function createIndustryModelRunner(store: IndustryStore, deps: {
  chatCall?: typeof callModelWithTools;
  imageCall?: typeof callModel;
  imageStorageAvailable?: boolean;
} = {}): IndustryModelRunner {
  return async (scope, input) => {
    const requestId = industryRequestId(input.usageSessionId, input.operationId, input.stepId);
    if (!input.messages.length || input.messages.length > 60 || input.messages.some(m => !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new IndustryModelError('任务输入无效', 'INDUSTRY_INPUT_INVALID', 400);
    const db = await store.read();
    input.verify(db);
    if (!activeMember(db, scope)) throw new IndustryModelError('当前空间不可用', 'INDUSTRY_ACCESS_DENIED', 403);
    const imageConfig = input.kind === 'image' ? resolveImageTask(db, deps.imageStorageAvailable === true) : undefined;
    const credential = imageConfig?.credentialModel ?? industryChatModel(db, scope, input.modelId);
    const model = imageConfig?.billingModel ?? credential;
    const messages = [{ role: 'system' as const, content: db.settings.safetyRules, createdAt: new Date().toISOString() }, ...structuredClone(input.messages)];
    const result = await runBilledModel(store.base, {
      ...scope, conversationId: input.conversationId, model,
      input: { messages, ...(imageConfig ? { taskVersion: imageConfig.version } : {}) },
      activity: input.kind === 'image' ? 'industry_image' : 'industry_text', requestId,
      maxOutputTokens: input.maxOutputTokens,
      beforeReserve: (fresh, amount) => {
        const projected = industryDatabase(fresh);
        input.verify(projected);
        if (!sameCredential(fresh.models.find(m => m.id === credential.id), credential)) throw new IndustryModelError('模型配置已变化，请重新查看任务', 'INDUSTRY_MODEL_CHANGED');
        if (imageConfig && fresh.settings.aiTasks?.image_generation?.published?.version !== imageConfig.version) throw new IndustryModelError('图片配置已变化，请重新查看任务', 'INDUSTRY_MODEL_CHANGED');
        if (fresh.modelUsageRecords.some(row => row.workspaceId === scope.workspaceId && row.userId === scope.userId && row.requestId === requestId)) throw new IndustryModelError('这一步已有调用回执，请查看原任务；不会重复发起付费调用', 'INDUSTRY_STEP_ALREADY_RESERVED');
        const session = assertIndustryBudget(fresh, scope, input.usageSessionId, amount, requestId);
        if (session.tool !== input.tool) throw new IndustryModelError('本轮用量授权不属于这个工具', 'INDUSTRY_BUDGET_MISMATCH');
        input.beforeReserve?.(projected, amount);
      },
    }, async selected => {
      try {
        if (imageConfig) return await callImageTask(imageConfig, selected, input.messages, db.settings.safetyRules, requestId, deps.imageCall, undefined, { imageSize: input.imageSize });
        const answer = await (deps.chatCall ?? callModelWithTools)(selected, messages.map(m => ({ role: m.role, content: m.content, inputImageDataUrls: m.inputImageDataUrls })), [], requestId, { maxOutputTokens: input.maxOutputTokens });
        if (answer.toolCalls.length) throw new Error('Unexpected tool response');
        return answer;
      } catch {
        throw new IndustryModelError('本次模型调用未完成，原任务和已有结果已保留，请查看调用回执后再决定是否重试', 'INDUSTRY_MODEL_CALL_FAILED', 502);
      }
    });
    input.verify(await store.read());
    // Never pass raw provider bodies, model credentials or diagnostics into domain DTOs.
    return { content: result.content, imageUrl: 'imageUrl' in result ? result.imageUrl : undefined, usage: result.usage, finishReason: result.finishReason };
  };
}
