import { avatarServicePayload, normalizedAvatarService } from './AvatarService';
import type { PublicationDraft } from './sharingWorkspaceState';

export type AvatarDebugReceipt = { operationId: string; response: string; finishReason?: string; warning?: string; limitations: string; chargedMicros: number; heldMicros: number };
export type AvatarDebugSubmission = { operationId: string; configKey: string; question: string; body: string };
export type AvatarDebugExchange = { submission: AvatarDebugSubmission; receipt: AvatarDebugReceipt };
export type AvatarDebugMessage = { role: 'user' | 'assistant'; content: string };
/** Private, in-memory only. The owning editor scopes this snapshot to one avatar. */
export type AvatarDebugSession = { question: string; consent: boolean; pending?: AvatarDebugSubmission; exchanges: AvatarDebugExchange[]; threadKey?: string };

export function createAvatarDebugSession(initial?: AvatarDebugSession): AvatarDebugSession {
    return { question: initial?.question ?? '', consent: initial?.consent === true,
        pending: initial?.pending ? { ...initial.pending } : undefined,
        exchanges: (initial?.exchanges ?? []).map(exchange => ({ submission: { ...exchange.submission }, receipt: { ...exchange.receipt } })),
        threadKey: initial?.threadKey ?? initial?.pending?.configKey ?? initial?.exchanges.at(-1)?.submission.configKey };
}

export function avatarDebugConfig(draft: PublicationDraft) {
    return { prompt: draft.prompt, modelId: draft.modelId, sourceIds: [...draft.sourceIds], service: avatarServicePayload(normalizedAvatarService(draft.service)) };
}
export const avatarDebugConfigKey = (draft: PublicationDraft): string => JSON.stringify(avatarDebugConfig(draft));

/** History belongs to one exact configuration, not the live form or other avatars. */
export function avatarDebugHistory(exchanges: readonly AvatarDebugExchange[], configKey: string): AvatarDebugMessage[] {
    const messages = exchanges.filter(exchange => exchange.submission.configKey === configKey).flatMap(exchange => [
        { role: 'user' as const, content: exchange.submission.question },
        { role: 'assistant' as const, content: exchange.receipt.response }
    ]).slice(-6);
    let remaining = 12000;
    const bounded: AvatarDebugMessage[] = [];
    for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
        const message = messages[index], content = message.content.slice(0, Math.min(4000, remaining));
        if (content.trim()) { bounded.unshift({ role: message.role, content }); remaining -= content.length; }
    }
    return bounded;
}

/** The serialized body is captured once; recovering a lost receipt reuses it byte-for-byte. */
export function createAvatarDebugSubmission(draft: PublicationDraft, question: string, exchanges: readonly AvatarDebugExchange[], operationId: string): AvatarDebugSubmission {
    const content = question.trim();
    if (!content || question.length > 2000) throw new Error('请输入 2000 字以内的测试问题。');
    if (!draft.modelId) throw new Error('先在左侧选择问答模型，再开始测试。');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) throw new Error('测试提交编号无效，请重新打开调试窗口。');
    const config = avatarDebugConfig(draft), configKey = JSON.stringify(config);
    return { operationId, configKey, question: content, body: JSON.stringify({ confirmed: true, operationId, content, config, history: avatarDebugHistory(exchanges, configKey) }) };
}

/** Unknown transport errors and pending receipts never permit an automatic new ID. */
export function avatarDebugFailure(error: unknown): 'pending' | 'uncertain' | 'finished' | 'session' {
    const detail = error && typeof error === 'object' ? error as { status?: number; code?: string } : {};
    if (detail.code === 'SESSION_CHANGED') return 'session';
    if (detail.code === 'CHAT_OPERATION_PENDING') return 'pending';
    if (detail.code === 'CHAT_OPERATION_FAILED' || detail.code === 'AVATAR_PREVIEW_FAILED' || detail.code === 'CHAT_OPERATION_INTERRUPTED') return 'finished';
    if ([400, 401, 403, 404, 422, 429].includes(detail.status ?? 0)) return 'finished';
    return 'uncertain';
}

export function createAvatarDebugGate() {
    let generation = 0;
    return { begin: () => ++generation, invalidate: () => { generation++; }, current: (ticket: number) => generation === ticket };
}

export async function retrieveAvatarDebugReceipt(submission: AvatarDebugSubmission, request: (body: string) => Promise<AvatarDebugReceipt>): Promise<AvatarDebugReceipt> {
    const receipt = await request(submission.body);
    if (receipt.operationId !== submission.operationId || typeof receipt.response !== 'string' || !Number.isFinite(receipt.chargedMicros) || receipt.chargedMicros < 0 || !Number.isFinite(receipt.heldMicros) || receipt.heldMicros < 0)
        throw new Error('返回的测试编号或用量不完整，先核对这一次结果，不会自动再跑。');
    return receipt;
}
