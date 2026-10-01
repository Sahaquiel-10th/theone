import express,{type Express,type RequestHandler} from 'express';
import type {Store} from './db.js';
import {asyncRoute} from './middleware.js';
import {commercePolicy,grantSponsorship,sponsorshipView} from './publicCommerce.js';
import {ownedPublication,SharingError} from './publicSharing.js';
import {uid} from './security.js';
export function installPublicCommerceRoutes(app:Express,keyAuth:readonly RequestHandler[],admin:readonly RequestHandler[],store:Store){
  const errors=(e:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(e instanceof SharingError?e.status:400).json({error:e instanceof SharingError?e.message:'未能保存，请刷新后重试'});
  const policy=express.Router();policy.use(...admin);
  policy.get('/',asyncRoute(async(_req,res)=>res.json(commercePolicy(await store.read()))));
  policy.post('/',asyncRoute(async(req,res)=>{
    const result=await store.mutate(db=>{const old=commercePolicy(db),b=req.body;if(b?.revision!==old.revision)throw new SharingError('计费政策已变更，请重新打开',409);
      if(b.confirmed!==true||typeof b.visitorPaymentsEnabled!=='boolean'||!Number.isInteger(b.publisherSharePercent)||b.publisherSharePercent<0||b.publisherSharePercent>100)throw new SharingError('请配置发布者获得加价收益的 0–100% 并明确确认');
      const next={revision:old.revision+1,visitorPaymentsEnabled:b.visitorPaymentsEnabled,publisherShareBps:b.publisherSharePercent*100};db.settings.publicCommercePolicy=next;
      db.auditLogs.push({id:uid('aud'),actorUserId:req.user!.id,action:'public_commerce.policy.updated',targetType:'settings',details:next,createdAt:new Date().toISOString()});return next;});res.json(result);
  }));policy.use(errors);app.use('/api/admin/public-commerce',policy);
  const owner=express.Router();owner.use(...keyAuth);
  const page=(value:unknown)=>Math.max(1,Math.min(100000,Math.floor(Number(value)||1)));
  owner.get('/:id/sponsorships',asyncRoute(async(req,res)=>{const db=await store.read(),p=ownedPublication(db,req.workspaceId!,req.user!.id,String(req.params.id)),items=sponsorshipView(db,p).reverse(),n=page(req.query.page);res.json({items:items.slice((n-1)*5,n*5),total:items.length});}));
  owner.post('/:id/sponsorships',asyncRoute(async(req,res)=>res.json(await store.mutate(db=>grantSponsorship(db,{workspaceId:req.workspaceId!,userId:req.user!.id},String(req.params.id),req.body)))));
  owner.post('/:id/sponsorships/:grantId/revoke',asyncRoute(async(req,res)=>{await store.mutate(db=>{const p=ownedPublication(db,req.workspaceId!,req.user!.id,String(req.params.id)),g=p.sponsorships?.find(g=>g.id===req.params.grantId);if(!g)throw new SharingError('赠送额度不存在',404);g.status='revoked';db.auditLogs.push({id:uid('aud'),workspaceId:p.workspaceId,actorUserId:p.userId,action:'publication.sponsorship.revoked',targetType:'publication',targetId:p.id,details:{grantId:g.id},createdAt:new Date().toISOString()});});res.json({ok:true});}));
  owner.get('/:id/earnings',asyncRoute(async(req,res)=>{
    const db=await store.read(),p=ownedPublication(db,req.workspaceId!,req.user!.id,String(req.params.id));
    const rows=db.modelUsageRecords.filter(r=>r.workspaceId===p.workspaceId&&r.userId===p.userId&&r.commercial?.snapshot.publicationId===p.id).slice().reverse(),n=page(req.query.page);
    res.json({total:rows.length,pendingRevenueMicros:rows.reduce((sum,r)=>sum+(r.commercial?.publisherRevenueMicros??0),0),items:rows.slice((n-1)*10,n*10).map(r=>({id:r.id,createdAt:r.createdAt,status:r.status,model:r.modelNameSnapshot,version:r.commercial!.snapshot.publicationVersion,platformFeeMicros:r.chargedMicros??0,visitorChargeMicros:r.commercial!.payerChargedMicros??0,paidPrincipalMicros:r.commercial!.paidPrincipalMicros??0,bonusMicros:r.commercial!.bonusMicros??0,publisherSubsidyMicros:r.commercial!.publisherChargedMicros??0,publisherRevenueMicros:r.commercial!.publisherRevenueMicros??0,platformRevenueMicros:r.commercial!.platformRevenueMicros??0}))});
  }));owner.use(errors);app.use('/api/sharing-commerce/manage',owner);
}
