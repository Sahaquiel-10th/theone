import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {ArrowLeft,ArrowRight,ArrowUpRight,BookOpen,Check,ChevronDown,FileText,Globe,LoaderCircle,MessageCircle,Search,X} from 'lucide-react';
import type {PracticeGoal,PracticeSearchResult,PracticeView} from '../server/onboardingPractice';
import type {FeatureApproval} from '../server/featurePricing';
import {api} from './oneApi';
import {OneEye} from './OneEye';
import {WelcomeGuideCard} from './WelcomeGuideCard';
import {confirmAction} from './ConfirmAction';
import {practiceLink,practiceNode,practiceNodes,practiceRecap,practiceRoundDone,practiceRoundPending,practiceStatus,practiceSubmission,practiceWebDone} from './practiceOnboardingState';

const endpoint='/api/me/onboarding-practice';
export type PracticeOnboardingProps={
  journeyId:string;
  request?:typeof api;
  defaultGoal?:PracticeGoal;
  defaultSample?:boolean;
  onKnowledge:()=>void;
  onDismiss:()=>void;
  onContinueChat?:()=>void;
  onOpenTask?:(id:string)=>void;
  onRefresh?:()=>unknown|Promise<unknown>;
  onFinish:()=>Promise<unknown>;
  onSkip:()=>Promise<unknown>;
  /** A view is supplied only by the isolated, synthetic local preview. */
  initialView?:PracticeView;
  preview?:boolean;
  renderArtifact?:(attachment:NonNullable<NonNullable<PracticeView['practice']>['web']>['attachment'])=>ReactNode;
};

/** A real, account-scoped practice. Opening or rendering it never starts work. */
export function PracticeOnboarding({journeyId,request=api,defaultGoal='article',defaultSample=false,onKnowledge,onDismiss,onContinueChat,onOpenTask,onRefresh,onFinish,onSkip,initialView,preview=false,renderArtifact}:PracticeOnboardingProps){
  const [view,setView]=useState<PracticeView|undefined>(initialView),[loading,setLoading]=useState(!initialView),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[connectionId,setConnectionId]=useState(initialView?.connections[0]?.id??''),[results,setResults]=useState<PracticeSearchResult[]>([]),[searched,setSearched]=useState(false),[searchMessage,setSearchMessage]=useState('');
  const [selection,setSelection]=useState<PracticeSearchResult>(),[sample,setSample]=useState(defaultSample),[goal,setGoal]=useState<PracticeGoal>(defaultGoal),[topic,setTopic]=useState(''),[editing,setEditing]=useState(false),[recap,setRecap]=useState(!!initialView?.practice?.completedAt);
  const mounted=useRef(false),working=useRef(false),searching=useRef<AbortController|undefined>(undefined),confirming=useRef<AbortController|undefined>(undefined),version=useRef(0);
  const operations=useRef<Record<string,{signature:string;operationId:string}>>({});
  const callbacks=useRef({onRefresh,onFinish,onSkip});callbacks.current={onRefresh,onFinish,onSkip};
  const id=useId().replace(/:/g,''),heading=useRef<HTMLHeadingElement>(null),p=view?.practice,node=practiceNode(p),pending=practiceRoundPending(p?.web??p?.first);
  const notify=useCallback(()=>{void Promise.resolve(callbacks.current.onRefresh?.()).catch(()=>{});},[]);
  const refresh=useCallback(async()=>{
    const revision=++version.current;
    try{const next=await request<PracticeView>(endpoint);if(mounted.current&&revision===version.current){setView(next);setError('');if(next.practice?.completedAt)setRecap(true);}return next;}
    catch(e){if(mounted.current&&revision===version.current)setError(e instanceof Error?e.message:'暂时没连上，这次体验的进度会保留。');return undefined;}
    finally{if(mounted.current&&revision===version.current)setLoading(false);}
  },[request]);
  useEffect(()=>{mounted.current=true;if(!initialView)void refresh();return()=>{mounted.current=false;version.current++;searching.current?.abort();confirming.current?.abort();};},[refresh,journeyId]);
  useEffect(()=>{if(!connectionId&&view?.connections.length)setConnectionId(view.connections[0].id);},[connectionId,view?.connections]);
  useEffect(()=>{if(!pending)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!working.current)void refresh();},4000);return()=>clearInterval(timer);},[pending,refresh]);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[node,recap]);

  async function operation(stage:string,payload:unknown){
    const signature=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload))))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const storageKey=`one-practice-submit:${journeyId}:${stage}`;
    let previous=operations.current[stage];
    if(!previous)try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved&&typeof saved.signature==='string'&&typeof saved.operationId==='string')previous=saved;}catch{/* Storage is optional. */}
    const next=practiceSubmission(previous,signature,()=>crypto.randomUUID());operations.current[stage]=next;
    try{sessionStorage.setItem(storageKey,JSON.stringify(next));}catch{/* The in-memory ID still prevents double clicks. */}
    return next.operationId;
  }
  async function mutate(label:string,run:()=>Promise<void>){
    if(working.current)return;working.current=true;version.current++;setBusy(label);setError('');
    try{await run();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'这一步暂时没完成，请检查已有任务。');}
    finally{working.current=false;if(mounted.current)setBusy('');}
  }
  async function search(){
    if(!query.trim()||!connectionId||working.current)return;
    searching.current?.abort();const controller=new AbortController();searching.current=controller;
    await mutate('search',async()=>{
      const found=await request<{results:PracticeSearchResult[];message?:string}>(endpoint+'/search',{method:'POST',body:JSON.stringify({query:query.trim(),connectionId,journeyId}),signal:controller.signal});
      if(!mounted.current||controller.signal.aborted)return;setResults(found.results);setSearched(true);setSearchMessage(found.message??'');setSelection(undefined);setSample(false);
    });
  }
  const materialTitle=sample?'示例：把一次读书会办得更轻松':selection?.title;
  const suggestion=goal==='article'?'把这份资料整理成一篇清楚、自然的短文章':'把这份资料整理成一份可以照着做的行动方案';
  async function start(){
    if(!sample&&!selection)return;
    await mutate('start',async()=>{
      const payload={...(sample?{sample:true}:{selectionId:selection!.selectionId}),goal,topic:topic.trim()||suggestion,journeyId};
      const operationId=await operation('first',payload);
      const next=await request<PracticeView>(endpoint+'/start',{method:'POST',body:JSON.stringify({...payload,operationId})});
      if(mounted.current)setView(next);notify();
    });
  }
  async function makeWeb(){
    if(!p||!view?.webFeature)return;
    await mutate('web',async()=>{
      const price=view.webFeature!,controller=new AbortController();confirming.current=controller;let featureApprovals:FeatureApproval[]=[];
      if(price.multiplier>view.approvalThreshold){
        const accepted=await confirmAction({title:'确认本次网页功能费用',message:`${price.name}的费用倍率为 ${price.multiplier} 倍，高于你设置的 ${view.approvalThreshold} 倍。`,details:['只使用刚才这份实际成果。','按实际用量计费，本次确认不会修改默认费用设置。'],confirmLabel:'确认使用',cancelLabel:'暂不制作'},controller.signal);
        if(!accepted||controller.signal.aborted)return;featureApprovals=[{id:price.id,releaseId:price.releaseId,version:price.version,multiplier:price.multiplier}];
      }
      const operationId=p.web?.operationId??await operation('web',{practiceId:p.id});
      const next=await request<PracticeView>(endpoint+'/web',{method:'POST',body:JSON.stringify({operationId,featureApprovals,journeyId,practiceId:p.id})});
      if(mounted.current)setView(next);notify();
    });
  }
  async function complete(skipWeb=false){if(!p)return;await mutate('complete',async()=>{const next=await request<PracticeView>(endpoint+'/complete',{method:'POST',body:JSON.stringify({journeyId,practiceId:p.id,...(skipWeb?{skipWeb:true}:{})})});if(mounted.current){setView(next);setRecap(true);}notify();});}
  async function retryHandoff(){if(!p)return;await mutate('handoff',async()=>{const next=await request<PracticeView>(endpoint+'/start',{method:'POST',body:JSON.stringify({journeyId,operationId:p.first.operationId,retryHandoff:true})});if(mounted.current)setView(next);notify();});}
  const continueChat=onContinueChat??onDismiss;
  const openTask=(taskId:string,label="查看这件事")=>onOpenTask?<button type="button" className="practice-secondary" onClick={()=>onOpenTask(taskId)}>{label}<ArrowUpRight size={15}/></button>:<a className="practice-secondary" href={`/?task=${encodeURIComponent(taskId)}`}>{label}<ArrowUpRight size={15}/></a>;
  const actualRound=p?.web??p?.first;
  const ended=!!p&&practiceRoundDone(p.first);
  return <section className="practice-onboarding" aria-labelledby={`practice-title-${id}`} aria-busy={!!busy}>
    <header className="practice-top"><span><OneEye size="sm" mood={pending?'thinking':recap?'pleased':'attentive'} decorative/><strong>{preview?'新手体验 · 合成预览':'和 ONE 做成一件事'}</strong></span><button type="button" className="practice-icon" onClick={onDismiss} aria-label="收起体验，稍后继续"><X size={18}/></button></header>
    <ol className="practice-route" aria-label="四个体验节点">{practiceNodes.map((label,index)=><li key={label} aria-current={!recap&&node===index?'step':undefined} data-done={recap?index===0||index===1&&ended||index===2&&!!p?.first.taskId||index===3&&practiceWebDone(p):index<node}><span>{index<node||recap&&(index<3||practiceWebDone(p))?<Check size={12}/>:index+1}</span>{label}</li>)}</ol>
    {loading?<div className="practice-loading" role="status"><LoaderCircle size={18} className="practice-spin"/>在找这次体验的进度…</div>:recap&&p?<>
      <div className="practice-copy"><span className="practice-eyebrow">这次做过的，下次还能这样用</span><h2 id={`practice-title-${id}`} ref={heading} tabIndex={-1}>下次，换个资料接着做。</h2><p>选资料，说清想拿到什么；ONE 去处理，你继续聊。</p></div>
      <ul className="practice-recap">{practiceRecap(p).slice(1).map(item=><li key={item.label} data-done={item.done}>{item.done?<Check size={16}/>:<span className="practice-skip-mark">—</span>}<span>{item.label}</span></li>)}</ul>
      <div className="practice-result-reference"><FileText size={17}/><span>{p.source.title}</span>{openTask(p.first.taskId)}</div>
      <p className="practice-note">你的成果留在任务里。个人使用指南可以另行保留，方便以后查用法。</p>
      <div className="practice-actions"><button type="button" className="practice-primary" disabled={!!busy} onClick={()=>void mutate('finish',async()=>{await callbacks.current.onFinish();})}>{busy==='finish'?'在保存体验…':'完成，回到 ONE'}<ArrowRight size={16}/></button></div>
    </>:!p?<>
      <div className="practice-copy"><span className="practice-eyebrow">02 / 04 · 用你的资料</span><h2 id={`practice-title-${id}`} ref={heading} tabIndex={-1}>挑一份你熟悉的资料。</h2><p>把笔记整理成文章或方案，先做一份你能判断好坏的成果。</p></div>
      {!sample&&!selection?<>
        {view?.connections.length?<form className="practice-search" onSubmit={e=>{e.preventDefault();void search();}}><label htmlFor={`practice-source-${id}`}>到哪里找<select id={`practice-source-${id}`} value={connectionId} onChange={e=>{searching.current?.abort();setConnectionId(e.target.value);setResults([]);setSearched(false);}} disabled={!!busy}>{view.connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label htmlFor={`practice-query-${id}`}>笔记标题或关键词<div className="practice-search-row"><input id={`practice-query-${id}`} value={query} onChange={e=>setQuery(e.target.value)} maxLength={200} placeholder="比如，上次读书会、产品想法" disabled={!!busy}/><button type="submit" className="practice-secondary" disabled={!!busy||!query.trim()}>{busy==='search'?<LoaderCircle className="practice-spin" size={16}/>:<Search size={16}/>}查找</button></div></label></form>:<div className="practice-empty"><BookOpen size={22}/><div><strong>接上你常用的笔记或云空间</strong><p>选定一份资料后再整理，查到的内容会在这里给你确认。</p><button type="button" className="practice-secondary" onClick={onKnowledge}>连接我的资料<ArrowUpRight size={15}/></button></div></div>}
        {results.length?<div className="practice-search-results" aria-label="选择一份真实资料">{results.map(result=><button type="button" key={result.selectionId} onClick={()=>{setSelection(result);setSample(false);}} className="practice-source-result"><span><small>{result.platform}</small><strong>{result.title}</strong><span>{result.excerpt}</span></span><ArrowRight size={17}/></button>)}</div>:searched?<p className="practice-note" role="status">{searchMessage||'这次没找到。换个熟悉的标题或关键词，再找一次。'}</p>:null}
        <button type="button" className="practice-text" disabled={!!busy} onClick={()=>{setSample(true);setSelection(undefined);}}>先用一份示例体验<ArrowRight size={14}/></button>
      </>:<>
        <div className="practice-source-selected"><BookOpen size={19}/><div><small>{sample?'ONE 提供的示例 · 不是你的笔记':selection!.platform}</small><strong>{materialTitle}</strong>{selection?.excerpt?<p>{selection.excerpt}</p>:<p>根据一份 8 人读书会的准备材料，整理文章或行动方案。</p>}{practiceLink(selection?.sourceUrl)?<a href={practiceLink(selection?.sourceUrl)} target="_blank" rel="noopener noreferrer">核对原资料<ArrowUpRight size={12}/></a>:null}</div><button type="button" className="practice-icon" aria-label="重新选择资料" disabled={!!busy} onClick={()=>{setSample(false);setSelection(undefined);}}><ArrowLeft size={16}/></button></div>
        <details className="practice-goal-change"><summary>这次做成：{goal==='article'?'一篇文章':'一份行动方案'}<span>换一种</span></summary><div className="practice-goals" aria-label="这份资料要做成什么">{([{id:'article',title:'写一篇文章',note:'把想法讲清楚'},{id:'plan',title:'做一份方案',note:'把下一步安排好'}] as const).map(item=><button type="button" key={item.id} aria-pressed={goal===item.id} disabled={!!busy} onClick={()=>setGoal(item.id)}><span><strong>{item.title}</strong><small>{item.note}</small></span>{goal===item.id?<Check size={17}/>:null}</button>)}</div></details>
        <div className="practice-request"><small>你可以直接这样说</small>{editing?<label htmlFor={`practice-topic-${id}`}><span className="practice-sr-only">你想得到什么</span><textarea id={`practice-topic-${id}`} value={topic} onChange={e=>setTopic(e.target.value)} maxLength={300} rows={3} disabled={!!busy} autoFocus/></label>:<p>{topic.trim()||suggestion}</p>}<button type="button" className="practice-text" disabled={!!busy} onClick={()=>{if(!editing&&!topic)setTopic(suggestion);setEditing(!editing);}}>{editing?'收起修改': '改成我的要求'}<ChevronDown size={13}/></button></div>
        <div className="practice-actions"><button type="button" className="practice-primary" disabled={!!busy||editing&&!topic.trim()} onClick={()=>void start()}>{busy==='start'?<LoaderCircle size={16} className="practice-spin"/>:<ArrowUpRight size={16}/>}交给 ONE 整理</button></div><p className="practice-note">点击后开始真实处理，按实际用量使用 ONE 电力，本次上限 0.5 电力。</p>
      </>}
    </>:<>
      <div className="practice-copy"><span className="practice-eyebrow">{ended?'04 / 04 · 成果变网页':'03 / 04 · 分头去办'}</span><h2 id={`practice-title-${id}`} ref={heading} tabIndex={-1}>{practiceWebDone(p)?'这份成果，已经能点开看了。':p.web?'正在把同一份成果做成网页。':ended?'正文做好了，再换一种用法。':'这件事交出去了，你可以接着聊。'}</h2><p>{practiceWebDone(p)?'打开网页试试展开步骤，也可以保存下来。':p.web?'沿用刚才的正文，保留原有事实和待确认事项。':ended?'把刚才的实际成果做成可以浏览、展开步骤的网页。':'任务在旁边独立处理，主对话可以继续说别的。'}</p></div>
      <div className="practice-source-trail"><BookOpen size={15}/><span>{p.source.title}</span><ArrowRight size={13}/><span>{p.goal==='article'?'文章':'行动方案'}</span>{p.web?<><ArrowRight size={13}/><span>互动网页</span></>:null}</div>
      <div className="practice-task-status" role="status">{pending?<LoaderCircle size={18} className="practice-spin"/>:practiceRoundDone(actualRound)?<Check size={18}/>:<FileText size={18}/>}<div><strong>{practiceStatus(actualRound)}</strong><small>{p.source.sample?'使用 ONE 明确标记的示例资料':`使用你选中的 ${p.source.platform} 资料`}</small></div>{actualRound?.taskId?openTask(actualRound.taskId):null}</div>
      {actualRound?.excerpt?<details className="practice-excerpt"><summary>{practiceRoundDone(actualRound)?'展开这次成果摘要':'看看这次返回的反馈'}</summary><p>{actualRound.excerpt}</p></details>:null}
      {practiceWebDone(p)&&p.web?.attachment?(renderArtifact?renderArtifact(p.web.attachment):<WelcomeGuideCard id={p.web.attachment.id} title={p.web.attachment.name} compact caption="真实网页成果 · 可以打开、展开和保存" request={request}/>):null}
      {pending?<div className="practice-actions"><button type="button" className="practice-primary" onClick={continueChat}>回主对话，继续聊<MessageCircle size={16}/></button><button type="button" className="practice-text" disabled={!!busy} onClick={()=>void refresh()}>刷新进度</button></div>:practiceWebDone(p)?<div className="practice-actions"><button type="button" className="practice-primary" disabled={!!busy} onClick={()=>void complete()}>{busy==='complete'?'在记录这次体验…':'这次体验完成了'}<Check size={16}/></button></div>:ended&&!p.web?<>
        {view?.webFeature?<><div className="practice-request"><small>接着说一句</small><p>{p.webPrompt}</p></div><div className="practice-actions"><button type="button" className="practice-primary" disabled={!!busy} onClick={()=>void makeWeb()}>{busy==='web'?<LoaderCircle size={16} className="practice-spin"/>:<Globe size={16}/>}把这份成果做成网页</button></div><p className="practice-note">{view.webFeature.name} · {view.webFeature.multiplier} 倍费用，按实际用量计费，本次上限 0.5 电力。</p></>:<p className="practice-note">互动网页功能暂时不可用，正文已经保留，可以先带着它继续用 ONE。</p>}
        <button type="button" className="practice-text" disabled={!!busy} onClick={()=>void complete(true)}>这次先用正文，跳过网页</button>
      </>:<><p className="practice-note">已有内容和本次用量都保留着。先打开任务查看反馈，再决定怎样继续。</p><div className="practice-actions">{actualRound?.taskId?openTask(actualRound.taskId,'打开这件事，继续处理'):null}<button type="button" className="practice-text" disabled={!!busy} onClick={()=>void refresh()}>检查状态</button>{!p.first.taskId?<button type="button" className="practice-secondary" disabled={!!busy} onClick={()=>void retryHandoff()}>{busy==='handoff'?'在核对原要求…':'重新交接这次要求'}</button>:p.web&&!p.web.taskId?<button type="button" className="practice-secondary" disabled={!!busy} onClick={()=>void makeWeb()}>重新交接网页要求</button>:null}{ended?<button type="button" className="practice-text" disabled={!!busy} onClick={()=>void complete(true)}>先保留正文，跳过网页</button>:null}</div></>}
    </>}
    {error?<div className="practice-error" role="alert"><p>{error}</p><button type="button" className="practice-text" disabled={!!busy} onClick={()=>void refresh()}>核对已有进度</button></div>:null}
    <footer className="practice-bottom"><button type="button" className="practice-text" onClick={continueChat}>收起，稍后继续<MessageCircle size={14}/></button>{!pending&&!recap?<button type="button" className="practice-text" disabled={!!busy} onClick={()=>void mutate('skip',async()=>{await callbacks.current.onSkip();})}>跳过这次体验</button>:null}</footer>
  </section>;
}
