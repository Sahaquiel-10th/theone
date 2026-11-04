import {useEffect,useRef,useState} from 'react';
import {FileText,Link2,RefreshCw,Search,X} from 'lucide-react';
import type {TeachingKnowledgeSource} from '../server/teachingTypes';
import {mergeTeachingKnowledgeSelection,teachingKnowledgePreviewLabel,teachingKnowledgeSourceKey,teachingKnowledgeSourceSaved,type TeachingKnowledgePreview,type TeachingKnowledgeSelection} from './teachingKnowledgeState';
const message=(error:unknown)=>error instanceof Error?error.message:'未能读取资料，请重试本次问题，或在知识连接中检查读取诊断。';
type TeachingConnection={id:string;provider:string;label:string;pageSupported:boolean;connectionStatus?:'connected'|'error';scopeDescription?:string};
type Props={request:<T>(path:string,options?:RequestInit)=>Promise<T>;sources:TeachingKnowledgeSource[];onChange:(sources:TeachingKnowledgeSource[])=>void;privateSource:boolean;disabled:boolean;querySeed?:string;courseId?:string;activityId?:string;savedSources?:TeachingKnowledgeSource[];defaultOpen?:boolean};
type PreviewState={sourceKey:string;preview?:TeachingKnowledgePreview;error?:string};

export function TeachingKnowledgePicker({request,sources,onChange,privateSource,disabled,querySeed='',courseId,activityId,savedSources=[],defaultOpen=false}:Props){
  const [expanded,setExpanded]=useState(defaultOpen),[connections,setConnections]=useState<TeachingConnection[]>([]),[loaded,setLoaded]=useState(false);
  const [connectionId,setConnectionId]=useState(''),[scope,setScope]=useState<'page'|'connection'>('page'),[pageId,setPageId]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [query,setQuery]=useState(querySeed),[queryEdited,setQueryEdited]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[preview,setPreview]=useState<PreviewState>(),[results,setResults]=useState<Record<string,PreviewState>>({});
  const mounted=useRef(true),generation=useRef(0),pending=useRef(false),latest=useRef({sources,onChange});latest.current={sources,onChange};
  const connection=connections.find(value=>value.id===connectionId),context=`${courseId??'new'}:${activityId??''}:${privateSource}`;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{generation.current++;pending.current=false;setConnections([]);setLoaded(false);setConnectionId('');setPreview(undefined);setResults({});setError('');setNotice('');setConfirmed(false);setQueryEdited(false);setQuery(querySeed);setLoading(false);setExpanded(defaultOpen);},[context]);
  useEffect(()=>{if(!queryEdited)setQuery(querySeed);},[querySeed,queryEdited]);
  const current=(version:number)=>mounted.current&&generation.current===version;
  async function load(){if(pending.current)return;pending.current=true;const version=++generation.current;setLoading(true);setError('');try{const result=await request<{connections:TeachingConnection[]}>('/api/teaching/knowledge/connections');if(current(version)){setConnections(result.connections);setLoaded(true);}}catch(error){if(current(version)){setError(message(error));setLoaded(true);}}finally{if(current(version)){pending.current=false;setLoading(false);}}}
  useEffect(()=>{if(expanded&&!loaded&&!pending.current)void load();},[expanded,loaded,context]);
  async function inspect(source:TeachingKnowledgeSelection|{connectionId:string;scope:'page'|'connection';pageId?:string;confirmed?:boolean},add:boolean){
    if(pending.current)return;
    if(source.scope==='connection'&&!query.trim()){setError('请先填写本课程的问题或关键词，再试搜。');return;}
    pending.current=true;const version=++generation.current;setLoading(true);setError('');setNotice('');setPreview(undefined);
    try{
      const result=await request<{source:TeachingKnowledgeSelection;preview:TeachingKnowledgePreview}>('/api/teaching/knowledge/preview',{method:'POST',body:JSON.stringify({source,query:query.trim(),...(courseId?{courseId,...(activityId?{activityId}:{})}:{})})});
      if(!current(version))return;
      if(add){latest.current.onChange(mergeTeachingKnowledgeSelection(latest.current.sources,result.source));setNotice(result.preview.status==='read'?'已选用这个范围，请保存课程或评分要求后生效。':'这个范围已选用、尚待保存。本次问题没有命中片段，可以换更具体的关键词继续试搜。');}
      const inspected={sourceKey:teachingKnowledgeSourceKey(result.source),preview:result.preview};setPreview(inspected);setResults(current=>({...current,[inspected.sourceKey]:inspected}));
    }catch(error){if(current(version)){setError(message(error));const failed={sourceKey:teachingKnowledgeSourceKey(source),error:message(error)};setPreview(failed);setResults(current=>({...current,[failed.sourceKey]:failed}));}}
    finally{if(current(version)){pending.current=false;setLoading(false);}}
  }
  function resetSelection(){setPreview(undefined);setError('');setNotice('');setConfirmed(false);}
  return <details className="teacher-knowledge" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary>从知识库关联资料{sources.length?` · 已选 ${sources.length} 处`:''}</summary>
    <div>
      <p>{privateSource?'所选范围仅用于教师评阅或试卷整理，学生助教不能通过问答读取。':'所选范围将供本课程学生的助教按问题检索，请只关联允许本课学生学习的资料。'}</p>
      <button type="button" disabled={disabled||loading} onClick={()=>void load()}><RefreshCw size={15}/>刷新已连接知识库</button>
      {!connections.length&&loaded&&!loading?<p className="teacher-help">没有可用的知识连接。请先在 ONE 的知识连接中授权，再回来刷新；关联课程不会复制整库内容。</p>:null}
      {loading?<p role="status">正在核对授权并读取所选范围…</p>:null}
      {connections.length?<>
        <label>知识连接<select disabled={disabled||loading} value={connectionId} onChange={event=>{const value=connections.find(item=>item.id===event.target.value);setConnectionId(event.target.value);setPageId('');setScope(value?.pageSupported?'page':'connection');resetSelection();}}><option value="">选择已连接的知识库</option>{connections.map(value=><option key={value.id} value={value.id}>{value.label}{value.connectionStatus==='error'?' · 连接需检查':' · 已连接'}</option>)}</select></label>
        {connection?<>
          <p className="teacher-help">{connection.scopeDescription??'此连接当前已授权的检索范围'}。已连接不代表本次问题一定能检索到正文。</p>
          <label>本次关联范围<select disabled={disabled||loading} value={scope} onChange={event=>{setScope(event.target.value as 'page'|'connection');resetSelection();}}>{connection.pageSupported?<option value="page">指定一个页面</option>:null}<option value="connection">当前连接的完整已授权范围</option></select></label>
          {scope==='page'?<label>页面链接或页面 ID<input disabled={disabled||loading} value={pageId} onChange={event=>{setPageId(event.target.value);setPreview(undefined);}} placeholder="粘贴本课程需要引用的具体页面链接"/></label>:<label className="teaching-check"><input type="checkbox" disabled={disabled||loading} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我确认{privateSource?'教师评阅与试卷整理':'本课学生的助教'}可以检索这个连接的完整已授权范围（包括连接设置中已选的知识库）。</label>}
        </>:null}
      </>:null}
      {connections.length||sources.length?<label>用本课问题试搜{scope==='page'?'（指定页面可直接读取）':''}<input disabled={disabled||loading} maxLength={6000} value={query} onChange={event=>{setQueryEdited(true);setQuery(event.target.value);setPreview(undefined);}} placeholder="例如：资料中的章节标题或关键词"/><small>课程名称可作起点；换成具体问题或资料中的词更容易核对检索结果。不会使用知识库名称代替问题。</small></label>:null}
      {connection?<button type="button" disabled={disabled||loading||scope==='page'&&!pageId.trim()||scope==='connection'&&(!confirmed||!query.trim())} onClick={()=>void inspect({connectionId,scope,...(scope==='page'?{pageId}:{confirmed})},true)}><Link2 size={15}/>核对并选用这个范围</button>:null}
      {error?<p className="teaching-inline-error" role="alert">{error}</p>:null}
      {notice?<p className="teacher-help" role="status">{notice}</p>:null}
      {preview?.preview?<details className="teacher-knowledge-preview" open><summary>{teachingKnowledgePreviewLabel(preview.preview.status)}：{preview.preview.title}</summary>{preview.preview.query?<small>试搜问题：{preview.preview.query}</small>:null}{preview.preview.status==='read'?<p>{preview.preview.text.slice(0,1800)}</p>:<p>本次问题没有匹配到可读片段，不代表知识库不存在相关资料。请换具体关键词试搜，或到知识连接核对已选范围。</p>}<small>只保存明确确认的关联范围；资料在实际使用时按授权检索，试搜片段不会存入课程。</small></details>:null}
      {sources.length?<ul className="teaching-file-list">{sources.map((source,index)=>{const saved=teachingKnowledgeSourceSaved(source,savedSources),result=results[teachingKnowledgeSourceKey(source)];return <li key={teachingKnowledgeSourceKey(source)}><FileText size={15}/><span>{source.label} · {source.scope==='page'?'指定页面':'当前连接已授权范围'}<small>{saved?'已保存关联':'待保存关联'} · {result?.preview?result.preview.status==='read'?'上次试搜取得片段':'上次试搜未命中':result?.error?'上次读取未完成':'尚未试搜'}</small></span><button type="button" disabled={disabled||loading||source.scope==='connection'&&!query.trim()} onClick={()=>void inspect(source,false)}><Search size={14}/>试搜此范围</button><button type="button" disabled={disabled||loading} aria-label={`移除知识关联 ${index+1}`} onClick={()=>onChange(sources.filter((_,i)=>i!==index))}><X size={14}/></button></li>;})}</ul>:null}
    </div>
  </details>;
}
