import {useState} from 'react';
import {Search} from 'lucide-react';
import type {api as Api} from './oneApi';
import {FeatureCatalog} from './FeatureCatalog';
import {SharingPanel} from './PublicSharing';
import {featureCategories} from '../server/featureCategories';
export function FeatureMarketplace({api,models,onAsk}:{api:typeof Api;models:{id:string;name:string;kind:string}[];onAsk:()=>void}){
  const [kind,setKind]=useState('official'),[category,setCategory]=useState('all'),[query,setQuery]=useState('');
  return <div className="feature-marketplace">
    <div className="equipment-toolbar"><div className="settings-tabs" aria-label="功能范围">{[['official','我的功能'],['personal','我的分身']].map(([id,name])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>{setKind(id);setCategory('all');setQuery('');}}>{name}</button>)}</div><button type="button" className="equipment-ask" onClick={onAsk}>回到 ONE 对话 <span aria-hidden="true">↗</span></button></div>
    <div className="equipment-find"><div className="settings-search"><Search size={17}/><input aria-label="搜索功能市场" type="search" placeholder="功能、用途或作者" value={query} onChange={e=>setQuery(e.target.value)}/></div><nav className="market-categories" aria-label="功能分类">{[{id:'all',name:'全部分类'},...featureCategories].map(c=><button type="button" key={c.id} aria-pressed={category===c.id} onClick={()=>setCategory(c.id)}>{c.name}</button>)}</nav>{query||category!=='all'?<button type="button" onClick={()=>{setCategory('all');setQuery('');}}>清除筛选</button>:null}</div>
    {kind!=='personal'?<FeatureCatalog api={api} query={query} category={category} equipment/>:null}
    {kind!=='official'&&(category==='all'||category==='knowledge')?<SharingPanel api={api} models={models} externalQuery={query} hideSearch/>:null}
    {kind==='personal'&&category!=='all'&&category!=='knowledge'?<div className="market-empty"><strong>分身属于问答检索</strong><button type="button" onClick={()=>setCategory('knowledge')}>查看我的分身</button></div>:null}
  </div>;
}
