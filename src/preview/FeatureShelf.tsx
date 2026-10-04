import {useEffect,useState} from 'react';
import {Sparkles,Check,Search} from 'lucide-react';
import type {api as Api} from '../oneApi';
import {SettingsDialog} from '../SettingsControls';
import {SharingPanel} from '../PublicSharing';
import {featureCategories} from '../../server/featureCategories';
export type FeatureChoice={id:string;name:string;description:string;knowledgeMode?:string;category?:string;author?:string;access?:'purchased'|'free'|'enterprise'|'locked';purchaseLabel?:string;usageLabel?:string};
/** Local selection UI. Production paid access and consent remain server-owned. */
export function FeatureShelf({api,models,selected,onChoose}:{api:typeof Api;models:{id:string;name:string;kind:string}[];selected:string[];onChoose:(feature:FeatureChoice)=>void}) {
 const [query,setQuery]=useState(''),[page,setPage]=useState(1),[category,setCategory]=useState('all'),[scope,setScope]=useState<'mine'|'discover'|'personal'>('mine');
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[detail,setDetail]=useState<FeatureChoice|null>(null);
 const [list,setList]=useState<{items:FeatureChoice[];total:number}>({items:[],total:0});
 useEffect(()=>{let live=true;setLoading(true);setError('');void api<typeof list>(`/api/features?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}&scope=${scope}&page=${page}`).then(data=>{if(live)setList(data);}).catch(e=>{if(live){setList({items:[],total:0});setError(e.message);}}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api,query,category,scope,page,refresh]);
 function changeScope(next:'mine'|'discover'|'personal'){setScope(next);setPage(1);}
 return <section className="feature-shelf" aria-label="为下一条消息选择功能" aria-busy={loading}>
  <nav className="feature-shelf-tabs" aria-label="功能范围"><button type="button" aria-pressed={scope==='mine'} onClick={()=>changeScope('mine')}>我的功能</button><button type="button" aria-pressed={scope==='discover'} onClick={()=>changeScope('discover')}>发现功能</button><button type="button" aria-pressed={scope==='personal'} onClick={()=>changeScope('personal')}>我的分身</button></nav>
  {scope==='personal'?<SharingPanel api={api} models={models}/>:<>
  <label className="feature-shelf-search"><Search size={15}/><input aria-label="搜索功能" placeholder="搜索名称或想完成的事" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>
  <nav className="feature-shelf-categories" aria-label="功能分类">{[{id:'all',name:'全部'},...featureCategories].map(item=><button key={item.id} type="button" aria-pressed={category===item.id} onClick={()=>{setCategory(item.id);setPage(1);}}>{item.name}</button>)}</nav>
  {loading?<p role="status">正在找功能…</p>:error?<div role="alert"><p>{error}</p><button type="button" onClick={()=>setRefresh(value=>value+1)}>重新加载</button></div>:<>
   <div className="feature-shelf-grid">{list.items.map(feature=><article className={`feature-shelf-card ${selected.includes(feature.id)?'is-selected':''}`} key={feature.id}>
    <header><Sparkles size={17}/><span>{feature.author==='ONE'?'官方':feature.author||'精选'}</span><small>{feature.access==='purchased'?'已购':feature.access==='enterprise'?'企业已开通':feature.access==='locked'?'未开通':'可使用'}</small></header>
    <h3>{feature.name}</h3><p>{feature.description}</p>
    <div className="feature-cost"><span>{feature.purchaseLabel||'已为你开放'}</span><small>{feature.usageLabel||'按实际用量消耗电力'}</small></div>
    <footer><button type="button" className="feature-detail-link" aria-label={`了解功能：${feature.name}`} onClick={()=>setDetail(feature)}>详情</button><button type="button" className="feature-shelf-item" aria-label={feature.access==='locked'?`了解开通：${feature.name}`:`${selected.includes(feature.id)?'取消选择':'选择功能'}：${feature.name}`} aria-pressed={feature.access==='locked'?undefined:selected.includes(feature.id)} onClick={()=>feature.access==='locked'?setDetail(feature):onChoose(feature)}>{feature.access==='locked'?'了解开通':selected.includes(feature.id)?<><Check size={14}/>已选</>:'加入对话'}</button></footer>
   </article>)}</div>
   {!list.items.length?<div className="feature-empty"><p>{query||category!=='all'?'没有找到匹配的功能':'即将上线'}</p>{query||category!=='all'?<button type="button" onClick={()=>{setQuery('');setCategory('all');setPage(1);}}>清除筛选</button>:scope==='mine'?<button type="button" onClick={()=>changeScope('discover')}>看看官方功能</button>:null}</div>:null}
   {list.total>10?<footer className="feature-pagination"><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.ceil(list.total/10)} · {list.total} 项</span><button type="button" disabled={page*10>=list.total} onClick={()=>setPage(page+1)}>下一页</button></footer>:null}
  </>}
  </>}
  {detail?<SettingsDialog title={detail.name} onClose={()=>setDetail(null)}><p>{detail.description}</p><p>{detail.purchaseLabel||'已为你开放'} · {detail.usageLabel||'按实际用量消耗电力'}</p>{detail.access==='locked'?<p>尚未为你开通。开通方式以官方说明为准；查看详情不会扣款。</p>:<><p>加入下一条消息，ONE 会按你的要求安排；选择本身不会执行或扣费。</p><button type="button" onClick={()=>{if(!selected.includes(detail.id))onChoose(detail);setDetail(null);}}>加入对话</button></>}</SettingsDialog>:null}
 </section>;
}
