import {useState} from 'react';
import {Search} from 'lucide-react';
import type {api as Api} from './oneApi';
import {FeatureCatalog} from './FeatureCatalog';
import {SharingPanel} from './PublicSharing';
import {featureCategories} from '../server/featureCategories';
export function FeatureMarketplace({api,models}:{api:typeof Api;models:{id:string;name:string;kind:string}[]}){
  const [kind,setKind]=useState('all'),[category,setCategory]=useState('all'),[query,setQuery]=useState('');
  return <div className="feature-marketplace">
    <div className="market-toolbar"><div className="settings-search"><Search size={17}/><input aria-label="搜索功能市场" type="search" placeholder="搜索功能、用途或作者" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="settings-tabs" aria-label="功能范围">{[['all','全部'],['official','官方精选'],['personal','我的分身']].map(([id,name])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>setKind(id)}>{name}</button>)}</div></div>
    <nav className="market-categories" aria-label="功能分类">{[{id:'all',name:'全部分类'},...featureCategories].map(c=><button type="button" key={c.id} aria-pressed={category===c.id} onClick={()=>setCategory(c.id)}>{c.name}</button>)}</nav>
    {kind!=='personal'?<FeatureCatalog api={api} query={query} category={category}/>:null}
    {kind!=='official'&&(category==='all'||category==='knowledge')?<SharingPanel api={api} models={models} externalQuery={query} hideSearch/>:null}
    {kind==='personal'&&category!=='all'&&category!=='knowledge'?<div className="market-empty"><strong>分身属于问答检索</strong><button type="button" onClick={()=>setCategory('knowledge')}>查看我的分身</button></div>:null}
  </div>;
}
