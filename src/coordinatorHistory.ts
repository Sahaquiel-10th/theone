import type { Conversation } from '../server/types';
type Link = { messageId: string; taskId: string };
export function mergeCoordinatorMessages(previous: Conversation['messages'], incoming: Conversation['messages']) {
  const result = new Map(previous.filter(message => message.id).map(message => [message.id!, message]));
  for (const message of incoming) if (message.id) result.set(message.id, message);
  return [...result.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function mergeCoordinatorLinks(previous: Link[], incoming: Link[]) {
  return [...new Map([...previous, ...incoming].map(link => [`${link.messageId}:${link.taskId}`, link])).values()];
}
