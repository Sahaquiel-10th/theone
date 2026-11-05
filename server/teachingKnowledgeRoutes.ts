import express, { type Express, type Request, type RequestHandler } from 'express';
import type { Store } from './db.js';
import { canReadKnowledge } from './enterprisePolicy.js';
import { TeachingError, teachingMember, ownedTeachingCourse } from './teaching.js';
import {ownedTeachingActivity} from './teachingLifecycle.js';
import { assertTeachingKnowledgeSources, bindTeachingKnowledgeSources, readTeachingKnowledgeSources, type TeachingKnowledgeDependencies } from './teachingKnowledge.js';

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
      res.json({ connections: db.knowledgeConnections.filter(connection => connection.workspaceId === owner.workspaceId && ['connected','error'].includes(connection.status) && canReadKnowledge(db, owner, connection.id)).map(connection => {
        const names=connection.retrievalScope?.selectedIds?.map(id=>connection.retrievalScope?.knowledgeBases?.find(library=>library.id===id)?.name??'已选知识库')??[];
        return { id: connection.id, provider: connection.provider, label: (connection.providerSpaceName || connection.provider).slice(0, 160), pageSupported: connection.provider === 'notion', connectionStatus:connection.status, scopeDescription:connection.provider==='ima'?`个人笔记${names.length?`和已选择的 ${names.length} 个知识库：${names.join('、')}`:'；尚未选择文件知识库，请到知识连接中选择'}`.slice(0,400):'此连接当前已授权的可检索范围' };
      }) });
    } catch (error) { next(error); }
  });
  router.get('/status',...auth,async(req,res,next)=>{try{
    const owner=scope(req),db=await store.read(),course=ownedTeachingCourse(db,owner,String(req.query.courseId??''));if(req.query.activityId)ownedTeachingActivity(course,String(req.query.activityId));
    assertTeachingKnowledgeSources(db,owner,course.knowledgeSources??[]);
    if(req.query.purpose==='script'&&!(course.knowledgeSources??[]).length&&(course.sourceMode==='knowledge'||!course.materialText.trim()&&!course.materialAttachmentIds.length))throw new TeachingError('请先为课程关联可核对的知识库。',409,'TEACHING_KNOWLEDGE_REQUIRED');
    res.json({valid:true,sourceCount:course.knowledgeSources?.length??0});
  }catch(error){next(error);}});
  router.post('/select', ...auth, async(req,res,next)=>{try{await deps.verifyKey(req);const raw=req.body?.source;const source=bindTeachingKnowledgeSources(await store.read(),scope(req),[raw])[0];res.json({source:{...source,...(source.scope==='connection'&&raw?.confirmed===true?{confirmed:true}:{})}});}catch(error){next(error);}});
  router.post('/preview', ...auth, async (req, res, next) => {
    try {
      await deps.verifyKey(req);
      const owner = scope(req), db=await store.read();teachingMember(db,owner);
      const raw=req.body?.source;
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new TeachingError('请明确选择需要核对的知识来源');
      if(req.body?.courseId!==undefined&&(typeof req.body.courseId!=='string'||req.body.courseId.length>100)||req.body?.activityId!==undefined&&(typeof req.body.activityId!=='string'||!req.body.courseId))throw new TeachingError('请检查课程和工具编号');
      const course=req.body?.courseId?ownedTeachingCourse(db,owner,req.body.courseId):undefined;
      const activity=req.body?.activityId?ownedTeachingActivity(course!,req.body.activityId):undefined;
      // A source without a binding is a deliberate fresh selection. Saved-row
      // tests carry their server binding and may retain that exact prior grant.
      const previous=raw.binding===undefined?[]:activity?.knowledgeSources??course?.knowledgeSources??[];
      const source = bindTeachingKnowledgeSources(db, owner, [raw],previous)[0];
      const query=req.body?.query===undefined?'':req.body.query;
      if(typeof query!=='string'||query.length>6000)throw new TeachingError('试搜问题最多 6000 字');
      if(source.scope==='connection'&&!query.trim())throw new TeachingError('请填写本课程的问题或关键词，再试搜所选范围。',400,'TEACHING_KNOWLEDGE_QUERY_REQUIRED');
      const result = await readTeachingKnowledgeSources(store, owner, [source], query, { ...deps, verify: () => deps.verifyKey(req) });
      // Carry the user's explicit consent through the unsaved form. The final
      // course/activity binder strips this transient flag when persisting.
      res.json({ source:{...source,...(source.scope==='connection'&&raw.confirmed===true?{confirmed:true}:{})}, preview: { status:result.sources[0]?.status??'no_match',query:query.trim(),title: result.sources[0]?.title || source.label, text: result.text.length > 12_000 ? `${result.text.slice(0, 12_000)}\n【预览仅显示前 12000 字；正式使用会读取所选范围】` : result.text } });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof TeachingError ? error.status : 400).json({ error: error instanceof TeachingError ? error.message : '教学资料暂未读取成功，请检查连接后重试。', code: error instanceof TeachingError ? error.code : 'TEACHING_KNOWLEDGE_FAILED' });
  });
  app.use('/api/teaching/knowledge', router);
}
