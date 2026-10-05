import { api, ApiError } from './oneApi';
import { chatSubmission, forgetChatSubmission } from './chatSubmission';

// Keep the selected conversation explicit: never inherit the workbench's target.
export async function sendThingMessage<T>(request: typeof api, userId: string, payload: { conversationId: string; modelId: string; content: string; agentId?: string }, pause = () => new Promise<void>(resolve => setTimeout(resolve, 2500))) {
  if (!payload.conversationId || !payload.modelId) throw new Error('这件事的模型暂不可用，请联系管理员');
  const operationId = await chatSubmission(userId, payload);
  let result = await request<{ conversation: T; pending?: boolean }>('/api/chat', { method: 'POST', body: JSON.stringify({ ...payload, operationId }) });
  while (result.pending) {
    await pause();
    try { result = await request<typeof result>(`/api/chat/operations/${encodeURIComponent(operationId)}`); }
    catch (error) { if (!(error instanceof ApiError) || error.code !== 'CHAT_OPERATION_PENDING') throw error; }
  }
  if (!result.conversation) throw new Error('尚未确认回复，请稍后重试；草稿已保留');
  forgetChatSubmission(userId, operationId);
  return result.conversation;
}
