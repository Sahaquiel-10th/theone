import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import { asyncRoute } from "./middleware.js";
import { FeatureConfigError, updateOfficialFeature } from "./officialFeatures.js";
import { uid } from "./security.js";

export function installOfficialFeatureRoutes(app: Express, admin: readonly RequestHandler[], store: Store) {
  const router=express.Router();
  router.use(...admin);
  router.use((_req,res,next)=>{res.setHeader("Cache-Control","no-store");next();});
  router.get("/",asyncRoute(async(req,res)=>{
    const q=String(req.query.q||"").slice(0,100).toLowerCase(), page=Math.max(1,Math.min(1000,Math.floor(Number(req.query.page)||1)));
    const items=((await store.read()).settings.officialFeatures??[]).filter(f=>`${f.id} ${f.draft.name} ${f.draft.author}`.toLowerCase().includes(q)).slice().reverse();
    res.json({total:items.length,items:items.slice((page-1)*10,page*10).map(f=>({id:f.id,name:f.draft.name,author:f.draft.author,revision:f.revision,status:f.status,version:f.current?.version??0,hasChanges:!!f.current&&JSON.stringify(f.current.values)!==JSON.stringify(f.draft)})),runtimeEnabled:false});
  }));
  router.get("/:id",asyncRoute(async(req,res)=>{
    const record=(await store.read()).settings.officialFeatures?.find(f=>f.id===req.params.id);
    if(!record)throw new FeatureConfigError("功能不存在",404);
    const page=Math.max(1,Math.min(1000,Math.floor(Number(req.query.page)||1)));
    res.json({...record,history:record.history.slice().reverse().slice((page-1)*5,page*5),total:record.history.length,runtimeEnabled:false});
  }));
  router.post("/:id",asyncRoute(async(req,res)=>{
    const revision=await store.mutate(db=>{
      const r=updateOfficialFeature(db.settings,String(req.params.id),req.body,req.user!.id,new Date().toISOString());
      db.auditLogs.push({id:uid("aud"),actorUserId:req.user!.id,action:`admin.official_feature.${req.body.action}`,targetType:"official_feature",targetId:r.id,details:{revision:r.revision,version:r.current?.version??0},createdAt:new Date().toISOString(),requestId:res.locals.requestId});
      return r.revision;
    });res.json({ok:true,revision});
  }));
  router.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(err instanceof FeatureConfigError){res.status(err.status).json({error:err.message});return;}
    _next(err);
  });
  app.use("/api/admin/official-features",router);
}
