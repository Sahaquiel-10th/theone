import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SharingPanel} from '../src/PublicSharing';
import {FluidWorkLayer} from '../src/FluidWorkLayer';
import {ApiError,type api as Api} from '../src/oneApi';
import {emptyAvatarBusiness,emptyAvatarService,type AvatarAvailableFeature} from '../src/AvatarService';
import type {PublicationDraft,PublicationRow} from '../src/sharingWorkspaceState';
import type {AvatarDebugReceipt} from '../src/avatarDebugState';
import '../src/styles.css';
import '../src/one-refinements.css';
import '../src/one-studio.css';
import '../src/one-surfaces.css';
import '../src/one-settings.css';
import '../src/one-product.css';
import '../src/account-preferences.css';
import '../src/one-playful.css';
import '../src/fluid-workspace.css';
import '../src/fluid-scenes.css';
import '../src/fluid-conversation.css';
import '../src/fluid-work-layers.css';
import '../src/fluid-flow-integration.css';
import '../src/fluid-workflow-system.css';
import '../src/fluid-control-rhythm.css';
import '../src/fluid/fluid-work-layer-arrival.css';
// Match the production import order: the scoped workbench rules follow the
// shared work-layer rules, and the real components provide all interactions.
import '../src/avatar-workbench.css';
import '../src/avatar-configuration.css';
import '../src/avatar-debug.css';

const models=[{id:'local-qa-model',name:'合成验收模型（不调用模型）',kind:'chat'}];
const names=['林老师的课程顾问','林老师的方法练习室','已关闭的合成咨询分身','项目复盘助手','这是一项用于检查长名称完整换行、按钮可达与列表滚动的本地合成分身','新课售前答疑','写作训练陪练','最后一项：滚动可达验收'];
const featureNames=['填写需求表','制作预算测算表','制作交互网页','资料对比','写作提纲','会议纪要','项目复盘','学习计划','知识问答','课程设计','邮件润色','阅读助手','输出行动清单'];
const features:AvatarAvailableFeature[]=featureNames.map((name,index)=>({id:`local-feature-${index+1}`,releaseId:'local-release-1',name,description:`合成能力 ${index+1}：仅供选择、搜索与配置验收，不执行实际工具。`,usageMultiplier:.6}));
type Config=PublicationDraft&{version:number;legacyPrompt:boolean;status:string;deletedAt?:string};
type FixtureRow=PublicationRow&{deletedAt?:string};
const rows:FixtureRow[]=[],configs=new Map<string,Config>(),history=new Map<string,Config[]>(),receipts=new Map<string,AvatarDebugReceipt>();
const transitions=new Map<string,{action:string;baseVersion:number;version:number}>();
const copy=<T,>(value:T):T=>structuredClone(value);
const expiry=()=>new Date(Date.now()+30*86400000).toISOString();
for(let index=0;index<8;index++){
  const id=`local-avatar-${index+1}`,status=index===2?'closed':index%3===0?'draft':'active';
  const service={...emptyAvatarService(),mode:index%2?'knowledge' as const:'consultation' as const,welcome:`你好，我是${names[index]}。这是合成开场白，不连接任何真实资料。`,starterQuestions:['我适合从哪里开始？','请先介绍你的方法'],method:'仅合成验收：先了解目标，再按现状、选择、下一步三个方面回答。不要执行任何真实工具。'};
  const description=index===4?'这是比较长的合成介绍，用于检查长文本是否挤压编辑按钮、分享按钮与状态。所有名字、资料、用量均为虚构，不含私人内容，也不会调用模型或连接任何知识来源。':'用于本地合成视觉与交互验收；不连接生产账号，不产生真实费用。';
  const config:Config={name:names[index],description,prompt:'只使用合成资料，明确标注本地演示，不作真实专业建议。',modelId:models[0].id,sourceIds:[],attachments:false,budget:10,perRun:1,days:30,confirmed:false,visitorPercent:0,requireLogin:false,allowedUsernames:[],service,serviceBusiness:emptyAvatarBusiness(),version:1,legacyPrompt:false,status};
  configs.set(id,config);history.set(id,[]);
  rows.push({id,version:1,...(status==='draft'?{}:{slug:`local-synthetic-${index+1}`}),name:config.name,description:config.description,status,expiresAt:expiry(),budgetMicros:10e6,perRunMicros:1e6,spent:0,held:0,attachments:false,sources:[],authorName:'合成作者 · 林老师',service:{mode:service.mode,featureCount:0}});
}
function response<T>(value:unknown):T{return copy(value) as T;}
function bodyOf(options:RequestInit){if(typeof options.body!=='string')return{};return JSON.parse(options.body) as Record<string,unknown>;}
function receipt(row:FixtureRow){return {id:row.id,status:row.status,version:row.version,...(row.deletedAt?{deletedAt:row.deletedAt}:{}),...(row.status==='active'&&!row.deletedAt?{slug:row.slug,expiresAt:row.expiresAt}:{})};}
function confirm(body:Record<string,unknown>){if(body.confirmed!==true)throw new ApiError('请确认这次合成生命周期操作。',undefined,400);}
function version(row:FixtureRow,body:Record<string,unknown>){if(body.version!==row.version)throw new ApiError('合成配置版本已变化，请重新打开。',undefined,409,'PUBLICATION_VERSION_CHANGED');}
function repeated(row:FixtureRow,action:string,body:Record<string,unknown>){const previous=transitions.get(row.id);return previous?.action===action&&previous.version===row.version&&body.version===previous.baseVersion;}
function transition(row:FixtureRow,config:Config,action:string,update:()=>void){
  const baseVersion=row.version;history.set(row.id,[copy({...config,...(row.deletedAt?{deletedAt:row.deletedAt}:{})}),...(history.get(row.id)??[])].slice(0,20));
  update();row.version++;config.version=row.version;config.status=row.status;
  if(row.deletedAt)config.deletedAt=row.deletedAt;else delete config.deletedAt;
  transitions.set(row.id,{action,baseVersion,version:row.version});
}

/** No network fallback: every unknown route fails locally and visibly. */
const fixtureApi:typeof Api=async<T,>(path:string,options:RequestInit={}):Promise<T>=>{
  const url=new URL(path,'http://127.0.0.1:5177'),method=options.method??'GET',body=bodyOf(options);
  if(url.pathname==='/api/sharing/manage/preview'&&method==='POST'){
    const operationId=String(body.operationId??'');
    const existing=receipts.get(operationId);if(existing)return response<T>(existing);
    const config=body.config as {service?:{mode?:string;method?:string}}|undefined;
    const receipt:AvatarDebugReceipt={operationId,response:`**本地合成回答（未调用 AI）**\n\n收到你的测试问题：“${String(body.content??'')}”。\n\n当前配置用途是${config?.service?.mode==='knowledge'?'知识服务':'售前咨询'}。这个回执只验证调试窗的显示、上下文切换与费用展示，不代表真实模型质量。\n\n- 模型调用：0 次\n- 知识检索：0 次\n- 实际费用：0 电力`,finishReason:'stop',limitations:'本地合成验收，未调用模型、工具或知识库；费用为 0。',chargedMicros:0,heldMicros:0};
    receipts.set(operationId,receipt);return response<T>(receipt);
  }
  if(url.pathname==='/api/sharing/manage'&&method==='GET'){
    const query=(url.searchParams.get('q')??'').trim().toLocaleLowerCase(),page=Math.max(1,Number(url.searchParams.get('page'))||1);
    const trash=url.searchParams.get('trash');if(trash!==null&&!['0','1'].includes(trash))throw new ApiError('回收站筛选无效。',undefined,400);
    const filtered=rows.filter(row=>Boolean(row.deletedAt)===(trash==='1')&&`${row.name} ${row.description}`.toLocaleLowerCase().includes(query));
    const items=filtered.slice((page-1)*10,page*10).map(row=>{const value=copy(row);if(value.deletedAt||value.status==='draft')delete value.slug;return value;});
    return response<T>({ready:true,authorName:'合成作者 · 林老师',visitorPaymentsEnabled:false,availableFeatures:features,sources:[],trashTotal:rows.filter(row=>row.deletedAt).length,total:filtered.length,items});
  }
  const match=url.pathname.match(/^\/api\/sharing\/manage\/([^/]+)\/(config|update|publish|close|delete|restore|usage|service|leads)$/);
  if(match){
    const [,id,action]=match,row=rows.find(item=>item.id===id),config=configs.get(id);
    if(!row||!config||row.deletedAt&&!['delete','restore','usage'].includes(action))throw new ApiError('合成分身不存在',undefined,404);
    if(action==='config'&&method==='GET')return response<T>(url.searchParams.has('page')?{total:history.get(id)?.length??0,history:history.get(id)??[]}:config);
    if(action==='usage')return response<T>({total:0,items:[]});
    if(action==='leads')return response<T>({items:[]});
    if(action==='service')return response<T>({...config.serviceBusiness,codes:[],entitlements:[]});
    if(action==='close'&&method==='POST'){
      confirm(body);
      if(row.status==='closed'&&(body.version===row.version||repeated(row,action,body)))return response<T>({ok:true,...receipt(row)});
      version(row,body);if(row.status!=='active')throw new ApiError('这个合成分身尚未开放。',undefined,409);
      transition(row,config,action,()=>{row.status='closed';});return response<T>({ok:true,...receipt(row)});
    }
    if(action==='publish'&&method==='POST'){
      confirm(body);
      if(row.status==='active'&&(body.version===row.version||repeated(row,action,body)))return response<T>(receipt(row));
      version(row,body);if(!['draft','closed'].includes(row.status))throw new ApiError('请从未分享或已关闭合成分身重新开放。',undefined,409);
      transition(row,config,action,()=>{if(row.status==='closed'||!row.slug)row.slug=`local-synthetic-${crypto.randomUUID()}`;row.status='active';row.expiresAt=new Date(Date.now()+config.days*86400000).toISOString();});
      return response<T>(receipt(row));
    }
    if(action==='delete'&&method==='POST'){
      confirm(body);
      if(row.deletedAt&&(body.version===row.version||repeated(row,action,body)))return response<T>(receipt(row));
      if(row.deletedAt)throw new ApiError('合成分身已在回收站。',undefined,409);
      version(row,body);transition(row,config,action,()=>{row.status=row.status==='draft'?'draft':'closed';row.deletedAt=new Date().toISOString();});
      return response<T>(receipt(row));
    }
    if(action==='restore'&&method==='POST'){
      confirm(body);
      if(!row.deletedAt&&repeated(row,action,body))return response<T>(receipt(row));
      if(!row.deletedAt)throw new ApiError('这个合成分身不在回收站。',undefined,409);
      version(row,body);transition(row,config,action,()=>{delete row.deletedAt;row.status=row.status==='draft'?'draft':'closed';});
      return response<T>(receipt(row));
    }
    if(action==='update'&&method==='POST')return save<T>(body,id);
  }
  if(url.pathname==='/api/sharing/manage'&&method==='POST')return save<T>(body);
  if(/^\/api\/sharing-(api|commerce)\/manage\//.test(url.pathname)&&method==='GET')return response<T>({items:[],total:0,pendingRevenueMicros:0});
  throw new ApiError(`本地合成验收未实现此操作：${method} ${url.pathname}。没有发出网络请求。`,undefined,400);
};
function save<T>(body:Record<string,unknown>,id?:string):T{
  const existing=id?rows.find(row=>row.id===id):undefined,prior=id?configs.get(id):undefined;
  if(existing?.deletedAt)throw new ApiError('请先从合成回收站恢复。',undefined,404);
  if(existing&&Number(body.version)!==existing.version)throw new ApiError('合成配置版本已变化，请重新打开。',undefined,409);
  if(existing?.status==='active'&&body.intent==='draft')throw new ApiError('已开放的分享不能通过保存变成私有，请先关闭。',undefined,409);
  confirm(body);
  if(!Array.isArray(body.sourceIds)||body.sourceIds.length)throw new ApiError('合成夹具没有可用知识来源。',undefined,403);
  if(body.modelId!==models[0].id)throw new ApiError('合成模型不可用。',undefined,400);
  const key=id??`local-created-${crypto.randomUUID()}`,version=(existing?.version??0)+1;
  const authorFields=['name','description','prompt','modelId','sourceIds','attachments','budget','perRun','days','visitorPercent','requireLogin','allowedUsernames','service','serviceBusiness'];
  const draft={...Object.fromEntries(authorFields.filter(field=>body[field]!==undefined).map(field=>[field,copy(body[field])])),confirmed:false} as unknown as PublicationDraft;
  const status=existing?.status??'draft';
  const config:Config={...draft,version,legacyPrompt:false,status};
  if(prior)history.set(key,[copy(prior),...(history.get(key)??[])]);
  configs.set(key,config);
  const row:FixtureRow={id:key,version,...(existing?.slug?{slug:existing.slug}:{}),name:draft.name,description:draft.description,status,expiresAt:new Date(Date.now()+draft.days*86400000).toISOString(),budgetMicros:Math.round(draft.budget*1e6),perRunMicros:Math.round(draft.perRun*1e6),spent:existing?.spent??0,held:0,attachments:draft.attachments,sources:[],authorName:'合成作者 · 林老师',service:{mode:draft.service?.mode??'consultation',featureCount:draft.service?.features.length??0}};
  if(existing)Object.assign(existing,row);else rows.unshift(row);
  transitions.delete(key);return response<T>(receipt(row));
}
function App(){
  const [open,setOpen]=useState(true);
  return <main className="app-shell one-shell one-studio one-fluid-workspace" data-fluid-material="optical" data-fluid-scene="silver" data-fluid-desktop="true"><section style={{padding:32,color:'var(--fluid-frame-ink)'}}><h1>分身工作台 · 本地合成验收</h1><p>合成分身数据只保存在本页内存，刷新恢复原样；未保存的作者配置按合成账号隔离保留在本页 sessionStorage。不调用模型、不读取资料、不接生产，实际费用 0。</p><button type="button" onClick={()=>setOpen(true)}>打开合成分身工作台</button></section><FluidWorkLayer title="分身" eyebrow="本地合成验收 · 8 个虚构分身 · 无网络调用 · 费用 0" open={open} className="fluid-work-layer-avatars" onClose={()=>setOpen(false)}><SharingPanel api={fixtureApi} models={models} draftScope={{userId:'local-qa-user',workspaceId:'local-qa-workspace'}}/></FluidWorkLayer></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
