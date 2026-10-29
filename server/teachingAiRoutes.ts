import express, { type Express, type Request, type RequestHandler } from 'express';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import type { Attachment, Message, ModelConfig } from './types.js';
import type { TeachingActivity, TeachingCourse, TeachingOperation, TeachingScope, TeachingSubmission } from './teachingTypes.js';
import { authTeachingSession, ownedTeachingCourse, teachingState, validateTeachingAttachments, teachingConversationId, TeachingError } from './teaching.js';
import { executeTeachingAi, TeachingAiError, type TeachingAiResult } from './teachingAi.js';
import { asyncRoute } from './middleware.js';
import { uid } from './security.js';
import { attachmentSegments, prepareAttachmentContext } from './attachmentRetrieval.js';
import { runBilledModel } from './modelBilling.js';
import { callModelWithTools } from './modelGateway.js';

export type TeachingAiRouteDependencies = {
  verifyKey: (req: Request) => Promise<void>;
  modelCall?: typeof callModelWithTools;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tokenOf = (req: Request) => req.headers.authorization?.replace(/^Bearer /, '') ?? '';
const owner = (req: Request) => ({ workspaceId: req.workspaceId!, userId: req.user!.id });
function publicOperation(operation: TeachingOperation) {
  return { id: operation.id, operationId: operation.operationId, courseRevision: operation.courseRevision, activityId: operation.activityId, submissionId: operation.submissionId, kind: operation.kind, status: operation.status, result: operation.result, error: operation.error, createdAt: operation.createdAt, completedAt: operation.completedAt };
}
function courseUsage(db: Awaited<ReturnType<Store['read']>>, course: TeachingCourse) {
  return db.modelUsageRecords.filter(u => u.workspaceId === course.workspaceId && u.userId === course.userId && u.conversationId === teachingConversationId(course.id)).reduce((sum, u) => sum + (u.chargedMicros ?? 0) + (u.reservedMicros ?? 0), 0);
}
async function fullWorkText(files: Attachment[]) {
  let text = '';
  for (const file of files) {
    if (file.kind === 'image') continue;
    for await (const segment of attachmentSegments(file)) {
      if (text.length + segment.text.length > 100_000) throw new TeachingError('作业文字较多，请拆分后评阅；尚未开始批改', 422);
      text += segment.text + '\n';
    }
  }
  return text;
}

/** Billed attempts are durable before execution; polling never reissues an unknown call. */
export function installTeachingAiRoutes(app: Express, auth: readonly RequestHandler[], store: Store, deps: TeachingAiRouteDependencies) {
  const router = express.Router(), running = new Set<string>();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  function begin(db: Awaited<ReturnType<Store['read']>>, scope: TeachingScope, course: TeachingCourse, body: Record<string, unknown>, sessionId?: string) {
    if (typeof body.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.operationId)) throw new TeachingError('请重新发起这次教学操作');
    if (!['prepare', 'answer', 'grade', 'insights'].includes(String(body.kind))) throw new TeachingError('请选择教学操作');
    const state = teachingState(db, scope, { create: true });
    const payloadHash = hash({ kind: body.kind, activityId: body.activityId, submissionId: body.submissionId, content: body.content, attachmentIds: body.attachmentIds ?? [] });
    const old = state.operations.find(o => o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.courseId === course.id && o.sessionId === sessionId && o.operationId === body.operationId);
    if (old) { if (old.payloadHash !== payloadHash) throw new TeachingError('提交内容已经变化，请重新确认后发起', 409); return { operation: old, created: false }; }
    const activity = body.activityId === undefined ? undefined : course.activities.find(a => a.id === body.activityId);
    if (body.kind !== 'insights' && !activity) throw new TeachingError('请先保存并选择教学活动');
    if (sessionId && (activity?.status !== 'published' || !['inquiry', 'scenario'].includes(activity.kind))) throw new TeachingError('这个活动暂未开放导学问答', 403);
    if (body.kind === 'prepare' && course.status === 'published') throw new TeachingError('请先关闭学生入口，再准备新版活动', 409);
    if (body.kind === 'grade' && !state.submissions.some(s => s.id === body.submissionId && s.courseId === course.id && s.activityId === activity?.id && s.workspaceId === scope.workspaceId && s.userId === scope.userId)) throw new TeachingError('未找到本课程的这份作业', 404);
    if (body.kind === 'grade' && state.submissions.find(s => s.id === body.submissionId)?.grade?.status === 'published') throw new TeachingError('这份成绩已经发布，请保留已确认结果', 409);
    if (body.kind === 'answer' && (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 6000)) throw new TeachingError('请填写 1–6000 字的学习问题');
    const attachmentIds = body.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 3 || attachmentIds.some(id => typeof id !== 'string')) throw new TeachingError('每次最多选择 3 份现场资料');
    validateTeachingAttachments(db, scope, course.id, attachmentIds as string[], sessionId ?? scope.userId);
    const mine = state.operations.filter(o => o.workspaceId === scope.workspaceId && o.courseId === course.id);
    if (body.kind === 'grade' && mine.some(o => o.kind === 'grade' && o.submissionId === body.submissionId && o.status === 'running')) throw new TeachingError('这份作业正在评阅，请先查看本次结果', 409);
    if (state.operations.length >= 10_000 || mine.filter(o => o.status === 'running').length >= 4 || (sessionId && mine.filter(o => o.status === 'running' && o.sessionId === sessionId).length) || mine.filter(o => Date.now() - Date.parse(o.createdAt) < 60_000).length >= 120) throw new TeachingError('教学 AI 正在处理其他请求，请稍后再试；原有记录已保留', 429);
    const operation: TeachingOperation = { ...scope, id: uid('tai'), courseId: course.id, courseRevision: course.revision, activityId: activity?.id, submissionId: typeof body.submissionId === 'string' ? body.submissionId : undefined, sessionId, operationId: body.operationId, payloadHash, kind: body.kind as TeachingOperation['kind'], question: body.kind === 'answer' ? String(body.content) : undefined, attachmentIds: attachmentIds as string[], status: 'running', createdAt: new Date().toISOString() };
    state.operations.push(operation); return { operation, created: true };
  }
  async function execute(operation: TeachingOperation, verify: () => Promise<void>) {
    running.add(operation.id);
    const scope = { workspaceId: operation.workspaceId, userId: operation.userId };
    try {
      await verify();
      const db = await store.read(), course = structuredClone(ownedTeachingCourse(db, scope, operation.courseId));
      const activity = structuredClone(course.activities.find(a => a.id === operation.activityId));
      const submission = structuredClone(teachingState(db, scope).submissions.find(s => s.id === operation.submissionId && s.courseId === course.id));
      const candidates = db.models.filter(m => m.kind === 'chat');
      const teacher = db.users.find(u => u.id === scope.userId)!;
      const model = candidates.find(m => m.enabled && m.apiKey && m.id === teacher.preferredModelId) ?? candidates.find(m => m.enabled && m.apiKey && m.isDefault) ?? candidates.find(m => m.enabled && m.apiKey) ?? candidates[0];
      if (!model) throw new TeachingError('请先配置可用的教学模型', 409);
      const courseFiles = course.materialAttachmentIds.map(id => {
        validateTeachingAttachments(db, scope, course.id, [id]); return db.attachments.find(f => f.id === id)!;
      });
      const courseText = courseFiles.length ? (await prepareAttachmentContext(courseFiles, { ...scope, conversationId: teachingConversationId(course.id) }, operation.question ?? activity?.title ?? '课程材料', 40_000, async () => { throw new TeachingError('请按章节选择课程资料'); })).text : '';
      if (course.materialText.length + courseText.length > 120_000) throw new TeachingError('课程资料较多，请按章节准备活动', 422);
      course.materialText += courseText ? `\n\n${courseText}` : '';
      let attachmentText = '', imageFiles: Attachment[] = [];
      if (operation.kind === 'prepare' && activity) {
        const ids = activity.sourceAttachmentIds ?? [];
        validateTeachingAttachments(db, scope, course.id, ids);
        attachmentText = `${activity.referenceText ?? ''}\n${await fullWorkText(ids.map(id => db.attachments.find(f => f.id === id)!))}`;
      } else if (operation.kind === 'grade' && submission) {
        const references = submission.activitySnapshot.sourceAttachmentIds ?? [];
        validateTeachingAttachments(db, scope, course.id, references);
        const gradingReference = `${submission.activitySnapshot.referenceText ?? ''}\n${await fullWorkText(references.map(id => db.attachments.find(f => f.id === id)!))}`.trim();
        if (gradingReference) course.materialText += `\n\n【教师评分参考，不是学生作品】\n${gradingReference}`;
        validateTeachingAttachments(db, scope, course.id, submission.attachmentIds, submission.sessionId ?? scope.userId);
        const files = submission.attachmentIds.map(id => db.attachments.find(f => f.id === id)!);
        attachmentText = await fullWorkText(files);
        imageFiles = files.filter(f => f.kind === 'image');
      } else if (operation.kind === 'answer') {
        validateTeachingAttachments(db, scope, course.id, operation.attachmentIds ?? [], operation.sessionId ?? scope.userId);
        const files = (operation.attachmentIds ?? []).map(id => db.attachments.find(f => f.id === id)!);
        attachmentText = await fullWorkText(files); imageFiles = files.filter(f => f.kind === 'image');
      }
      const imageDataUrls: string[] = [];
      if (imageFiles.length > 3 || imageFiles.reduce((n, f) => n + f.size, 0) > 8 * 1024 ** 2) throw new TeachingError('图片较多或较大，请将本次图片总量压缩至 8 MB 内', 422);
      for (const file of imageFiles) imageDataUrls.push(`data:${file.mimeType};base64,${(await fs.readFile(file.storagePath)).toString('base64')}`);
      const submissions = operation.kind === 'insights' ? teachingState(db, scope).submissions.filter(s => s.workspaceId === scope.workspaceId && s.courseId === course.id && (!activity || s.activityId === activity.id)) : [];
      if (operation.kind === 'insights') {
        // Only explicitly disclosed course questions, never a publisher's private chat history.
        for (const question of teachingState(db, scope).operations.filter(o => o.courseId === course.id && o.workspaceId === scope.workspaceId && o.sessionId && o.kind === 'answer' && o.status === 'completed' && o.question && (!activity || o.activityId === activity.id))) {
          const snapshot = course.activities.find(a => a.id === question.activityId);
          const participant = teachingState(db, scope).sessions.find(s => s.id === question.sessionId && s.courseId === course.id && s.workspaceId === scope.workspaceId && s.userId === scope.userId);
          if (snapshot) submissions.push({ ...scope, id: question.id, courseId: course.id, activityId: snapshot.id, activityRevision: snapshot.revision, participantName: participant?.participantName ?? '', participantRef: participant?.participantRef ?? '', operationId: question.operationId, payloadHash: question.payloadHash, text: question.question!, answers: {}, attachmentIds: [], activitySnapshot: snapshot, createdAt: question.createdAt });
        }
      }
      const output = await executeTeachingAi({ kind: operation.kind, course, activity, submission, submissions, question: operation.question, imageDataUrls, attachmentText, model }, { call: async (messages, options) => {
        await verify();
        const safety = (await store.read()).settings.safetyRules;
        const inputMessages: Message[] = [{ role: 'system', content: safety, createdAt: operation.createdAt }, ...messages];
        return runBilledModel(store, { ...scope, conversationId: teachingConversationId(course.id), model, input: { messages: inputMessages }, activity: `teaching_${operation.kind}`, requestId: operation.id, maxOutputTokens: options?.maxOutputTokens, beforeReserve: (fresh, amount) => {
          const live = ownedTeachingCourse(fresh, scope, course.id);
          if (live.revision !== operation.courseRevision || (operation.sessionId && live.status !== 'published')) throw new TeachingError('课程内容或开放状态已变化，这次尚未继续', 409);
          if (courseUsage(fresh, live) + amount > live.budgetMicros) throw new TeachingError('本次预计用量超过课程额度，请老师调整上限后再试', 402);
        } }, snapshot => (deps.modelCall ?? callModelWithTools)(snapshot, inputMessages.map(m => ({ role: m.role, content: m.content, inputImageDataUrls: m.inputImageDataUrls })), [], operation.id, options));
      } });
      await verify();
      await store.mutate(fresh => {
        const live = ownedTeachingCourse(fresh, scope, course.id), state = teachingState(fresh, scope), saved = state.operations.find(o => o.id === operation.id)!;
        if (live.revision !== operation.courseRevision || saved.status !== 'running') throw new TeachingError('课程已更新，结果保留待核对，请刷新后查看', 409);
        if (output.kind === 'grade') {
          const target = state.submissions.find(s => s.id === operation.submissionId && s.courseId === course.id && s.userId === scope.userId && s.workspaceId === scope.workspaceId);
          if (!target || target.grade?.status === 'published') throw new TeachingError('作业状态已变化，未覆盖老师确认的结果', 409);
          target.grade = output.grade;
        }
        saved.result = output; saved.status = 'completed'; saved.completedAt = new Date().toISOString();
      });
    } catch (error) {
      await store.mutate(db => {
        const saved = db.users.find(u => u.id === scope.userId)?.teaching?.operations.find(o => o.id === operation.id && o.workspaceId === scope.workspaceId);
        if (!saved || saved.status !== 'running') return;
        saved.status = error instanceof TeachingAiError || error instanceof TeachingError ? 'failed' : 'uncertain';
        saved.error = error instanceof TeachingAiError || error instanceof TeachingError ? error.message : '本次 AI 结果尚未确认，已保留原记录；不会自动重复执行，请先查看用量或联系管理员。';
        saved.completedAt = new Date().toISOString();
      });
    } finally { running.delete(operation.id); }
  }
  async function readOperation(scope: TeachingScope, courseId: string, id: string, sessionId?: string) {
    const db = await store.read();
    ownedTeachingCourse(db, scope, courseId);
    const scoped = teachingState(db, scope).operations.filter(o => o.courseId === courseId && o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.sessionId === sessionId);
    const found = scoped.find(o => o.id === id) ?? scoped.find(o => o.operationId === id);
    if (!found) throw new TeachingError('教学操作不存在', 404);
    if (found.status !== 'running' || running.has(found.id)) return publicOperation(found);
    return store.mutate(db => {
      ownedTeachingCourse(db, scope, courseId);
      const operation = teachingState(db, scope).operations.find(o => o.id === found.id && o.courseId === courseId && o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.sessionId === sessionId);
      if (!operation) throw new TeachingError('教学操作不存在', 404);
      if (operation.status === 'running' && !running.has(operation.id)) { operation.status = 'uncertain'; operation.error = '服务中断后本次结果尚未确认，未自动重试，请核对原记录。'; }
      return publicOperation(operation);
    });
  }
  router.post('/courses/:courseId/ai', ...auth, asyncRoute(async (req, res) => {
    if (req.body?.budgetConfirmed !== true || req.body?.kind === 'answer') throw new TeachingError('请确认本次教学 AI 操作和课程费用');
    await deps.verifyKey(req);
    const scope = owner(req), result = await store.mutate(db => begin(db, scope, ownedTeachingCourse(db, scope, String(req.params.courseId)), req.body));
    if (result.created) { running.add(result.operation.id); void execute(result.operation, () => deps.verifyKey(req)).catch(() => { running.delete(result.operation.id); }); }
    res.status(result.operation.status === 'running' ? 202 : 200).json({ operation: publicOperation(result.operation) });
  }));
  router.get('/courses/:courseId/operations/:id', ...auth, asyncRoute(async (req, res) => res.json({ operation: await readOperation(owner(req), String(req.params.courseId), String(req.params.id)) })));
  router.get('/courses/:courseId/operations', ...auth, asyncRoute(async (req, res) => {
    const scope = owner(req), db = await store.read(), course = ownedTeachingCourse(db, scope, String(req.params.courseId));
    const latest = teachingState(db, scope).operations.filter(o => o.courseId === course.id && o.workspaceId === scope.workspaceId && o.userId === scope.userId && !o.sessionId).slice(-10).reverse();
    res.json({ operations: await Promise.all(latest.map(o => readOperation(scope, course.id, o.id))) });
  }));
  router.post('/public/:slug/questions', asyncRoute(async (req, res) => {
    const token = tokenOf(req), slug = String(req.params.slug);
    const result = await store.mutate(db => { const { course, session, scope } = authTeachingSession(db, slug, token); return begin(db, scope, course, { ...req.body, kind: 'answer' }, session.id); });
    const verify = async () => { authTeachingSession(await store.read(), slug, token); };
    if (result.created) { running.add(result.operation.id); void execute(result.operation, verify).catch(() => { running.delete(result.operation.id); }); }
    res.status(result.operation.status === 'running' ? 202 : 200).json({ operation: publicOperation(result.operation) });
  }));
  router.get('/public/:slug/operations/:id', asyncRoute(async (req, res) => {
    const { course, session, scope } = authTeachingSession(await store.read(), String(req.params.slug), tokenOf(req));
    res.json({ operation: await readOperation(scope, course.id, String(req.params.id), session.id) });
  }));
  router.get('/public/:slug/operations', asyncRoute(async (req, res) => {
    const db = await store.read(), { course, session, scope } = authTeachingSession(db, String(req.params.slug), tokenOf(req));
    const latest = teachingState(db, scope).operations.filter(o => o.courseId === course.id && o.workspaceId === scope.workspaceId && o.userId === scope.userId && o.sessionId === session.id).slice(-10).reverse();
    res.json({ operations: await Promise.all(latest.map(o => readOperation(scope, course.id, o.id, session.id))) });
  }));
  router.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof TeachingError ? error.status : 400).json({ error: error instanceof TeachingError ? error.message : '教学操作暂未完成，请刷新后核对原记录', code: error instanceof TeachingError ? error.code : 'TEACHING_AI_FAILED' });
  });
  app.use('/api/teaching', router);
}
