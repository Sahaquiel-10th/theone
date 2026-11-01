import type {Database} from './types.js';
import {activeMember} from './enterprisePolicy.js';
import {localExecutionBlocker} from './executionService.js';
import {validInstallationId} from './oneKeyInstallation.js';
import {localDeviceReadinessReason,parseLocalDeviceReadiness,type LocalDeviceReadiness} from '../src/localDeviceReadiness.js';
import type {Express,Request,RequestHandler} from 'express';
import {asyncRoute} from './middleware.js';

export type LocalDeviceReadinessScope={workspaceId:string;userId:string;deviceId:string;installationId?:string};
export type ReadinessExecutorProbe={available:boolean;preparing?:boolean;installedVersion?:string;installedSource?:'existing'|'managed'|'builtin';error?:string};
export type LocalDeviceReadinessDependencies={
  authorize:(scope:LocalDeviceReadinessScope)=>Promise<{busy:boolean}>;
  /** Opaque exact authenticated socket, never serialized into the owner response. */
  connectionToken:(scope:LocalDeviceReadinessScope)=>object|undefined;
  probeFolder:(scope:LocalDeviceReadinessScope,signal:AbortSignal)=>Promise<{targetName?:string}>;
  probeExecutor:(scope:LocalDeviceReadinessScope,signal:AbortSignal)=>Promise<ReadinessExecutorProbe>;
  metadata?:(scope:LocalDeviceReadinessScope)=>{platform:'macos'|'windows'|'unknown';capabilities:{staticPreview:boolean;taskDirectoryBinding:boolean}};
  now?:()=>number;timeoutMs?:number;ttlMs?:number;
};
export function assertLocalDeviceReadinessScope(db:Database,scope:LocalDeviceReadinessScope):{busy:boolean} {
  if(!validInstallationId(scope.installationId)||!db.users.some(u=>u.id===scope.userId&&u.enabled)
    ||!db.workspaces.some(w=>w.id===scope.workspaceId&&w.status==='active')||!activeMember(db,scope)
    ||!db.oneKeyDevices.some(d=>d.id===scope.deviceId&&d.status==='active'&&d.userId===scope.userId&&d.workspaceId===scope.workspaceId))throw new Error('无权检查这台电脑的本机状态');
  return{busy:!!localExecutionBlocker(db,scope)};
}
function failedFolder(error:unknown):LocalDeviceReadiness['folder'] {
  const message=error instanceof Error?error.message:'';
  if(/permission denied|operation not permitted|权限|未允许|没有.*许可/i.test(message))return{state:'denied'};
  if(/工作(?:文件夹|目录).*(?:不可用|无法打开|发生变化)|不能把系统根目录|not a directory|no such file/i.test(message))return{state:'unavailable'};
  return{state:'unknown'};
}
function executorState(value:ReadinessExecutorProbe):LocalDeviceReadiness['executor'] {
  if(value.preparing)return{state:'busy'};
  if(value.available&&value.installedVersion){
    const parsed=parseLocalDeviceReadiness({checkedAt:new Date(0).toISOString(),connected:true,ready:true,folder:{state:'ready',targetName:'/probe'},executor:{state:'ready',installedVersion:value.installedVersion,installedSource:value.installedSource},reason:'ready'});
    return parsed?.executor??{state:'unknown'};
  }
  if(value.error)return{state:'unknown'};
  return{state:value.available?'unprepared':'unavailable'};
}
/** Shared by owner settings and coordinator. This fact snapshot cannot grant execution authority. */
export function createLocalDeviceReadiness(deps:LocalDeviceReadinessDependencies) {
  const now=deps.now??Date.now,ttl=Math.min(10_000,Math.max(0,deps.ttlMs??5_000)),timeout=Math.min(5_000,Math.max(1,deps.timeoutMs??5_000));
  const cache=new Map<string,{token:object;expires:number;value:LocalDeviceReadiness}>();
  const inflight=new Map<string,{token:object;generation:{invalidated:boolean};work:Promise<LocalDeviceReadiness>}>();
  const empty=(connected:boolean):LocalDeviceReadiness=>({checkedAt:new Date(now()).toISOString(),connected,ready:false,folder:{state:'unknown'},executor:{state:'unknown'},reason:connected?'unknown':'offline'});
  const copy=(value:LocalDeviceReadiness)=>structuredClone(value);
  const response=(value:LocalDeviceReadiness,expires=now()+ttl,scope?:LocalDeviceReadinessScope)=>Object.assign(copy(value),{validForMs:Math.max(0,Math.min(10_000,expires-now())),...(scope&&deps.metadata?deps.metadata(scope):{platform:'unknown' as const,capabilities:{staticPreview:false,taskDirectoryBinding:false}})});
  function invalidate(scope:LocalDeviceReadinessScope){const key=JSON.stringify([scope.workspaceId,scope.userId,scope.deviceId,scope.installationId]);cache.delete(key);const pending=inflight.get(key);if(pending)pending.generation.invalidated=true;}
  async function inspect(scope:LocalDeviceReadinessScope,options:{fresh?:boolean}={}):Promise<LocalDeviceReadiness> {
    const key=JSON.stringify([scope.workspaceId,scope.userId,scope.deviceId,scope.installationId]);
    let access:{busy:boolean};
    try{access=await deps.authorize(scope);}catch(error){invalidate(scope);throw error;}
    const token=deps.connectionToken(scope);
    if(!token){cache.delete(key);return response(empty(false),undefined,scope);}
    if(access.busy){cache.delete(key);return response({...empty(true),executor:{state:'busy'},reason:'busy'},undefined,scope);}
    const previous=cache.get(key);
    if(!options.fresh&&previous?.token===token&&previous.expires>now())return response(previous.value,previous.expires,scope);
    cache.delete(key);
    const pending=inflight.get(key);if(pending?.token===token&&!pending.generation.invalidated){const value=await pending.work;return response(value,cache.get(key)?.expires,scope);}
    const abort=new AbortController(),generation={invalidated:false};
    const work=(async()=>{
      const result=empty(true);
      let timer:ReturnType<typeof setTimeout>|undefined;
      const probes=Promise.allSettled([Promise.resolve().then(()=>deps.probeFolder(scope,abort.signal)),Promise.resolve().then(()=>deps.probeExecutor(scope,abort.signal))]);
      const settled=await Promise.race([probes,new Promise<undefined>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve(undefined);},timeout);})]);
      if(timer)clearTimeout(timer);
      const after=await deps.authorize(scope);
      if(deps.connectionToken(scope)!==token)return empty(false);
      if(generation.invalidated)return empty(true);
      result.checkedAt=new Date(now()).toISOString();
      if(settled){
        const [folder,executor]=settled;
        if(folder.status==='fulfilled')result.folder=folder.value.targetName?{state:'ready',targetName:folder.value.targetName}:{state:'unselected'};
        else result.folder=failedFolder(folder.reason);
        if(executor.status==='fulfilled')result.executor=executorState(executor.value);
      }
      if(after.busy)result.executor={state:'busy'};
      result.reason=localDeviceReadinessReason(result);result.ready=result.reason==='ready';
      const safe=parseLocalDeviceReadiness(result)??empty(true);
      cache.set(key,{token,expires:now()+ttl,value:safe});
      // Bound idle metadata, not just the age of entries, on a long-lived server.
      for(const [id,item] of cache)if(item.expires<=now())cache.delete(id);
      if(cache.size>500)cache.delete(cache.keys().next().value!);
      return safe;
    })();
    inflight.set(key,{token,generation,work});
    try{const value=await work;return response(value,cache.get(key)?.expires,scope);}finally{abort.abort();if(inflight.get(key)?.work===work)inflight.delete(key);}
  }
  return{inspect,invalidate};
}

export function localDeviceReadinessScope(req:Request):LocalDeviceReadinessScope {
  return{workspaceId:req.workspaceId!,userId:req.user!.id,deviceId:req.oneKeyDeviceId!,installationId:req.oneKeyInstallationId};
}
export function installLocalDeviceReadinessRoute(app:Express,keyAuth:readonly RequestHandler[],checker:ReturnType<typeof createLocalDeviceReadiness>){
  // Include authentication failures: an offline response must not be cached either.
  app.get('/api/me/local-device/readiness',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();},...keyAuth,
    asyncRoute(async(req,res)=>res.json(await checker.inspect(localDeviceReadinessScope(req),{fresh:req.query.fresh==='1'}))));
}
