import express, { type Express, type Request, type RequestHandler } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from './db.js';
import { AttachmentService, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_BYTES, removeAttachmentFiles } from './attachmentService.js';
import { publicAttachmentSummary } from './conversationAttachments.js';
import { asyncRoute } from './middleware.js';
import { uid } from './security.js';
import { authTeachingSession, ownedTeachingCourse, teachingConversationId, teachingState, teachingSessionActivity, TeachingError } from './teaching.js';
import type { TeachingCourse, TeachingScope, TeachingSession } from './teachingTypes.js';
import type { Attachment } from './types.js';

const videoExtensions = new Set(['.mp4', '.webm', '.mov']);
type FileAccess = { course: TeachingCourse; scope: TeachingScope; fileUserId: string; session?: TeachingSession };
const token = (req: Request) => req.headers.authorization?.replace(/^Bearer /, '') ?? '';

/** Media assignments are private original files, never put through the document parser. */
export function installTeachingFileRoutes(app: Express, auth: readonly RequestHandler[], store: Store, directory: string, service: AttachmentService) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const access = async (req: Request, publicRoute: boolean): Promise<FileAccess> => {
    const db = await store.read();
    if (publicRoute) {
      const found = authTeachingSession(db, String(req.params.slug), token(req));
      return { ...found, fileUserId: found.session.id };
    }
    const scope = { workspaceId: req.workspaceId!, userId: req.user!.id };
    return { scope, course: ownedTeachingCourse(db, scope, String(req.params.courseId)), fileUserId: scope.userId };
  };
  const currentFile = (db: Awaited<ReturnType<Store['read']>>, a: FileAccess, id: string) => {
    const course=assertAccess(db,a);
    const file = db.attachments.find(f => f.id === id && f.workspaceId === a.scope.workspaceId && f.userId === a.fileUserId && f.conversationId === teachingConversationId(a.course.id));
    if (!file || !visibleFile(db,a,course,id)) throw new TeachingError('附件不存在或不属于本次课程', 404);
    return file;
  };
  const visibleFile = (db: Awaited<ReturnType<Store['read']>>,a:FileAccess,course:TeachingCourse,id:string) => {
    if(course.materialAttachmentIds.includes(id)&&!a.session)return true;
    const state=teachingState(db,a.scope),refs=course.activities.filter(activity=>activity.sourceAttachmentIds?.includes(id)).map(activity=>activity.id);
    for(const row of state.submissions.filter(row=>row.courseId===course.id&&row.workspaceId===a.scope.workspaceId&&row.userId===a.scope.userId))if(row.attachmentIds.includes(id)||row.activitySnapshot.sourceAttachmentIds?.includes(id)||row.gradingSnapshot?.sourceAttachmentIds?.includes(id))refs.push(row.activityId);
    for(const operation of state.operations.filter(row=>row.courseId===course.id&&row.workspaceId===a.scope.workspaceId&&row.userId===a.scope.userId&&row.activityId))if(operation.attachmentIds?.includes(id))refs.push(operation.activityId!);
    return !refs.length||refs.some(activityId=>{const activity=course.activities.find(row=>row.id===activityId&&!row.deletedAt);if(!activity)return false;if(!a.session)return true;try{teachingSessionActivity(course,a.session,activityId);return true;}catch{return false;}});
  };
  const assertAccess = (db: Awaited<ReturnType<Store['read']>>, a: FileAccess) => {
    const course=ownedTeachingCourse(db,a.scope,a.course.id);
    if(a.session){
      const session=teachingState(db,a.scope).sessions.find(row=>row.id===a.session!.id&&row.courseId===course.id&&row.workspaceId===a.scope.workspaceId&&row.userId===a.scope.userId&&row.expiresAt>new Date().toISOString()&&row.tokenHash===a.session!.tokenHash);
      if(!session||session.createdAt<(course.sessionsRevokedAt??course.updatedAt))throw new TeachingError('参与身份已更新，请重新进入',401);
      if(session.activityId)teachingSessionActivity(course,session,session.activityId);else if(course.status!=='published')throw new TeachingError('学生入口已关闭',410);
    }
    return course;
  };
  for (const publicRoute of [false, true]) {
    const prefix = publicRoute ? '/public/:slug' : '/courses/:courseId';
    const middleware = publicRoute ? [] : [...auth];
    router.get(`${prefix}/uploads`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute), db = await store.read();
      const course=assertAccess(db,a);
      res.json({ attachments: db.attachments.filter(file => file.workspaceId === a.scope.workspaceId && file.userId === a.fileUserId && file.conversationId === teachingConversationId(a.course.id) && visibleFile(db,a,course,file.id)).map(publicAttachmentSummary) });
    }));
    router.post(`${prefix}/uploads`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute), body = req.body ?? {};
      if (typeof body.name !== 'string' || body.name.length > 180 || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > ATTACHMENT_MAX_BYTES) throw new TeachingError('请选择不超过 200 MB 的作业文件');
      const extension = path.extname(body.name).toLowerCase(), video = videoExtensions.has(extension);
      if (video) {
        const space = await fs.statfs(directory);
        if (space.bavail * space.bsize < body.size + 2 * 1024 ** 3) throw new TeachingError('作业存储空间不足，请联系老师', 429);
      }
      let file: Attachment | undefined;
      try {
        if (!video) file = await service.create({ workspaceId: a.scope.workspaceId, userId: a.fileUserId }, body.name, body.size, body.mimeType);
        else {
          const id = uid('att');
          file = { id, workspaceId: a.scope.workspaceId, userId: a.fileUserId, originalName: path.basename(body.name), size: body.size, mimeType: extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4', kind: 'document', storagePath: path.join(directory, id + extension), extractedText: '', createdAt: new Date().toISOString(), status: 'uploading', uploadedBytes: 0 };
          await fs.writeFile(file.storagePath, '', { flag: 'wx', mode: 0o600 });
        }
        const allocated = file;
        await store.mutate(db => {
          if (publicRoute) authTeachingSession(db, String(req.params.slug), token(req));
          else ownedTeachingCourse(db, a.scope, a.course.id);
          const courseFiles = db.attachments.filter(f => f.workspaceId === a.scope.workspaceId && f.conversationId === teachingConversationId(a.course.id));
          const mine = courseFiles.filter(f => f.userId === a.fileUserId);
          if (courseFiles.length >= 3000 || courseFiles.reduce((n, f) => n + f.size, 0) + allocated.size > 2 * 1024 ** 3 || mine.filter(f => f.status === 'uploading').length >= 5) throw new TeachingError('本次课程附件额度已满，请联系老师', 429);
          if (video) db.attachments.push(allocated);
          const saved = db.attachments.find(f => f.id === allocated.id)!;
          saved.conversationId = teachingConversationId(a.course.id);
        });
        res.json({ attachment: publicAttachmentSummary(allocated) });
      } catch (error) {
        if (file) {
          const abandoned = file;
          await store.mutate(db => { db.attachments = db.attachments.filter(f => f.id !== abandoned.id); });
          await removeAttachmentFiles(abandoned.storagePath);
        }
        throw error;
      }
    }));
    router.put(`${prefix}/uploads/:id/chunks`, ...middleware, (req, _res, next) => { void access(req, publicRoute).then(() => next(), next); }, express.raw({ type: 'application/octet-stream', limit: ATTACHMENT_CHUNK_BYTES }), asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute);
      currentFile(await store.read(), a, String(req.params.id));
      if (!Buffer.isBuffer(req.body)) throw new TeachingError('上传格式不正确');
      const uploadedBytes = await service.chunk({ workspaceId: a.scope.workspaceId, userId: a.fileUserId }, String(req.params.id), Number(req.query.offset), req.body);
      currentFile(await store.read(),a,String(req.params.id));
      res.json({ uploadedBytes });
    }));
    router.post(`${prefix}/uploads/:id/complete`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute), file = currentFile(await store.read(), a, String(req.params.id));
      if (!videoExtensions.has(path.extname(file.originalName).toLowerCase())) await service.complete({ workspaceId: a.scope.workspaceId, userId: a.fileUserId }, file.id);
      else if (file.status === 'uploading') {
        if (file.uploadedBytes !== file.size) throw new TeachingError('作业尚未上传完成');
        const handle = await fs.open(file.storagePath, 'r');
        const bytes = Buffer.alloc(16);
        try { await handle.read(bytes, 0, 16, 0); } finally { await handle.close(); }
        const valid = path.extname(file.originalName).toLowerCase() === '.webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : ['ftyp', 'moov', 'mdat', 'wide'].includes(bytes.subarray(4, 8).toString('ascii'));
        if (!valid) throw new TeachingError('文件内容与视频格式不一致，请重新选择原始视频');
        await store.mutate(db => {
          if (publicRoute) authTeachingSession(db, String(req.params.slug), token(req));
          const saved = currentFile(db, a, file.id);
          if (saved.uploadedBytes !== saved.size) throw new TeachingError('上传进度尚未确认');
          saved.status = 'ready'; saved.textChars = 0; saved.segmentCount = 0;
        });
      }
      currentFile(await store.read(),a,file.id);res.json({ ok: true });
    }));
    router.get(`${prefix}/uploads/:id`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute);
      res.json({ attachment: publicAttachmentSummary(currentFile(await store.read(), a, String(req.params.id))) });
    }));
    router.delete(`${prefix}/uploads/:id`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute);
      const file = await store.mutate(db => {
        if (publicRoute) authTeachingSession(db, String(req.params.slug), token(req));
        else ownedTeachingCourse(db, a.scope, a.course.id);
        const current = currentFile(db, a, String(req.params.id)), state = teachingState(db, a.scope), course = ownedTeachingCourse(db, a.scope, a.course.id);
        const references = (activity: TeachingCourse['activities'][number]) => activity.sourceAttachmentIds?.includes(current.id);
        if (course.materialAttachmentIds.includes(current.id) || course.activities.some(references)
          || state.submissions.some(submission => submission.courseId === course.id && (submission.attachmentIds.includes(current.id) || references(submission.activitySnapshot) || submission.gradingSnapshot && references(submission.gradingSnapshot)))
          || state.operations.some(operation => operation.courseId === course.id && operation.attachmentIds?.includes(current.id))) throw new TeachingError('附件已被课程、作业或学习记录使用，请保留原件', 409, 'TEACHING_FILE_REFERENCED');
        db.attachments = db.attachments.filter(value => value.id !== current.id); return current;
      });
      await removeAttachmentFiles(file.storagePath); res.json({ ok: true });
    }));
    if (!publicRoute) router.get(`${prefix}/uploads/:id/content`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, false), file = currentFile(await store.read(), a, String(req.params.id));
      if (file.status !== 'ready') throw new TeachingError('附件尚未处理完成', 404);
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.download(file.storagePath, file.originalName);
    }));
    router.get(`${prefix}/submissions/:submissionId/attachments/:attachmentId/content`, ...middleware, asyncRoute(async (req, res) => {
      const a = await access(req, publicRoute), db = await store.read();
      const currentCourse=assertAccess(db,a);
      const submission = teachingState(db, a.scope).submissions.find(s => s.id === req.params.submissionId && s.courseId === a.course.id && s.workspaceId === a.scope.workspaceId && s.userId === a.scope.userId && (!a.session || s.sessionId === a.session.id));
      if (submission && !currentCourse.activities.some(activity=>activity.id===submission.activityId&&!activity.deletedAt)) throw new TeachingError('活动已移入回收站',404);
      if(submission&&a.session)teachingSessionActivity(currentCourse,a.session,submission.activityId);
      const file = submission?.attachmentIds.includes(String(req.params.attachmentId)) && db.attachments.find(f => f.id === req.params.attachmentId && f.workspaceId === a.scope.workspaceId && f.userId === (submission.sessionId ?? a.scope.userId) && f.conversationId === teachingConversationId(a.course.id) && f.status === 'ready');
      if (!file) throw new TeachingError('未找到已提交给本课程的附件', 404);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.download(file.storagePath, file.originalName);
    }));
  }
  router.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof TeachingError ? error.status : 400).json({ error: error instanceof TeachingError ? error.message : '附件处理未完成，请检查文件后重试', code: error instanceof TeachingError ? error.code : 'TEACHING_FILE_FAILED' });
  });
  app.use('/api/teaching', router);
}
