import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from './types.js';
import type { TeachingActivity, TeachingCourse, TeachingCriterion, TeachingGrade, TeachingQuestion, TeachingScene, TeachingScope, TeachingSession, TeachingState, TeachingSubmission, TeachingTaskKind } from './teachingTypes.js';
import { bindTeachingKnowledgeSources } from './teachingKnowledge.js';

export class TeachingError extends Error {
  constructor(message: string, public status = 400, public code = 'TEACHING_INVALID') { super(message); }
}
export const TEACHING_LIMITS = { courses: 30, activities: 30, sessions: 2000, submissions: 5000 } as const;
const emptyState = (): TeachingState => ({ courses: [], sessions: [], submissions: [], operations: [] });
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeachingError('请检查提交内容');
  return value as Record<string, unknown>;
};
function text(value: unknown, name: string, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /\0/.test(value)) throw new TeachingError(`${name}格式不正确或超过长度限制`);
  return value.trim();
}
function requiredText(value: unknown, name: string, max: number) {
  const result = text(value, name, max); if (!result) throw new TeachingError(`请填写${name}`); return result;
}
function integer(value: unknown, name: string, max: number, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new TeachingError(`${name}超出允许范围`);
  return value as number;
}
function boolean(value: unknown, name: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TeachingError(`${name}格式不正确`);
  return value;
}
function strings(value: unknown, name: string, count: number, length: number, fallback: string[] = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > count) throw new TeachingError(`${name}数量超出限制`);
  const result = value.map(v => requiredText(v, name, length));
  if (new Set(result).size !== result.length) throw new TeachingError(`${name}不能重复`);
  return result;
}
function unique<T extends { id: string }>(items: T[], name: string) {
  if (new Set(items.map(x => x.id)).size !== items.length) throw new TeachingError(`${name}编号不能重复`);
  return items;
}
function boundedRows(value: unknown, name: string, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max) throw new TeachingError(`${name}数量超出限制`);
  return value.map(object);
}
function questions(value: unknown, fallback: TeachingQuestion[] = []): TeachingQuestion[] {
  if (value === undefined) return fallback;
  return unique(boundedRows(value, '题目', 40).map(q => {
    if (q.type !== 'single' && q.type !== 'text') throw new TeachingError('请选择题目类型');
    const options = strings(q.options, '选项', 8, 1000);
    const answer = text(q.answer, '参考答案', 4000, '');
    if (q.type === 'single' && (options.length < 2 || (answer && !options.includes(answer)))) throw new TeachingError('选择题需有至少两个选项，答案须为其中一个选项');
    return { id: q.id === undefined ? id('tq') : requiredText(q.id, '题目编号', 100), type: q.type, prompt: requiredText(q.prompt, '题目', 4000), options, answer, points: integer(q.points, '题目分值', 10000, 10) };
  }), '题目');
}
function scenes(value: unknown, fallback: TeachingScene[] = []): TeachingScene[] {
  if (value === undefined) return fallback;
  return unique(boundedRows(value, '场景', 10).map(s => ({ id: s.id === undefined ? id('tsc') : requiredText(s.id, '场景编号', 100), title: requiredText(s.title, '场景标题', 160), content: requiredText(s.content, '场景内容', 8000), choices: strings(s.choices, '决策选项', 6, 1000), reflection: text(s.reflection, '教学反思', 4000, '') })), '场景');
}
function rubric(value: unknown, fallback: TeachingCriterion[] = []): TeachingCriterion[] {
  if (value === undefined) return fallback;
  return unique(boundedRows(value, '评分标准', 20).map(r => ({ id: r.id === undefined ? id('tr') : requiredText(r.id, '标准编号', 100), label: requiredText(r.label, '标准名称', 160), description: text(r.description, '标准说明', 4000, ''), maxScore: integer(r.maxScore, '标准分值', 10000, 10) })), '评分标准');
}

export function teachingMember(db: Database, scope: TeachingScope) {
  const user = db.users.find(u => u.id === scope.userId && u.enabled);
  const member = db.workspaceMembers.find(m => m.workspaceId === scope.workspaceId && m.userId === scope.userId && m.status !== 'disabled');
  if (!user || !member || !db.workspaces.some(w => w.id === scope.workspaceId && w.status === 'active')) throw new TeachingError('账号或课程空间不可用', 403, 'TEACHING_FORBIDDEN');
  // Teaching can publish materials and spend the workspace payer's budget. Until
  // an explicit teaching grant exists, membership alone must not grant this power.
  // Platform administrators have no exception to the exact workspace binding.
  if (member.role !== 'owner') throw new TeachingError('请由当前空间负责人管理课程', 403, 'TEACHING_OWNER_REQUIRED');
  return user;
}
/** Call with create:true inside Store.mutate; a read never silently persists state. */
export function teachingState(db: Database, scope: TeachingScope, options: { create?: boolean } = {}): TeachingState {
  const user = teachingMember(db, scope);
  if (!user.teaching && options.create) user.teaching = emptyState();
  return user.teaching ?? emptyState();
}
export function ownedTeachingCourse(db: Database, scope: TeachingScope, courseId: string) {
  const state = teachingState(db, scope);
  const course = state.courses.find(c => c.id === courseId && c.workspaceId === scope.workspaceId && c.userId === scope.userId);
  if (!course) throw new TeachingError('课程不存在', 404, 'TEACHING_NOT_FOUND');
  return course;
}
export function listTeachingCourses(db: Database, scope: TeachingScope) {
  return teachingState(db, scope).courses.filter(c => c.workspaceId === scope.workspaceId && c.userId === scope.userId);
}
export function activeTeachingCourse(db: Database, slug: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(slug)) throw new TeachingError('课程入口不存在', 404, 'TEACHING_NOT_FOUND');
  for (const user of db.users) {
    const course = user.teaching?.courses.find(c => c.slug === slug && c.userId === user.id);
    if (!course) continue;
    const scope = { workspaceId: course.workspaceId, userId: course.userId };
    teachingMember(db, scope);
    if (course.status !== 'published') throw new TeachingError('老师已关闭这个课程入口', 410, 'TEACHING_CLOSED');
    return course;
  }
  throw new TeachingError('课程入口不存在或已更新', 404, 'TEACHING_NOT_FOUND');
}
export function authTeachingSession(db: Database, slug: string, token: string) {
  const course = activeTeachingCourse(db, slug);
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new TeachingError('请先填写参与信息', 401, 'TEACHING_SESSION_REQUIRED');
  const scope = { workspaceId: course.workspaceId, userId: course.userId };
  const state = teachingState(db, scope), tokenHash = hash(`${slug}:${token}`);
  const session = state.sessions.find(s => s.courseId === course.id && s.workspaceId === scope.workspaceId && s.userId === scope.userId && s.expiresAt > now() && s.tokenHash.length === tokenHash.length && timingSafeEqual(Buffer.from(s.tokenHash), Buffer.from(tokenHash)));
  if (!session) throw new TeachingError('参与身份已过期，请重新进入课程', 401, 'TEACHING_SESSION_REQUIRED');
  // Publication rotation revokes prior sessions even if the URL is replayed with a new slug.
  if (session.createdAt < course.updatedAt) throw new TeachingError('课程内容已更新，请重新进入', 409, 'TEACHING_SESSION_CHANGED');
  return { course, session, scope, state };
}
export const requireTeachingSession = authTeachingSession;

export function teachingConversationId(courseId: string) { return `teaching:${courseId}`; }
export function validateTeachingAttachments(db: Database, scope: TeachingScope, courseId: string, ids: string[], fileUserId = scope.userId) {
  for (const attachmentId of ids) {
    if (!db.attachments.some(a => a.id === attachmentId && a.workspaceId === scope.workspaceId && a.userId === fileUserId && a.conversationId === teachingConversationId(courseId) && a.status === 'ready')) throw new TeachingError('附件不属于本次课程或尚未处理完成', 400, 'TEACHING_ATTACHMENT_INVALID');
  }
}
function revision(course: TeachingCourse, value: unknown) {
  if (value !== course.revision) throw new TeachingError('课程已更新，请刷新后再保存', 409, 'TEACHING_REVISION_CONFLICT');
}
function editable(course: TeachingCourse) {
  if (course.status === 'published') throw new TeachingError('请先关闭学生入口，再修改课程或活动；重新开放后学生需重新进入', 409, 'TEACHING_CLOSE_REQUIRED');
}
export function createTeachingCourse(db: Database, scope: TeachingScope, input: unknown) {
  const body = object(input), state = teachingState(db, scope, { create: true });
  const clientCreateKey = body.clientRequestId === undefined ? undefined : requiredText(body.clientRequestId, '课程创建编号', 120);
  if (clientCreateKey !== undefined && !/^[A-Za-z0-9_-]{8,120}$/.test(clientCreateKey)) throw new TeachingError('课程创建编号格式不正确');
  const content = { title: requiredText(body.title, '课程名称', 160), subject: text(body.subject, '学科', 120, ''), description: text(body.description, '课程介绍', 4000, ''), materialText: text(body.materialText, '课程材料', 120000, ''), knowledgeSources: bindTeachingKnowledgeSources(db, scope, body.knowledgeSources), budgetMicros: integer(body.budgetMicros, '教学用量上限', 1_000_000_000, 0) };
  if (body.materialAttachmentIds !== undefined && strings(body.materialAttachmentIds, '材料附件', 20, 100).length) throw new TeachingError('请先保存课程，再上传并选择课程材料');
  const createPayloadHash = hash(JSON.stringify(content));
  if (clientCreateKey) {
    const existing = state.courses.find(course => course.workspaceId === scope.workspaceId && course.userId === scope.userId && course.clientCreateKey === clientCreateKey);
    if (existing) {
      if (existing.createPayloadHash !== createPayloadHash) throw new TeachingError('该创建编号已用于另一份课程内容，请先核对原课程', 409, 'TEACHING_CREATE_CONFLICT');
      return existing;
    }
  }
  if (state.courses.length >= TEACHING_LIMITS.courses) throw new TeachingError('课程数量已达上限，请联系老师管理现有课程', 409, 'TEACHING_CAPACITY');
  const createdAt = now();
  const course: TeachingCourse = { ...scope, id: id('tc'), revision: 1, ...content, ...(clientCreateKey ? { clientCreateKey, createPayloadHash } : {}), materialAttachmentIds: [], status: 'draft', activities: [], createdAt, updatedAt: createdAt };
  state.courses.push(course); return course;
}
/** One explicit save/upload creates a private task container atomically inside Store.mutate. */
export function createTeachingTask(db: Database, scope: TeachingScope, input: unknown) {
  const body = object(input), draftId = requiredText(body.draftId, '任务草稿编号', 120);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(draftId) || !['grade', 'ask', 'quiz', 'game'].includes(String(body.kind))) throw new TeachingError('请重新选择教学任务');
  const kind = body.kind as TeachingTaskKind;
  const titles: Record<TeachingTaskKind, string> = { grade: '作业批改', ask: '知识问答', quiz: '在线答题', game: '文字游戏' };
  const title = body.title === undefined ? titles[kind] : requiredText(body.title, '任务名称', 160);
  const budgetMicros = integer(body.budgetMicros, '教学用量上限', 1_000_000_000, 5_000_000);
  const existing = teachingState(db, scope).courses.find(c => c.workspaceId === scope.workspaceId && c.userId === scope.userId && c.clientDraftId === draftId);
  if (existing) {
    if (existing.taskKind !== kind) throw new TeachingError('这个草稿编号已用于另一种教学任务，请重新开始', 409, 'TEACHING_TASK_CONFLICT');
    const activity = existing.activities[0];
    if (!activity || activity.workspaceId !== scope.workspaceId || activity.userId !== scope.userId || activity.courseId !== existing.id) throw new TeachingError('任务内容已变化，请从已有任务重新打开', 409, 'TEACHING_TASK_CONFLICT');
    return { course: existing, activity, duplicate: true };
  }
  const course = createTeachingCourse(db, scope, { title, budgetMicros });
  course.clientDraftId = draftId; course.taskKind = kind;
  const activity = createTeachingActivity(db, scope, course.id, {
    revision: course.revision, title, stage: kind === 'ask' ? 'before' : kind === 'game' ? 'during' : 'after',
    kind: kind === 'grade' ? 'assignment' : kind === 'ask' ? 'inquiry' : kind,
    status: 'published', allowStudentPrompt: kind === 'game',
    instructions: kind === 'grade' ? '依据老师提供的任务要求和作品原文辅助批改，评分建议由老师复核后发布。' : kind === 'game' ? '这是一场虚构的文字游戏。你可以设置自己的角色，作出选择并继续对话。' : '',
    avatarPrompt: kind === 'game' ? '担任文字游戏主持人，结合学习主题与玩家角色推进简短情境。尊重玩家选择，每轮给出可行动的线索；虚构情节不得冒充史实，不读取评分答案或其他人的资料。' : '',
    rubric: kind === 'grade' ? [{ id: 'overall', label: '整体完成情况', description: '依据教师提供的要求、评分参考与学生作品，核对完成情况并给出有原文依据的建议。', maxScore: 100 }] : []
  }).activity;
  return { course, activity, duplicate: false };
}
export function updateTeachingCourse(db: Database, scope: TeachingScope, courseId: string, input: unknown) {
  const body = object(input), course = ownedTeachingCourse(db, scope, courseId); revision(course, body.revision); editable(course);
  const attachmentIds = strings(body.materialAttachmentIds, '材料附件', 20, 100, course.materialAttachmentIds);
  validateTeachingAttachments(db, scope, courseId, attachmentIds);
  Object.assign(course, { title: body.title === undefined ? course.title : requiredText(body.title, '课程名称', 160), subject: text(body.subject, '学科', 120, course.subject), description: text(body.description, '课程介绍', 4000, course.description), materialText: text(body.materialText, '课程材料', 120000, course.materialText), materialAttachmentIds: attachmentIds, knowledgeSources: bindTeachingKnowledgeSources(db, scope, body.knowledgeSources, course.knowledgeSources), budgetMicros: integer(body.budgetMicros, '教学用量上限', 1_000_000_000, course.budgetMicros), revision: course.revision + 1, updatedAt: now() });
  return course;
}
export function publishTeachingCourse(db: Database, scope: TeachingScope, courseId: string, input: unknown) {
  const body = object(input), course = ownedTeachingCourse(db, scope, courseId); revision(course, body.revision);
  if (body.confirmed !== true) throw new TeachingError('请确认课程材料与活动可向学生开放');
  if (!course.activities.some(a => a.status === 'published')) throw new TeachingError('请先将至少一项活动设为向学生开放');
  validateTeachingAttachments(db, scope, courseId, course.materialAttachmentIds);
  bindTeachingKnowledgeSources(db, scope, undefined, course.knowledgeSources);
  for (const activity of course.activities.filter(a => a.status === 'published')) {
    validateTeachingAttachments(db, scope, courseId, activity.sourceAttachmentIds ?? []);
    bindTeachingKnowledgeSources(db, scope, undefined, activity.knowledgeSources);
  }
  if (course.status === 'published') return course;
  course.status = 'published'; course.slug = randomBytes(24).toString('base64url'); course.revision++; course.updatedAt = now(); return course;
}
export function closeTeachingCourse(db: Database, scope: TeachingScope, courseId: string, input: unknown) {
  const course = ownedTeachingCourse(db, scope, courseId); revision(course, object(input).revision);
  course.status = 'closed'; course.revision++; course.updatedAt = now(); return course;
}
function activityFields(db: Database, scope: TeachingScope, courseId: string, body: Record<string, unknown>, previous?: TeachingActivity) {
  const stage = body.stage ?? previous?.stage, kind = body.kind ?? previous?.kind, status = body.status ?? previous?.status ?? 'draft';
  if (!['before', 'during', 'after'].includes(stage as string) || !['inquiry', 'scenario', 'quiz', 'assignment', 'game'].includes(kind as string) || !['draft', 'published', 'closed'].includes(status as string)) throw new TeachingError('请选择有效的教学阶段、活动类型和开放状态');
  const sourceAttachmentIds = strings(body.sourceAttachmentIds, '活动私有材料', 20, 100, previous?.sourceAttachmentIds ?? []);
  validateTeachingAttachments(db, scope, courseId, sourceAttachmentIds);
  return { stage: stage as TeachingActivity['stage'], kind: kind as TeachingActivity['kind'], status: status as TeachingActivity['status'], title: body.title === undefined && previous ? previous.title : requiredText(body.title, '活动名称', 160), instructions: text(body.instructions, '活动说明', 12000, previous?.instructions ?? ''), avatarPrompt: text(body.avatarPrompt, '教学分身提示词', 12000, previous?.avatarPrompt ?? ''), allowStudentPrompt: boolean(body.allowStudentPrompt, '学生角色编辑权限', previous?.allowStudentPrompt ?? kind === 'game'), knowledgeSources: bindTeachingKnowledgeSources(db, scope, body.knowledgeSources, previous?.knowledgeSources), referenceText: text(body.referenceText, '活动私有参考材料', 120000, previous?.referenceText ?? ''), sourceAttachmentIds, questions: questions(body.questions, previous?.questions), scenes: scenes(body.scenes, previous?.scenes), rubric: rubric(body.rubric, previous?.rubric) };
}
export function createTeachingActivity(db: Database, scope: TeachingScope, courseId: string, input: unknown) {
  const body = object(input), course = ownedTeachingCourse(db, scope, courseId); revision(course, body.revision); editable(course);
  if (course.activities.length >= TEACHING_LIMITS.activities) throw new TeachingError('这门课程的活动数量已达上限', 409, 'TEACHING_CAPACITY');
  const createdAt = now(), activity: TeachingActivity = { ...scope, id: id('ta'), courseId, revision: 1, ...activityFields(db, scope, courseId, body), createdAt, updatedAt: createdAt };
  course.activities.push(activity); course.revision++; course.updatedAt = createdAt; return { course, activity };
}
export function updateTeachingActivity(db: Database, scope: TeachingScope, courseId: string, activityId: string, input: unknown) {
  const body = object(input), course = ownedTeachingCourse(db, scope, courseId); revision(course, body.revision); editable(course);
  const activity = course.activities.find(a => a.id === activityId && a.workspaceId === scope.workspaceId && a.userId === scope.userId && a.courseId === courseId);
  if (!activity) throw new TeachingError('活动不存在', 404, 'TEACHING_NOT_FOUND');
  if (body.activityRevision !== undefined && body.activityRevision !== activity.revision) throw new TeachingError('活动已更新，请刷新后重试', 409, 'TEACHING_REVISION_CONFLICT');
  Object.assign(activity, activityFields(db, scope, courseId, body, activity), { revision: activity.revision + 1, updatedAt: now() });
  course.revision++; course.updatedAt = activity.updatedAt; return { course, activity };
}
/** Private assignment grading can be prepared after collection without rotating
 * the student entry. Existing submissions adopt it only by explicit confirmation. */
export function updateTeachingGrading(db: Database, scope: TeachingScope, courseId: string, activityId: string, input: unknown) {
  const body = object(input), course = ownedTeachingCourse(db, scope, courseId);
  revision(course, body.revision);
  const activity = course.activities.find(item => item.id === activityId && item.courseId === courseId && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  if (!activity) throw new TeachingError('活动不存在', 404, 'TEACHING_NOT_FOUND');
  if (activity.kind !== 'assignment') throw new TeachingError('只有作业活动支持单独设置评分要求');
  if (body.activityRevision !== activity.revision) throw new TeachingError('评分要求已更新，请刷新后再保存', 409, 'TEACHING_REVISION_CONFLICT');
  const allowed = ['revision', 'activityRevision', 'rubric', 'referenceText', 'sourceAttachmentIds', 'knowledgeSources', 'avatarPrompt'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new TeachingError('此入口只能修改作业评分要求；修改学生任务请先关闭课程入口');
  const sourceAttachmentIds = strings(body.sourceAttachmentIds, '评分私有材料', 20, 100, activity.sourceAttachmentIds ?? []);
  validateTeachingAttachments(db, scope, courseId, sourceAttachmentIds);
  const grading = { rubric: rubric(body.rubric, activity.rubric), referenceText: text(body.referenceText, '评分私有参考材料', 120000, activity.referenceText ?? ''), sourceAttachmentIds, knowledgeSources: bindTeachingKnowledgeSources(db, scope, body.knowledgeSources, activity.knowledgeSources), avatarPrompt: text(body.avatarPrompt, '教学分身提示词', 12000, activity.avatarPrompt ?? '') };
  Object.assign(activity, grading, { revision: activity.revision + 1, updatedAt: now() });
  course.revision++;
  // course.updatedAt is the existing publication/session-revocation watermark.
  // A private grading-only edit must not revoke the original student identity.
  return { course, activity };
}

export function publicTeachingCourse(course: TeachingCourse) {
  return { id: course.id, revision: course.revision, title: course.title, subject: course.subject, description: course.description,
    activities: course.activities.filter(a => a.status === 'published').map(a => ({ id: a.id, courseId: a.courseId, revision: a.revision, stage: a.stage, kind: a.kind, title: a.title, instructions: a.instructions, avatarPrompt: a.kind === 'inquiry' || a.kind === 'game' ? a.avatarPrompt ?? '' : '', allowStudentPrompt: a.kind === 'game' && a.allowStudentPrompt === true, status: a.status, questions: a.questions.map(q => ({ id: q.id, prompt: q.prompt, type: q.type, options: q.options, points: q.points })), scenes: a.scenes.map(s => ({ id: s.id, title: s.title, content: s.content, choices: s.choices, reflection: '' })), rubric: a.rubric.map(r => ({ id: r.id, label: r.label, description: r.description, maxScore: r.maxScore })), createdAt: a.createdAt, updatedAt: a.updatedAt })) };
}
export function createTeachingSession(db: Database, slug: string, input: unknown) {
  const body = object(input), course = activeTeachingCourse(db, slug), scope = { workspaceId: course.workspaceId, userId: course.userId };
  if (body.consent !== true) throw new TeachingError('请确认向任课老师提交参与信息及本课程学习记录');
  const participantName = requiredText(body.participantName, '姓名或昵称', 80), participantRef = text(body.participantRef, '学号或识别信息', 100, ''), participantClass = text(body.participantClass, '班级', 100, '');
  const state = teachingState(db, scope, { create: true });
  if (state.sessions.length >= TEACHING_LIMITS.sessions) throw new TeachingError('课程参与人数已达上限，请联系老师', 429, 'TEACHING_CAPACITY');
  const token = randomBytes(32).toString('base64url'), createdAt = now();
  const session: TeachingSession = { ...scope, id: id('tss'), courseId: course.id, tokenHash: hash(`${slug}:${token}`), participantName, participantRef, participantClass, consentedAt: createdAt, createdAt, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
  state.sessions.push(session); return { token, sessionId: session.id, participantName, participantRef, participantClass, expiresAt: session.expiresAt };
}
export function publicTeachingSession(session: TeachingSession) { return { id: session.id, participantName: session.participantName, participantRef: session.participantRef, participantClass: session.participantClass ?? '', expiresAt: session.expiresAt }; }
function answerValues(value: unknown, activity: TeachingActivity) {
  if (value === undefined) return {} as Record<string, string>;
  const body = object(value), entries = Object.entries(body);
  if (entries.length > 50) throw new TeachingError('答案数量超出限制');
  const allowed = new Set([...activity.questions.map(q => q.id), ...activity.scenes.map(s => s.id)]);
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!allowed.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new TeachingError('答案包含不属于本活动的题目');
    const answer = text(raw, '答案', 12000);
    const question = activity.questions.find(q => q.id === key);
    if (question?.type === 'single' && answer && !question.options.includes(answer)) throw new TeachingError('请选择有效选项');
    const scene = activity.scenes.find(s => s.id === key);
    if (scene?.choices.length && answer && !scene.choices.includes(answer)) throw new TeachingError('请选择有效的情境决策');
    result[key] = answer;
  }
  return result;
}
export function addTeachingSubmission(db: Database, scope: TeachingScope, course: TeachingCourse, input: unknown, session?: TeachingSession) {
  teachingMember(db, scope);
  if (ownedTeachingCourse(db, scope, course.id) !== course) throw new TeachingError('课程不存在', 404);
  const body = object(input), activityId = requiredText(body.activityId, '活动编号', 100);
  const activity = course.activities.find(a => a.id === activityId && a.workspaceId === scope.workspaceId && a.userId === scope.userId && a.courseId === course.id);
  if (!activity) throw new TeachingError('活动不存在', 404, 'TEACHING_NOT_FOUND');
  if (session && (session.courseId !== course.id || session.workspaceId !== scope.workspaceId || session.userId !== scope.userId || course.status !== 'published' || activity.status !== 'published')) throw new TeachingError('该活动暂未开放提交', 410, 'TEACHING_CLOSED');
  if (body.activityRevision !== undefined && body.activityRevision !== activity.revision) throw new TeachingError('活动内容已更新，请刷新后提交', 409, 'TEACHING_REVISION_CONFLICT');
  const operationId = requiredText(body.operationId, '提交编号', 120);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(operationId)) throw new TeachingError('提交编号格式不正确');
  const answers = answerValues(body.answers, activity), content = text(body.text, '作业内容', 80000, ''), attachmentIds = strings(body.attachmentIds, '作业附件', 10, 100);
  const participantName = session?.participantName ?? requiredText(body.participantName, '学生姓名或昵称', 80), participantRef = session?.participantRef ?? text(body.participantRef, '学生学号或识别信息', 100, '');
  const participantClass = session ? session.participantClass ?? '' : text(body.participantClass, '班级', 100, '');
  if (!content && !attachmentIds.length && !Object.values(answers).some(Boolean)) throw new TeachingError('请填写答案、学习记录或上传作业');
  validateTeachingAttachments(db, scope, course.id, attachmentIds, session?.id ?? scope.userId);
  const state = teachingState(db, scope, { create: true }), payloadHash = hash(JSON.stringify({ activityId, activityRevision: activity.revision, participantName, participantRef, ...(participantClass ? { participantClass } : {}), text: content, answers: Object.fromEntries(Object.entries(answers).sort()), attachmentIds }));
  const existing = state.submissions.find(s => s.workspaceId === scope.workspaceId && s.userId === scope.userId && s.courseId === course.id && s.sessionId === session?.id && s.operationId === operationId);
  if (existing) { if (existing.payloadHash !== payloadHash) throw new TeachingError('此提交编号已使用，请刷新确认已提交内容', 409, 'TEACHING_OPERATION_CONFLICT'); return { submission: existing, duplicate: true }; }
  if (state.submissions.length >= TEACHING_LIMITS.submissions) throw new TeachingError('课程提交数量已达上限，请联系老师', 429, 'TEACHING_CAPACITY');
  const submission: TeachingSubmission = { ...scope, id: id('tsub'), courseId: course.id, activityId, activityRevision: activity.revision, ...(session ? { sessionId: session.id } : {}), participantName, participantRef, participantClass, operationId, payloadHash, text: content, answers, attachmentIds, activitySnapshot: structuredClone(activity), createdAt: now() };
  state.submissions.push(submission); return { submission, duplicate: false };
}
export function teachingSubmissions(db: Database, scope: TeachingScope, courseId: string) {
  ownedTeachingCourse(db, scope, courseId);
  return teachingState(db, scope).submissions.filter(s => s.workspaceId === scope.workspaceId && s.userId === scope.userId && s.courseId === courseId);
}
export function publicTeachingSubmission(s: TeachingSubmission) {
  const grade = s.grade?.status === 'published' ? { criteria: s.grade.criteria.map(c => ({ criterionId: c.criterionId, score: c.score, comment: c.comment, evidence: c.evidence })), total: s.grade.total, feedback: s.grade.feedback, source: s.grade.source, status: s.grade.status, needsReview: s.grade.needsReview, reviewedAt: s.grade.reviewedAt, publishedAt: s.grade.publishedAt } : undefined;
  const learningReview = s.activitySnapshot.kind === 'scenario' ? s.activitySnapshot.scenes.filter(scene => !!s.answers[scene.id]).map(scene => ({ title: scene.title, reflection: scene.reflection })) : undefined;
  return { id: s.id, courseId: s.courseId, activityId: s.activityId, activityRevision: s.activityRevision, operationId: s.operationId, participantName: s.participantName, participantRef: s.participantRef, participantClass: s.participantClass ?? '', text: s.text, answers: s.answers, attachmentIds: s.attachmentIds, createdAt: s.createdAt, ...(grade ? { grade } : {}), ...(learningReview ? { learningReview } : {}) };
}
export function teachingGradingActivity(submission: TeachingSubmission): TeachingActivity { return submission.gradingSnapshot ?? submission.activitySnapshot; }
export function bindTeachingGradingBasis(db: Database, scope: TeachingScope, courseId: string, submissionId: string, input: unknown) {
  const body = object(input), course = ownedTeachingCourse(db, scope, courseId), submission = teachingSubmissions(db, scope, courseId).find(row => row.id === submissionId);
  if (!submission) throw new TeachingError('作业不存在', 404, 'TEACHING_NOT_FOUND');
  if (body.confirmed !== true) throw new TeachingError('请明确确认采用当前评分标准');
  if (submission.grade?.status === 'published') throw new TeachingError('成绩已发布，不能更换这份作业的评分依据', 409, 'TEACHING_GRADE_PUBLISHED');
  const current = course.activities.find(activity => activity.id === submission.activityId && activity.courseId === courseId && activity.workspaceId === scope.workspaceId && activity.userId === scope.userId);
  if (!current || current.kind !== 'assignment' || submission.activitySnapshot.kind !== 'assignment') throw new TeachingError('只有作业活动可在收件后明确采用新评分标准');
  if (body.submissionActivityRevision !== submission.activityRevision || body.activityRevision !== current.revision) throw new TeachingError('作业或评分活动版本已变化，请刷新后再确认', 409, 'TEACHING_GRADING_REVISION_CONFLICT');
  if (!current.rubric.length || current.rubric.some(item => item.maxScore <= 0)) throw new TeachingError('请先保存完整的作业评分标准');
  validateTeachingAttachments(db, scope, courseId, current.sourceAttachmentIds ?? []);
  const knowledgeSources = bindTeachingKnowledgeSources(db, scope, undefined, current.knowledgeSources ?? []);
  const candidate = { ...structuredClone(current), knowledgeSources, questions: structuredClone(submission.activitySnapshot.questions), scenes: structuredClone(submission.activitySnapshot.scenes), instructions: submission.activitySnapshot.instructions };
  if (submission.gradingSnapshot && JSON.stringify(submission.gradingSnapshot) === JSON.stringify(candidate)) return submission;
  if ((body.expectedGradingRevision ?? 0) !== (submission.gradingRevision ?? 0)) throw new TeachingError('这份作业已采用另一版评分标准，请刷新后核对', 409, 'TEACHING_GRADING_REVISION_CONFLICT');
  submission.gradingSnapshot = candidate; submission.gradingRevision = (submission.gradingRevision ?? 0) + 1; submission.gradingBoundAt = now(); delete submission.grade;
  return submission;
}
export function reviewTeachingSubmission(db: Database, scope: TeachingScope, courseId: string, submissionId: string, input: unknown) {
  const submission = teachingSubmissions(db, scope, courseId).find(s => s.id === submissionId);
  if (!submission) throw new TeachingError('作业不存在', 404, 'TEACHING_NOT_FOUND');
  const body = object(input), rows = boundedRows(body.criteria, '评分项', 40), activity = teachingGradingActivity(submission);
  if ((submission.gradingRevision ?? 0) > 0 && body.gradingRevision !== submission.gradingRevision) throw new TeachingError('评分依据已更新，请重新核对当前版本再发布', 409, 'TEACHING_GRADING_REVISION_CONFLICT');
  const allowed = activity.kind === 'quiz' ? activity.questions.map(q => ({ id: q.id, max: q.points })) : activity.rubric.map(r => ({ id: r.id, max: r.maxScore }));
  const criteria = rows.map(row => {
    const criterionId = requiredText(row.criterionId, '评分项编号', 100), criterion = allowed.find(r => r.id === criterionId);
    if (!criterion || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > criterion.max) throw new TeachingError('评分项或分数不符合本次作业标准');
    return { criterionId, score: row.score, comment: text(row.comment, '评分说明', 4000, ''), evidence: text(row.evidence, '评分依据', 6000, '') };
  });
  if (new Set(criteria.map(c => c.criterionId)).size !== criteria.length || (allowed.length && criteria.length !== allowed.length)) throw new TeachingError('请完成每一项评分，评分项不能重复');
  const total = Math.round(criteria.reduce((sum, c) => sum + c.score, 0) * 100) / 100;
  if (body.total !== undefined && body.total !== total) throw new TeachingError('总分与分项得分不一致');
  const reviewedAt = now();
  const grade: TeachingGrade = { criteria, total, feedback: text(body.feedback, '总体反馈', 12000, ''), source: 'teacher', status: 'published', needsReview: false, reviewedAt, publishedAt: reviewedAt, gradingRevision: submission.gradingRevision ?? 0 };
  if (submission.grade?.status === 'published') {
    if (JSON.stringify({ criteria: submission.grade.criteria, total: submission.grade.total, feedback: submission.grade.feedback }) === JSON.stringify({ criteria, total, feedback: grade.feedback })) return submission;
    throw new TeachingError('成绩已经发布，不能覆盖已确认的结果', 409, 'TEACHING_GRADE_PUBLISHED');
  }
  submission.grade = grade; return submission;
}
