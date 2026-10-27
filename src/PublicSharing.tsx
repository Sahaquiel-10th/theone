import { useEffect, useRef, useState, useReducer, type FormEvent, type ReactNode, type RefObject } from "react";
import type { api as Api } from "./oneApi";
import { Pagination, SearchPicker, SettingsDialog } from "./SettingsControls";
import { MessageMarkdown } from "./MessageMarkdown";
import {PublicServicePanel} from './PublicServicePanels';
import {VisitorAccountPanel} from './VisitorAccountPanel';
import {AvatarBusinessFields,AvatarMethodFields,AvatarWelcomeFields} from './AvatarConfiguration';
import {AvatarGuestService,AvatarServiceManagement} from './AvatarBusinessPanels';
import {AvatarArtifacts,type AvatarArtifact} from './AvatarArtifacts';
import {AvatarPublicIdentity} from './AvatarPublicIdentity';
import {AvatarDebugPanel,type AvatarDebugSession} from './AvatarDebugPanel';
import {SESSION_EVENT} from './oneApi';
import {copyAvatarDraft} from './avatarDraftCopy';
import {avatarRunProgress,avatarServicePayload,emptyAvatarBusiness,emptyAvatarService,normalizedAvatarBusiness,normalizedAvatarService,type AvatarServiceConfig} from './AvatarService';
import {ShareLinkBubble,type ShareLinkReceipt} from './ShareLinkBubble';
import {publicationShareUrl,publishWithReceipt} from './shareLinkFission';
import {ArrowLeft,Settings2,Link2,BarChart3,Code2} from 'lucide-react';
import {FluidSplitWorkspace} from './fluid/FluidSplitWorkspace';
import {confirmedPublicationRow,createSharingOwnerRequestGate,initialSharingWorkspace,publicationSubmitIsUncertain,reconcilePublicationList,sharingWorkspaceTransition,upsertConfirmedPublication,type PublicationDraft,type PublicationList as List,type PublicationRow,type PublicationReceipt,type SharingOwnerRequest,type SharingWorkspaceAction} from './sharingWorkspaceState';
import "./public-sharing.css";
import "./avatar-configuration.css";
import "./avatar-workbench.css";
import "./avatar-debug.css";

const power=(n:number)=>(n/1e6).toLocaleString("zh-CN",{maximumFractionDigits:6});
const failure=(e:unknown)=>e instanceof Error?e.message:"暂时未能完成";
const labels:Record<string,string>={getnote:"得到大脑",notion:"Notion",yinxiang:"印象笔记",flowus:"息流",feishu:"飞书"};
const emptyDraft=(models:{id:string;kind:string}[]):PublicationDraft=>({name:"",description:"",prompt:"",modelId:models.find(model=>model.kind==='chat')?.id??'',sourceIds:[],attachments:true,budget:10,perRun:1,days:7,confirmed:false,visitorPercent:0,requireLogin:false,allowedUsernames:[],service:emptyAvatarService(),serviceBusiness:emptyAvatarBusiness()});
export function SharingCostHelp(){return <details className="sharing-cost-help"><summary aria-label="查看分身费用说明">?</summary><div>收费 0% 时从你的余额扣除；大于 0% 时访客登录并使用自己的电力。低于 100% 的差额由你补贴。API 和指定访客赠送仍由你承担。达到限额、到期或关闭分享后停止。</div></details>;}
export type PublicationReadyNotice={url:string;name:string;updated:boolean};
export function SharingPanel({api,models,externalQuery,hideSearch=false,onPublicationReady,privateSave=true}:{api:typeof Api;models:{id:string;name:string;kind:string}[];externalQuery?:string;hideSearch?:boolean;privateSave?:boolean;onPublicationReady?:(notice:PublicationReadyNotice)=>void}){
 const [data,setData]=useState<List>(),[page,setPage]=useState(1),[query,setQuery]=useState(''),[listError,setListError]=useState(''),[editorError,setEditorError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const [workspace,dispatch]=useReducer(sharingWorkspaceTransition,initialSharingWorkspace);
 const [debugOpen,setDebugOpen]=useState(false),[newEditorGeneration,setNewEditorGeneration]=useState(0);
 const debugSessions=useRef(new Map<string,AvatarDebugSession>());
 useEffect(()=>{const clear=()=>debugSessions.current.clear();window.addEventListener(SESSION_EVENT,clear);return()=>{clear();window.removeEventListener(SESSION_EVENT,clear);};},[]);
 const [draft,setDraft]=useState<PublicationDraft>(()=>emptyDraft(models)),[editing,setEditing]=useState<{id:string;version:number;legacy:boolean;owner:PublicationRow}>();
 const [usagePage,setUsagePage]=useState(1),[usageRefresh,setUsageRefresh]=useState(0),[usageError,setUsageError]=useState(''),[rows,setRows]=useState<{total:number;items:{id:string;status:string;createdAt:string;spent:number;held:number;calls:{model:string;activity:string;spent:number;status:string}[]}[]}>( );
 const [successByOwner,setSuccessByOwner]=useState<Record<string,string>>({});
 const [shareReview,setShareReview]=useState<PublicationDraft&{version:number}>(),[shareReviewError,setShareReviewError]=useState(''),[shareConfirmed,setShareConfirmed]=useState(false),[shareBusy,setShareBusy]=useState(false);
 const shareReviewRequest=useRef(0);
 const publishingOwner=workspace.pane?.kind==='publish'?workspace.pane.owner:undefined;
 const privateEditor=editing?editing.owner.status==='draft':privateSave;
 const confirmedRows=useRef(new Map<string,PublicationRow>()),uncertainKeys=useRef(new Set<string>()),newDraft=useRef<PublicationDraft|null>(null),draftsByOwner=useRef(new Map<string,{version:number;draft:PublicationDraft}>());
 const receiptSequence=useRef(0),receiptSequences=useRef(new Map<string,number>()),listRequest=useRef(0),createButton=useRef<HTMLButtonElement>(null),editorHeading=useRef<HTMLHeadingElement>(null);
 const panel=useRef<HTMLElement>(null),paneOpener=useRef<HTMLElement|null>(null),editRequests=useRef(createSharingOwnerRequestGate()),pendingEdit=useRef<SharingOwnerRequest|null>(null);
 const workspaceRef=useRef(workspace);workspaceRef.current=workspace;
 const currentUsage=workspace.pane?.kind==='usage'?workspace.pane.owner:undefined;
 function navigate(action:SharingWorkspaceAction,source?:HTMLElement){
  editRequests.current.invalidate();
  setDebugOpen(false);
  const current=workspaceRef.current.pane;
  const sameReview=action.type==='open-pane'&&action.pane.kind==='publish'&&current?.kind==='publish'&&action.pane.owner.id===current.owner.id;
  if(!sameReview){shareReviewRequest.current++;setShareReview(undefined);setShareConfirmed(false);setShareReviewError('');}
  if(action.type==='open-pane'&&action.pane.kind==='usage'&&(current?.kind!=='usage'||action.pane.owner.id!==current.owner.id)){setRows(undefined);setUsageError('');}
  if(pendingEdit.current){pendingEdit.current=null;setBusy(false);}
  if(source)paneOpener.current=source;
  dispatch(action);
 }
 function closePane(){
  const secondary=panel.current?.querySelector<HTMLElement>('.sharing-workspace-split > .fluid-split-secondary');
  if(secondary?.contains(document.activeElement)&&paneOpener.current?.isConnected)paneOpener.current.focus({preventScroll:true});
  navigate({type:'close-pane'});
 }
 // The shared primitive focuses on first reveal. A replacement detail needs
 // one handoff only when its source still has focus; never interrupt typing.
 useEffect(()=>{
  if(!workspace.pane)return;
  const source=paneOpener.current;
  const frame=requestAnimationFrame(()=>{
   const secondary=panel.current?.querySelector<HTMLElement>('.sharing-workspace-split > .fluid-split-secondary');
   if(secondary&&!secondary.hidden&&!secondary.inert&&document.activeElement===source)secondary.querySelector<HTMLElement>('h3[tabindex]')?.focus({preventScroll:true});
  });
  return()=>cancelAnimationFrame(frame);
 },[workspace.pane]);
 useEffect(()=>()=>{editRequests.current.invalidate();pendingEdit.current=null;},[api]);
 useEffect(()=>{if(externalQuery!==undefined){setQuery(externalQuery);setPage(1);}},[externalQuery]);
 useEffect(()=>{if(workspace.pane?.kind==='create')newDraft.current=draft;else if(workspace.pane?.kind==='edit'&&editing)draftsByOwner.current.set(editing.id,{version:editing.version,draft});},[draft,workspace.pane,editing]);
 async function load(nextPage=page,nextQuery=query){const request=++listRequest.current;setLoading(true);try{const server=await api<List>(`/api/sharing/manage?page=${nextPage}&q=${encodeURIComponent(nextQuery)}`);if(request!==listRequest.current)return;const merged=reconcilePublicationList(server,confirmedRows.current,nextPage===1&&!nextQuery);confirmedRows.current=merged.pending;setData(merged.list);setListError('');}catch(error){if(request===listRequest.current)throw error;}finally{if(request===listRequest.current)setLoading(false);}}
 useEffect(()=>{void load().catch(e=>setListError(failure(e)));return()=>{listRequest.current++;};},[api,page,query]);
 useEffect(()=>{if(!currentUsage)return;let live=true;setRows(undefined);setUsageError('');void api<NonNullable<typeof rows>>(`/api/sharing/manage/${currentUsage.id}/usage?page=${usagePage}`).then(value=>{if(live)setRows(value);}).catch(e=>{if(live)setUsageError(failure(e));});return()=>{live=false;};},[api,currentUsage?.id,usagePage,usageRefresh]);
 useEffect(()=>{if(!publishingOwner)return;const request=++shareReviewRequest.current;setShareReview(undefined);setShareReviewError('');setShareConfirmed(false);void api<PublicationDraft&{version:number}>(`/api/sharing/manage/${publishingOwner.id}/config`).then(config=>{if(request===shareReviewRequest.current)setShareReview(config);}).catch(error=>{if(request===shareReviewRequest.current)setShareReviewError(failure(error));});return()=>{shareReviewRequest.current++;};},[api,publishingOwner?.id]);
 function beginCreate(){if(workspace.pane?.kind==='create'){editorHeading.current?.focus();return;}setEditing(undefined);setDraft(newDraft.current??emptyDraft(models));setUncertain(uncertainKeys.current.has('new'));setEditorError('');navigate({type:'open-pane',pane:{kind:'create'}},createButton.current??undefined);}
 async function edit(owner:PublicationRow,source?:HTMLElement){
  if(workspace.pane?.kind==='edit'&&editing?.id===owner.id){editorHeading.current?.focus();return;}
  editRequests.current.invalidate();const request=editRequests.current.begin(owner.id);pendingEdit.current=request;
  if(source)paneOpener.current=source;
  setBusy(true);setListError('');
  try{
   const config=await api<PublicationDraft&{version:number;legacyPrompt:boolean}>(`/api/sharing/manage/${owner.id}/config`);
   if(!editRequests.current.isCurrent(request))return;
   const cached=draftsByOwner.current.get(owner.id);
   setDraft(cached?.version===config.version?{...cached.draft,confirmed:false}:{...config,visitorPercent:config.visitorPercent??0,requireLogin:config.requireLogin??false,allowedUsernames:config.allowedUsernames??[],confirmed:false,service:normalizedAvatarService(config.service),serviceBusiness:normalizedAvatarBusiness(config.serviceBusiness)});
   setDebugOpen(false);setEditing({id:owner.id,version:config.version,legacy:config.legacyPrompt,owner});setUncertain(uncertainKeys.current.has(owner.id));setEditorError('');dispatch({type:'open-pane',pane:{kind:'edit',owner}});
  }catch(e){if(editRequests.current.isCurrent(request))setListError(failure(e));}
  finally{if(pendingEdit.current===request){pendingEdit.current=null;setBusy(false);}}
 }
 async function copyClosed(owner:PublicationRow,source?:HTMLElement){
  if(busy)return;
  const request=editRequests.current.begin(owner.id);pendingEdit.current=request;
  if(source)paneOpener.current=source;
  setBusy(true);setListError('');
  try{
   const config=await api<PublicationDraft>(`/api/sharing/manage/${owner.id}/config`);
   if(!editRequests.current.isCurrent(request))return;
   const copy=copyAvatarDraft(config);
   newDraft.current=copy;setNewEditorGeneration(value=>value+1);setDraft(copy);setEditing(undefined);setDebugOpen(false);setUncertain(uncertainKeys.current.has('new'));setEditorError('');dispatch({type:'open-pane',pane:{kind:'create'}});
  }catch(error){if(editRequests.current.isCurrent(request))setListError(failure(error));}
  finally{if(pendingEdit.current===request){pendingEdit.current=null;setBusy(false);}}
 }
 async function create(event:FormEvent){
  event.preventDefault();if(busy||uncertain)return;
  setBusy(true);setEditorError('');
  const updated=!!editing,name=draft.name,key=editing?.id??'new',request=editRequests.current.begin(key);
  try{
   const result=await publishWithReceipt({
    publish:()=>api<PublicationReceipt>(editing?`/api/sharing/manage/${editing.id}/update`:'/api/sharing/manage',{method:'POST',body:JSON.stringify({...draft,service:avatarServicePayload(normalizedAvatarService(draft.service)),...(privateEditor?{intent:'draft'}:{}),version:editing?.version})}),
    onConfirmed:response=>{
     const row=confirmedPublicationRow(response,draft,data?.sources??[],editing?.owner);
     // A new draft gains a durable owner ID on save. Carry its original trial
     // submission along so saving during an answer never loses receipt recovery.
     const trial=debugSessions.current.get(editing?.id??`new:${newEditorGeneration}`);
     if(trial)debugSessions.current.set(row.id,trial);
     confirmedRows.current.set(row.id,row);setData(current=>upsertConfirmedPublication(current??{ready:true,items:[],total:0,sources:[]},row));
     setSuccessByOwner(current=>({...current,[row.id]:row.status==='draft'?'分身已保存，目前未分享。':updated?'配置已更新，原分享链接保留。':'创建完成。分享链接可从这个分身打开。'}));
     uncertainKeys.current.delete(key);if(updated)draftsByOwner.current.delete(key);else {newDraft.current=null;setNewEditorGeneration(value=>value+1);}
     if(editRequests.current.isCurrent(request)){setUncertain(false);setPage(1);setQuery('');dispatch({type:'saved'});}
     if(row.slug&&row.status==='active')onPublicationReady?.({url:publicationShareUrl(location.origin,row.slug),name,updated});
    },refresh:()=>editRequests.current.isCurrent(request)?load(1,''):Promise.resolve()
   });
   if(result.refreshError)setListError('配置已保存，分身已留在列表里；详细状态暂时未同步，可稍后刷新。');
  }catch(e){
   const unknown=publicationSubmitIsUncertain(e);if(unknown)uncertainKeys.current.add(key);
   if(editRequests.current.isCurrent(request)){setUncertain(unknown);setEditorError(failure(e));}
  }finally{setBusy(false);}
 }
 async function checkUncertainResult(){
  const request=editRequests.current.begin(editing?.id??'new');
  try{await load();if(editRequests.current.isCurrent(request))closePane();}
  catch(e){if(editRequests.current.isCurrent(request))setEditorError(`仍未能核对列表：${failure(e)}`);}
 }
 async function close(owner:PublicationRow){setBusy(true);setListError('');try{await api(`/api/sharing/manage/${owner.id}/close`,{method:'POST'});confirmedRows.current.delete(owner.id);setData(current=>current?{...current,items:current.items.map(row=>row.id===owner.id?{...row,status:'closed'}:row)}:current);if(workspaceRef.current.pane?.kind==='close'&&workspaceRef.current.pane.owner.id===owner.id)closePane();await load();}catch(e){setListError(failure(e));}finally{setBusy(false);}}
 function showShare(owner:PublicationRow,source?:HTMLElement){if(owner.status==='draft'){navigate({type:'open-pane',pane:{kind:'publish',owner}},source);return;}receiptSequences.current.set(owner.id,++receiptSequence.current);navigate({type:'open-link',ownerId:owner.id},source);}
 async function activateShare(){
  if(!publishingOwner||!shareReview||!shareConfirmed||shareBusy)return;
  const request=editRequests.current.begin(publishingOwner.id);
  setShareBusy(true);setShareReviewError('');
  try{
   const receipt=await api<PublicationReceipt>(`/api/sharing/manage/${publishingOwner.id}/publish`,{method:'POST',body:JSON.stringify({version:shareReview.version,confirmed:true})});
   if(receipt.id!==publishingOwner.id||!receipt.slug||receipt.status!=='active')throw new Error('开放结果需要核对，请刷新分身列表。');
   const row:PublicationRow={...publishingOwner,status:'active',slug:receipt.slug,version:receipt.version??shareReview.version+1,expiresAt:receipt.expiresAt??new Date(Date.now()+shareReview.days*86400000).toISOString(),syncPending:true};
   confirmedRows.current.set(row.id,row);setData(current=>upsertConfirmedPublication(current??{ready:true,items:[],total:0,sources:[]},row));
   setSuccessByOwner(current=>({...current,[row.id]:'分享已开放，链接已保留在这个分身里。'}));
   receiptSequences.current.set(row.id,++receiptSequence.current);
   if(editRequests.current.isCurrent(request))dispatch({type:'open-link',ownerId:row.id});
   onPublicationReady?.({url:publicationShareUrl(location.origin,receipt.slug),name:row.name,updated:false});
   if(editRequests.current.isCurrent(request))try{await load();}catch{setListError('分享已开放，链接已保留；详细状态稍后可刷新。');}
  }catch(error){if(editRequests.current.isCurrent(request))setShareReviewError(failure(error));}
  finally{setShareBusy(false);}
 }

 const ownerList=<section className="sharing-owner-list" aria-label="我的分身列表" aria-busy={loading}>
  <header className="sharing-owner-list-header"><div><h3>我的分身</h3></div><button type="button" className="primary" ref={createButton} disabled={!data?.ready||busy} onClick={beginCreate}>＋ {newDraft.current?'继续创建':'创建分身'}</button></header>
  {data?.ready===false?<p role="status">分享功能准备中，请管理员完成数据库升级。</p>:null}
  {!hideSearch?<input aria-label="搜索分享分身" placeholder="搜索分身" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/>:null}
  {listError?<div className="sharing-list-error" role="alert"><p>{listError}</p><button type="button" disabled={busy} onClick={()=>void load().catch(e=>setListError(failure(e)))}>刷新分身列表</button></div>:null}
  {!data&&loading?<p role="status">正在读取分身…</p>:null}
  <div className="sharing-list sharing-owner-cards">{data?.items.map(owner=>{const expired=owner.status!=='draft'&&Date.parse(owner.expiresAt)<Date.now(),linkOpen=workspace.linkOwnerId===owner.id;const receipt:ShareLinkReceipt|undefined=owner.slug?{url:publicationShareUrl(location.origin,owner.slug),name:owner.name,updated:false,fresh:false,sequence:receiptSequences.current.get(owner.id)??0}:undefined;const row=<div className="sharing-owner-main"><header><div><h4 title={owner.name}>{owner.name}</h4><small>v{owner.version??1}</small></div><span className={`sharing-owner-status ${owner.status==='closed'||expired?'is-inactive':''}`}>{owner.status==='draft'?'未分享':owner.status==='closed'?'分享已关闭':expired?'分享已到期':'分享已开放'}</span></header><p className="avatar-list-author">{owner.authorName||data.authorName||'账号作者'} · {owner.service?.mode==='knowledge'?'知识服务':'售前咨询'}</p><p className="sharing-owner-description">{owner.description||'还没有填写介绍。'}</p><p className="sharing-owner-usage">{owner.syncPending?'配置已确认，详细用量待同步。':`已用 ${power(owner.spent)} / ${power(owner.budgetMicros)} 电力${owner.held?` · 预留 ${power(owner.held)}`:''}`}</p>{successByOwner[owner.id]?<p className="sharing-owner-success" role="status">{successByOwner[owner.id]}</p>:null}<footer><button type="button" aria-expanded={linkOpen} onClick={event=>linkOpen?navigate({type:'close-link'}):showShare(owner,event.currentTarget)}><Link2 size={14}/>{owner.status==='draft'?'开放分享':linkOpen?'收起链接':'分享链接'}</button>{owner.status!=='closed'?<button type="button" aria-label={`编辑分身：${owner.name}`} disabled={busy} onClick={event=>void edit(owner,event.currentTarget)}><Settings2 size={14} aria-hidden="true"/>编辑分身</button>:<button type="button" disabled={busy} onClick={event=>void copyClosed(owner,event.currentTarget)}>复制为新分身</button>}{owner.status!=='draft'?<details className="sharing-owner-more"><summary>更多</summary><div><button type="button" onClick={event=>{setUsagePage(1);navigate({type:'open-pane',pane:{kind:'usage',owner}},event.currentTarget);}}><BarChart3 size={14}/>用量详情</button><button type="button" onClick={event=>navigate({type:'open-pane',pane:{kind:'services',owner}},event.currentTarget)}><Code2 size={14}/>服务资格、API 与收益</button>{owner.status==='active'?<button type="button" disabled={busy} onClick={event=>navigate({type:'open-pane',pane:{kind:'close',owner}},event.currentTarget)}>关闭分享</button>:null}</div></details>:null}</footer></div>;return <article className="sharing-owner" key={owner.id} data-publication-id={owner.id}><FluidSplitWorkspace compact height={246} ratio={.46} open={linkOpen} primary={row} secondary={linkOpen&&receipt?<ShareLinkBubble key={receipt.sequence} surfaceOwned receipt={receipt} availability={owner.status==='closed'||expired?'inactive':'active'} onDismiss={()=>navigate({type:'close-link'})}/>:null} primaryLabel={`${owner.name}的分身`} secondaryLabel={`${owner.name}的分享链接`} className="sharing-owner-split"/></article>;})}</div>
  {data?.ready&&!data.items.length&&!loading?<p className="sharing-empty">{query?'没有匹配的分身':'还没有分身。创建后，它会留在这里。'}</p>:null}
  {data&&data.total>10?<Pagination page={page} total={data.total} onChange={setPage}/>:null}
 </section>;
 const pane=workspace.pane;
 const service=normalizedAvatarService(draft.service),business=normalizedAvatarBusiness(draft.serviceBusiness),debugKey=editing?.id??`new:${newEditorGeneration}`;
 const changeBusiness=(serviceBusiness:typeof business)=>setDraft({...draft,serviceBusiness,visitorPercent:serviceBusiness.access==='entitlement'?0:draft.visitorPercent,requireLogin:serviceBusiness.access==='entitlement'?true:draft.requireLogin});
 const configForm=<form className="sharing-form avatar-config-form avatar-editor-form" onSubmit={create} aria-busy={busy}><fieldset disabled={busy} className="sharing-editor-fields">
  {editing?<><p className="hint">{privateEditor?'仅保存这个分身的配置，目前不会对外开放。':'更新后原链接不变，历史消耗不清零。访客需重新开始，新版不会带入旧会话资料。有效期从本次发布起算；有问题正在回答时暂不能更新。'}</p>{editing.legacy?<p role="alert">这是旧版发布记录，请重新填写回答要求；旧系统提示词不会重复叠加。</p>:null}</>:null}
  <AvatarEditorSection index="01" title="身份与用途" hint="先让访客知道这是谁的分身，能帮他做什么。">
   <label>分身名称<input required maxLength={60} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="例如：林老师的学习顾问"/></label>
   <label>一句话介绍<input maxLength={300} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})} placeholder="告诉访客适合问什么、能得到什么帮助"/></label>
   <AvatarWelcomeFields section="purpose" value={service} onChange={service=>setDraft({...draft,service})} authorName={data?.authorName} disabled={busy}/>
  </AvatarEditorSection>
  <div className="avatar-editor-section">
   <AvatarMethodFields value={service} onChange={service=>setDraft({...draft,service})} features={data?.availableFeatures??[]} disabled={busy}/>
   <fieldset><legend>连接你的知识库 <span>选填</span></legend>
    {data?.sources.map(s=><label className="sharing-check" key={s.id}><input type="checkbox" checked={draft.sourceIds.includes(s.id)} onChange={e=>setDraft({...draft,sourceIds:e.target.checked?[...draft.sourceIds,s.id]:draft.sourceIds.filter(id=>id!==s.id)})}/>{labels[s.provider]||s.provider} · {s.name}</label>)}
    {!data?.sources.length?<p className="hint">还没有可用连接。你仍可导入上方文档，或粘贴方法资料。</p>:null}
    <small>{privateEditor?'保存后仍未分享。开放分享时会再次确认这些来源和费用；未选择的来源不会读取。':'访客可提问并检索所选连接的全部已授权资料，不是单篇文档。未选择的来源不会读取。'}</small>
   </fieldset>
   {draft.sourceIds.filter(id=>!data?.sources.some(s=>s.id===id)).map(id=><p key={id}>一个原知识连接已不可用。<button type="button" onClick={()=>setDraft({...draft,sourceIds:draft.sourceIds.filter(s=>s!==id)})}>移除该来源</button></p>)}
   <label className="sharing-check"><input type="checkbox" checked={draft.attachments} onChange={e=>setDraft({...draft,attachments:e.target.checked})}/>允许访客上传附件用于问答</label>
  </div>
  <AvatarEditorSection index="03" title="回答方式" hint="这里写给 AI 看，不会作为开场白展示给访客。">
   <label>回答要求<textarea rows={5} maxLength={12000} value={draft.prompt} onChange={e=>setDraft({...draft,prompt:e.target.value})} placeholder={service.mode==='consultation'?'如何了解需求、解释服务边界，什么时候建议联系你本人？':'按什么方法分析、怎样引用资料、成果需要包含什么？'}/></label>
   <div className="sharing-model-field"><span>问答模型</span><SearchPicker label="问答模型" value={draft.modelId} options={models.filter(m=>m.kind==="chat").map(m=>({value:m.id,label:m.name}))} onChange={modelId=>setDraft({...draft,modelId})}/></div>
  </AvatarEditorSection>
  <AvatarEditorSection index="04" title="访客开场" hint="开场白与快捷问题会实时显示在旁边的访客预览里。">
   <AvatarWelcomeFields section="welcome" value={service} onChange={service=>setDraft({...draft,service})} authorName={data?.authorName} disabled={busy}/>
   <button type="button" onClick={()=>setDebugOpen(true)}>在旁边预览并试聊</button>
  </AvatarEditorSection>
  <AvatarEditorSection index="05" title="收费与访问" hint="先设置谁可以使用，再决定是否收费；不会自动代收款或续费。">
   <AvatarBusinessFields section="pricing" mode={service.mode} value={business} onChange={changeBusiness} disabled={busy}/>
   <details><summary>访客的电力与登录设置 · {draft.visitorPercent?`${draft.visitorPercent}%`:'我请客'}</summary>
    <label>访客按 ONE 基础费用的多少百分比消费<input type="number" min="0" max="1000" step="1" value={draft.visitorPercent} onChange={e=>setDraft({...draft,visitorPercent:Number(e.target.value)})}/></label>
    <p className="hint">0 表示你请客；100 表示访客承担基础费用；120 表示加价 20%。加价收益只在实际消费后形成，暂不提现。</p>
    {!data?.visitorPaymentsEnabled?<p>管理员尚未启用访客付费，目前只能设置 0%。</p>:null}
    <label className="sharing-check"><input type="checkbox" checked={draft.requireLogin||business.access==='entitlement'} disabled={business.access==='entitlement'} onChange={e=>setDraft({...draft,requireLogin:e.target.checked})}/>要求访客登录账号</label>
    <label>仅这些已注册账号可以访问（每行一个，留空不限定）<textarea rows={3} value={draft.allowedUsernames.join('\n')} onChange={e=>setDraft({...draft,allowedUsernames:e.target.value.split('\n')})}/></label>
   </details>
   <section className="sharing-budget"><header><span>{privateEditor?'开放分享后的使用额度':'使用额度'}</span><SharingCostHelp/></header>
    <div className="sharing-grid"><label>总电力<input type="number" min="0.01" max="10000" step="0.01" required value={draft.budget} onChange={e=>setDraft({...draft,budget:Number(e.target.value)})}/></label><label>单次电力<input type="number" min="0.01" max={draft.budget} step="0.01" required value={draft.perRun} onChange={e=>setDraft({...draft,perRun:Number(e.target.value)})}/></label><label>有效天数<input type="number" min="1" max="90" required value={draft.days} onChange={e=>setDraft({...draft,days:Number(e.target.value)})}/></label></div>
   </section>
  </AvatarEditorSection>
  <AvatarEditorSection index="06" title="客户信息" hint={service.mode==='consultation'?'让有意向的访客自愿留下需求，方便你本人跟进。':'需要人工辅导或后续服务时，再收集必要的信息。'}>
   <AvatarBusinessFields section="contact" mode={service.mode} value={business} onChange={changeBusiness} disabled={busy}/>
  </AvatarEditorSection>
  {editing?<PublicationHistory api={api} id={editing.id}/>:null}
  <label className="sharing-check"><input required type="checkbox" checked={draft.confirmed} onChange={e=>setDraft({...draft,confirmed:e.target.checked})}/>{privateEditor?'确认分身的知识使用范围；保存不会开放分享，也不会调用模型。':'确认知识范围、收费方式和费用承担规则'}</label>
  {editorError?<p role="alert">{editorError}</p>:null}
  {uncertain?<section className="sharing-uncertain" aria-label="核对发布结果"><p>这次提交的结果尚未确认。先核对列表，避免重复发布同一个分身。</p><div><button type="button" onClick={()=>void checkUncertainResult()}>核对分身列表</button><button type="button" onClick={()=>{uncertainKeys.current.delete(editing?.id??'new');setUncertain(false);setEditorError('');}}>我已核对，恢复编辑</button></div></section>:null}
  <button className="primary" disabled={busy||uncertain||!draft.modelId}>{busy?"正在保存…":privateEditor?editing?"保存配置":"创建分身":editing?"确认更新，保留原链接":"发布并生成链接"}</button>
 </fieldset></form>;
 const editor=<SharingSubview title={editing?`编辑分身 · ${editing.owner.name}`:'创建分身'} busy={busy} headingRef={editorHeading} onClose={()=>{if(!busy)closePane();}}>
  <div className="avatar-editor-workbench" key={debugKey}>
   <div className="avatar-editor-toolbar"><p>{privateEditor?'先配置、再试聊，满意后再决定是否开放分享。':'正在编辑已分享的分身；保存后才对访客生效。'}</p><button type="button" aria-expanded={debugOpen} onClick={()=>setDebugOpen(value=>!value)}>{debugOpen?'收起调试窗口':'打开访客预览与调试'}</button></div>
   <FluidSplitWorkspace className="avatar-editor-split" ratio={.66} open={debugOpen} primary={configForm} secondary={<AvatarDebugPanel api={api} draft={draft} authorName={data?.authorName} modelName={models.find(model=>model.id===draft.modelId)?.name} initialSession={debugSessions.current.get(debugKey)} onSessionChange={session=>debugSessions.current.set(debugKey,session)} onClose={()=>setDebugOpen(false)}/>} primaryLabel="分身配置" secondaryLabel="访客预览与调试"/>
  </div>
 </SharingSubview>;
 const review=<SharingSubview title={`开放分享 · ${publishingOwner?.name??'分身'}`} busy={shareBusy} onClose={()=>{if(!shareBusy)closePane();}}>{shareReview?<section className="sharing-publish-review"><p>这个分身目前只由你管理。确认开放后，持有链接的访客才能按以下范围提问。</p><dl><div><dt>知识范围</dt><dd>{publishingOwner?.sources.join('、')||'不使用个人知识来源'}</dd></div><div><dt>访客附件</dt><dd>{shareReview.attachments?'允许上传，用于访客自己的问答':'不接受附件'}</dd></div><div><dt>费用承担</dt><dd>{shareReview.visitorPercent?`访客按基础费用的 ${shareReview.visitorPercent}% 支付，相关补贴规则保留。`:'实际问答费用由你承担；未发生问答不会扣费。'}</dd></div><div><dt>使用上限</dt><dd>总计 {shareReview.budget} 电力 · 每次 {shareReview.perRun} 电力</dd></div><div><dt>有效期</dt><dd>开放后 {shareReview.days} 天</dd></div><div><dt>访问范围</dt><dd>{shareReview.allowedUsernames?.length?`仅指定账号：${shareReview.allowedUsernames.join('、')}`:shareReview.requireLogin?'访客需要登录':'持有链接的访客'}</dd></div></dl><label className="sharing-check"><input type="checkbox" checked={shareConfirmed} disabled={shareBusy} onChange={event=>setShareConfirmed(event.target.checked)}/>确认开放所列知识范围，并按这些规则承担实际问答费用。</label><button type="button" className="primary" disabled={!shareConfirmed||shareBusy} onClick={()=>void activateShare()}>{shareBusy?'正在核对开放结果…':'开放分享并生成链接'}</button></section>:!shareReviewError?<p role="status">正在核对分身的配置与分享范围…</p>:null}{shareReviewError?<p role="alert">{shareReviewError}</p>:null}</SharingSubview>;
 const secondary=pane?.kind==='close'?<SharingSubview title={`关闭分享 · ${pane.owner.name}`} busy={busy} onClose={closePane}><p>“{pane.owner.name}”的链接将停止服务。已产生的费用和成果保留，不会继续接受新问题。</p><footer className="avatar-dialog-actions"><button type="button" disabled={busy} onClick={closePane}>继续分享</button><button type="button" disabled={busy} onClick={()=>void close(pane.owner)}>关闭分享</button></footer></SharingSubview>:pane?.kind==='publish'?review:pane?.kind==='services'?<SharingSubview title={`${pane.owner.name} · 接入与收益`} onClose={closePane}><AvatarServiceManagement key={pane.owner.id} api={api} id={pane.owner.id}/><details><summary>API、访客赠送与收益</summary><PublicServicePanel api={api} publication={pane.owner}/></details></SharingSubview>:pane?.kind==='usage'?<SharingSubview title={`${pane.owner.name} · 用量`} onClose={closePane}><p>仅显示任务状态和费用，不展示访客原文或附件。</p>{usageError?<div role="alert"><p>{usageError}</p><button type="button" onClick={()=>setUsageRefresh(value=>value+1)}>重新读取用量</button></div>:null}{rows?.items.map(row=><details key={row.id}><summary>{new Date(row.createdAt).toLocaleString()} · {({completed:'完成',running:'进行中',failed:'未完成',interrupted:'已中断'} as Record<string,string>)[row.status]} · {power(row.spent)} 电力</summary><p>任务编号 {row.id}</p><p>预留 {power(row.held)} 电力</p>{row.calls?.map((call,index)=><p key={index}>{call.activity} · {call.model} · {power(call.spent)} 电力</p>)}</details>)}{rows?<Pagination page={usagePage} total={rows.total} onChange={setUsagePage}/>:!usageError?<p role="status">正在读取用量…</p>:null}</SharingSubview>:pane?editor:null;
 return <section ref={panel} className={`sharing-panel market-section sharing-hierarchy ${debugOpen&&(pane?.kind==='create'||pane?.kind==='edit')?'avatar-debug-open':''}`}><FluidSplitWorkspace open={pane!==null} detailKey={pane?`${pane.kind}:${'owner' in pane?pane.owner.id:'new'}`:undefined} ratio={.28} primary={ownerList} secondary={secondary} primaryLabel="我的分身列表" secondaryLabel={pane?.kind==='create'?'创建分身':pane?.kind==='edit'?`${pane.owner.name}的配置`:pane?.kind==='usage'?'分身用量':pane?.kind==='publish'?'开放分身分享':'分身接入与收益'} onSettled={open=>{if(!open&&!workspaceRef.current.pane)dispatch({type:'main-merged'});}} className="sharing-workspace-split"/></section>;
}
function AvatarEditorSection({index,title,hint,children}:{index:string;title:string;hint:string;children:ReactNode}){
 return <section className="avatar-editor-section" aria-label={title}><header className="avatar-editor-section-heading"><span className="avatar-section-index">{index}</span><div><h4>{title}</h4><p>{hint}</p></div></header><div className="avatar-editor-section-body">{children}</div></section>;
}
function SharingSubview({title,onClose,children,busy=false,headingRef}:{title:string;onClose:()=>void;children:ReactNode;busy?:boolean;headingRef?:RefObject<HTMLHeadingElement|null>}) {
 const ownHeading=useRef<HTMLHeadingElement>(null),heading=headingRef??ownHeading;
 return <section className="sharing-subview" aria-label={title}><header><div><button type="button" className="sharing-subview-back" disabled={busy} onClick={onClose}><ArrowLeft size={15}/>收回工作面板</button><h3 tabIndex={-1} ref={heading}>{title}</h3></div></header><div className="sharing-subview-body">{children}</div></section>;
}
function PublicationHistory({ api, id }: {
    api: typeof Api;
    id: string;
}) {
    const [page, setPage] = useState(1), [open, setOpen] = useState(false), [error, setError] = useState(''), [data, setData] = useState<{
        total: number;
        history: {
            version: number;
            name: string;
            prompt: string;
            legacyPrompt: boolean;
            updatedAt: string;
            budget: number;
            perRun: number;
        }[];
    }>();
    useEffect(() => { if (!open)
        return; let active = true; void api<typeof data>(`/api/sharing/manage/${id}/config?page=${page}`).then(v => { if (active)
        setData(v); }).catch(e => { if (active)
        setError(failure(e)); }); return () => { active = false; }; }, [api, id, page, open]);
    return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>历史配置（保留最近 20 版）</summary>{data?.history.map(v => <details key={v.version}><summary>v{v.version} · {v.name} · {new Date(v.updatedAt).toLocaleString()}</summary><p>总额度 {v.budget} · 单次 {v.perRun} 电力</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v.legacyPrompt ? '旧版未独立保存用户回答要求' : v.prompt || '未填写额外回答要求'}</p></details>)}{data && !data.total ? <p>暂无历史版本</p> : null}<button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span> {page} </span><button type="button" disabled={!data || page * 5 >= data.total} onClick={() => setPage(page + 1)}>下一页</button>{error ? <p role="alert">{error}</p> : null}</details>;
}
type Run = {
    id: string;
    operationId: string;
    content: string;
    response?: string;
    status: string;
    stage?: string;
    artifacts?: AvatarArtifact[];
    finishReason?: string;
    error?: string;
    warning?: string;
    createdAt: string;
    chargedMicros?: number;
};
type FileItem = {
    id: string;
    originalName: string;
    status?: string;
    parseError?: string;
};
export function PublicSharingPage({ slug }: {
    slug: string;
}) {
    const [meta, setMeta] = useState<{
        name: string;
        authorName?: string;
        description: string;
        service?: Pick<AvatarServiceConfig, 'mode' | 'welcome' | 'starterQuestions'>;
        attachments: boolean;
        version: number;
        visitorPercent: number;
        requireLogin: boolean;
        paymentEnabled: boolean;
    }>(), [token, setToken] = useState(() => { try {
        return sessionStorage.getItem(`one-guest:${slug}`) || "";
    }
    catch {
        return "";
    } }), [items, setItems] = useState<Run[]>([]), [page, setPage] = useState(1), [total, setTotal] = useState(0), [text, setText] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [files, setFiles] = useState<FileItem[]>([]), [retry, setRetry] = useState<{
        operationId: string;
        content: string;
        attachmentIds: string[];
        confirmedPriceVersion?: number;
        confirmedPayment?: boolean;
    }>(), [paymentConfirmed, setPaymentConfirmed] = useState(false), [restart, setRestart] = useState(false), [needsRestart, setNeedsRestart] = useState(false);
    const live = useRef(true), tokenRef = useRef(token);
    tokenRef.current = token;
    const base = `/api/sharing/${encodeURIComponent(slug)}`;
    async function request<T>(path: string, options: RequestInit = {}, auth = tokenRef.current): Promise<T> { const headers = new Headers(options.headers); if (auth)
        headers.set("Authorization", `Bearer ${auth}`); if (!headers.has("Content-Type"))
        headers.set("Content-Type", "application/json"); const r = await fetch(base + path, { ...options, headers, credentials: "same-origin" }); const d = await r.json(); if(auth&&auth!==tokenRef.current)throw new Error('会话已切换，旧请求不会带入当前会话。'); if (!r.ok) {
        if ((d.code === 'PUBLICATION_UPDATED' || d.code === 'VISITOR_LOGIN_REQUIRED') && live.current) {
            setItems([]);
            setFiles([]);
            setRetry(undefined);
            setNeedsRestart(true);
        }
        throw Object.assign(new Error(d.error || "暂时无法访问"), { status: r.status });
    } return d; }
    async function load() { const d = await request<{
        items: Run[];
        total: number;
    }>(`/session?page=${page}`); if (live.current) {
        setItems(d.items);
        setTotal(d.total);
    } }
    useEffect(() => { live.current = true; void request<typeof meta>("", {}, "").then(d => { if (live.current)
        setMeta(d); }).catch(e => { if (live.current)
        setError(failure(e)); }); return () => { live.current = false; }; }, [slug]);
    useEffect(() => { if (!token)
        return; let cancelled = false; let timer: ReturnType<typeof setTimeout>; async function poll() { try {
        const d = await request<{
            items: Run[];
            total: number;
        }>(`/session?page=${page}`);
        if (cancelled)
            return;
        setItems(d.items);
        setTotal(d.total);
        if (d.items.some(r => r.status === "running"))
            timer = setTimeout(poll, 2500);
    }
    catch (e) {
        if (!cancelled)
            setError(failure(e));
    } } void poll(); return () => { cancelled = true; clearTimeout(timer); }; }, [token, page, busy]);
    async function start() { setBusy(true); setError(""); try {
        const fresh = await request<typeof meta>("", {}, "");
        setMeta(fresh);
        const d = await request<{
            token: string;
        }>("/sessions", { method: "POST" }, "");
        tokenRef.current = d.token;
        setToken(d.token);
        try {
            sessionStorage.setItem(`one-guest:${slug}`, d.token);
        }
        catch { }
        setItems([]);
        setPage(1);
        setText('');
        setFiles([]);
        setRetry(undefined);
        setNeedsRestart(false);
        setRestart(false);
        return true;
    }
    catch (e) {
        setError(failure(e));
        return false;
    }
    finally {
        setBusy(false);
    } }
    async function chooseStarter(question: string) { if (!token && !(await start()))
        return; setText(question); requestAnimationFrame(() => document.getElementById('avatar-question')?.focus()); }
    async function send(e: FormEvent) { e.preventDefault(); if (needsRestart || items.some(r => r.status === 'running') || (!text.trim() && !retry))
        return; setBusy(true); setError(""); const payload = retry || { operationId: crypto.randomUUID(), content: text.trim(), attachmentIds: files.map(f => f.id), confirmedPriceVersion: meta?.version, confirmedPayment: paymentConfirmed }; setRetry(payload); try {
        await request("/questions", { method: "POST", body: JSON.stringify(payload) });
        setRetry(undefined);
        setText("");
        setFiles([]);
        setPage(1);
        await load();
    }
    catch (e) {
        if (e && typeof e === "object" && "status" in e && [400, 401, 402, 403, 404, 410, 413, 422, 429].includes(Number(e.status)))
            setRetry(undefined);
        setError(failure(e));
    }
    finally {
        setBusy(false);
    } }
    async function upload(selected: FileList | null) { if (!selected)
        return; setUploading(true); setError(""); try {
        if (selected.length + files.length > 5)
            throw new Error("每条消息最多 5 个附件");
        for (const file of Array.from(selected)) {
            const created = await request<{
                attachment: FileItem;
            }>("/uploads", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type }) });
            const id = created.attachment.id;
            setFiles(current => [...current, created.attachment]);
            for (let offset = 0; offset < file.size; offset += 4 * 1024 ** 2) {
                await request(`/uploads/${id}/chunks?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + 4 * 1024 ** 2) });
            }
            await request(`/uploads/${id}/complete`, { method: "POST" });
        }
    }
    catch (e) {
        setFiles(current => current.map(f => f.status === "uploading" ? { ...f, status: "failed", parseError: "上传未完成，请移除后重试" } : f));
        setError(failure(e));
    }
    finally {
        setUploading(false);
    } }
    useEffect(() => { const pending = files.filter(f => !["ready", "failed"].includes(f.status || "")); if (!pending.length || uploading)
        return; let cancelled = false; const timer = setTimeout(() => void Promise.all(pending.map(async (f) => (await request<{
        attachment: FileItem;
    }>(`/uploads/${f.id}`)).attachment)).then(results => { if (!cancelled)
        setFiles(current => current.map(f => results.find(r => r.id === f.id) || f)); }).catch(e => { if (!cancelled) {
        setError(failure(e));
        setFiles(current => current.map(f => pending.some(p => p.id === f.id) ? { ...f, status: "failed" } : f));
    } }), 2000); return () => { cancelled = true; clearTimeout(timer); }; }, [files, uploading, token]);
    const running = items.some(r => r.status === "running");
    return <main className="public-sharing-page"><AvatarPublicIdentity name={meta?.name || '正在打开…'} description={meta?.description || ''} authorName={meta?.authorName} mode={meta?.service?.mode}/>
    <p className="sharing-privacy">你正在与 AI 分身交流。问题与附件不会自动发给作者；只有你确认发送的联系表单会交给作者。{meta?.visitorPercent ? `实际使用按 ONE 基础费用的 ${meta.visitorPercent}% 从你的电力扣除；指定赠送额度优先由作者承担。` : '实际使用费用由作者承担。'}</p>
    <VisitorAccountPanel required={!!meta?.requireLogin} onChanged={() => { setToken(''); tokenRef.current = ''; setItems([]); setText(''); setFiles([]); setRetry(undefined); setPaymentConfirmed(false); setError(''); setNeedsRestart(false); try {
        sessionStorage.removeItem(`one-guest:${slug}`);
    }
    catch { } }}/>
    {meta ? <AvatarGuestService key={`${slug}:${token}:${meta.version}`} request={request} token={token} version={meta.version} authorName={meta.authorName} refreshKey={items.filter(r=>r.status!=='running').map(r=>`${r.id}:${r.chargedMicros??0}`).join('|')} onRedeemed={() => void load().catch(e => setError(failure(e)))}/> : null}
    {meta?.visitorPercent ? <label><input type="checkbox" checked={paymentConfirmed} onChange={e => setPaymentConfirmed(e.target.checked)}/>我确认当前版本的收费百分比，并承担实际消耗</label> : null}
    {!items.length && meta ? <section className="avatar-welcome"><p>{meta.service?.welcome || '你好，可以先说说你现在想解决的一件事。'}</p>{meta.service?.starterQuestions?.length ? <div className="avatar-starter-questions" aria-label="从这些问题开始">{meta.service.starterQuestions.map((q, i) => <button type="button" key={i} disabled={busy || running || needsRestart} onClick={() => void chooseStarter(q)}>{q}<span aria-hidden="true">↗</span></button>)}</div> : null}</section> : null}
    {!token ? <button className="primary" disabled={!meta || busy} onClick={() => void start()}>{busy ? '正在连接…' : '开始聊聊'}</button> : <>
      <div className="public-answers" aria-live="polite">{items.slice().reverse().map(r => <article key={r.id}><p className="public-question">{r.content}</p>{r.status === 'running' ? <p className="avatar-run-progress" role="status"><span aria-hidden="true"/>{avatarRunProgress(r.stage)}</p> : null}<div className="markdown-body"><MessageMarkdown allowImages={false}>{r.response || r.error || (r.status === 'running' ? '' : '这次还没做完，可以补充要求后继续。')}</MessageMarkdown></div>{r.artifacts?.length ? <AvatarArtifacts artifacts={r.artifacts} runId={r.id} base={base} token={token}/> : null}{r.status !== 'running' ? <small>{r.chargedMicros ? `本次消耗 ${power(r.chargedMicros)} 电力` : '本次没有从你的钱包扣除已结算费用'}</small> : null}{r.warning ? <p role="status">{r.warning}</p> : null}{r.finishReason === "length" ? <p>回答还没展开完，可以发送“继续”接着聊。</p> : null}</article>)}</div>
      {total > 10 && !running ? <Pagination page={page} total={total} onChange={setPage}/> : null}
      <form className="public-composer" onSubmit={send}><label className="avatar-composer-label" htmlFor="avatar-question">{running ? '可以先想想下一问，当前问题还在处理' : '说说你想解决的事'}</label><textarea id="avatar-question" aria-label="问题" rows={3} maxLength={6000} value={text} onChange={e => setText(e.target.value)} disabled={!!retry || needsRestart} placeholder="从你的实际情况说起…"/>
        {files.map(f => <div className="sharing-file" key={f.id}><span>{f.originalName} · {f.status === "ready" ? "已就绪" : f.status === "failed" ? f.parseError || "未完成" : "处理中…"}</span><button type="button" disabled={uploading || busy || !!retry} onClick={() => setFiles(current => current.filter(x => x.id !== f.id))}>移除</button></div>)}
        <footer>{meta?.attachments ? <label className="sharing-upload">添加附件<input type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.webp,.gif" disabled={busy || uploading || running || !!retry || needsRestart} onChange={e => { void upload(e.target.files); e.target.value = ""; }}/></label> : null}<button className="primary" disabled={busy || uploading || running || needsRestart || files.some(f => f.status !== "ready") || (!text.trim() && !retry) || !!meta?.visitorPercent && !paymentConfirmed}>{busy ? '正在提交…' : retry ? '找回这次提交' : '发送'}</button></footer>
        {retry && !busy ? <p className="hint" role="status">提交结果尚未确认，先找回这次请求，不会再做一份。</p> : null}
        {meta?.attachments ? <small>最多 5 个附件，单文件 200 MB；图片 20 MB。只用于本会话问答。</small> : null}
      </form></>}
    {error ? <div className="avatar-public-error" role="alert"><p>{error}</p>{token ? <div>{!needsRestart ? <button type="button" disabled={busy || uploading} onClick={() => void load().then(() => setError('')).catch(e => setError(failure(e)))}>查看最新进展</button> : null}<button type="button" disabled={busy || uploading || running || !!retry} onClick={() => setRestart(true)}>开启新会话</button></div> : null}</div> : null}
    {restart ? <SettingsDialog title="开启一段新会话？" onClose={() => { if (!busy)
        setRestart(false); }}><p>新会话不会带入当前问题和附件。当前记录不会删除，但请先保存需要的成果。</p><footer className="avatar-dialog-actions"><button type="button" data-dialog-focus disabled={busy} onClick={() => setRestart(false)}>留在这里</button><button type="button" disabled={busy} onClick={() => void start()}>开启新会话</button></footer></SettingsDialog> : null}
  </main>;
}
