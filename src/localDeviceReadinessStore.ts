import type {api as Api} from './oneApi';
import {parseLocalDeviceReadiness,type LocalDeviceReadiness} from './localDeviceReadiness';

export const LOCAL_READINESS_TTL_MS=10_000;
export const ONE_LOCAL_SETTINGS_EVENT='one-local-settings';
export type LocalReadinessSnapshot={status:'idle'|'checking'|'confirmed'|'error';value?:LocalDeviceReadiness;error?:string;updatedAt:number};

/** One component-scoped API function already binds user, workspace and login
 * generation. Never share a ready result across those function identities. */
export function createLocalDeviceReadinessResource(api:typeof Api,options:{now?:()=>number}={}) {
 const now=options.now??Date.now;
 let snapshot:LocalReadinessSnapshot={status:'idle',updatedAt:0},generation=0;
 let inflight:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const subscribers=new Set<()=>void>();
 const clearTimer=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
 const publish=(next:LocalReadinessSnapshot)=>{snapshot=next;for(const notify of subscribers)notify();};
 const schedule=()=>{
  clearTimer();if(!subscribers.size||snapshot.status!=='confirmed'&&snapshot.status!=='error')return;
  timer=setTimeout(()=>{timer=undefined;void refresh(true);},Math.max(0,LOCAL_READINESS_TTL_MS-(now()-snapshot.updatedAt)));
  (timer as unknown as {unref?:()=>void}).unref?.();
 };
 function invalidate(){generation++;clearTimer();publish({status:'idle',updatedAt:0});}
 function refresh(force=false):Promise<void>{
  if(inflight)return inflight.then(()=>snapshot.status==='idle'?refresh(true):undefined);
  if(!force&&snapshot.status==='confirmed'&&now()-snapshot.updatedAt<LOCAL_READINESS_TTL_MS)return Promise.resolve();
  clearTimer();const revision=generation;
  const request=(async()=>{
   try{
    const raw=await api<unknown>(`/api/me/local-device/readiness${force?'?fresh=1':''}`,{signal:AbortSignal.timeout(15_000)});
    const value=parseLocalDeviceReadiness(raw);
    if(!value||now()-Date.parse(value.checkedAt)>=LOCAL_READINESS_TTL_MS)throw new Error('本机状态这次没核对完整，请重新检查。');
    // Server and browser both cache, but their windows must not stack into
    // twenty seconds. Expiry remains anchored to the server's actual probe.
    if(revision===generation)publish({status:'confirmed',value,updatedAt:Math.min(now(),Date.parse(value.checkedAt))});
   }catch(error){
    if(revision===generation)publish({status:'error',error:error instanceof Error?error.message:'本机连接暂时无法确认，请重新检查。',updatedAt:now()});
   }
  })().finally(()=>{if(inflight===request)inflight=undefined;if(revision===generation)schedule();});
  inflight=request;publish({status:'checking',updatedAt:0});return request;
 }
 return{getSnapshot:()=>snapshot,refresh,invalidate,subscribe:(notify:()=>void)=>{subscribers.add(notify);schedule();return()=>{subscribers.delete(notify);if(!subscribers.size)clearTimer();};}};
}
export type LocalDeviceReadinessResource=ReturnType<typeof createLocalDeviceReadinessResource>;
const resources=new WeakMap<typeof Api,LocalDeviceReadinessResource>();
export function localDeviceReadinessResource(api:typeof Api){
 let value=resources.get(api);if(!value){value=createLocalDeviceReadinessResource(api);resources.set(api,value);}return value;
}
/** A setting change invalidates older inflight responses before the fresh read. */
export function refreshLocalDeviceReadiness(api:typeof Api){
 const resource=localDeviceReadinessResource(api);resource.invalidate();return resource.refresh(true);
}
