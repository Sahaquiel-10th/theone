import express, { type Express, type Request, type RequestHandler } from 'express';
import fs from 'node:fs';
import type { Store } from './db.js';
import { AttachmentService, ATTACHMENT_CHUNK_BYTES, removeAttachmentFiles } from './attachmentService.js';
import { asyncRoute } from './middleware.js';
import { publicAttachmentSummary } from './conversationAttachments.js';
import { industryRetailPricing } from './industryModel.js';
import { IndustryError, IndustryStore, INDUSTRY_CID, assertIndustryActor, createIndustryUsageSession, industryScope, industryUsage,
  privateIndustryState, readIndustryOperation, readIndustryReceipt, recoverIndustryOperations, industryAttachmentReferenced, type IndustryActor } from './industryState.js';

const actorOf = (req: Request): IndustryActor => ({ id: req.user!.id, workspaceId: req.workspaceId! });
export function installIndustryRoutes(app: Express, auth: readonly RequestHandler[], store: Store, files: AttachmentService, options: { verifyKey: (req: Request) => Promise<void>; storageAvailable: boolean }) {
  const industry = new IndustryStore(store), router = express.Router(), ready = recoverIndustryOperations(industry);
  router.use(...auth, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); void ready.then(() => next(), next); });
  router.get('/config', asyncRoute(async (req, res) => {
    const db = await store.read(), actor = actorOf(req); assertIndustryActor(db, actor);
    res.json({ pricing: industryRetailPricing(db, industryScope(actor), options.storageAvailable) });
  }));
  router.post('/usage-sessions', asyncRoute(async (req, res) => {
    await options.verifyKey(req);
    if (!req.oneKeyDeviceId) throw new IndustryError('请使用 ONE Key 进入并确认用量', 428, 'ONE_KEY_REQUIRED');
    const session = await store.mutate(db => createIndustryUsageSession(db, actorOf(req), req.body ?? {}, { keyDeviceId: req.oneKeyDeviceId }));
    res.status(201).json({ session: { id: session.id, tool: session.tool, budgetMicros: session.budgetMicros, createdAt: session.createdAt, expiresAt: session.expiresAt }, usedMicros: 0 });
  }));
  router.get('/usage-sessions/:id', asyncRoute(async (req, res) => {
    const db = await store.read(), actor = actorOf(req), scope = industryScope(actor);
    const session = privateIndustryState(db, actor)?.usageSessions.find(item => item.id === req.params.id && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
    if (!session) throw new IndustryError('未找到本轮用量确认', 404);
    res.json({ session: { id: session.id, tool: session.tool, budgetMicros: session.budgetMicros, createdAt: session.createdAt, expiresAt: session.expiresAt }, usedMicros: industryUsage(db, scope, session) });
  }));
  router.get('/operations/:id', asyncRoute(async (req, res) => {
    const operation = readIndustryOperation(await store.read(), actorOf(req), String(req.params.id));
    const { workspaceId: _workspace, userId: _user, payloadHash: _hash, ...safe } = operation;
    res.json({ operation: safe });
  }));
  router.get('/receipts/:requestKey', asyncRoute(async (req, res) => {
    const receipt = readIndustryReceipt(await store.read(), actorOf(req), String(req.params.requestKey), { tool: req.query.tool, path: req.query.path });
    res.json({ receipt });
  }));
  const fileAccess = async (req: Request) => {
    const db = await store.read(), actor = actorOf(req); assertIndustryActor(db, actor);
    const file = db.attachments.find(item => item.id === req.params.id && item.workspaceId === actor.workspaceId && item.userId === actor.id && item.conversationId === INDUSTRY_CID);
    if (!file) throw new IndustryError('未找到本工作台的附件', 404, 'INDUSTRY_FILE_NOT_FOUND');
    return file;
  };
  router.post('/files/uploads', asyncRoute(async (req, res) => {
    const actor = actorOf(req); assertIndustryActor(await store.read(), actor);
    const input = req.body ?? {};
    const file = await files.create(industryScope(actor), input.name, input.size, input.mimeType);
    try {
      await store.mutate(db => { assertIndustryActor(db, actor); const saved = db.attachments.find(item => item.id === file.id && item.workspaceId === actor.workspaceId && item.userId === actor.id); if (!saved) throw new IndustryError('附件上传状态已变化', 409); saved.conversationId = INDUSTRY_CID; });
    } catch (error) {
      await store.mutate(db => { db.attachments = db.attachments.filter(item => item.id !== file.id); });
      await removeAttachmentFiles(file.storagePath); throw error;
    }
    res.status(201).json({ attachment: publicAttachmentSummary(file), chunkBytes: ATTACHMENT_CHUNK_BYTES });
  }));
  router.put('/files/:id/chunks', express.raw({ type: 'application/octet-stream', limit: ATTACHMENT_CHUNK_BYTES }), asyncRoute(async (req, res) => {
    await fileAccess(req);
    if (!Buffer.isBuffer(req.body)) throw new IndustryError('上传内容无效');
    res.json({ uploadedBytes: await files.chunk(industryScope(actorOf(req)), String(req.params.id), Number(req.query.offset), req.body) });
  }));
  router.post('/files/:id/complete', asyncRoute(async (req, res) => { await fileAccess(req); await files.complete(industryScope(actorOf(req)), String(req.params.id)); res.json({ ok: true }); }));
  router.post('/files/:id/retry', asyncRoute(async (req, res) => { await fileAccess(req); await files.retry(industryScope(actorOf(req)), String(req.params.id)); res.json({ ok: true }); }));
  router.get('/files/:id', asyncRoute(async (req, res) => { res.json({ attachment: publicAttachmentSummary(await fileAccess(req)) }); }));
  router.get('/files/:id/content', asyncRoute(async (req, res) => {
    const file = await fileAccess(req);
    if (file.status !== 'ready' || !fs.existsSync(file.storagePath)) throw new IndustryError('附件尚未就绪', 404);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
    fs.createReadStream(file.storagePath).on('error', () => res.destroy()).pipe(res);
  }));
  router.delete('/files/:id', asyncRoute(async (req, res) => {
    const file = await fileAccess(req), scope = industryScope(actorOf(req));
    await store.mutate(db => { assertIndustryActor(db, actorOf(req)); if (industryAttachmentReferenced(db, scope, file.id)) throw new IndustryError('附件仍被工作台记录使用，请保留原件', 409); db.attachments = db.attachments.filter(item => item.id !== file.id); });
    await removeAttachmentFiles(file.storagePath); res.json({ ok: true });
  }));
  router.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof IndustryError ? error.status : 400).json({ error: error instanceof IndustryError ? error.message : '工作台操作暂未完成，请核对原记录后继续', code: error instanceof IndustryError ? error.code : 'INDUSTRY_FAILED' });
  });
  app.use('/api/industry', router);
  return industry;
}
