import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search, X } from 'lucide-react';
import type { api as Api } from './oneApi';
import type { FeatureChoice } from './preview/FeatureShelf';
import { featureMention, withoutFeatureMention } from './noviceUx';
import './composer-features.css';

/** Uses the existing account-bound, server-authorized catalog; selecting never runs a tool. */
export function useComposerFeatures({api,text,setText,selected,onChoose}:{api:typeof Api;text:string;setText:(text:string)=>void;selected:string[];onChoose:(feature:FeatureChoice)=>void}) {
  const [picker,setPicker]=useState<{query:string;mention:ReturnType<typeof featureMention>}|null>(null);
  const [items,setItems]=useState<FeatureChoice[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[index,setIndex]=useState(0);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const root=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),id=useId();
  const query=picker?.query;
  useEffect(()=>{
    if(query===undefined)return;
    const abort=new AbortController();setLoading(true);setError('');setItems([]);setIndex(0);
    const timer=setTimeout(()=>void api<{items:FeatureChoice[];total:number}>(`/api/features?scope=mine&category=all&q=${encodeURIComponent(query)}&page=${page}`,{signal:abort.signal})
      .then(result=>{if(!abort.signal.aborted){setItems(result.items.filter(f=>f.access!=='locked'));setTotal(result.total);}})
      .catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'暂时无法读取功能');})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);}),150);
    return()=>{clearTimeout(timer);abort.abort();};
  },[api,query,page,refresh]);
  useEffect(()=>{
    if(!picker)return;
    const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)&&event.target!==input.current)setPicker(null);};
    document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);
  },[Boolean(picker)]);
  function choose(feature:FeatureChoice){
    if(!selected.includes(feature.id)&&selected.length>=8)return;
    onChoose(feature);
    if(picker?.mention)setText(withoutFeatureMention(text,picker.mention));
    setPicker(null);input.current?.focus();
  }
  function update(value:string,cursor:number){
    const mention=featureMention(value,cursor);
    setPage(1);setPicker(mention?{query:mention.query,mention}:null);
  }
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement|HTMLInputElement>){
    if(!picker||event.nativeEvent.isComposing)return false;
    if(event.key==='Escape'){event.preventDefault();setPicker(null);return true;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setIndex(i=>items.length?(i+(event.key==='ArrowDown'?1:-1)+items.length)%items.length:0);return true;
    }
    if(event.key==='Enter'&&!event.shiftKey){
      event.preventDefault();if(!loading&&items[index])choose(items[index]);return true;
    }
    return false;
  }
  const panel=picker?<div ref={root} className="composer-feature-picker" aria-label="添加下一条使用的功能">
    <header><strong>添加功能</strong><button type="button" aria-label="关闭功能选择" onClick={()=>{setPicker(null);input.current?.focus();}}><X size={15}/></button></header>
    <p>仅用于下一条消息 · 选择不会执行或扣费</p>
    {!picker.mention?<label className="composer-feature-search"><Search size={15}/><input type="search" autoFocus aria-label="搜索我的功能" placeholder="搜索我的功能" value={picker.query} onChange={e=>{setPage(1);setPicker({query:e.target.value,mention:null});}} onKeyDown={e=>{keyDown(e);if(e.key==='Escape')input.current?.focus();}}/></label>:null}
    {loading?<p role="status">正在读取我的功能…</p>:error?<div role="alert"><p>{error}</p><button type="button" onClick={()=>setRefresh(v=>v+1)}>重新加载</button></div>:<div id={id} role="listbox" aria-label="可使用的功能" aria-multiselectable="true">{items.map((feature,i)=><button type="button" role="option" id={`${id}-${i}`} aria-selected={selected.includes(feature.id)} key={feature.id} className={i===index?'is-highlighted':''} disabled={!selected.includes(feature.id)&&selected.length>=8} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(feature)}><span><strong>{feature.name}</strong><small>{feature.description} · {feature.usageMultiplier??.6} 倍</small></span>{selected.includes(feature.id)?<Check size={15}/>:null}</button>)}{!items.length?<p>{query?'没有匹配的可用功能，换个关键词试试。':'暂无可用功能，可到功能页查看。'}</p>:null}</div>}
    {selected.length>=8?<p role="status">每条消息最多选择 8 个功能，可先取消一个。</p>:null}
    {!loading&&!error&&total>10?<footer><button type="button" disabled={page===1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page} / {Math.ceil(total/10)}</span><button type="button" disabled={page*10>=total} onClick={()=>setPage(p=>p+1)}>下一页</button></footer>:null}
  </div>:null;
  return {input,panel,open:()=>{setPage(1);setPicker(p=>p?null:{query:'',mention:null});},close:()=>setPicker(null),update,keyDown,isOpen:Boolean(picker),listId:id,activeOption:picker&&!loading&&items[index]?`${id}-${index}`:undefined};
}
