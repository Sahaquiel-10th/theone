import type { Message as StoredMessage } from '../server/types';
import type { Message } from './preview/dispatchPreviewState';

/** Generated media stays behind the existing authenticated attachment route. */
export function privateImageUrl(value: unknown): string | undefined {
 return typeof value === 'string' && /^\/api\/attachments\/[A-Za-z0-9_-]+\/content$/.test(value) ? value : undefined;
}

export function coordinatorMessage(message: StoredMessage): Message {
 return {
  id: message.id!, role: message.role === 'user' ? 'user' : 'assistant', text: message.content,
  ...(message.role==='assistant'&&message.id?.startsWith('report_')?{kind:'result' as const}:{}),
  requestId: message.requestId, finishReason: message.finishReason,
  imageUrl: privateImageUrl(message.imageUrl),
  files: message.attachments?.map(file => ({
   id: file.id, originalName: file.originalName, mimeType: file.mimeType, kind: file.kind, size: file.size,
   ...(file.status ? {status: file.status} : {}),
   ...(file.uploadedBytes !== undefined ? {uploadedBytes: file.uploadedBytes} : {}),
   ...(file.parseError ? {parseError: file.parseError} : {}),
   ...(file.officeArtifact ? {officeArtifact: file.officeArtifact} : {}),
   ...(file.welcomeGuide ? {welcomeGuide: true} : {}),
   ...(file.visualDocument ? {visualDocument: true} : {}),
  })),
  sources: message.sources?.map(source => ({title: source.title, url: source.url, snippet: source.snippet})),
  // Adapter diagnostics contain provider and connection details. Only the
  // user-facing outcome belongs in the conversation's presentation model.
  knowledgeDiagnostics: message.knowledgeDiagnostics ? {
   status: message.knowledgeDiagnostics.status,
   failures: message.knowledgeDiagnostics.failures.map(failure => ({message: failure.message})),
  } : undefined,
  attachmentWarning: message.attachmentWarning,
 };
}
