import express, { type Express, type Request, type RequestHandler } from 'express';
import type { Store } from './db.js';
import { canReadKnowledge } from './enterprisePolicy.js';
import { TeachingError, teachingMember } from './teaching.js';
import { bindTeachingKnowledgeSources, readTeachingKnowledgeSources, type TeachingKnowledgeDependencies } from './teachingKnowledge.js';

export type TeachingKnowledgeRouteDependencies = Omit<TeachingKnowledgeDependencies, 'verify'> & { verifyKey: (request: Request) => Promise<void> };
export function installTeachingKnowledgeRoutes(app: Express, auth: readonly RequestHandler[], store: Store, deps: TeachingKnowledgeRouteDependencies) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  function scope(req: Request) {
    if (!req.user?.id || !req.workspaceId) throw new TeachingError('请登录后选择教学资料。', 401);
    return { workspaceId: req.workspaceId, userId: req.user.id };
  }
  router.get('/connections', ...auth, async (req, res, next) => {
    try {
      const owner = scope(req), db = await store.read(); teachingMember(db, owner);
      res.json({ connections: db.knowledgeConnections.filter(connection => connection.workspaceId === owner.workspaceId && connection.status === 'connected' && canReadKnowledge(db, owner, connection.id)).map(connection => ({ id: connection.id, provider: connection.provider, label: (connection.providerSpaceName || connection.provider).slice(0, 160), pageSupported: connection.provider === 'notion' })) });
    } catch (error) { next(error); }
  });
  router.post('/preview', ...auth, async (req, res, next) => {
    try {
      await deps.verifyKey(req);
      const owner = scope(req), source = bindTeachingKnowledgeSources(await store.read(), owner, [req.body?.source])[0];
      const query = req.body?.query === undefined ? '课程资料' : req.body.query;
      const result = await readTeachingKnowledgeSources(store, owner, [source], query, { ...deps, verify: () => deps.verifyKey(req) });
      res.json({ source, preview: { title: result.sources[0]?.title || source.label, text: result.text.length > 12_000 ? `${result.text.slice(0, 12_000)}\n【预览仅显示前 12000 字；正式使用会读取所选范围】` : result.text || '本次未找到匹配内容；没有读取其他知识来源。' } });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof TeachingError ? error.status : 400).json({ error: error instanceof TeachingError ? error.message : '教学资料暂未读取成功，请检查连接后重试。', code: error instanceof TeachingError ? error.code : 'TEACHING_KNOWLEDGE_FAILED' });
  });
  app.use('/api/teaching/knowledge', router);
}
