import { useEffect, useState } from "react";
import type { api as Api } from "./oneApi";
import { Pagination, SettingsDialog } from "./SettingsControls";
import { ToolCredentialEditor, MyToolCredentials } from './FeatureConnections';
import {featureCategories} from '../server/featureCategories';
import {ArrowUpRight,BookOpen,Sparkles} from 'lucide-react';

type Feature={id:string;releaseId:string;version:number;name:string;description:string;author:string;category?:string;limitations:string;knowledgeMode:string;destinations:string[];credentials?:{endpoint:string;auth:'bearer'|'api_key'}[];sources?:{id:string;name:string}[]};
type Run={operationId:string;name:string;version:number;status:string;createdAt:string;power:number;prompt?:string;content?:string;error?:string;finishReason?:string;trace?:{tool:string;query?:string;resultPreview:string;status:string}[];charges?:{model:string;power:number;status:string}[]};
const status:Record<string,string>={pending:'执行中',completed:'已完成',failed:'未完成',interrupted:'已中断'};

export function FeatureCatalog({api,query:q='',category='all',equipment=false}:{api:typeof Api;query?:string;category?:string;equipment?:boolean}) {
  const [page,setPage]=useState(1),[runPage,setRunPage]=useState(1),[refresh,setRefresh]=useState(0);
  const [list,setList]=useState<{items:Feature[];total:number}>({items:[],total:0}),[runs,setRuns]=useState<{items:Run[];total:number}>({items:[],total:0}),[selected,setSelected]=useState<string>(),[operation,setOperation]=useState<string>(),[error,setError]=useState('');
  useEffect(()=>setPage(1),[q,category]);
  useEffect(()=>{let live=true;void api<typeof list>(`/api/features?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&page=${page}`).then(d=>{if(live){setList(d);setError('');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,q,category,page,refresh]);
  useEffect(()=>{let live=true;void api<typeof runs>(`/api/features/runs?page=${runPage}`).then(d=>{if(live)setRuns(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,runPage,refresh]);
  return <section className={`market-section ${equipment?'equipment-catalog':''}`}><header className="section-toolbar"><h3>{equipment?'我的功能':'官方精选'}</h3><span className="market-count">{list.total} 项</span></header>
    {equipment?<div className="equipment-groups">{featureCategories.map(c=>{const items=list.items.filter(f=>(f.category??'general')===c.id);return items.length?<details className="equipment-group" key={c.id} open><summary>{c.name}<span>{items.length} 项 · 本页</span></summary><div className="equipment-grid">{items.map(f=><button type="button" className="equipment-card" key={f.id} onClick={()=>setSelected(f.id)} aria-label={`查看能力：${f.name}`}><span className="market-icon">{f.knowledgeMode==='required'?<BookOpen size={19}/>:<Sparkles size={19}/>}</span><strong>{f.name}</strong><small>{f.author}</small><span className="equipment-inspect">查看 <ArrowUpRight size={12}/></span></button>)}</div></details>:null;})}</div>:<div className="market-grid">{list.items.map(f=><button className="market-card" type="button" key={f.id} onClick={()=>setSelected(f.id)}><span className="market-card-top"><span className="market-icon">{f.knowledgeMode==='required'?<BookOpen size={21}/>:<Sparkles size={21}/>}</span><span className="market-badge">{featureCategories.find(c=>c.id===f.category)?.name??'通用助手'}</span></span><strong>{f.name}</strong><p>{f.description}</p><span className="market-card-footer"><small>{f.author} · v{f.version}</small><span>打开 <ArrowUpRight size={15}/></span></span></button>)}</div>}
    {!list.total&&!error?<div className="market-empty"><Sparkles size={22}/><strong>{q||category!=='all'?'没有匹配的功能':'即将上线'}</strong></div>:null}{list.total>10?<Pagination page={page} total={list.total} onChange={setPage}/>:null}
    <div className="market-utilities"><details className="quiet-details"><summary>任务记录 · {runs.total}</summary><button type="button" onClick={()=>setRefresh(n=>n+1)}>刷新任务</button><div className="settings-choice-list">{runs.items.map(r=><button type="button" key={r.operationId} onClick={()=>setOperation(r.operationId)}><span><strong>{r.name} · v{r.version}</strong><small>{new Date(r.createdAt).toLocaleString()} · {status[r.status]} · {r.power.toFixed(6)} 电力</small></span><span>查看</span></button>)}</div>{runs.total>10?<Pagination page={runPage} total={runs.total} onChange={setRunPage}/>:null}</details><MyToolCredentials api={api}/></div>
    {error?<p role="alert">{error}</p>:null}
    {selected?<SettingsDialog title={equipment?'能力详情':'使用精选功能'} onClose={()=>setSelected(undefined)}><FeatureLaunch inspectFirst={equipment} api={api} id={selected} onStarted={id=>{setSelected(undefined);setOperation(id);setRefresh(n=>n+1);}}/></SettingsDialog>:null}
    {operation?<SettingsDialog title="功能任务" onClose={()=>{setOperation(undefined);setRefresh(n=>n+1);}}><FeatureRunView api={api} operationId={operation}/></SettingsDialog>:null}
  </section>;
}
function FeatureLaunch({api,id,onStarted,inspectFirst=false}:{api:typeof Api;id:string;onStarted:(id:string)=>void;inspectFirst?:boolean}) {
  const [launch,setLaunch]=useState(!inspectFirst);
  const [feature,setFeature]=useState<Feature>(),[sources,setSources]=useState<string[]>([]),[prompt,setPrompt]=useState(''),[budget,setBudget]=useState('0.1'),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [attempt,setAttempt]=useState<{operationId:string;payload:string}>();
  useEffect(()=>{let live=true;void api<Feature>(`/api/features/${id}`).then(d=>{if(live)setFeature(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,id]);
  async function start() {
    if(!feature)return;setBusy(true);setError('');
    const payload=JSON.stringify({releaseId:feature.releaseId,prompt,budget:Number(budget),sourceIds:sources,confirmed});
    if(attempt&&attempt.payload!==payload){setError('上一次提交结果待确认，请先在任务记录查看，再重新打开功能。');setBusy(false);return;}
    const operationId=attempt?.operationId??crypto.randomUUID();setAttempt({operationId,payload});
    try{const r=await api<Run>(`/api/features/${id}/runs`,{method:'POST',body:JSON.stringify({...JSON.parse(payload),operationId})});onStarted(r.operationId);}catch(e){setError(e instanceof Error?e.message:'提交未确认，请查看任务记录；重试保留同一任务编号。');}finally{setBusy(false);}
  }
  if(feature&&!launch)return <div className="sharing-form"><h3>{feature.name}</h3><p>{feature.description}</p><p>{feature.limitations}</p><div className="equipment-status"><span>已为你开放</span><span>对话自动调用 · 待接入</span></div><details className="quiet-details"><summary>使用范围</summary><p>{feature.knowledgeMode==='required'?'需要选择你的知识来源':feature.knowledgeMode==='optional'?'可按任务选择知识来源':'不要求个人知识来源'}</p><p>{feature.destinations.length?`外部只读接口：${feature.destinations.join('、')}`:'无外部数据接口'}</p><p>按实际用量计费，单独运行前需要确认电力上限。</p></details><button type="button" onClick={()=>setLaunch(true)}>单独运行</button>{error?<p role="alert">{error}</p>:null}</div>;
  return <div className="sharing-form">{feature?<><h3>{feature.name}</h3><p>{feature.description}</p><p className="hint">{feature.limitations}</p>
    {feature.knowledgeMode!=='none'?<fieldset disabled={busy||!!attempt}><legend>使用我的知识{feature.knowledgeMode==='required'?'（必选）':'（可选）'}</legend><p className="hint">仅本次选中的连接。范围为该账号已授权的全部可搜索资料，不是单篇笔记。</p>{feature.sources?.map(s=><label className="sharing-check" key={s.id}><input type="checkbox" checked={sources.includes(s.id)} onChange={e=>setSources(e.target.checked?[...sources,s.id]:sources.filter(id=>id!==s.id))}/>{s.name}</label>)}{!feature.sources?.length?<p>暂无已连接来源，请先到设置连接知识平台。</p>:null}</fieldset>:null}
    {feature.credentials?.filter((c,i,all)=>all.findIndex(x=>x.endpoint===c.endpoint&&x.auth===c.auth)===i).map(c=><ToolCredentialEditor key={`${c.endpoint}:${c.auth}`} api={api} endpoint={c.endpoint} auth={c.auth}/>)}
    <label>要完成的任务<textarea rows={4} maxLength={4000} value={prompt} disabled={busy||!!attempt} onChange={e=>setPrompt(e.target.value)}/></label>
    <label>本次电力上限<input type="number" min="0.001" max="10" step="0.001" disabled={busy||!!attempt} value={budget} onChange={e=>setBudget(e.target.value)}/></label>
    <p className="hint">按实际模型用量从你的余额扣除。失败或中断也可能已有用量。执行期间请保持 Key 插着。</p>
    {feature.destinations.length?<details><summary>外部工具与数据去向 · {feature.destinations.length}</summary><p>执行任务所需的参数可能包含你输入或所选知识中的资料，并发送给以下只读接口；不要提交未经许可外发的内容。</p>{feature.destinations.map(d=><p key={d} style={{overflowWrap:'anywhere'}}>{d}</p>)}</details>:null}
    <label className="sharing-check"><input type="checkbox" checked={confirmed} disabled={busy||!!attempt} onChange={e=>setConfirmed(e.target.checked)}/>我确认知识与外部工具使用范围，实际电力由我承担。</label>
    <button type="button" className="primary" disabled={busy||!confirmed||!prompt.trim()||(feature.knowledgeMode==='required'&&!sources.length)||!Number.isFinite(Number(budget))||Number(budget)<.001||Number(budget)>10} onClick={()=>void start()}>{busy?'正在提交…':attempt?'确认上次提交（不重复执行）':'开始任务'}</button>
    {attempt?<button type="button" disabled={busy} onClick={()=>onStarted(attempt.operationId)}>查看上次任务</button>:null}</>:<p>正在加载配置…</p>}{error?<p role="alert">{error}</p>:null}</div>;
}
function FeatureRunView({api,operationId}:{api:typeof Api;operationId:string}) {
  const [result,setResult]=useState<Run>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;async function poll(){try{const r=await api<Run>(`/api/features/runs/${operationId}`);if(!live)return;setResult(r);setError('');if(r.status==='pending')timer=setTimeout(()=>void poll(),2500);}catch(e){if(live)setError(e instanceof Error?e.message:'无法读取结果');}}void poll();return()=>{live=false;clearTimeout(timer);};},[api,operationId,refresh]);
  return <div className="sharing-form"><button type="button" onClick={()=>setRefresh(n=>n+1)}>检查状态</button>{error?<p role="alert">{error}</p>:null}{result?<><h3>{result.name} · v{result.version}</h3><p>{status[result.status]} · {result.power.toFixed(6)} 电力</p>{result.status==='pending'?<p>正在执行，可关闭窗口，稍后在“我的功能任务”找回结果。不会因刷新而重跑。</p>:null}<details><summary>任务内容</summary><p style={{whiteSpace:'pre-wrap'}}>{result.prompt}</p></details>{result.error?<p role="alert">{result.error}</p>:null}<article style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{result.content}</article>
    {result.finishReason==='length'?<p>达到回答长度上限，内容尚未完整。</p>:null}
    <details><summary>工具调用 · {result.trace?.length??0}</summary>{result.trace?.map((t,i)=><details key={i}><summary>{t.tool} · {t.status==='returned'?'已返回':t.status==='reused'?'复用结果':'已拒绝'}</summary><p>输入</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{t.query}</pre><p>返回</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{t.resultPreview}</pre></details>)}</details>
    <details><summary>电力明细</summary>{result.charges?.map((c,i)=><p key={i}>{c.model} · {c.power.toFixed(6)} 电力 · {c.status==='success'?'已结算':c.status==='needs_review'?'待核对':c.status==='failed'?'调用失败':c.status}</p>)}</details></>:null}</div>;
}
