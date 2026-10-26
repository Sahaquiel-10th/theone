import type express from 'express';
import type { RequestHandler } from 'express';
import type { Store } from './db.js';
import type { Database } from './types.js';
import type { KnowledgeService } from './knowledge/knowledgeService.js';
import { asyncRoute } from './middleware.js';
import { beginChatOperation, ChatOperationError, failChatOperation, type ChatOperation } from './chatOperations.js';
import { callModelWithTools, type ModelToolMessage } from './modelGateway.js';
import { runBilledModel } from './modelBilling.js';
import { ownerActive, publicationModel, publicationSources, SharingError, sourceBinding } from './publicSharing.js';
import { validatePublicAvatarService } from './publicAvatarConfig.js';
import { publicAvatarSystemContent } from './publicAvatarPrompt.js';
import { uid } from './security.js';

export const avatarPreviewLimitations = '仅测试回答与选中知识检索；不执行功能，不接收附件，不提交联系信息，不向访客收费或兑换资格，不创建文件或公开分享。测试使用的模型电力由你承担。';
const maxOutputTokens = 1200;
type Scope = { workspaceId: string; userId: string };
type PreviewInput = { content: string; config: Record<string, unknown>; history: ModelToolMessage[] };
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validateInput(raw: unknown): PreviewInput & {operationId: string} {
  if (!plain(raw) || raw.confirmed !== true) throw new SharingError('请确认测试回答会使用你自己的电力', 400, 'AVATAR_PREVIEW_CONSENT_REQUIRED');
  if (typeof raw.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(raw.operationId)) throw new SharingError('测试提交标识无效', 400);
  if (typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 2000 || !plain(raw.config)) throw new SharingError('请输入 2000 字以内的测试问题并选择模型');
  const history = raw.history ?? [];
  if (!Array.isArray(history) || history.length > 6 || history.some(m => !plain(m) || !['user', 'assistant'].includes(String(m.role)) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 4000) || history.reduce((sum, m) => sum + String(m.content).length, 0) > 12000) throw new SharingError('测试历史最多 6 条、合计 12000 字，只接受访客问题和分身回答');
  return {operationId: raw.operationId, content: raw.content.trim(), config: raw.config, history: history.map(m => ({role: m.role as 'user' | 'assistant', content: m.content as string}))};
}

function validatedConfiguration(db: Database, scope: Scope, raw: Record<string, unknown>) {
  ownerActive(db, scope);
  if (typeof raw.prompt !== 'string' || raw.prompt.length > 12000) throw new SharingError('回答要求不能超过 12000 字');
  const resolved = publicationModel(db, raw.modelId);
  const model = structuredClone(resolved.model);
  model.systemPrompt = [model.systemPrompt, raw.prompt.trim()].filter(Boolean).join('\n\n');
  const sources = publicationSources(db, scope, raw.sourceIds ?? []);
  // A short answer test cannot exercise delivery tools. Do not let an
  // unfinished/stale tool grant block unrelated Q&A; the immutable request
  // fingerprint still includes the original config, and publish validates
  // its full feature grants separately.
  const service = validatePublicAvatarService(db, scope, plain(raw.service) ? {...raw.service, features: []} : raw.service);
  return {model, sources, service, taskVersion: resolved.version};
}

/** No publication, guest session, artifact writer, lead collector, commerce,
 * or executable tool reaches this path. Durable ChatOperation tombstones
 * prevent a lost HTTP receipt (or restart) from paying for the same test twice. */
export function installPublicAvatarPreviewRoute(router: express.Router, keyAuth: readonly RequestHandler[], store: Store, knowledge: Pick<KnowledgeService, 'recallWithDiagnostics'>, modelCall: typeof callModelWithTools = callModelWithTools) {
  router.post('/manage/preview', ...keyAuth, asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const input = validateInput(req.body);
    const scope = {workspaceId: req.workspaceId!, userId: req.user!.id};
    ownerActive(await store.read(), scope);
    const requestId = `avatar-preview:${uid('req')}`;
    let operation: ChatOperation;
    let prepared: ReturnType<typeof validatedConfiguration> | undefined;
    try {
      const claimed = await beginChatOperation(store, {...scope, operationId: input.operationId, requestId,
        payload: {kind: 'avatar-preview', content: input.content, config: input.config, history: input.history},
        beforeClaim: db => {
          prepared = validatedConfiguration(db, scope, input.config);
          const recent = (db.chatOperations ?? []).filter(o => o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.requestId.startsWith('avatar-preview:'));
          if (recent.some(o => o.status === 'pending') || recent.filter(o => Date.now() - Date.parse(o.createdAt) < 60000).length >= 10) throw new SharingError('已有测试正在回答，或测试较频繁，请稍后再试', 429);
        }});
      if (claimed.kind === 'completed') {
        if (!claimed.operation.requestId.startsWith('avatar-preview:') || !claimed.operation.avatarPreviewResult) throw new SharingError('这次测试的原结果尚不可用，不会重新调用或扣费', 409, 'AVATAR_PREVIEW_RESULT_UNAVAILABLE');
        res.json(structuredClone(claimed.operation.avatarPreviewResult));
        return;
      }
      operation = claimed.operation;
    } catch (error) {
      if (error instanceof ChatOperationError) throw new SharingError(error.message, error.status, error.code);
      throw error;
    }
    const initial = prepared;
    if (!initial) throw new SharingError('测试配置尚未就绪', 409);
    const verify = async () => {
      const db = await store.read();
      ownerActive(db, scope);
      const currentModel = db.models.find(m => m.id === initial.model.id && m.enabled && m.kind === 'chat' && m.apiKey);
      if (!currentModel) throw new SharingError('测试模型已停用，请重新选择', 409);
      for (const source of initial.sources) {
        const current = db.knowledgeConnections.find(c => c.id === source.id && c.workspaceId === scope.workspaceId && c.provider === source.provider && c.status === 'connected');
        if (!current || sourceBinding(current) !== source.binding) throw new SharingError('知识授权已经变化，请核对所选来源后重新测试', 409);
      }
    };
    try {
      await verify();
      const recall = initial.sources.length ? await knowledge.recallWithDiagnostics(scope.workspaceId, input.content, 4, initial.sources.map(s => s.id), scope.userId, {retry: false}) : {chunks: [], failures: [], status: 'not_connected'};
      await verify();
      const references = recall.chunks.map((chunk, index) => `${index + 1}. ${chunk.title}\n${chunk.content}`).join('\n\n').slice(0, 12000);
      const knowledgeWarning = !initial.sources.length ? '' : recall.failures.length
        ? recall.chunks.length ? '部分选中的知识来源暂不可用，本次回答可能不完整。' : '所选知识来源本次未能返回可用资料，回答仅依据方法资料与当前试聊。'
        : !recall.chunks.length ? '本次未检索到相关的所选知识资料，回答仅依据方法资料与当前试聊。' : '';
      const db = await store.read();
      const messages: ModelToolMessage[] = [{role: 'system', content: [db.settings.safetyRules, initial.model.systemPrompt, publicAvatarSystemContent({service: initial.service, references, privatePreview: true})].filter(Boolean).join('\n\n')}, ...input.history, {role: 'user', content: input.content}];
      const result = await runBilledModel(store, {...scope, conversationId: operation.id, model: initial.model, maxOutputTokens, input: {messages, taskVersion: initial.taskVersion}, activity: '分身私有测试', requestId,
        beforeReserve: current => {
          ownerActive(current, scope);
          for (const source of initial.sources) {
            const connection = current.knowledgeConnections.find(c => c.id === source.id && c.workspaceId === scope.workspaceId && c.status === 'connected');
            if (!connection || sourceBinding(connection) !== source.binding) throw new SharingError('知识授权已经变化，本次没有开始新的模型调用', 409);
          }
        }}, snapshot => modelCall(snapshot, messages, [], requestId, {maxOutputTokens, timeoutMs: 60000}));
      await verify();
      if (result.toolCalls.length) throw new SharingError('本次只测试回答，不执行工具；模型要求使用的功能没有运行。', 409);
      if (!result.content.trim() || result.finishReason === 'filtered') throw new SharingError('模型没有返回可用的测试回答，已有用量会保留，不会自动重试。', 409);
      const receipt = await store.mutate(current => {
        const own = current.chatOperations?.find(o => o.id === operation.id && o.workspaceId === scope.workspaceId && o.userId === scope.userId);
        if (!own || own.status !== 'pending') throw new SharingError('这次测试的处理状态需要核对，不会自动重复执行', 409);
        const usage = current.modelUsageRecords.filter(u => u.workspaceId === scope.workspaceId && u.userId === scope.userId && u.requestId === requestId && u.conversationId === operation.id);
        const resultReceipt: NonNullable<ChatOperation['avatarPreviewResult']> = {operationId: input.operationId, response: result.content.slice(0, 12000), finishReason: result.finishReason,
          warning: [knowledgeWarning, result.finishReason === 'length' ? '测试回答到达长度上限，未自动续写。' : '', usage.some(u => u.status === 'needs_review') ? '模型用量尚待核对，相关电力暂时预留，不会自动重复调用。' : ''].filter(Boolean).join(' ') || undefined,
          limitations: avatarPreviewLimitations, chargedMicros: usage.reduce((sum, u) => sum + (u.chargedMicros ?? 0), 0), heldMicros: usage.reduce((sum, u) => sum + (u.reservedMicros ?? 0), 0)};
        own.avatarPreviewResult = resultReceipt;
        own.status = 'completed'; own.updatedAt = new Date().toISOString();
        return structuredClone(resultReceipt);
      });
      res.json(receipt);
    } catch (error) {
      await failChatOperation(store, {...scope, operationId: input.operationId}).catch(() => undefined);
      if (error instanceof SharingError) throw error;
      throw new SharingError('这次测试回答没有完成，不会自动重试。若已有模型用量会保留；请核对用量后再发起新的测试。', 400, 'AVATAR_PREVIEW_FAILED');
    }
  }));
}
