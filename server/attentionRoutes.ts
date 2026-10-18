import type {Express,Request,RequestHandler} from 'express';
import type {Store} from './db.js';
import {asyncRoute} from './middleware.js';
import {featureMember} from './featureRuns.js';
import {validTimeZone,runtimeContext} from './runtimeContext.js';
import type {AttentionService} from './attention.js';

export function installAttentionRoutes(app:Express,auth:readonly RequestHandler[],store:Store,attention:AttentionService,verify:(req:Request)=>Promise<void>){
  const scope=(req:Request)=>({workspaceId:req.workspaceId!,userId:req.user!.id});
  app.get('/api/me/context-preferences',...auth,asyncRoute(async(req,res)=>{
    const db=await store.read(),s=scope(req);featureMember(db,s);
    const saved=db.users.find(u=>u.id===s.userId)!.contextPreferences?.find(p=>p.workspaceId===s.workspaceId&&p.userId===s.userId);
    res.json({saved:saved?{timeZone:saved.timeZone,city:saved.city}:null,current:runtimeContext(db,s,undefined,req.get('X-ONE-Time-Zone'))});
  }));
  app.post('/api/me/context-preferences',...auth,asyncRoute(async(req,res)=>{
    await verify(req);const s=scope(req),v=req.body;
    if(!validTimeZone(v?.timeZone)||typeof v.city!=='string'||v.city.length>60||/[\r\n\x00-\x1f]/.test(v.city))throw new Error('请检查时区和常驻城市，城市最多 60 字');
    await store.mutate(db=>{featureMember(db,s);const u=db.users.find(u=>u.id===s.userId)!;u.contextPreferences=[...(u.contextPreferences??[]).filter(p=>p.workspaceId!==s.workspaceId),{...s,timeZone:v.timeZone,city:v.city.trim()}];for(const c of u.attentionStates??[])if(c.workspaceId===s.workspaceId){c.timeZone=v.timeZone;c.revision++;delete c.lease;}});
    res.json({ok:true});
  }));
  app.get('/api/attention',...auth,asyncRoute(async(req,res)=>res.json({...await attention.view(scope(req)),timeZone:runtimeContext(await store.read(),scope(req),undefined,req.get('X-ONE-Time-Zone')).timeZone})));
  app.post('/api/attention/settings',...auth,asyncRoute(async(req,res)=>{await verify(req);res.json(await attention.configure(scope(req),req.body,{deviceId:req.oneKeyDeviceId!,installationId:req.oneKeyInstallationId}));}));
  app.post('/api/attention/check',...auth,asyncRoute(async(req,res)=>{await verify(req);const s=scope(req),queued=await attention.requestCheck(s);res.status(202).json(await attention.view(s));if(queued)void attention.check(s,true).catch(()=>{});}));
  app.post('/api/attention/notices/:id',...auth,asyncRoute(async(req,res)=>{
    const action=req.body?.action;if(!['read','snooze','all'].includes(action))throw new Error('请选择提醒操作');
    await verify(req);res.json(await attention.acknowledge(scope(req),String(req.params.id),action));
  }));
}
