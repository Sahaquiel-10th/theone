import type { Message as StoredMessage } from '../server/types';
import type { Message } from './preview/dispatchPreviewState';

/** Generated media stays behind the existing authenticated attachment route. */
export function privateImageUrl(value: unknown): string | undefined {
 return typeof value === 'string' && /^\/api\/attachments\/[A-Za-z0-9_-]+\/content$/.test(value) ? value : undefined;
}

export function coordinatorMessage(message: StoredMessage): Message {
 return {
  id: message.id!, role: message.role === 'user' ? 'user' : 'assistant', text: message.content,
  imageUrl: privateImageUrl(message.imageUrl),
  files: message.attachments?.map(file => ({id:file.id,originalName:file.originalName,...(file.welcomeGuide?{welcomeGuide:true}:{})})),
 };
}
