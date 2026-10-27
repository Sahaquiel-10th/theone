import {useEffect,useRef,useState} from 'react';
import {BadgeCheck,Check,Search,ArrowLeft,Clock3,KeyRound} from 'lucide-react';
import type {api as Api} from '../oneApi';
import {FeatureLaunch,FeatureRunView,FeatureRunHistory,type FeatureRunSummary} from '../FeatureCatalog';
import {MyToolCredentials} from '../FeatureConnections';
import {FluidSplitWorkspace} from '../fluid/FluidSplitWorkspace';
import {featureCategories} from '../../server/featureCategories';
import {FeatureShelfCard} from './FeatureShelfCard';
import './feature-workflow.css';
export type FeatureChoice={usageMultiplier?:number;id:string;name:string;description:string;knowledgeMode?:string;category?:string;author?:string;access?:'purchased'|'free'|'enterprise'|'locked';purchaseLabel?:string;usageLabel?:string};
type ShelfProps={active?:boolean;api:typeof Api;models:{id:string;name:string;kind:string}[];selected:string[];onChoose:(feature:FeatureChoice,source?:HTMLElement)=>void;onDone?:()=>void;initialOperationId?:string;initialOpenRequest?:number;onRunStarted?:(run:FeatureRunSummary)=>void;onRunStatus?:(run:FeatureRunSummary)=>void;onOperationChange?:(operationId:string|undefined)=>void};
/** The list remains a spatial anchor while a feature's working surface splits beside it. */
export function FeatureShelf({active=true,api,selected,onChoose,onDone,initialOperationId,initialOpenRequest,onRunStarted,onRunStatus,onOperationChange}:ShelfProps) {
 const [query,setQuery]=useState(''),[page,setPage]=useState(1),[category,setCategory]=useState('all');
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[detail,setDetail]=useState<FeatureChoice|null>(null),[operation,setOperation]=useState(initialOperationId);
 const [utility,setUtility]=useState<'history'|'credentials'|null>(null),[list,setList]=useState<{items:FeatureChoice[];total:number}>({items:[],total:0});
 const selectionSession=Boolean(onDone&&!utility);
 const detailHeading=useRef<HTMLHeadingElement>(null),operationChange=useRef(onOperationChange);operationChange.current=onOperationChange;
 useEffect(()=>{operationChange.current?.(active?operation:undefined);},[active,operation]);
 useEffect(()=>()=>operationChange.current?.(undefined),[]);
 useEffect(()=>{if(initialOperationId){setOperation(initialOperationId);setDetail(null);setUtility('history');}},[initialOperationId,initialOpenRequest]);
 useEffect(()=>{if(active&&(detail||operation))detailHeading.current?.focus({preventScroll:true});},[detail,operation,active]);
 useEffect(()=>{if(utility)return;let live=true;setLoading(true);setError('');void api<typeof list>(`/api/features?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}&page=${page}`).then(data=>{if(live)setList(data);}).catch(e=>{if(live){setList({items:[],total:0});setError(e.message);}}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api,query,category,page,refresh,utility]);
 function showAvailable(){setUtility(null);closeDetail();}
 function closeDetail(){setDetail(null);setOperation(undefined);}
 function changeUtility(next:'history'|'credentials'){setUtility(next);closeDetail();}
 function showDetail(feature:FeatureChoice){setOperation(undefined);setDetail(feature);}
 function started(operationId:string){const run={operationId,name:detail?.name??'功能任务',status:'pending'};setOperation(operationId);setDetail(null);onRunStarted?.(run);}
 const secondary=operation?<section className="feature-workflow-detail">
  <div className="feature-detail-toolbar"><button type="button" className="feature-workflow-back" onClick={closeDetail}><ArrowLeft size={16} aria-hidden="true"/>收起详情</button><h3 ref={detailHeading} tabIndex={-1} className="feature-run-context">运行记录</h3></div>
  <FeatureRunView key={operation} api={api} operationId={operation} onStatus={onRunStatus} active={active}/>
 </section>:detail?<section className="feature-workflow-detail">
  <div className="feature-detail-toolbar"><button type="button" className="feature-workflow-back" onClick={closeDetail}><ArrowLeft size={16} aria-hidden="true"/>收起详情</button>{detail.access!=='locked'?<button type="button" className="feature-workflow-choose" aria-pressed={selected.includes(detail.id)} onClick={event=>onChoose(detail,event.currentTarget)}>{selected.includes(detail.id)?<><Check size={14} aria-hidden="true"/>已选 · 取消</>:'下一条使用'}</button>:null}</div>
  <header className="feature-workflow-heading"><div><h3 ref={detailHeading} tabIndex={-1}>{detail.name}</h3>{detail.author==='ONE'?<span className="feature-official-badge"><BadgeCheck size={12} aria-hidden="true"/>官方</span>:detail.author?<span className="feature-workflow-author">{detail.author}</span>:null}</div></header>
  {detail.access==='locked'?<div className="feature-information-layout feature-locked-information"><section className="feature-information-section"><h4>用途</h4><p>{detail.description}</p></section><aside className="feature-information-facts"><section className="feature-information-section"><h4>开通状态</h4><p>{detail.purchaseLabel||'尚未开通'}</p><small>开通方式以官方说明为准。</small></section></aside></div>:<FeatureLaunch key={detail.id} inspectFirst hideHeading api={api} id={detail.id} accessLabel={detail.purchaseLabel||'已为你开放'} onStarted={started}/>}
 </section>:null;
 const primary=<div className="feature-shelf-list-anchor">
  <div className="feature-workflow-navigation"><nav className="feature-shelf-tabs" aria-label="功能范围"><button type="button" aria-pressed={!utility} onClick={showAvailable}>可用功能</button></nav><nav className="feature-workflow-utilities" aria-label="功能管理"><button type="button" aria-pressed={utility==='history'} onClick={()=>changeUtility('history')}><Clock3 size={14}/>运行记录</button><button type="button" aria-pressed={utility==='credentials'} onClick={()=>changeUtility('credentials')}><KeyRound size={14}/>工具连接</button></nav></div>
  {utility==='history'?<FeatureRunHistory api={api} active={active} onOpen={run=>{setDetail(null);setOperation(run.operationId);}}/>:utility==='credentials'?<section className="feature-workflow-connections"><h3>工具连接</h3><p className="feature-selection-hint">查看、更新或撤销你本人的接口凭证。</p><MyToolCredentials api={api} inline/></section>:<>
   <div className="feature-shelf-toolbar"><label className="feature-shelf-search"><Search size={15}/><input aria-label="搜索功能" placeholder="搜索功能名称或用途" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>{!loading&&!error?<span className="feature-shelf-total">共 {list.total} 项</span>:null}</div>
   <nav className="feature-shelf-categories" aria-label="功能分类">{[{id:'all',name:'全部'},...featureCategories].map(item=><button key={item.id} type="button" aria-pressed={category===item.id} onClick={()=>{setCategory(item.id);setPage(1);}}>{item.name}</button>)}</nav>
   {loading?<p role="status">正在找功能…</p>:error?<div role="alert"><p>{error}</p><button type="button" onClick={()=>setRefresh(value=>value+1)}>重新加载</button></div>:<>
    <div className="feature-shelf-grid">{list.items.map(feature=><FeatureShelfCard key={feature.id} feature={feature} selected={selected.includes(feature.id)} inspecting={detail?.id===feature.id} onInspect={()=>detail?.id===feature.id?closeDetail():showDetail(feature)} onChoose={onChoose}/>)}</div>
    {!list.items.length?<div className="feature-empty"><p>{query||category!=='all'?'没有找到匹配的功能':'暂无可用功能'}</p>{query||category!=='all'?<button type="button" onClick={()=>{setQuery('');setCategory('all');setPage(1);}}>清除筛选</button>:null}</div>:null}
    {list.total>10?<footer className="feature-pagination"><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.ceil(list.total/10)} · {list.total} 项</span><button type="button" disabled={page*10>=list.total} onClick={()=>setPage(page+1)}>下一页</button></footer>:null}
   </>}
  </>}
 </div>;
 return <section className={`feature-shelf${detail||operation?' has-detail':''}${selectionSession?' has-selection-session':''}`} aria-label="功能" aria-busy={loading&&!utility}>
  <FluidSplitWorkspace open={Boolean(detail||operation)} detailKey={operation?`run:${operation}`:detail?.id} primary={primary} secondary={secondary} ratio={.40} primaryLabel="功能列表" secondaryLabel="功能详情" className="feature-workflow-split"/>
  {selectionSession?<footer className="feature-shelf-selection-footer"><span role="status">{selected.length?<>下一条已选 <strong>{selected.length}</strong> / 8 个功能</>:'可多选，随下一条消息使用'}</span><button type="button" onClick={onDone}><Check size={14}/>{selected.length?'完成选择':'回到对话'}</button></footer>:null}
 </section>;
}
