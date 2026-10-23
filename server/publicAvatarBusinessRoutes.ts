import type express from 'express';
import type { RequestHandler } from 'express';
import type { Store } from './db.js';
import { asyncRoute } from './middleware.js';
import { activePublication, ownedPublication, SharingError } from './publicSharing.js';
import type { Publication, PublicSession } from './publicSharingTypes.js';
import { issueServiceCode, listAvatarLeads, redeemServiceCode, revokeServiceGrant, serviceManagement, servicePublicSnapshot, submitAvatarLead } from './publicAvatarBusiness.js';

export function installPublicAvatarBusinessRoutes(router:express.Router,keyAuth:readonly RequestHandler[],store:Store,authGuest:(req:express.Request)=>Promise<{publication:Publication;session:PublicSession}>){
  const scope=(req:express.Request)=>({workspaceId:req.workspaceId!,userId:req.user!.id});
  router.get('/manage/:id/service',...keyAuth,asyncRoute(async(req,res)=>{
    const db=await store.read(),s=scope(req),p=ownedPublication(db,s.workspaceId,s.userId,String(req.params.id));
    res.setHeader('Cache-Control','no-store');res.json(serviceManagement(db,s,p));
  }));
  router.post('/manage/:id/service/codes',...keyAuth,asyncRoute(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.json(await store.mutate(db=>{const s=scope(req),p=ownedPublication(db,s.workspaceId,s.userId,String(req.params.id));return issueServiceCode(db,s,p,req.body);}));
  }));
  for(const kind of ['codes','grants'])router.post(`/manage/:id/service/${kind}/:grantId/revoke`,...keyAuth,asyncRoute(async(req,res)=>{
    await store.mutate(db=>{const s=scope(req),p=ownedPublication(db,s.workspaceId,s.userId,String(req.params.id));revokeServiceGrant(db,s,p,String(req.params.grantId));});res.json({ok:true});
  }));
  router.get('/manage/:id/leads',...keyAuth,asyncRoute(async(req,res)=>{
    const db=await store.read(),s=scope(req),p=ownedPublication(db,s.workspaceId,s.userId,String(req.params.id));res.setHeader('Cache-Control','no-store');res.json(listAvatarLeads(db,s,p));
  }));
  router.get('/:slug/service',asyncRoute(async(req,res)=>{
    const scoped=req.headers.authorization?await authGuest(req):undefined,db=await store.read();
    const p=scoped?.publication??db.publications?.find(p=>p.slug===req.params.slug);
    if(!p)throw new SharingError('分身不存在',404);
    activePublication(db,p.id);res.setHeader('Cache-Control','no-store');res.json(servicePublicSnapshot(db,p,scoped?.session));
  }));
  router.post('/:slug/service/redeem',asyncRoute(async(req,res)=>{
    const {publication:p,session:s}=await authGuest(req);
    const result=await store.mutate(db=>redeemServiceCode(db,p,s,req.body?.code));res.setHeader('Cache-Control','no-store');res.json(result);
  }));
  router.post('/:slug/leads',asyncRoute(async(req,res)=>{
    const {publication:p,session:s}=await authGuest(req);res.json(await store.mutate(db=>submitAvatarLead(db,p,s,req.body)));
  }));
}
