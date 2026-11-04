import {useCallback,useEffect,useId,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {ArrowUp,BookOpen,Check,ExternalLink,LoaderCircle,Plug,RefreshCw} from 'lucide-react';
import type {AccountProfile} from '../server/betaProfile';
import type {CuriousOnboardingInput,CuriousOnboardingView,CuriousOption} from '../server/curiousOnboarding';
import type {CompanionPreferences} from '../server/oneCompanion';
import {api,ApiError,currentApiIdentity} from './oneApi';
import {OneMessageAvatar} from './OneMessageAvatar';
import {CuriousText,CuriousInlineText,curiousOptionPresentation} from './curiousPresentation';
import type {ConversationInlineEntry} from './conversationTimeline';
import {companionChoices,companionIntensityChoices,companionSample} from './companionPersonas';

const endpoint='/api/me/profile/curious-onboarding';
type PendingAnswer={input:CuriousOnboardingInput;reply?:string};
export type CuriousOnboardingProps={
  profile:AccountProfile;
  request?:typeof api;
  onProfile:(profile:AccountProfile)=>void;
  onKnowledge:(sessionId?:string)=>void;
  onComplete:()=>void;
  onContinueChat?:(text?:string)=>void;
  onActiveChange?:(active:boolean)=>void;
  onOpenTask?:(id:string)=>void;
  refreshKey?:string;
  renderConversation?:(entries:ConversationInlineEntry[])=>ReactNode;
  /** An accepted launch response, or an isolated presentation fixture. */
  initialView?:CuriousOnboardingView;
};

/** A conversation embedded in the main chat. Only server-provided choices can
 * advance it; connecting a source opens settings and never claims authorization. */
export function CuriousOnboarding({profile,request=api,onProfile,onKnowledge,onComplete,onContinueChat,onActiveChange,onOpenTask,refreshKey,initialView,renderConversation}:CuriousOnboardingProps){
  const [view,setView]=useState(initialView),[loading,setLoading]=useState(!initialView),[working,setWorking]=useState(false),[error,setError]=useState('');
  const [draft,setDraft]=useState(''),[pending,setPending]=useState<PendingAnswer>(),[suspended,setSuspended]=useState(false),[picking,setPicking]=useState(false);
  const [styleExpanded,setStyleExpanded]=useState(false);
  const [style,setStyle]=useState<CompanionPreferences>(initialView?.profile.companion??profile.companion??{persona:'robot',intensity:'normal'}),[styleSample,setStyleSample]=useState(false),[styleSaved,setStyleSaved]=useState(false);
  const mounted=useRef(false),version=useRef(0),locked=useRef(false),viewRef=useRef(view),pauseQueued=useRef(false),continueText=useRef<string|undefined>(undefined);
  const pendingAt=useRef('');
  const beginId=useRef(''),pendingRef=useRef<PendingAnswer|undefined>(undefined),scroll=useRef<HTMLDivElement>(null),prompt=useRef<HTMLDivElement>(null),focusNext=useRef(Boolean(initialView));
  const lastRefreshKey=useRef(refreshKey);
  const callbacks=useRef({onProfile,onKnowledge,onComplete,onContinueChat,onActiveChange,onOpenTask});callbacks.current={onProfile,onKnowledge,onComplete,onContinueChat,onActiveChange,onOpenTask};
  const operateRef=useRef<(item:PendingAnswer)=>Promise<void>>(async()=>{}),identity=useRef(currentApiIdentity()),completedNotice=useRef('');
  const id=useId().replaceAll(':',''),session=view?.session,current=session?.current;
  const active=!suspended&&(loading||!session||session.status==='active');
  const busy=working||!!view?.busy;
  const companion=view?.profile.companion??profile.companion??style;
  const persona=companionChoices.find(p=>p.id===companion.persona);
  const invalidStyle=[...(style.custom??'')].length>120||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(style.custom??'');
  const replyLimit=session?.stage==='name'?40:180;
  const invalidReply=[...draft.trim()].length>replyLimit||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(draft.trim());
  const ownIdentity=()=>{const now=currentApiIdentity(),then=identity.current;return now.userId===then.userId&&now.workspaceId===then.workspaceId&&now.revision===then.revision;};
  const requestId=()=>`curious_${crypto.randomUUID()}`;
  const apply=useCallback((next:CuriousOnboardingView)=>{
    viewRef.current=next;setView(next);callbacks.current.onProfile(next.profile);
    if(next.profile.companion)setStyle(next.profile.companion);
    if(continueText.current!==undefined&&next.session&&next.session.status!=='active'){
      const text=continueText.current;continueText.current=undefined;setSuspended(true);callbacks.current.onContinueChat?.(text);
    }
  },[]);
  const refresh=useCallback(async()=>{
    if(locked.current)return;
    const token=++version.current;
    try{
      const next=await request<CuriousOnboardingView>(endpoint);
      if(!mounted.current||token!==version.current||!ownIdentity())return;
      apply(next);setError('');setLoading(false);
      const pendingInput=pendingRef.current?.input;
      if(next.session&&pendingInput&&(pendingInput.action==='begin'||next.session.id!==pendingInput.sessionId||next.session.revision>(pendingInput.revision??0))){pendingRef.current=undefined;setPending(undefined);}
      if(!next.session){
        beginId.current||=(requestId());
        await operateRef.current({input:{action:'begin',requestId:beginId.current}});
      }
      return next;
    }catch(e){if(mounted.current&&token===version.current&&ownIdentity()){setError(e instanceof Error?e.message:'暂时没连上。已经聊过的内容会保留。');setLoading(false);}}
  },[request,apply]);
  const operate=useCallback(async(item:PendingAnswer)=>{
    if(locked.current||!mounted.current||!ownIdentity())return;
    locked.current=true;setWorking(true);setError('');++version.current;
    if(pendingRef.current?.input.requestId!==item.input.requestId)pendingAt.current=new Date().toISOString();
    pendingRef.current=item;setPending(item);
    try{
      const next=await request<CuriousOnboardingView>(endpoint,{method:'POST',body:JSON.stringify(item.input)});
      if(!mounted.current||!ownIdentity())return;
      apply(next);pendingRef.current=undefined;setPending(undefined);setDraft('');setPicking(false);setStyleSample(false);setStyleSaved(false);
      if(item.input.action==='resume')setSuspended(false);
      focusNext.current=item.input.action==='answer'||item.input.action==='resume';
    }catch(e){
      if(!mounted.current||!ownIdentity())return;
      if(e instanceof ApiError&&e.status===409){
        // A stale option is not replayed. Reconcile the durable receipt first.
        pendingRef.current=undefined;setPending(undefined);
        try{const next=await request<CuriousOnboardingView>(endpoint);if(mounted.current&&ownIdentity()){apply(next);setError(e.message);}}
        catch(readError){if(mounted.current&&ownIdentity())setError(readError instanceof Error?readError.message:'暂时无法确认这一轮，请稍后查看。');}
      }else setError(e instanceof Error?e.message:'这一条暂时没确认好。可以查看状态，或用同一条回复重试。');
    }finally{
      locked.current=false;
      if(mounted.current&&ownIdentity()){
        setWorking(false);setLoading(false);
        if(pauseQueued.current){
          pauseQueued.current=false;
          const s=viewRef.current?.session;
          if(s?.status==='active')void operateRef.current({input:{action:'pause',requestId:requestId(),sessionId:s.id,revision:s.revision}});
        }
      }
    }
  },[request,apply]);
  operateRef.current=operate;
  useEffect(()=>{
    mounted.current=true;identity.current=currentApiIdentity();
    // The accepted launch snapshot paints immediately; a remount must still
    // reconcile later answers, source authorizations, or another tab's restart.
    void refresh();
    return()=>{mounted.current=false;++version.current;};
  },[refresh]);
  useEffect(()=>{
    callbacks.current.onActiveChange?.(active);
    if(!active){
      const key=`${session?.id??'local'}:${suspended?'suspended':session?.status}`;
      if(completedNotice.current!==key){completedNotice.current=key;callbacks.current.onComplete();}
    }else completedNotice.current='';
  },[active,suspended,session?.id,session?.status]);
  useEffect(()=>{
    if(!active)return;
    scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});
    if(focusNext.current&&!busy){focusNext.current=false;prompt.current?.focus({preventScroll:true});}
  },[session?.revision,current?.id,working,active,busy]);
  useEffect(()=>{
    const delivery=view?.welcomeDelivery;
    if(!view?.busy&&!delivery||working)return;
    if(!view?.busy&&delivery&&!['preparing','queued','running'].includes(delivery.state))return;
    const timer=setTimeout(()=>void refresh(),5000);
    return()=>clearTimeout(timer);
  },[view,working,refresh]);
  useEffect(()=>{
    if(lastRefreshKey.current===refreshKey||locked.current||view?.busy)return;
    lastRefreshKey.current=refreshKey;
    if(session?.status==='active'&&session.stage==='knowledge')void refresh();
  },[refreshKey,session?.stage,session?.status,working,view?.busy,refresh]);
  const pause=(text?:string)=>{
    continueText.current=text;setError('');
    if(text===undefined)setSuspended(true);
    const s=viewRef.current?.session;
    if(locked.current){pauseQueued.current=true;return;}
    if(s?.status==='active')void operate({input:{action:'pause',requestId:requestId(),sessionId:s.id,revision:s.revision}});
  };
  const resume=()=>{
    const s=viewRef.current?.session;
    if(!s){setSuspended(false);setLoading(true);void refresh();return;}
    if(s.status==='completed')return;
    void operate({input:{action:'resume',requestId:requestId(),sessionId:s.id,revision:s.revision}});
  };
  const answer=(option?:CuriousOption,text?:string,personaId?:string)=>{
    if(!session||busy||suspended)return;
    if(option?.action==='connect'){callbacks.current.onKnowledge(session.id);return;}
    if(option?.action==='choose_style'&&!personaId){setPicking(v=>!v);return;}
    const chosen=personaId?companionChoices.find(p=>p.id===personaId):undefined;
    void operate({input:{action:'answer',requestId:requestId(),sessionId:session.id,revision:session.revision,...(option?{optionId:option.id}:{}),...(text?{text}:{}),...(personaId?{personaId}:{})},reply:chosen?`试试「${chosen.name}」`:text??option?.reply??option?.label});
  };
  const submit=(event:FormEvent)=>{event.preventDefault();const text=draft.trim();if(!text||busy)return;if(current?.allowText){if(!invalidReply&&!pending)answer(undefined,text);}else if(onContinueChat)pause(text);};
  const retryGuide=async()=>{
    const delivery=viewRef.current?.welcomeDelivery;
    if(locked.current||!delivery?.canRetry)return;
    locked.current=true;setWorking(true);setError('');
    try{
      await request('/api/me/profile/onboarding',{method:'POST',body:JSON.stringify({action:'retry_delivery',operationId:delivery.operationId})});
      if(mounted.current&&ownIdentity()){locked.current=false;await refresh();}
    }catch(e){if(mounted.current&&ownIdentity())setError(e instanceof Error?e.message:'这份说明暂时没安排好，请稍后查看状态。');}
    finally{locked.current=false;if(mounted.current&&ownIdentity())setWorking(false);}
  };
  const saveStyle=async()=>{
    if(locked.current||busy||invalidStyle)return;
    locked.current=true;setWorking(true);setError('');++version.current;
    try{
      const next=await request<{profile:AccountProfile}>('/api/me/profile',{method:'PATCH',body:JSON.stringify({companion:{...style,custom:style.custom?.trim()||undefined}})});
      if(!mounted.current||!ownIdentity())return;
      callbacks.current.onProfile(next.profile);
      const updated=await request<CuriousOnboardingView>(endpoint);
      if(mounted.current&&ownIdentity()){apply(updated);setStyleSaved(true);focusNext.current=true;}
    }catch(e){if(mounted.current&&ownIdentity())setError(e instanceof Error?e.message:'口气暂时没保存好，稍后再试。');}
    finally{
      locked.current=false;
      if(mounted.current&&ownIdentity()){
        setWorking(false);
        if(pauseQueued.current){pauseQueued.current=false;const s=viewRef.current?.session;if(s?.status==='active')void operateRef.current({input:{action:'pause',requestId:requestId(),sessionId:s.id,revision:s.revision}});}
      }
    }
  };
  const renderChoices=()=>current&&active&&!busy&&!pending&&<div className="curious-current" tabIndex={-1} ref={prompt} aria-label="这一轮可以这样回复">
    <div className="curious-replies" data-stage={session?.stage}>{current.options.map(option=>{const display=curiousOptionPresentation(option,session?.stage);return <button type="button" key={option.id} data-action={option.action} data-intent={display.intent} data-option-kind={display.kind} aria-expanded={option.action==='choose_style'?picking:undefined} onClick={()=>answer(option)}>{option.action==='connect'&&<Plug size={17} aria-hidden="true"/>}<span className="curious-option-copy"><span className="curious-option-title"><CuriousInlineText text={display.title} emphasis={display.emphasis} fallbackEmphasis={false}/></span>{display.support&&<small>{display.support}</small>}</span>{option.action==='connect'&&<ExternalLink size={13} aria-hidden="true"/>}</button>;})}</div>
    {session?.stage==='style'&&<>
      {picking&&<div className="curious-personas" aria-label="挑一种聊天口气">{companionChoices.map(choice=><button type="button" key={choice.id} aria-pressed={choice.id===companion.persona} onClick={()=>answer(current.options.find(o=>o.action==='choose_style'),undefined,choice.id)}><strong>{choice.name}</strong><small>{choice.description}</small></button>)}</div>}
      <details className="curious-style" open={styleExpanded} onToggle={event=>setStyleExpanded(event.currentTarget.open)}><summary>口气也可以微调，或者写成你喜欢的样子</summary><div className="curious-style-controls">
        <fieldset><legend>这份性格放开到什么程度</legend><div className="curious-strengths">{companionIntensityChoices.map(choice=><button type="button" key={choice.id} aria-pressed={style.intensity===choice.id} title={choice.description} onClick={()=>{setStyle(s=>({...s,intensity:choice.id}));setStyleSaved(false);}}>{choice.name}</button>)}</div></fieldset>
        <label className="curious-custom"><span>你喜欢的聊天方式（选填，最多 120 个字）</span><input value={style.custom??''} maxLength={240} aria-invalid={invalidStyle||undefined} onChange={e=>{setStyle(s=>({...s,custom:e.target.value}));setStyleSaved(false);}} placeholder="比如：短一点，少用感叹号，也可以直接吐槽"/></label>
        <div className="curious-style-actions"><button type="button" onClick={()=>setStyleSample(v=>!v)}>试一句</button><button type="button" className="curious-primary" disabled={invalidStyle} onClick={()=>void saveStyle()}>{styleSaved?<><Check size={14} aria-hidden="true"/>已保存</>:'保存口气'}</button></div>
        {invalidStyle&&<p className="curious-style-note" role="status">请写成一行，最多 120 个字。</p>}
        {styleSample&&<p className="curious-style-note">口气示例：{companionSample(style.persona,style.intensity,view?.profile.displayName)}<br/>这是预设示例；自定义要求会在保存后用于聊天。</p>}
      </div></details>
    </>}
  </div>;
  const history=[...(session?.messages??[])];
  if(current&&history.at(-1)?.content!==current.text)history.push({id:`current-${current.id}`,role:'assistant',content:current.text,createdAt:history.at(-1)?.createdAt??session?.startedAt});
  const entries:ConversationInlineEntry[]=[];
  const renderMessage=(message:typeof history[number],key:string,isCurrent=false)=> <article className={`coordinator-message curious-inline-message ${message.role}${message.role==='assistant'?' markdown-body':''}`} data-role={message.role} data-message-kind="introduction" aria-label={message.role==='assistant'?'ONE 的回复':'你的消息'} key={key}>
    {message.role==='assistant'&&<span className="coordinator-one-avatar" aria-hidden="true"><OneMessageAvatar/></span>}
    {message.role==='assistant'?<CuriousText text={message.content}/>:<p className="coordinator-user-text">{message.content}</p>}
    {isCurrent&&renderChoices()}
  </article>;
  const addSession=(s:{id:string;startedAt:string;status:string;messages:typeof history},isCurrent:boolean)=>{
    entries.push({id:`intro-start-${s.id}`,createdAt:s.startedAt,content:<div className="curious-session-divider" data-onboarding-session={s.id}><span>和 ONE 认识一下</span><small>{isCurrent&&active?'聊聊你的日常':s.status==='paused'?'稍后接着聊':'聊天记录'}</small></div>});
    s.messages.forEach((message,index)=>entries.push({id:`intro-${s.id}-${message.id}`,createdAt:message.createdAt??new Date((Date.parse(s.startedAt)||0)+index+1).toISOString(),content:renderMessage(message,`${s.id}-${message.id}`,isCurrent&&index===s.messages.length-1&&message.role==='assistant')}));
  };
  for(const previous of view?.history??[])addSession(previous,false);
  if(session)addSession({...session,messages:history},true);
  if(pending?.reply&&working)entries.push({id:'intro-pending-reply',createdAt:pendingAt.current,content:renderMessage({id:'pending-reply',role:'user',content:pending.reply},'pending-reply')});
  const statusAt=pendingAt.current||history.at(-1)?.createdAt||session?.startedAt||new Date().toISOString();
  if(loading||working||view?.busy)entries.push({id:'intro-loading',createdAt:statusAt,content:<p className="curious-pending" role="status"><LoaderCircle size={15} className="curious-spinner" aria-hidden="true"/>{loading?'正在接上这段对话…':view?.busy&&!working?'这一轮还在整理，已聊过的内容会保留。':'正在接着你这句话想…'}</p>});
  const delivery=view?.welcomeDelivery;
  const endAt=(offset:number)=>new Date((Date.parse(session?.completedAt??history.at(-1)?.createdAt??session?.startedAt??'')||0)+offset).toISOString();
  if(!active&&session?.status!=='completed')entries.push({id:`intro-resume-${session?.id??'local'}`,createdAt:endAt(1),content:<div className="curious-rest"><p>先聊你的事。这段对话留在这里，想继续时再接上。</p><button type="button" disabled={working} onClick={resume}>接着认识</button></div>});
  if(!active&&delivery)entries.push({id:`intro-guide-${delivery.operationId}`,createdAt:endAt(2),content:<div className="curious-handoff" aria-label="ONE 使用说明"><BookOpen size={18} aria-hidden="true"/><div><strong>{session?.guideOperationId===delivery.operationId?'你的 ONE 使用说明':'之前的 ONE 使用说明'}</strong><p>{delivery.message}</p><div className="curious-handoff-actions">{delivery.taskId&&onOpenTask&&<button type="button" onClick={()=>callbacks.current.onOpenTask?.(delivery.taskId!)}>打开这件事</button>}{delivery.canRetry&&<button type="button" disabled={working} onClick={()=>void retryGuide()}>重新安排这份说明</button>}<button type="button" className="curious-quiet" disabled={working} onClick={()=>void refresh()}>查看最新状态</button></div></div></div>});
  return <section className="curious-onboarding" data-active={active} data-integrated={Boolean(renderConversation)} aria-label="主对话中的认识一下" aria-busy={loading||working}>
    {renderConversation?renderConversation(entries):<div className="curious-scroll coordinator-messages" ref={scroll} role="log" aria-live="polite" aria-label="与 ONE 的持续对话">{entries.map(entry=><div key={entry.id} className="curious-timeline-entry">{entry.content}</div>)}</div>}
    <div className="curious-footer">
    {active&&<header className="curious-header"><span><strong>认识一下</strong><small>{persona?.name??'ONE'}</small></span><button type="button" className="curious-quiet" onClick={()=>pause()}>先做别的</button></header>}
    {view?.busy&&!working&&<div className="curious-rest"><button type="button" onClick={resume}>恢复这段对话</button></div>}
    {error&&<div className="curious-error" role="alert"><p>{error}</p><div className="curious-error-actions"><button type="button" disabled={working} onClick={()=>void refresh()}><RefreshCw size={13} aria-hidden="true"/> 查看当前状态</button>{pendingRef.current&&!working&&!suspended&&<button type="button" onClick={()=>{if(pendingRef.current)void operate(pendingRef.current);}}>{pending?.input.action==='answer'?'重试这条回复':'再试一次'}</button>}</div></div>}
    {active&&current&&(current.allowText||onContinueChat)&&!view?.busy&&<form className="curious-compose" onSubmit={submit}>
      <label htmlFor={`${id}-reply`}>{current.allowText?(session?.stage==='name'?'也可以直接告诉我怎么称呼你':'没有刚好合适的？也可以自己说'):'也可以先说你想聊的事，带回主对话'}</label>
      <div className="curious-compose-field">
        <textarea id={`${id}-reply`} rows={1} disabled={working} maxLength={20000} value={draft} aria-describedby={invalidReply&&current.allowText?`${id}-reply-hint`:undefined} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{
          if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(draft.trim()&&!busy){if(current.allowText){if(!invalidReply&&!pending)answer(undefined,draft.trim());}else pause(draft.trim());}}
        }} placeholder={current.allowText?(session?.stage==='name'?'输入你的称呼':'说一点你自己的情况…'):'说说你想做的事…'}/>
        <button className="curious-primary" type="submit" disabled={working||!draft.trim()||!!current.allowText&&(invalidReply||!!pending)} aria-label={current.allowText?'发送这条回复':'直接聊这件事'}>{current.allowText?<ArrowUp size={18} aria-hidden="true"/>:'直接聊'}</button>
      </div>
      {current.allowText&&invalidReply&&<p id={`${id}-reply-hint`} className="curious-compose-hint">这一轮先说一小句，最多 {replyLimit} 个字。完整要求可以直接带回主对话。</p>}
      {current.allowText&&draft.trim()&&onContinueChat&&<button type="button" className="curious-quiet curious-direct" disabled={busy} onClick={()=>pause(draft.trim())}>直接聊这件事</button>}
    </form>}
    {active&&view?.billingNotice&&<p className="curious-billing">{view.billingNotice}</p>}


    </div>
  </section>;
}
