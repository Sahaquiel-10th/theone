import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowLeft,ArrowUpRight,ChevronRight,ImagePlus,MessageSquareText,Search,WandSparkles} from 'lucide-react';
import type {api as Api} from './oneApi';
import {currentApiIdentity} from './oneApi';
import {TeachingWorkspace} from './TeachingWorkspace';
import {TeachingEntry} from './TeachingEntry';
import {decodeIndustryDirectory,emptyIndustryDirectory,encodeIndustryDirectory,filterIndustryWorkspaces,industryCategories,industryDirectoryStorageKey,industryDirectoryTransition,industryWorkspaces,type CommerceWorkspaceKind,type IndustryWorkspaceId} from './industryWorkspaceState';

export function IndustryWorkspaces({api,scopeKey,renderCommerce}:{api:typeof Api;scopeKey:string;renderCommerce:(kind:CommerceWorkspaceKind,onBack:()=>void)=>ReactNode}){
  const identity=useRef(currentApiIdentity());
  const [state,setState]=useState(()=>{try{return decodeIndustryDirectory(sessionStorage.getItem(industryDirectoryStorageKey(scopeKey)),scopeKey);}catch{return emptyIndustryDirectory();}});
  const [visited,setVisited]=useState<IndustryWorkspaceId[]>(()=>state.workspace?[state.workspace]:[]);
  const current=industryWorkspaces.find(entry=>entry.id===state.workspace),matches=filterIndustryWorkspaces(state.query,state.category),group=industryCategories.find(item=>item.id===current?.category),heading=useRef<HTMLHeadingElement>(null),root=useRef<HTMLElement>(null);
  useEffect(()=>{const now=currentApiIdentity(),owner=identity.current;if(now.userId!==owner.userId||now.workspaceId!==owner.workspaceId||now.revision!==owner.revision)return;try{sessionStorage.setItem(industryDirectoryStorageKey(scopeKey),encodeIndustryDirectory(state,scopeKey));}catch{/* Navigation still works when storage is unavailable. */}},[state,scopeKey]);
  useEffect(()=>{root.current?.closest('.settings-dialog-body')?.scrollTo({top:0});heading.current?.focus({preventScroll:true});},[state.workspace]);
  function open(workspace:IndustryWorkspaceId){setVisited(old=>old.includes(workspace)?old:[...old,workspace]);setState(old=>industryDirectoryTransition(old,{type:'open',workspace}));}
  function back(){setState(old=>industryDirectoryTransition(old,{type:'back'}));}
  const commerceIcons={product_creative:ImagePlus,image_edit:WandSparkles,review_reply:MessageSquareText};
  return <section ref={root} className="industry-workspaces" aria-label="行业工作台">
    {current?<nav className="industry-breadcrumb" aria-label="当前位置"><button type="button" onClick={back}><ArrowLeft size={15}/>行业目录</button><ChevronRight size={13} aria-hidden="true"/><button type="button" onClick={()=>setState(old=>industryDirectoryTransition(old,{type:'category',category:current.category}))}>{group?.label}</button><ChevronRight size={13} aria-hidden="true"/><span aria-current="page">{current.name}</span></nav>:null}
    <div className="industry-directory" hidden={!!current} inert={!!current}>
      <header className="industry-directory-heading"><span>ONE · 行业工作台</span><h2 ref={!current?heading:undefined} tabIndex={-1}>从手上的行业工作开始</h2><p>按行业找到完整流程，放入材料、说明要求，再检查结果。</p></header>
      <div className="industry-directory-toolbar"><label><Search size={16}/><input aria-label="搜索行业工作台" type="search" placeholder="搜索工作台或要做的事" value={state.query} maxLength={200} onChange={e=>setState(old=>industryDirectoryTransition(old,{type:'query',query:e.target.value}))}/></label><nav aria-label="行业筛选">{[{id:'all' as const,label:'全部行业'},...industryCategories].map(category=><button type="button" key={category.id} aria-pressed={state.category===category.id} onClick={()=>setState(old=>industryDirectoryTransition(old,{type:'category',category:category.id}))}>{category.label}</button>)}</nav></div>
      {industryCategories.map(category=>{const entries=matches.filter(entry=>entry.category===category.id);return entries.length?<section className="industry-directory-group" aria-labelledby={`industry-${category.id}-title`} key={category.id}><header><h3 id={`industry-${category.id}-title`}>{category.label}</h3><p>{category.description}</p></header><div>{entries.map(entry=>{if(entry.id==='teaching')return <TeachingEntry key={entry.id} onOpen={()=>open('teaching')}/>;const Icon=commerceIcons[entry.id];return <article className="industry-workspace-row" key={entry.id}><span className="industry-workspace-symbol" aria-hidden="true"><Icon size={22} strokeWidth={1.5}/></span><div><h3>{entry.name}</h3><p>{entry.description}</p><small>{entry.materials}</small></div><button type="button" onClick={()=>open(entry.id)} aria-label={`打开工作台：${entry.name}`}>打开工作台<ArrowUpRight size={15} aria-hidden="true"/></button></article>;})}</div></section>:null;})}
      {!matches.length?<div className="industry-directory-empty"><p>没有找到匹配的工作台。</p><button type="button" onClick={()=>setState(emptyIndustryDirectory())}>清除筛选</button></div>:null}
    </div>
    {current?<h2 className="industry-sr-only" ref={heading} tabIndex={-1}>{current.name}</h2>:null}
    {visited.includes('teaching')?<div className="industry-workspace-page" hidden={state.workspace!=='teaching'} inert={state.workspace!=='teaching'}><TeachingWorkspace api={api}/></div>:null}
    {visited.filter((kind):kind is CommerceWorkspaceKind=>kind!=='teaching').map(kind=><div key={kind} className="industry-workspace-page" hidden={state.workspace!==kind} inert={state.workspace!==kind}>{renderCommerce(kind,back)}</div>)}
  </section>;
}
