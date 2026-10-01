import express,{type Express,type RequestHandler} from 'express';
import type {Store} from './db.js';
import type {KnowledgeService} from './knowledge/knowledgeService.js';
import {asyncRoute} from './middleware.js';
import {apiGrantView,authenticateApi,issueApiGrant} from './publicApi.js';
import {beginPublicRun,ownedPublication,publicRun,SharingError,usageFor} from './publicSharing.js';
import {executePublicQuestion} from './publicSharingRoutes.js';
import {uid} from './security.js';
export function installPublicApiRoutes(app:Express,keyAuth:readonly RequestHandler[],store:Store,knowledge:Pick<KnowledgeService,'recallWithDiagnostics'>,call?:Parameters<typeof executePublicQuestion>[3]){
  const management=express.Router();management.use(...keyAuth);
  management.get('/:id/keys',asyncRoute(async(req,res)=>{
    const db=await store.read(),p=ownedPublication(db,req.workspaceId!,req.user!.id,String(req.params.id)),page=Math.max(1,Math.floor(Number(req.query.page)||1));
    const items=(p.apiGrants??[]).slice().reverse();res.json({items:items.slice((page-1)*5,page*5).map(g=>apiGrantView(db,p,g)),total:items.length});
  }));
  management.post('/:id/keys',asyncRoute(async(req,res)=>res.json(await store.mutate(db=>issueApiGrant(db,{workspaceId:req.workspaceId!,userId:req.user!.id},String(req.params.id),req.body)))));
  management.post('/:id/keys/:grantId/revoke',asyncRoute(async(req,res)=>{
    await store.mutate(db=>{const p=ownedPublication(db,req.workspaceId!,req.user!.id,String(req.params.id)),g=p.apiGrants?.find(g=>g.id===req.params.grantId);if(!g)throw new SharingError('密钥不存在',404);g.status='revoked';g.revokedAt=new Date().toISOString();db.auditLogs.push({id:uid('aud'),workspaceId:p.workspaceId,actorUserId:req.user!.id,action:'publication.api.revoked',targetType:'publication',targetId:p.id,details:{grantId:g.id},createdAt:g.revokedAt});});res.json({ok:true});
  }));
  const errors=(e:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(e instanceof SharingError?e.status:400).json({error:e instanceof SharingError?e.message:'任务暂不可用，请保留编号后查询'});
  management.use(errors);app.use('/api/sharing-api/manage',management);
  const router=express.Router();
  const token=(req:express.Request)=>req.headers.authorization?.replace(/^Bearer /,'')??'';
  router.post('/tasks',asyncRoute(async(req,res)=>{
    const result=await store.mutate(db=>{const {publication,session}=authenticateApi(db,token(req));return beginPublicRun(db,publication,session,{content:req.body?.question,operationId:req.body?.operationId,attachmentIds:[]});});
    res.status(result.created?202:200).json({task:publicRun(result.run)});
    if(result.created)void executePublicQuestion(store,knowledge,result.run.id,call).catch(()=>{});
  }));
  router.get('/tasks/:id',asyncRoute(async(req,res)=>{
    const db=await store.read(),{publication:p,session:s,grant:g}=authenticateApi(db,token(req));
    const r=db.publicRuns!.find(r=>r.id===req.params.id&&r.publicationId===p.id&&r.sessionId===s.id&&r.apiGrantId===g.id&&r.workspaceId===p.workspaceId);
    if(!r)throw new SharingError('任务不存在',404);res.json({task:{...publicRun(r),version:r.publicationVersion??1,...usageFor(db,p,r.id)}});
  }));
  router.post('/tasks/:id/cancel',asyncRoute(async(req,res)=>{
    await store.mutate(db=>{const {publication:p,session:s,grant:g}=authenticateApi(db,token(req));const r=db.publicRuns!.find(r=>r.id===req.params.id&&r.publicationId===p.id&&r.sessionId===s.id&&r.apiGrantId===g.id&&r.workspaceId===p.workspaceId);if(!r)throw new SharingError('任务不存在',404);if(r.status==='running'){r.status='failed';r.completedAt=new Date().toISOString();r.error='任务已取消；已经产生的用量仍记录，不会自动重跑';}});res.json({ok:true});
  }));router.use(errors);app.use('/api/v1',router);
}
