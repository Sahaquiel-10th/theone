import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './types.js';
import type { TeachingGameConfig, TeachingOperation, TeachingScope } from './teachingTypes.js';
import { ownedTeachingCourse, teachingState, TeachingError } from './teaching.js';

function access(db: Database, scope: TeachingScope, courseId: string, activityId: string, sessionId: string) {
  const course = ownedTeachingCourse(db, scope, courseId), state = teachingState(db, scope);
  if (course.status !== 'published') throw new TeachingError('老师已关闭这个游戏入口', 410, 'TEACHING_CLOSED');
  const activity = course.activities.find(a => a.id === activityId && a.courseId === course.id && a.workspaceId === scope.workspaceId && a.userId === scope.userId && a.status === 'published');
  if (!activity || activity.kind !== 'game') throw new TeachingError('文字游戏不存在或尚未开放', 404, 'TEACHING_GAME_NOT_FOUND');
  const session = state.sessions.find(s => s.id === sessionId && s.courseId === courseId && s.workspaceId === scope.workspaceId && s.userId === scope.userId && s.expiresAt > new Date().toISOString() && s.createdAt >= course.updatedAt);
  if (!session) throw new TeachingError('参与身份已过期，请重新进入课程', 401, 'TEACHING_SESSION_REQUIRED');
  return { course, activity, session, state };
}
/** First read is deterministic and read-only; no game config is persisted until save. */
export function teachingGameSnapshot(db: Database, scope: TeachingScope, courseId: string, activityId: string, sessionId: string): TeachingGameConfig {
  const { session } = access(db, scope, courseId, activityId, sessionId);
  const existing = session.gameConfigs?.find(c => c.activityId === activityId && c.courseId === courseId && c.sessionId === sessionId && c.workspaceId === scope.workspaceId && c.userId === scope.userId);
  if (existing) return structuredClone(existing);
  const stableId = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.userId, courseId, activityId, sessionId])).digest('hex').slice(0, 32);
  return { ...scope, courseId, activityId, sessionId, revision: 0, roleName: '', prompt: '', conversationId: `tgame_${stableId}`, updatedAt: session.createdAt };
}
export function publicTeachingGameConfig(config: TeachingGameConfig) {
  return { activityId: config.activityId, revision: config.revision, roleName: config.roleName, prompt: config.prompt, conversationId: config.conversationId, updatedAt: config.updatedAt };
}
export function updateTeachingGameConfig(db: Database, scope: TeachingScope, courseId: string, activityId: string, sessionId: string, input: unknown) {
  const { activity, session, state } = access(db, scope, courseId, activityId, sessionId);
  if (activity.allowStudentPrompt !== true) throw new TeachingError('老师暂未开放修改个人游戏设定', 403, 'TEACHING_GAME_READ_ONLY');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TeachingError('请检查个人游戏设定');
  const body = input as Record<string, unknown>, previous = teachingGameSnapshot(db, scope, courseId, activityId, sessionId);
  if (body.revision !== previous.revision) throw new TeachingError('个人游戏设定已更新，请刷新后再保存', 409, 'TEACHING_GAME_REVISION_CONFLICT');
  if (typeof body.roleName !== 'string' || body.roleName.length > 80 || typeof body.prompt !== 'string' || body.prompt.length > 4000 || /\0/.test(body.roleName + body.prompt)) throw new TeachingError('角色名称最多 80 字，游戏提示词最多 4000 字');
  if (state.operations.some(o => o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.courseId === courseId && o.activityId === activityId && o.sessionId === sessionId && o.status === 'running')) throw new TeachingError('这一轮游戏还在回应，请先查看结果再修改设定', 409, 'TEACHING_GAME_BUSY');
  const roleName = body.roleName.trim(), prompt = body.prompt.trim();
  if (previous.revision > 0 && previous.roleName === roleName && previous.prompt === prompt) return previous;
  const configs = session.gameConfigs ?? [];
  if (!configs.some(c => c.activityId === activityId) && configs.length >= 30) throw new TeachingError('个人游戏配置数量已达上限', 409, 'TEACHING_CAPACITY');
  const config: TeachingGameConfig = { ...scope, courseId, activityId, sessionId, revision: previous.revision + 1, roleName, prompt, conversationId: `tgame_${randomBytes(16).toString('hex')}`, updatedAt: new Date().toISOString() };
  session.gameConfigs = [...configs.filter(c => c.activityId !== activityId), config]; return structuredClone(config);
}
export type TeachingGameHistoryItem = { id: string; operationId: string; question: string; answer: string; status: TeachingOperation['status']; choices?: string[]; error?: string; createdAt: string };
export function teachingGameHistory(db: Database, scope: TeachingScope, courseId: string, activityId: string, sessionId: string, conversationId?: string): TeachingGameHistoryItem[] {
  const snapshot = teachingGameSnapshot(db, scope, courseId, activityId, sessionId);
  if (conversationId !== undefined && conversationId !== snapshot.conversationId) throw new TeachingError('游戏已重新开始，请查看当前这一局', 409, 'TEACHING_GAME_REVISION_CONFLICT');
  return teachingState(db, scope).operations.filter(o => o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.courseId === courseId && o.activityId === activityId && o.sessionId === sessionId && o.conversationId === snapshot.conversationId && o.gameRevision === snapshot.revision && o.kind === 'answer').slice(-30).map(o => {
    const result = o.result && typeof o.result === 'object' ? o.result as Record<string, unknown> : undefined;
    const choices = o.status === 'completed' && result?.kind === 'answer' && Array.isArray(result.choices) ? result.choices.filter((v): v is string => typeof v === 'string' && v.length <= 500).slice(0, 4) : undefined;
    return { id: o.id, operationId: o.operationId, question: o.question ?? '', answer: o.status === 'completed' && result?.kind === 'answer' && typeof result.answer === 'string' ? result.answer : '', status: o.status, ...(choices ? { choices } : {}), ...(o.error ? { error: o.error } : {}), createdAt: o.createdAt };
  });
}
/** Bounded context for the model, never trust browser-supplied chat history. */
export function teachingGameModelHistory(db: Database, scope: TeachingScope, courseId: string, activityId: string, sessionId: string, conversationId?: string) {
  const complete = teachingGameHistory(db, scope, courseId, activityId, sessionId, conversationId).filter(o => o.status === 'completed' && o.answer).slice(-6);
  let size = 0; const selected: { question: string; answer: string }[] = [];
  for (const turn of complete.reverse()) {
    if (turn.question.length > 6000 || turn.answer.length > 12000 || size + turn.question.length + turn.answer.length > 24000) break;
    selected.unshift({ question: turn.question, answer: turn.answer }); size += turn.question.length + turn.answer.length;
  }
  return selected;
}
