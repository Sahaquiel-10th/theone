import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './db.js';
import type {Database} from './types.js';
import {featureMember} from './featureRuns.js';
import {canReadKnowledge} from './enterprisePolicy.js';
import {sourceBinding} from './publicSharing.js';
import type {KnowledgeService} from './knowledge/knowledgeService.js';
import {calendarDay,validTimeZone,runtimeContext} from './runtimeContext.js';

type Scope={workspaceId:string;userId:string};
export type AttentionNotice=Scope&{id:string;topic:string;sourceIds:string[];sourceBindings:Record<string,string>;createdAt:string;readAt?:string;snoozedUntil?:string};
export type AttentionState=Scope&{
  enabled:boolean;revision:number;deviceId:string;installationId:string;sourceIds:string[];topics:string[];
  intervalHours:number;dailyLimit:number;quietStart:number;quietEnd:number;timeZone:string;
  nextCheckAt?:string;lastCheckedAt?:string;lastStatus?:'queued'|'baseline'|'checked'|'partial'|'failed'|'offline'|'quiet'|'daily_limit'|'paused';
  day?:string;checksToday:number;seen:Record<string,string[]>;notices:AttentionNotice[];
  lease?:{id:string;until:string};
};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const own=(a:Scope,b:Scope)=>a.workspaceId===b.workspaceId&&a.userId===b.userId;
function state(db:Database,s:Scope){featureMember(db,s);return db.users.find(u=>u.id===s.userId)!.attentionStates?.find(c=>own(c,s));}
function sources(db:Database,s:Scope,ids:string[]){return db.knowledgeConnections.filter(c=>c.workspaceId===s.workspaceId&&ids.includes(c.id)&&['connected','error'].includes(c.status)&&canReadKnowledge(db,s,c.id));}
function readable(db:Database,s:Scope,n:AttentionNotice){return own(n,s)&&n.sourceIds.every(id=>sources(db,s,[id]).some(c=>sourceBinding(c)===n.sourceBindings[id]));}
function publicState(db:Database,s:Scope,now:number){
  const c=state(db,s);
  const available=sources(db,s,db.knowledgeConnections.map(c=>c.id)).map(c=>({id:c.id,name:({getnote:'得到大脑',notion:'Notion',feishu:'飞书',flowus:'FlowUs',yinxiang:'印象笔记',flomo:'flomo'} as Record<string,string>)[c.provider]||'知识来源'}));
  return {timeZone:runtimeContext(db,s).timeZone,settings:c?{enabled:c.enabled,revision:c.revision,sourceIds:c.sourceIds,topics:c.topics,intervalHours:c.intervalHours,dailyLimit:c.dailyLimit,quietStart:c.quietStart,quietEnd:c.quietEnd,timeZone:c.timeZone,nextCheckAt:c.nextCheckAt,lastCheckedAt:c.lastCheckedAt,lastStatus:c.lease&&Date.parse(c.lease.until)>now?'checking':c.lastStatus,checksToday:c.day===calendarDay(new Date(now).toISOString(),c.timeZone)?c.checksToday:0}:null,
    sources:available,notices:(c?.notices??[]).filter(n=>!n.readAt&&c?.topics.includes(n.topic)&&n.sourceIds.every(id=>c.sourceIds.includes(id))&&(!n.snoozedUntil||Date.parse(n.snoozedUntil)<=now)&&readable(db,s,n)).slice(-5).reverse().map(({sourceBindings,...notice})=>notice)};
}
export class AttentionService{
  private timer?:ReturnType<typeof setInterval>;
  private ticking=false;
  constructor(private store:Store,private knowledge:Pick<KnowledgeService,'recallWithDiagnostics'>,private deps:{verify:(s:Scope&{deviceId:string;installationId:string})=>Promise<void>;connected:(deviceId:string,installationId:string)=>boolean;now?:()=>number;readTimeoutMs?:number}){}
  private now(){return this.deps.now?.()??Date.now();}
  async view(s:Scope){return publicState(await this.store.read(),s,this.now());}
  async configure(s:Scope,input:unknown,device:{deviceId:string;installationId?:string}){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('请检查主动提醒设置');
    const v=input as Record<string,unknown>;
    return this.store.mutate(db=>{
      const previous=state(db,s);
      if(v.revision!==(previous?.revision??0))throw new Error('设置已变化，请刷新后再保存');
      // Pausing never needs the old source to remain connected.
      if(v.enabled===false){if(previous){previous.enabled=false;previous.lastStatus='paused';previous.revision++;delete previous.lease;}return publicState(db,s,this.now());}
      if(v.enabled!==true||!device.deviceId||!device.installationId)throw new Error('先连接这台电脑上的 ONE Key，再开启提醒');
      const ids=v.sourceIds,topics=v.topics;
      if(!Array.isArray(ids)||!ids.length||ids.length>3||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length||sources(db,s,ids).length!==ids.length)throw new Error('请选择最多三个已授权的知识来源');
      if(!Array.isArray(topics)||!topics.length||topics.length>3||topics.some(q=>typeof q!=='string'||!q.trim()||q.length>80))throw new Error('请填写一至三个关注主题，每项最多 80 字');
      if(![1,3,6,12,24].includes(Number(v.intervalHours))||!Number.isInteger(v.dailyLimit)||Number(v.dailyLimit)<1||Number(v.dailyLimit)>12)throw new Error('请检查频率和每天检查次数');
      if(!Number.isInteger(v.quietStart)||!Number.isInteger(v.quietEnd)||Number(v.quietStart)<0||Number(v.quietStart)>23||Number(v.quietEnd)<0||Number(v.quietEnd)>23||!validTimeZone(v.timeZone))throw new Error('请检查时区和免打扰时间');
      const same=previous&&JSON.stringify([previous.sourceIds,previous.topics])===JSON.stringify([ids,topics.map(q=>q.trim())]);
      const c:AttentionState={...s,enabled:true,revision:(previous?.revision??0)+1,deviceId:device.deviceId,installationId:device.installationId,sourceIds:ids,topics:topics.map(q=>q.trim()),intervalHours:Number(v.intervalHours),dailyLimit:Number(v.dailyLimit),quietStart:Number(v.quietStart),quietEnd:Number(v.quietEnd),timeZone:v.timeZone,checksToday:previous?.checksToday??0,day:previous?.day,seen:same?previous.seen:{},notices:previous?.notices??[],lastStatus:'queued',nextCheckAt:new Date(this.now()).toISOString()};
      const u=db.users.find(u=>u.id===s.userId)!;u.attentionStates=[...(u.attentionStates??[]).filter(p=>!own(p,s)),c];
      return publicState(db,s,this.now());
    });
  }
  async acknowledge(s:Scope,id:string,action:'read'|'snooze'|'all'){
    return this.store.mutate(db=>{
      const c=state(db,s);if(!c){if(action!=='all')throw new Error('提醒不存在或已经失效');return {ok:true};}
      const selected=action==='all'?c.notices:c.notices.filter(n=>n.id===id&&readable(db,s,n));
      if(action!=='all'&&!selected.length)throw new Error('提醒不存在或已经失效');
      for(const n of selected){if(action==='snooze')n.snoozedUntil=new Date(this.now()+86400000).toISOString();else n.readAt=new Date(this.now()).toISOString();}
      return {ok:true};
    });
  }
  async requestCheck(s:Scope){
    return this.store.mutate(db=>{const c=state(db,s);if(!c?.enabled)throw new Error('先开启关注，我才能检查你选的主题。');if(c.lease&&Date.parse(c.lease.until)>this.now()||c.lastCheckedAt&&this.now()-Date.parse(c.lastCheckedAt)<60000)return false;c.nextCheckAt=new Date(this.now()).toISOString();c.lastStatus='queued';return true;});
  }
  async check(s:Scope,manual=false){
    const time=this.now(),at=new Date(time).toISOString(),leaseId=randomUUID();
    const claimed=await this.store.mutate(db=>{
      const c=state(db,s);if(!c?.enabled||c.lease&&Date.parse(c.lease.until)>time||c.lastCheckedAt&&time-Date.parse(c.lastCheckedAt)<60000||!manual&&c.nextCheckAt&&Date.parse(c.nextCheckAt)>time)return;
      const day=calendarDay(at,c.timeZone),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:c.timeZone,hour:'2-digit',hourCycle:'h23'}).format(new Date(time)));
      if(c.day!==day){c.day=day;c.checksToday=0;}
      const quiet=c.quietStart!==c.quietEnd&&(c.quietStart<c.quietEnd?hour>=c.quietStart&&hour<c.quietEnd:hour>=c.quietStart||hour<c.quietEnd);
      if(quiet||c.checksToday>=c.dailyLimit||!this.deps.connected(c.deviceId,c.installationId)){c.lastStatus=quiet?'quiet':c.checksToday>=c.dailyLimit?'daily_limit':'offline';c.nextCheckAt=new Date(time+15*60000).toISOString();return;}
      c.lease={id:leaseId,until:new Date(time+5*60000).toISOString()};return structuredClone(c);
    });
    if(!claimed)return;
    const live=async()=>{
      const db=await this.store.read(),c=state(db,s);
      if(!c?.enabled||c.revision!==claimed.revision||c.lease?.id!==leaseId)throw new Error('paused');
      await this.deps.verify({...s,deviceId:claimed.deviceId,installationId:claimed.installationId});
      const fresh=await this.store.read(),latest=state(fresh,s);
      if(!latest?.enabled||latest.revision!==claimed.revision||latest.lease?.id!==leaseId)throw new Error('paused');
      return fresh;
    };
    let successes=0,failures=0,baseline=false;
    try{
      await live();
      await this.store.mutate(db=>{const c=state(db,s);if(c?.lease?.id===leaseId)c.checksToday++;});
      for(const topic of claimed.topics){
        for(const sourceId of claimed.sourceIds){
          try{
            const db=await live(),connection=sources(db,s,[sourceId])[0];
            if(!connection){failures++;continue;}
            const binding=sourceBinding(connection),key=hash(JSON.stringify([sourceId,binding,topic]));
            let timer:ReturnType<typeof setTimeout>|undefined;
            const result=await Promise.race([this.knowledge.recallWithDiagnostics(s.workspaceId,topic,5,[sourceId],s.userId,{retry:false}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),this.deps.readTimeoutMs??20000);})]).finally(()=>clearTimeout(timer));
            const after=await live();
            if(!sources(after,s,[sourceId]).some(c=>sourceBinding(c)===binding)||!['used','no_match'].includes(result.status)){failures++;continue;}
            const fingerprints=result.chunks.map(c=>hash(JSON.stringify([c.id,c.title,c.content,c.updatedAt])));
            await this.store.mutate(d=>{
              const c=state(d,s);if(!c?.enabled||c.revision!==claimed.revision||c.lease?.id!==leaseId||!sources(d,s,[sourceId]).some(c=>sourceBinding(c)===binding))return;
              const previous=c.seen[key];if(!previous)baseline=true;
              else if(fingerprints.some(fp=>!previous.includes(fp))){
                const pending=c.notices.find(n=>!n.readAt&&n.topic===topic&&readable(d,s,n));
                if(pending){pending.sourceIds=[...new Set([...pending.sourceIds,sourceId])];pending.sourceBindings[sourceId]=binding;pending.createdAt=at;}
                else c.notices.push({...s,id:randomUUID(),topic,sourceIds:[sourceId],sourceBindings:{[sourceId]:binding},createdAt:at});
                c.notices=c.notices.slice(-30);
              }
              c.seen[key]=[...new Set([...(previous??[]),...fingerprints])].slice(-500);
              // Old topic/binding digests are not a knowledge archive.
              if(Object.keys(c.seen).length>30)for(const old of Object.keys(c.seen).slice(0,-30))delete c.seen[old];
            });successes++;
          }catch{failures++;}
        }
      }
      await this.store.mutate(db=>{const c=state(db,s);if(c?.lease?.id!==leaseId)return;c.lastCheckedAt=at;c.lastStatus=failures?successes?'partial':'failed':baseline?'baseline':'checked';c.nextCheckAt=new Date(time+claimed.intervalHours*3600000).toISOString();delete c.lease;});
    }catch{
      await this.store.mutate(db=>{const c=state(db,s);if(c?.lease?.id===leaseId){c.lastStatus='offline';c.nextCheckAt=new Date(time+15*60000).toISOString();delete c.lease;}}).catch(()=>{});
    }
  }
  async tick(){
    if(this.ticking)return;this.ticking=true;
    try{const db=await this.store.read();const configs=db.users.flatMap(u=>u.attentionStates??[]).filter(c=>c.enabled&&(!c.nextCheckAt||Date.parse(c.nextCheckAt)<=this.now())).slice(0,50);for(const c of configs)await this.check(c).catch(()=>{});}finally{this.ticking=false;}
  }
  start(){if(!this.timer){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},60000);this.timer.unref();}}
  stop(){clearInterval(this.timer);this.timer=undefined;}
}
