import {useEffect,useRef,useState,type ReactNode,type Ref} from 'react';
import {ChevronLeft,ChevronRight,Menu,Search} from 'lucide-react';
import type {api as Api} from './oneApi';
import {ApiError} from './oneApi';
import {FluidSplitWorkspace} from './fluid/FluidSplitWorkspace';
import {getNotePollFailureAction,prepareGetNoteAuthorizationWindow} from './getNoteAuthorization';
import {waitingForOfficialApproval,officialApprovalLabel,officialApprovalHint} from './knowledgeAvailability';
import {NotionWritingSettings} from './DocumentDestination';
import {EnterpriseKnowledgeCard,FlomoConnectionNotice} from './EnterpriseConnectionNotice';
import {FeishuConnection} from './FeishuConnection';
import './knowledge-connections.css';

export type KnowledgeConnection={provider:'getnote'|'notion'|'yinxiang'|'flowus'|'flomo';status:'disconnected'|'pending'|'connected'|'error'|'revoked';providerSpaceName?:string;credentialExpiresAt?:string;lastCheckedAt?:string;lastError?:string};
type GetNoteDeviceFlow={flowId:string;verificationUri:string;userCode:string;expiresIn:number;interval:number};
type ReturnOutcome={notion:string|null;provider:string|null;status:string|null};
const providerLabels:Record<string,string>={getnote:'得到大脑',notion:'Notion',yinxiang:'印象笔记',flowus:'息流 FlowUs',flomo:'flomo',feishu:'飞书',dingtalk:'钉钉',wechat:'微信'};
export function KnowledgeDetail({title,status,onClose,children,headingRef}:{title:string;status?:ReactNode;onClose:()=>void;children:ReactNode;headingRef?:Ref<HTMLHeadingElement>}){
 return <section className="knowledge-inline-detail"><button className="feature-workflow-back" type="button" onClick={onClose}><ChevronLeft size={16}/>收回连接详情</button><header className="knowledge-detail-heading"><h3 ref={headingRef} tabIndex={-1} className="knowledge-detail-title">{title}</h3>{status}</header>{children}</section>;
}

/** Only the already identity-bound API is accepted. Opening details never authorizes. */
export function KnowledgeConnections({api,onOpenSidebar,onConnectionChange,returnOutcome,inline=false}:{api:typeof Api;onOpenSidebar:()=>void;onConnectionChange?:(connection:KnowledgeConnection)=>void;returnOutcome?:ReturnOutcome;inline?:boolean}){
 const [selectedProvider,setSelectedProvider]=useState(()=>returnOutcome?.notion?'notion':returnOutcome?.provider||'');
 const [providerQuery,setProviderQuery]=useState(''),[providerFilter,setProviderFilter]=useState('all');
 const [connection,setConnection]=useState<KnowledgeConnection>({provider:'getnote',status:'disconnected'});
 const [remoteConnections,setRemoteConnections]=useState<Record<'notion'|'yinxiang'|'flowus'|'flomo',KnowledgeConnection>>({notion:{provider:'notion',status:'disconnected'},yinxiang:{provider:'yinxiang',status:'disconnected'},flowus:{provider:'flowus',status:'disconnected'},flomo:{provider:'flomo',status:'disconnected'}});
 const [configured,setConfigured]=useState(false),[remoteConfigured,setRemoteConfigured]=useState<Record<'notion'|'yinxiang'|'flowus'|'flomo',boolean>>({notion:false,yinxiang:false,flowus:false,flomo:false});
 const [remoteBusy,setRemoteBusy]=useState<'notion'|'yinxiang'|'flowus'|'flomo'|''>(''),[testConnectAvailable,setTestConnectAvailable]=useState(false);
 const [flow,setFlow]=useState<GetNoteDeviceFlow|null>(null),[polling,setPolling]=useState(false),[notices,setNotices]=useState<Record<string,string>>({}),[getNoteBusy,setGetNoteBusy]=useState(false);
 const getNoteRequest=useRef(false),remoteRequest=useRef(false);
 const root=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null),opener=useRef<HTMLElement|null>(null),lastProvider=useRef(selectedProvider);
 const [enterpriseHost,setEnterpriseHost]=useState<HTMLDivElement|null>(null);
 if(selectedProvider)lastProvider.current=selectedProvider;
 function note(owner:string,text:string){setNotices(previous=>({...previous,[owner]:text}));}
 function selectProvider(provider:string,source?:HTMLElement){if(source)opener.current=source;setSelectedProvider(provider);}
 function closeDetail(){
  const secondary=root.current?.querySelector<HTMLElement>('.fluid-split-secondary');
  if(secondary?.contains(document.activeElement)){
   const target=opener.current?.isConnected?opener.current:root.current?.querySelector<HTMLElement>('input[type="search"]');target?.focus({preventScroll:true});
  }
  setSelectedProvider('');
 }
 // Initial reveal is focused by FluidSplitWorkspace as soon as it becomes
 // interactive. Only a source switch on an already open pane needs help.
 useEffect(()=>{if(!selectedProvider)return;const source=opener.current;const frame=requestAnimationFrame(()=>{if(document.activeElement===source&&root.current?.querySelector('.fluid-split-secondary[aria-hidden="false"]'))heading.current?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[selectedProvider]);

  async function load() {
    const providers = ["notion", "yinxiang", "flowus", "flomo"] as const;
    const [getNoteResult, ...remoteResults] = await Promise.allSettled([
      api<{ connection: KnowledgeConnection; configured: boolean; testConnectAvailable?: boolean }>("/api/knowledge/connections/getnote"),
      ...providers.map(provider => api<{ connection: KnowledgeConnection; configured: boolean }>(`/api/knowledge/connections/${provider}`))
    ]);
    if (getNoteResult.status === "fulfilled") {
      setConnection(getNoteResult.value.connection);
      setConfigured(getNoteResult.value.configured);
      setTestConnectAvailable(Boolean(getNoteResult.value.testConnectAvailable));
      onConnectionChange?.(getNoteResult.value.connection);
    } else {
      setConfigured(false);
    }
    const nextConnections = { ...remoteConnections };
    const nextConfigured = { ...remoteConfigured };
    providers.forEach((provider, index) => {
      const result = remoteResults[index];
      if (result.status === "fulfilled") { nextConnections[provider] = result.value.connection; nextConfigured[provider] = result.value.configured; onConnectionChange?.(result.value.connection); }
      else nextConfigured[provider] = false;
    });
    setRemoteConnections(nextConnections);
    setRemoteConfigured(nextConfigured);
    if (getNoteResult.status === "rejected") throw getNoteResult.reason;
  }

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("notion") || returnOutcome?.notion;
    if (outcome) {
      note("notion", outcome === "connected" ? "Notion 已连接" : outcome === "cancelled" ? "Notion 授权已取消" : "Notion 授权未完成，请重试。");
      const url = new URL(window.location.href);
      url.searchParams.delete("notion");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("knowledge") || returnOutcome?.provider;
    const status = params.get("status") || returnOutcome?.status;
    if ((provider === "yinxiang" || provider === "flowus" || provider === "flomo" || provider === "feishu") && status) {
      const label = provider === "yinxiang" ? "印象笔记" : provider === "feishu" ? "飞书" : provider === "flomo" ? "flomo" : "息流 FlowUs";
      note(provider, status === "connected" ? `${label} 已连接` : status === "cancelled" ? `${label} 授权已取消` : provider === "flomo" ? "flomo 授权未完成，请确认 MAX 会员并重试。" : `${label} 授权未完成，请重试。`);
      const url = new URL(window.location.href); url.searchParams.delete("knowledge"); url.searchParams.delete("status"); window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    load().catch((err) => note("getnote", err.message));
  }, []);

  useEffect(() => {
    if (!flow || !polling) return;
    let cancelled = false;
    const delay = Math.max(5, flow.interval || 5) * 1000;
    const expiresAt = Date.now() + flow.expiresIn * 1000;
    let retries = 0;
    let timer: number;
    async function poll() {
      if (cancelled) return;
      if (Date.now() >= expiresAt) { setFlow(null); setPolling(false); note("getnote", "授权已过期，请重新连接。"); return; }
      try {
        const result = await api<{ status?: "pending"; phase?: "provider_retry" | "verifying"; retryAfterSeconds?: number; connection?: KnowledgeConnection }>(`/api/knowledge/connections/getnote/device-flow/${encodeURIComponent(flow!.flowId)}/poll`, { method: "POST" });
        if (cancelled) return;
        if (result.connection) {
          setConnection(result.connection);
          onConnectionChange?.(result.connection);
          setFlow(null);
          setPolling(false);
          note("getnote", "得到大脑已连接");
        } else {
          retries = 0;
          if (result.phase === "verifying") note("getnote", "正在确认知识权限…");
          else if (result.phase === "provider_retry") note("getnote", "连接不稳定，正在重试…");
          timer = window.setTimeout(poll, Math.max(delay, (result.retryAfterSeconds || 0) * 1000));
        }
      } catch (err) {
        if (cancelled) return;
        const action = getNotePollFailureAction(err);
        if (action === "retry_key") {
          note("getnote", "请插入 ONE Key。插入后会继续。");
          timer = window.setTimeout(poll, delay);
        } else if (action === "retry_provider") {
          note("getnote", "连接不稳定，正在重试…");
          timer = window.setTimeout(poll, Math.min(30000, delay * 2 ** ++retries));
        } else if (err instanceof ApiError && [400, 401, 403, 404, 410, 502, 503].includes(err.status || 0)) {
          setFlow(null); setPolling(false); note("getnote", err.message);
        } else {
          note("getnote", "连接不稳定，正在重试…");
          timer = window.setTimeout(poll, Math.min(30000, delay * 2 ** ++retries));
        }
      }
    }
    timer = window.setTimeout(poll, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [flow, polling]);

  async function connect() {
    if (getNoteRequest.current || flow) return;
    getNoteRequest.current = true;
    setGetNoteBusy(true);
    note("getnote", "");
    let authorizationWindow = null as ReturnType<typeof prepareGetNoteAuthorizationWindow>;
    if (!testConnectAvailable) {
      authorizationWindow = prepareGetNoteAuthorizationWindow((url, target) => window.open(url, target) as ReturnType<typeof prepareGetNoteAuthorizationWindow>);
    }
    try {
      if (testConnectAvailable) {
        const result = await api<{ connection: KnowledgeConnection }>("/api/knowledge/connections/getnote/test-connect", { method: "POST" });
        setConnection(result.connection);
        onConnectionChange?.(result.connection);
        note("getnote", "测试知识已连接");
        return;
      }
      const result = await api<GetNoteDeviceFlow>("/api/knowledge/connections/getnote/device-flow", { method: "POST" });
      setFlow(result);
      setPolling(true);
      if (authorizationWindow && !authorizationWindow.closed) authorizationWindow.location.replace(result.verificationUri);
      else note("getnote", "点击“打开得到大脑”完成授权。");
    } catch (err) {
      authorizationWindow?.close();
      note("getnote", err instanceof Error ? err.message : "无法发起授权");
    } finally {
      getNoteRequest.current = false;
      setGetNoteBusy(false);
    }
  }

  async function disconnect() {
    if (getNoteRequest.current || !confirm("断开得到大脑？")) return;
    getNoteRequest.current = true;setGetNoteBusy(true);note("getnote", "");
    try {
      await api("/api/knowledge/connections/getnote", { method: "DELETE" });
      setFlow(null);setPolling(false);await load();note("getnote", "得到大脑已断开");
    } catch (error) {
      note("getnote", error instanceof Error ? error.message : "无法断开得到大脑");
    } finally {getNoteRequest.current = false;setGetNoteBusy(false);}
  }

  async function cancelGetNoteFlow() {
    const current = flow;
    setFlow(null);
    setPolling(false);
    note("getnote", "");
    if (!current) return;
    try {
      await api(`/api/knowledge/connections/getnote/device-flow/${encodeURIComponent(current.flowId)}`, { method: "DELETE" });
      await load();
    } catch (error) {
      note("getnote", error instanceof Error ? error.message : "无法取消授权");
    }
  }

  async function connectRemote(provider: "notion" | "yinxiang" | "flowus" | "flomo") {
    if (remoteRequest.current) return;
    remoteRequest.current = true;
    note(provider, "");
    setRemoteBusy(provider);
    try {
      const result = await api<{ authorizationUrl: string }>(`/api/knowledge/connections/${provider}/oauth/start`, { method: "POST" });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      remoteRequest.current = false;
      setRemoteBusy("");
      note(provider, err instanceof Error ? err.message : "无法发起授权");
    }
  }

  async function disconnectRemote(provider: "notion" | "yinxiang" | "flowus" | "flomo", label: string) {
    if (remoteRequest.current || !confirm(`断开 ${label}？`)) return;
    remoteRequest.current = true;setRemoteBusy(provider);note(provider, "");
    try {
      await api(`/api/knowledge/connections/${provider}`, { method: "DELETE" });await load();note(provider, `${label} 已断开`);
    } catch (error) {
      note(provider, error instanceof Error ? error.message : `无法断开 ${label}`);
    } finally {remoteRequest.current = false;setRemoteBusy("");}
  }

 const providers=[{id:'getnote',label:'得到大脑',note:'笔记与语义搜索',item:connection},{id:'notion',label:'Notion',note:'页面与工作区',item:remoteConnections.notion},{id:'yinxiang',label:'印象笔记',note:'笔记与笔记本',item:remoteConnections.yinxiang},{id:'flowus',label:'息流 FlowUs',note:'页面与知识空间',item:remoteConnections.flowus},{id:'flomo',label:'flomo',note:'笔记搜索 · 需 MAX 会员',item:remoteConnections.flomo}];
 const primary=<div className="knowledge-source-list-anchor">
  <div className="knowledge-catalog-toolbar"><div className="settings-search"><Search size={17}/><input type="search" aria-label="搜索知识来源" placeholder="搜索知识来源" value={providerQuery} onChange={event=>setProviderQuery(event.target.value)}/></div><div className="settings-tabs" aria-label="连接状态">{[['all','全部'],['connected','已连接'],['disconnected','未连接']].map(([id,label])=><button type="button" key={id} aria-pressed={providerFilter===id} onClick={()=>setProviderFilter(id)}>{label}</button>)}</div></div>
  <div className="knowledge-catalog">{providers.filter(provider=>`${provider.label} ${provider.id}`.toLowerCase().includes(providerQuery.trim().toLowerCase())&&(providerFilter==='all'||(providerFilter==='connected'?provider.item.status==='connected':provider.item.status!=='connected'))).map(provider=><button type="button" className={`knowledge-source-card${selectedProvider===provider.id?' is-selected':''}`} key={provider.id} aria-expanded={selectedProvider===provider.id} onClick={event=>selectProvider(provider.id,event.currentTarget)}><span className={`knowledge-source-mark ${provider.id}`}>{provider.label.slice(0,1)}</span><span><strong>{provider.label}</strong><small>{provider.note}</small></span><span className={`knowledge-source-status ${provider.item.status}`}>{waitingForOfficialApproval(provider.id,remoteConfigured.yinxiang,provider.item.status)?officialApprovalLabel:provider.item.status==='connected'?'已连接':provider.item.status==='pending'?'授权中':provider.item.status==='error'?'需重连':'连接'}<ChevronRight size={14}/></span></button>)}
   <FeishuConnection api={api} query={providerQuery} filter={providerFilter} open={selectedProvider==='feishu'} onOpenChange={(open,source)=>open?selectProvider('feishu',source):closeDetail()} detailTarget={lastProvider.current==='feishu'?enterpriseHost:null}/>
   <EnterpriseKnowledgeCard id="dingtalk" label="钉钉" query={providerQuery} filter={providerFilter} open={selectedProvider==='dingtalk'} onOpenChange={(open,source)=>open?selectProvider('dingtalk',source):closeDetail()} detailTarget={lastProvider.current==='dingtalk'?enterpriseHost:null}/>
   <EnterpriseKnowledgeCard id="wechat" label="微信" query={providerQuery} filter={providerFilter} open={selectedProvider==='wechat'} onOpenChange={(open,source)=>open?selectProvider('wechat',source):closeDetail()} detailTarget={lastProvider.current==='wechat'?enterpriseHost:null}/>
  </div>
 </div>;
 const notice=notices[selectedProvider]||'';
 let detail:ReactNode=null,detailStatus:ReactNode=null;
 if(selectedProvider==='getnote')detailStatus=<span className={`provider-status ${connection.status}`}>{connection.status==='connected'?'已连接':connection.status==='pending'?'授权中':connection.status==='error'?'需重连':'未连接'}</span>;
 if(selectedProvider==='getnote')detail=<>
  <section className="knowledge-connection-detail">
   {connection.status==='connected'?<button className="danger" type="button" disabled={getNoteBusy} onClick={()=>void disconnect()}>断开连接</button>:<>
    {connection.status==='error'&&connection.lastError?<p className="error" role="alert">{connection.lastError}</p>:null}
    <p className="hint">请先开通得到大脑会员，再完成官方授权。</p><button className="primary" type="button" disabled={!configured||Boolean(flow)||getNoteBusy} onClick={()=>void connect()}>{getNoteBusy?'正在打开授权…':testConnectAvailable?'一键连接测试知识':'连接得到大脑'}</button>
    {testConnectAvailable?<div className="notice">测试连接 · 使用管理员预置账号</div>:null}{!configured?<p className="hint">此知识连接暂未开通，请联系管理员。</p>:null}
    {flow?<div className="notice knowledge-device-flow">授权码：<strong>{flow.userCode}</strong><span>{Math.max(1,Math.ceil(flow.expiresIn/60))} 分钟内完成</span><a href={flow.verificationUri} target="_blank" rel="noreferrer">打开得到大脑</a><button type="button" onClick={()=>void cancelGetNoteFlow()}>取消</button></div>:null}
   </>}
  </section>
 </>;
 const remoteProvider=([{id:'notion',label:'Notion'},{id:'yinxiang',label:'印象笔记'},{id:'flowus',label:'息流 FlowUs'},{id:'flomo',label:'flomo'}] as const).find(provider=>provider.id===selectedProvider);
 if(remoteProvider){const provider=remoteProvider,item=remoteConnections[provider.id],awaitingApproval=waitingForOfficialApproval(provider.id,remoteConfigured[provider.id],item.status);detailStatus=<span className={`provider-status ${item.status}`}>{awaitingApproval?officialApprovalLabel:item.status==='connected'?'已连接':item.status==='pending'?'授权中':item.status==='error'?'需重连':'未连接'}</span>;detail=<section className="knowledge-connection-detail">
  {item.status!=='connected'?<p className="knowledge-connection-purpose">{provider.id==='notion'?'连接后，ONE 可以按你的请求查阅已授权的页面。写入页面需要另行设置，你也可以随时断开连接。':'连接后，ONE 会按你的问题搜索相关笔记。此连接只读，不会修改或删除内容。'}</p>:null}
  {provider.id==='flomo'?<FlomoConnectionNotice/>:null}
  {item.status==='connected'?<><div className="notice">工作区：{item.providerSpaceName||provider.label}</div><p className="hint">{provider.id==='notion'?'可搜索已授权页面。':'只读：ONE 会按需搜索相关内容，不会修改或删除内容。'}</p>{provider.id==='notion'?<NotionWritingSettings api={api}/>:null}<button className="danger" type="button" disabled={Boolean(remoteBusy)} onClick={()=>void disconnectRemote(provider.id,provider.label)}>断开连接</button></>:<><button className="primary" type="button" disabled={!remoteConfigured[provider.id]||Boolean(remoteBusy)} onClick={()=>void connectRemote(provider.id)}>{awaitingApproval?officialApprovalLabel:remoteBusy===provider.id?`正在打开 ${provider.label}…`:`连接 ${provider.label}`}</button>{!remoteConfigured[provider.id]?<p className="hint">{awaitingApproval?officialApprovalHint:`${provider.label} 连接暂未开通，请联系管理员。`}</p>:null}</>}
 </section>;}
 const enterprise=['feishu','dingtalk','wechat'].includes(selectedProvider);
 const secondary=selectedProvider&&providerLabels[selectedProvider]?<KnowledgeDetail title={providerLabels[selectedProvider]} status={detailStatus} headingRef={heading} onClose={closeDetail}>{enterprise?<div ref={setEnterpriseHost} className="knowledge-enterprise-host"/>:detail}{notice?<p className={`knowledge-owner-notice ${/失败|无法|过期|不稳定|尚未配置|未完成|还没有会员|请联系/.test(notice)?'error':'notice'}`} role="status">{notice}</p>:null}</KnowledgeDetail>:null;
 return <section ref={root} className={`account-page knowledge-page knowledge-connections${selectedProvider?' has-detail':''}`} data-inline={inline}>
  <header className="admin-header"><button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20}/></button><div><h2>知识来源</h2></div></header>
  <div className="account-body knowledge-catalog-body"><FluidSplitWorkspace open={Boolean(secondary)} detailKey={selectedProvider} primary={primary} secondary={secondary} ratio={.40} primaryLabel="知识来源列表" secondaryLabel="连接与授权详情" className="knowledge-connections-split"/></div>
 </section>;
}
