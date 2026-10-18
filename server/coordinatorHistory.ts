import type { Conversation } from './types.js';
import { CoordinatorError } from './executorProfiles.js';

/** Display pagination is independent of the model's bounded context. */
export function coordinatorHistoryPage(conversation: Conversation | undefined, before?: unknown) {
  if (before !== undefined && (typeof before !== 'string' || !before || before.length > 160)) throw new CoordinatorError('历史位置不正确，请重新打开工作台', 400);
  const messages = conversation?.messages ?? [];
  const end = before === undefined ? messages.length : messages.findIndex(message => message.id === before);
  if (end < 0) throw new CoordinatorError('这段历史的位置已变化，请刷新后再试', 409);
  const start = Math.max(0, end - 40), items = messages.slice(start, end);
  return { messages: items, history: { hasMore: start > 0, before: items[0]?.id, total: messages.length } };
}
