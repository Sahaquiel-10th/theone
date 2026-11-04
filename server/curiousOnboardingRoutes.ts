import express, { type Express, type RequestHandler } from 'express';
import type { Store } from './db.js';
import { accountInScope, accountProfile, type AccountScope } from './betaProfile.js';
import { asyncRoute } from './middleware.js';
import { curiousOnboardingView, updateCuriousOnboarding, type CuriousDependencies, type CuriousOnboardingInput } from './curiousOnboarding.js';
import { startOnboardingHandbook } from './onboardingHandbook.js';
import type { OnboardingProfileDependencies } from './onboardingRoutes.js';

export function installCuriousOnboardingRoutes(app:Express,keyAuth:readonly RequestHandler[],store:Store,deps:OnboardingProfileDependencies & {curiousGenerate?:CuriousDependencies['generate']}){
  const router=express.Router();router.use(...keyAuth);
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const scope=(req:express.Request):AccountScope=>({workspaceId:req.workspaceId!,userId:req.user!.id});
  router.get('/',asyncRoute(async(req,res)=>{await deps.verifyKey(req);res.json(curiousOnboardingView(await store.read(),scope(req),deps.storageAvailable));}));
  router.post('/',asyncRoute(async(req,res)=>{
    const s=scope(req),view=await updateCuriousOnboarding(store,s,req.body as CuriousOnboardingInput,{storageAvailable:deps.storageAvailable,verifyKey:()=>deps.verifyKey(req),generate:deps.curiousGenerate});
    let notice=view.notice;
    // Collection and delivery have separate lifecycles. A concurrent restart
    // may archive the finished session before its already authorized handoff.
    // Keep that original handoff, while restart itself never queues work.
    const db=await store.read(),p=accountProfile(db,s),h=p.onboarding.handbook;
    const guideOwner=[p.onboarding.curious,...(p.onboarding.curious?.history??[])].find(session=>session?.status==='completed'&&session.guideOperationId===h?.operationId);
    // The frozen snapshot remains the authorization receipt for old records
    // created before recoverable conversation history was available.
    if(req.body.action!=='restart'&&(guideOwner||h?.guideSnapshot?.curiosity)&&h?.status==='pending'){
      try {
        const delivery=await startOnboardingHandbook(store,s,{storageAvailable:deps.storageAvailable,verifyKey:()=>deps.verifyKey(req),enqueueImage:deps.enqueueImage});
        notice=delivery.notice??notice;
        if(delivery.handbook?.status==='queued')void deps.resume(s,()=>deps.verifyKey(req)).catch(()=>{});
      }catch{
        await store.mutate(current=>{const user=accountInScope(current,s),profile=accountProfile(current,s),marker=profile.onboarding.handbook;if(marker?.operationId!==h.operationId||marker.status!=='pending')return;
          const accepted=current.chatOperations?.some(op=>op.workspaceId===s.workspaceId&&op.userId===s.userId&&op.operationId===`${h.operationId}_image`&&op.workRun?.kind==='image');
          if(!accepted){marker.status='failed';marker.reason='unavailable';marker.updatedAt=new Date().toISOString();user.profile=profile;}});
        notice='认识你的内容已经保存。使用说明这次没交接好，不会自动重复制作；你可以先照常聊天。';
      }
    }
    res.json(curiousOnboardingView(await store.read(),s,deps.storageAvailable,notice));
  }));
  app.use('/api/me/profile/curious-onboarding',router);
}
