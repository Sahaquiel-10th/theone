import type { TeachingPublicActivity } from '../server/teachingTypes';
import type { TeachingUpload } from './teachingUploads';

export type StudentSubmissionAttempt = { operationId: string; payload: string; files?: TeachingUpload[] };
type PrivateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function studentReceiptStorage(): PrivateStorage | undefined { try { return globalThis.sessionStorage; } catch { return; } }
const key = (slug: string, sessionId: string) => `one:teaching:submission:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId)}`;
/** No bearer token is stored in the receipt; it belongs to one course/session. */
export function readStudentSubmissionAttempt(storage: PrivateStorage | undefined, slug: string, sessionId: string): StudentSubmissionAttempt | undefined {
  try {
    if (!storage) return;
    const text = storage.getItem(key(slug, sessionId));
    if (!text || text.length > 200_000) return;
    const value = JSON.parse(text) as StudentSubmissionAttempt;
    if (typeof value.operationId !== 'string' || !/^[\w-]{8,120}$/.test(value.operationId) || typeof value.payload !== 'string') return;
    const payload = JSON.parse(value.payload);
    if (!payload || typeof payload.activityId !== 'string' || typeof payload.text !== 'string' || !payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers) || !Object.values(payload.answers).every(answer => typeof answer === 'string') || !Array.isArray(payload.attachmentIds) || payload.attachmentIds.length > 10 || !payload.attachmentIds.every((id: unknown) => typeof id === 'string')) return;
    const files = Array.isArray(value.files) ? value.files.filter(file => file && typeof file.id === 'string' && payload.attachmentIds.includes(file.id) && typeof file.originalName === 'string').map(file => ({ id: file.id, originalName: file.originalName })) : [];
    return { operationId: value.operationId, payload: value.payload, files };
  } catch { return; }
}
export function saveStudentSubmissionAttempt(storage: PrivateStorage | undefined, slug: string, sessionId: string, attempt?: StudentSubmissionAttempt) {
  try { if (!storage) return; if (attempt) storage.setItem(key(slug, sessionId), JSON.stringify(attempt)); else storage.removeItem(key(slug, sessionId)); } catch { /* The in-memory receipt remains; the page warns before leaving. */ }
}
export function studentActivityFromSearch(activities: TeachingPublicActivity[], search: string) {
  const params = new URLSearchParams(search), id = params.get('activityId') ?? params.get('activity');
  return activities.find(activity => activity.id === id) ?? activities[0];
}
export function requireStudentSubmissionReceipt(value: unknown, operationId: string, courseId: string, activityId: string) {
  const submission = value && typeof value === 'object' && 'submission' in value ? value.submission : undefined;
  if (!submission || typeof submission !== 'object' || !('id' in submission) || typeof submission.id !== 'string' || !('operationId' in submission) || submission.operationId !== operationId || !('courseId' in submission) || submission.courseId !== courseId || !('activityId' in submission) || submission.activityId !== activityId) throw new Error('提交回执尚未确认，原编号和附件已保留，请先查询我的提交。');
}
