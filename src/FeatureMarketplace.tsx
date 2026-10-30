import {useState} from 'react';
import {TeachingWorkspace} from './TeachingWorkspace';
import {TeachingEntry} from './TeachingEntry';
import type {TeachingStage} from '../server/teachingTypes';
import {Search} from 'lucide-react';
import type {api as Api} from './oneApi';
import {FeatureCatalog} from './FeatureCatalog';
import {featureCategories} from '../server/featureCategories';
export function FeatureMarketplace({api,onAsk}:{api:typeof Api;models:{id:string;name:string;kind:string}[];onAsk:()=>void}){
  const [category,setCategory]=useState('all'),[query,setQuery]=useState('');
  const [teachingStage,setTeachingStage]=useState<TeachingStage|null>(null);
  if(teachingStage)return <TeachingWorkspace api={api} initialStage={teachingStage} onClose={()=>setTeachingStage(null)}/>;
  return <div className="feature-marketplace">
    <div className="equipment-toolbar"><h3>功能目录</h3><button type="button" className="equipment-ask" onClick={onAsk}>回到 ONE 对话 <span aria-hidden="true">↗</span></button></div>
    <div className="equipment-find"><div className="settings-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索功能市场" type="search" placeholder="功能、用途或作者" value={query} onChange={e=>setQuery(e.target.value)}/></div><nav className="market-categories" aria-label="功能分类">{[{id:'all',name:'全部分类'},...featureCategories].map(c=><button type="button" key={c.id} aria-pressed={category===c.id} onClick={()=>setCategory(c.id)}>{c.name}</button>)}</nav>{query||category!=='all'?<button type="button" onClick={()=>{setCategory('all');setQuery('');}}>清除筛选</button>:null}</div>
    {category==='all'?<TeachingEntry query={query} onOpen={setTeachingStage}/>:null}
    <FeatureCatalog api={api} query={query} category={category} equipment/>
  </div>;
}
