import {useEffect,useLayoutEffect,useRef,useState,type MouseEvent,type ReactNode} from 'react';
import {ArrowLeft,ArrowUpRight,Bookmark,ChevronRight,GraduationCap,ImagePlus,LoaderCircle,MessageSquareText,Search,WandSparkles,X} from 'lucide-react';
import type {api as Api} from './oneApi';
import {currentApiIdentity} from './oneApi';
import {TeachingWorkspace} from './TeachingWorkspace';
import {useIndustryFavorites} from './useIndustryFavorites';
import {decodeIndustryDirectory,emptyIndustryDirectory,encodeIndustryDirectory,filterIndustryWorkspaces,industryCategories,industryDirectoryStorageKey,industryWorkspaces,type CommerceWorkspaceKind,type IndustryWorkspaceId} from './industryWorkspaceState';

type Props={
  api:typeof Api;scopeKey:string;
  currentWorkspace:IndustryWorkspaceId|null;
  onOpenWorkspace:(workspace:IndustryWorkspaceId)=>void;
  onBackToDirectory:()=>void;onExitToOne:()=>void;
  renderCommerce:(kind:CommerceWorkspaceKind,onBack:()=>void)=>ReactNode;
};
const icons={teaching:GraduationCap,product_creative:ImagePlus,image_edit:WandSparkles,review_reply:MessageSquareText};
export function IndustryWorkspaces({api,scopeKey,currentWorkspace,onOpenWorkspace,onBackToDirectory,onExitToOne,renderCommerce}:Props){
  const identity=useRef(currentApiIdentity());
  const [state,setState]=useState(()=>{try{return {...decodeIndustryDirectory(sessionStorage.getItem(industryDirectoryStorageKey(scopeKey)),scopeKey),workspace:null};}catch{return emptyIndustryDirectory();}});
  const [visited,setVisited]=useState<IndustryWorkspaceId[]>(()=>currentWorkspace?[currentWorkspace]:[]);
  const favorites=useIndustryFavorites(api),favoritesOnly=state.collection==='favorites';
  const current=industryWorkspaces.find(entry=>entry.id===currentWorkspace),category=industryCategories.find(item=>item.id===current?.category);
  const matches=filterIndustryWorkspaces(state.query,state.category,favoritesOnly?favorites.favoriteIds:undefined);
  const heading=useRef<HTMLHeadingElement>(null),root=useRef<HTMLElement>(null),favoritesTab=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const now=currentApiIdentity(),owner=identity.current;if(now.userId!==owner.userId||now.workspaceId!==owner.workspaceId||now.revision!==owner.revision)return;try{sessionStorage.setItem(industryDirectoryStorageKey(scopeKey),encodeIndustryDirectory({...state,workspace:null},scopeKey));}catch{/* Filters still work when storage is unavailable. */}},[state,scopeKey]);
  useLayoutEffect(()=>{
    // A retained native modal escapes ancestor inertness. Leave its top layer
    // before showing another page, while retaining the tool's business draft.
    root.current?.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog=>dialog.close());
    if(currentWorkspace)setVisited(old=>old.includes(currentWorkspace)?old:[...old,currentWorkspace]);
    root.current?.closest('.industry-page-shell')?.scrollTo({top:0});heading.current?.focus({preventScroll:true});
  },[currentWorkspace]);
  function open(event:MouseEvent<HTMLAnchorElement>,workspace:IndustryWorkspaceId){
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();setVisited(old=>old.includes(workspace)?old:[...old,workspace]);onOpenWorkspace(workspace);
  }
  const back=onBackToDirectory;
  const showFavoritesProblem=favoritesOnly&&(favorites.loading||Boolean(favorites.error));
  return <section ref={root} className="industry-workspaces" aria-label="行业工作台">
    {current?<header className="industry-page-topbar"><nav className="industry-breadcrumb" aria-label="当前位置"><button type="button" onClick={back}><ArrowLeft size={16} aria-hidden="true"/>行业目录</button><ChevronRight size={14} aria-hidden="true"/><button type="button" onClick={()=>{setState(old=>({...old,category:current.category}));back();}}>{category?.label}</button><ChevronRight size={14} aria-hidden="true"/><span aria-current="page">{current.name}</span></nav><button type="button" className="industry-return-one" onClick={onExitToOne}>返回 ONE<ArrowUpRight size={15} aria-hidden="true"/></button></header>:null}
    <div className="industry-directory" hidden={!!current} inert={!!current}>
      <header className="industry-directory-heading"><div><span>ONE · WORKBENCHES</span><h1 ref={!current?heading:undefined} tabIndex={-1}>行业工作台</h1><p>找到适合手上工作的工具，把常用的收藏在这里。</p></div><button type="button" className="industry-return-one" onClick={onExitToOne}><ArrowLeft size={16} aria-hidden="true"/>返回 ONE</button></header>
      <div className="industry-directory-toolbar"><label className="industry-directory-search"><Search size={19} aria-hidden="true"/><input aria-label="搜索行业工作台" type="search" placeholder="搜索工作台、行业或要做的事" value={state.query} maxLength={200} onChange={e=>setState(old=>({...old,query:e.target.value}))}/>{state.query?<button type="button" aria-label="清除工作台搜索" onClick={()=>setState(old=>({...old,query:''}))}><X size={16} aria-hidden="true"/></button>:null}</label><nav className="industry-collection-tabs" aria-label="工作台范围"><button type="button" aria-pressed={!favoritesOnly} onClick={()=>setState(old=>({...old,collection:'all'}))}>全部工作台<span>{industryWorkspaces.length}</span></button><button type="button" ref={favoritesTab} aria-pressed={favoritesOnly} onClick={()=>setState(old=>({...old,collection:'favorites'}))}><Bookmark size={16} aria-hidden="true"/>我的收藏<span>{favorites.loading?'…':favorites.favoriteIds.length}</span></button></nav></div>
      <div className="industry-directory-filters"><nav aria-label="行业筛选">{[{id:'all' as const,label:'全部行业'},...industryCategories].map(item=><button type="button" key={item.id} aria-pressed={state.category===item.id} onClick={()=>setState(old=>({...old,category:item.id}))}>{item.label}</button>)}</nav><p role="status" aria-live="polite">{showFavoritesProblem?'':`${matches.length} 个工作台`}</p></div>
      {favorites.error?<div className="industry-favorites-error" role="alert"><p>{favorites.error}</p><button type="button" disabled={favorites.loading} onClick={()=>void favorites.retry()}>重新同步收藏</button></div>:null}
      {showFavoritesProblem?<div className="industry-directory-empty"><Bookmark size={28} strokeWidth={1.5} aria-hidden="true"/><h2>{favorites.loading?'正在读取你的收藏':'收藏暂时没有同步'}</h2><p>{favorites.loading?'读取完成后，常用的工作台会显示在这里。':'可以重新同步收藏，或先从全部工作台打开工具。'}</p>{!favorites.loading?<button type="button" onClick={()=>setState(old=>({...old,collection:'all'}))}>浏览全部工作台</button>:null}</div>:<div className="industry-workspace-grid" aria-label={favoritesOnly?'收藏的工作台':'可用工作台'}>{matches.map(entry=>{
        const Icon=icons[entry.id],saved=favorites.favoriteIds.includes(entry.id),saving=favorites.savingIds.includes(entry.id),group=industryCategories.find(item=>item.id===entry.category);
        return <article className="industry-workspace-card" key={entry.id} aria-label={`工作台：${entry.name}`}><div className="industry-card-top"><span className="industry-workspace-symbol" aria-hidden="true"><Icon size={25} strokeWidth={1.5}/></span><span className="industry-card-category">{group?.label}</span><button className="industry-card-favorite" type="button" aria-label={`${saved?'取消收藏':'收藏'}：${entry.name}`} aria-pressed={saved} disabled={favorites.loading||Boolean(favorites.error)||saving} onClick={()=>{if(saved&&favoritesOnly)favoritesTab.current?.focus();void favorites.setFavorite(entry.id,!saved);}}>{saving?<LoaderCircle size={19} className="creative-spin" aria-hidden="true"/>:<Bookmark size={19} fill={saved?'currentColor':'none'} strokeWidth={1.7} aria-hidden="true"/>}</button></div><a className="industry-workspace-link" href={`/workbenches/${entry.id}`} onClick={event=>open(event,entry.id)} aria-label={`打开工作台：${entry.name}`}><h2>{entry.name}</h2><p>{entry.description}</p><small>{entry.materials}</small><span className="industry-card-open">打开工作台<ArrowUpRight size={17} aria-hidden="true"/></span></a></article>;
      })}</div>}
      {!matches.length&&!showFavoritesProblem?<div className="industry-directory-empty">{favoritesOnly&&!state.query&&state.category==='all'?<><Bookmark size={28} strokeWidth={1.5} aria-hidden="true"/><h2>把常用的工作台收藏在这里</h2><p>在工作台卡片右上角点一下收藏，下次就能更快找到。</p><button type="button" onClick={()=>setState(old=>({...old,collection:'all'}))}>浏览全部工作台</button></>:<><Search size={28} strokeWidth={1.5} aria-hidden="true"/><h2>没有找到匹配的工作台</h2><p>试试「批改」「主图」或「回复」，也可以清除搜索和行业筛选。</p><button type="button" onClick={()=>setState(old=>({...old,query:'',category:'all'}))}>清除搜索和筛选</button></>}</div>:null}
      {favorites.loading&&!favoritesOnly?<p className="industry-favorites-loading" role="status">正在同步收藏…</p>:null}
    </div>
    {current?<h1 className="industry-sr-only" ref={heading} tabIndex={-1}>{current.name}</h1>:null}
    {visited.includes('teaching')?<div className="industry-workspace-page" hidden={currentWorkspace!=='teaching'} inert={currentWorkspace!=='teaching'}><TeachingWorkspace api={api}/></div>:null}
    {visited.filter((kind):kind is CommerceWorkspaceKind=>kind!=='teaching').map(kind=><div key={kind} className="industry-workspace-page" hidden={currentWorkspace!==kind} inert={currentWorkspace!==kind}>{renderCommerce(kind,back)}</div>)}
  </section>;
}
