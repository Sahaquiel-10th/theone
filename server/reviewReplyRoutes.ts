import express, { type Request, type RequestHandler, type Response } from 'express';
import { asyncRoute } from './middleware.js';
import { IndustryStore, IndustryError, assertIndustryActor, type IndustryActor } from './industryState.js';
import { IndustryModelError, industryChatModel } from './industryModel.js';
import { ReviewReplyService, type ReviewReplyDependencies } from './reviewReplies.js';
import { reviewReplyTemplates } from './reviewReplyTemplates.js';

export type ReviewReplyRouteDependencies = ReviewReplyDependencies & { verifyKey?: (req: Request) => Promise<void> };
export function createReviewReplyRouter(store: IndustryStore, keyAuth: readonly RequestHandler[], deps: ReviewReplyRouteDependencies = {}) {
  const router = express.Router(), service = new ReviewReplyService(store, deps);
  const ready = service.recover();
  void ready.catch(() => undefined);
  const actor = (req: Request): IndustryActor => {
    if (!req.user?.id || !req.workspaceId) throw new IndustryError('请登录后使用工作台', 401);
    return { id: req.user.id, workspaceId: req.workspaceId };
  };
  router.use('/review-replies', ...keyAuth, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    void ready.then(async () => {
      assertIndustryActor(await store.read(), actor(req));
      if (!['GET', 'HEAD'].includes(req.method)) await deps.verifyKey?.(req);
      next();
    }).catch(next);
  });
  const route = (action: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      if (error instanceof IndustryError || error instanceof IndustryModelError) return res.status(error.status).json({ error: error.message, code: error.code });
      return res.status(400).json({ error: error instanceof Error ? error.message.slice(0, 500) : '本次操作未完成，请查看原记录' });
    }
  });
  router.get('/review-replies/config', route(async (req, res) => {
    const user = actor(req), db = await store.read(); assertIndustryActor(db, user);
    let available = true;
    try { industryChatModel(db, { workspaceId: user.workspaceId, userId: user.id }); } catch { available = false; }
    res.json({ agentId: 'review_reply', ready: available, visionReady: available, message: available ? '' : '请管理员配置可用的文字与图片理解模型', templates: reviewReplyTemplates() });
  }));
  router.get('/review-replies/profiles', route(async (req, res) => { res.json({ profiles: await service.listProfiles(actor(req)) }); }));
  router.post('/review-replies/profiles', route(async (req, res) => { res.status(201).json({ profile: await service.saveProfile(actor(req), req.body.draft) }); }));
  router.get('/review-replies/profiles/:id', route(async (req, res) => { res.json({ profile: await service.getProfile(actor(req), String(req.params.id)) }); }));
  router.put('/review-replies/profiles/:id', route(async (req, res) => { res.json({ profile: await service.saveProfile(actor(req), req.body.draft, String(req.params.id), req.body.expectedRevision) }); }));
  router.delete('/review-replies/profiles/:id', route(async (req, res) => { res.json(await service.deleteProfile(actor(req), String(req.params.id))); }));
  router.post('/review-replies/profiles/:id/copy', route(async (req, res) => { res.status(201).json({ profile: await service.copyProfile(actor(req), String(req.params.id)) }); }));
  router.post('/review-replies/profiles/:id/restore', route(async (req, res) => { res.json({ profile: await service.restoreProfile(actor(req), String(req.params.id), req.body.revision, req.body.expectedRevision) }); }));
  router.get('/review-replies/profiles/:id/export', route(async (req, res) => {
    const output = await service.exportSkill(actor(req), String(req.params.id));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`);
    res.send(output.content);
  }));
  router.post('/review-replies/profiles/:id/rules', route(async (req, res) => { res.json({ profile: await service.addRule(actor(req), String(req.params.id), req.body) }); }));
  router.post('/review-replies/analyze', route(async (req, res) => { res.json(await service.analyze(actor(req), req.body)); }));
  router.post('/review-replies/recognize', route(async (req, res) => { res.json(await service.recognize(actor(req), req.body)); }));
  router.get('/review-replies/runs', route(async (req, res) => { res.json({ runs: await service.listRuns(actor(req)) }); }));
  router.get('/review-replies/runs/:id', route(async (req, res) => { res.json({ run: await service.getRun(actor(req), String(req.params.id)) }); }));
  router.post('/review-replies/runs', route(async (req, res) => {
    const run = await service.createRun(actor(req), req.body);
    res.status(run.status === 'generating' ? 202 : 201).json({ run });
  }));
  router.post('/review-replies/runs/:id/refine', route(async (req, res) => { res.json({ run: await service.refine(actor(req), String(req.params.id), req.body) }); }));
  router.post('/review-replies/runs/:id/edit', route(async (req, res) => { res.json({ run: await service.edit(actor(req), String(req.params.id), req.body) }); }));
  router.post('/review-replies/runs/:id/propose-rule', route(async (req, res) => { res.json(await service.proposeRule(actor(req), String(req.params.id), req.body)); }));
  router.use((error: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (error instanceof IndustryError || error instanceof IndustryModelError) res.status(error.status).json({ error: error.message, code: error.code });
    else next(error);
  });
  return router;
}
