import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import type { OneKeyService } from "./oneKeyService.js";
import { asyncRoute } from "./middleware.js";
import { CompanyError, addCompanyMember, companyManager, companySummary, createCompany, platformOperator, recordBankTransfer, updateCompanyMember } from "./companyService.js";
import { releaseCompanyFeature } from "./featureRuns.js";
import { uid } from "./security.js";
import { FeatureConfigError } from "./officialFeatures.js";

export function installCompanyRoutes(app: Express, keyAuth: readonly RequestHandler[], admin: readonly RequestHandler[], store: Store, keys: Pick<OneKeyService,"provision"|"revoke">) {
  const platform=express.Router(); platform.use(...admin);
  const company=express.Router(); company.use(...keyAuth);
  for(const router of [platform,company])router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  platform.get('/',asyncRoute(async(_req,res)=>{const db=await store.read();res.json({items:db.workspaces.filter(w=>w.kind==='company').map(w=>({id:w.id,name:w.name,status:w.status,revision:w.revision,agreementRef:w.company?.agreementRef,members:db.workspaceMembers.filter(m=>m.workspaceId===w.id&&m.status!=='disabled').length}))});}));
  platform.post('/',asyncRoute(async(req,res)=>{res.status(201).json(await store.mutate(db=>createCompany(db,req.user!.id,req.body)));}));
  platform.get('/:id',asyncRoute(async(req,res)=>{res.json(companySummary(await store.read(),String(req.params.id)));}));
  platform.patch('/:id',asyncRoute(async(req,res)=>{
    await store.mutate(db=>{platformOperator(db,req.user!.id);const w=db.workspaces.find(w=>w.id===req.params.id&&w.kind==='company');if(!w)throw new CompanyError('公司不存在',404);if(req.body.revision!==w.revision)throw new CompanyError('公司配置已更新，请刷新',409);if(!['active','suspended'].includes(req.body.status))throw new CompanyError('状态无效');w.status=req.body.status;w.revision=(w.revision??0)+1;w.updatedAt=new Date().toISOString();db.auditLogs.push({id:uid('aud'),workspaceId:w.id,actorUserId:req.user!.id,action:'company.status.updated',targetType:'company',targetId:w.id,details:{status:w.status},createdAt:w.updatedAt});});res.json({ok:true});
  }));
  platform.post('/:id/payments',asyncRoute(async(req,res)=>{res.json(await store.mutate(db=>recordBankTransfer(db,{workspaceId:String(req.params.id),userId:req.user!.id},req.body)));}));
  platform.get('/:id/features',asyncRoute(async(req,res)=>{
    const db=await store.read();companySummary(db,String(req.params.id));
    res.json({items:(db.settings.officialFeatures??[]).filter(f=>f.status==='approved'&&f.current&&(!f.workspaceId||f.workspaceId===req.params.id)).map(f=>({id:f.id,name:f.current!.values.name,revision:f.revision,version:f.current!.version,enabled:!!f.companyReleases?.some(r=>r.workspaceId===req.params.id)}))});
  }));
  platform.post('/:id/features/:featureId',asyncRoute(async(req,res)=>{
    await store.mutate(db=>{if(typeof req.body.enabled!=='boolean')throw new CompanyError('开放状态无效');releaseCompanyFeature(db,String(req.params.featureId),String(req.params.id),{revision:req.body.revision,enabled:req.body.enabled,version:req.body.version},req.user!.id);
    });res.json({ok:true});
  }));
  function memberRoutes(router: express.Router, isPlatform: boolean) {
    const s=(req:express.Request)=>({workspaceId:isPlatform?String(req.params.id):req.workspaceId!,userId:req.user!.id});
    const base=isPlatform?'/:id':'';
    router.post(base+'/members',asyncRoute(async(req,res)=>{res.status(201).json(await store.mutate(db=>addCompanyMember(db,s(req),req.body,isPlatform)));}));
    router.patch(base+'/members/:userId',asyncRoute(async(req,res)=>{res.json(await store.mutate(db=>updateCompanyMember(db,s(req),String(req.params.userId),req.body,isPlatform)));}));
    router.post(base+'/keys',asyncRoute(async(req,res)=>{
      const scope=s(req),db=await store.read();if(isPlatform){platformOperator(db,scope.userId);companySummary(db,scope.workspaceId);}else companyManager(db,scope);
      const userId=req.body.userId,serialNumber=req.body.serialNumber;
      if(typeof userId!=='string'||typeof serialNumber!=='string'||!/^[-A-Za-z0-9_]{3,80}$/.test(serialNumber))throw new CompanyError('请选择员工并填写 3–80 位 Key 序列号');
      if(!db.workspaceMembers.some(m=>m.workspaceId===scope.workspaceId&&m.userId===userId&&m.status!=='disabled'))throw new CompanyError('员工不属于此公司',403);
      res.status(201).json(await keys.provision({workspaceId:scope.workspaceId,userId,serialNumber},db=>{if(isPlatform)platformOperator(db,scope.userId);else companyManager(db,scope);}));
    }));
    router.post(base+'/keys/:deviceId/revoke',asyncRoute(async(req,res)=>{
      const scope=s(req),db=await store.read();if(isPlatform)platformOperator(db,scope.userId);else companyManager(db,scope);
      if(!db.oneKeyDevices.some(d=>d.id===req.params.deviceId&&d.workspaceId===scope.workspaceId))throw new CompanyError('Key 不属于此公司',404);
      await keys.revoke(String(req.params.deviceId),db=>{if(isPlatform)platformOperator(db,scope.userId);else companyManager(db,scope);if(!db.oneKeyDevices.some(d=>d.id===req.params.deviceId&&d.workspaceId===scope.workspaceId))throw new CompanyError('Key 不属于此公司',404);});res.json({ok:true});
    }));
  }
  memberRoutes(platform,true);memberRoutes(company,false);
  company.get('/',asyncRoute(async(req,res)=>{const db=await store.read();companyManager(db,{workspaceId:req.workspaceId!,userId:req.user!.id});res.json(companySummary(db,req.workspaceId!));}));
  for(const router of [platform,company])router.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(error instanceof CompanyError || error instanceof FeatureConfigError)res.status(error.status).json({error:error.message});else res.status(400).json({error:'企业操作未完成，请刷新后检查权限及输入'});});
  app.use('/api/admin/companies',platform);app.use('/api/company',company);
}
