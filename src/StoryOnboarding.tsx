import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,BookOpen,Check,Monitor,Sparkles,X} from 'lucide-react';
import type {AccountProfile} from '../server/betaProfile';
import type {JourneyInput,WelcomeContext} from '../server/onboardingJourney';
import type {OnboardingHandbookOffer} from '../server/onboardingHandbook';
import {onboardingPurposes,type OnboardingPurpose} from './onboardingPurposes';
import {confirmAction} from './ConfirmAction';

export const welcomeBenefits=[
  {title:'用自己的资料找答案',description:'需要时查找已连接的资料，保留引用。'},
  {title:'把想法变成内容',description:'写文章、理方案、做分析，直接说要求。'},
  {title:'把工作交出去',description:'任务区能看进度，做好再来看看。'},
  {title:'在电脑上交付',description:'本机就绪并选好工作区后，可以创建文件。'}
];
export function StoryOnboarding({profile,context,offer,onBegin,onAction,onKnowledge,onDevice,onDismiss}:{
  profile:AccountProfile;context?:WelcomeContext;offer?:OnboardingHandbookOffer;
  onBegin:()=>Promise<unknown>;onAction:(input:JourneyInput)=>Promise<unknown>;
  onKnowledge:()=>void;onDevice:()=>void;onDismiss:()=>void;
}) {
  const j=profile.onboarding.journey,stage=j?.stage??'name';
  const [name,setName]=useState(profile.displayName),[chosen,setChosen]=useState<OnboardingPurpose[]>(j?.purposeIds??[]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const started=useRef(false),finishing=useRef(''),card=useRef<HTMLElement>(null);
  const generationAbort=useRef<AbortController|undefined>(undefined);
  useEffect(()=>()=>generationAbort.current?.abort(),[]);
  const price=offer?.pricePower,canDraw=offer?.available===true&&typeof price==='number'&&price>0&&price<=.5;
  useEffect(()=>{if(j||started.current)return;started.current=true;setBusy(true);void onBegin().catch(e=>setError(e instanceof Error?e.message:'引导暂时没打开，再试一次？')).finally(()=>setBusy(false));},[j,onBegin]);
  useEffect(()=>{setName(profile.displayName);setChosen(j?.purposeIds??[]);setError('');},[j?.id]);
  useEffect(()=>{card.current?.scrollIntoView({block:'start',behavior:'auto'});},[stage,j?.id]);
  async function generationChoice(signal:AbortSignal){
    if(!canDraw)return {createGuide:false,choice:'without_image'};
    if(!offer?.firstGift&&!await confirmAction({title:'再做一份使用说明？',message:`这次会整理说明并配图，最多使用 ${price} 电力，按实际用量结算。`,details:['之前的说明会保留。','也可以只保存设置，不重新制作。'],confirmLabel:'确认制作',cancelLabel:'只保存设置'},signal))return {createGuide:false,choice:'without_image'};
    return {createGuide:true,budgetPower:offer?.firstGift?undefined:price};
  }
  async function act(input:JourneyInput){if(busy)return;setBusy(true);setError('');try{await onAction({...input,journeyId:j?.id});}catch(e){setError(e instanceof Error?e.message:'这一步没保存好，再试一次？');}finally{setBusy(false);}}
  async function finishWithChoice(input:JourneyInput){if(busy||generationAbort.current)return;const controller=new AbortController();generationAbort.current=controller;try{const generation=await generationChoice(controller.signal);if(!controller.signal.aborted)await act({...generation,...input});}finally{if(generationAbort.current===controller)generationAbort.current=undefined;}}
  async function finishLegacy(){await finishWithChoice({action:'finish'});}
  useEffect(()=>{if(stage!=='ready'||!j||finishing.current===j.id)return;finishing.current=j.id;void finishLegacy();},[stage,j?.id]);
  if(stage==='complete')return null;
  if(stage==='ready')return <section className="one-onboarding" role="status"><p>{error||'在保存设置，马上就好。'}</p>{error?<button onClick={()=>void finishLegacy()} disabled={busy}>重新保存</button>:null}</section>;
  const step=['name','knowledge','device','features'].indexOf(stage)+1;
  return <section ref={card} className="one-onboarding one-story-onboarding" aria-labelledby="one-story-title" aria-busy={busy}>
    <div className="one-onboarding-top"><span>认识一下 ONE</span><span>{step} / 4<button type="button" className="story-close" aria-label="稍后继续新手引导" onClick={onDismiss}><X size={17}/></button></span></div>
    {stage==='name'?<>
      <h2 id="one-story-title">我在。怎么称呼你？</h2><p>不想填的可以跳过，之后随时能改。</p>
      <form onSubmit={e=>{e.preventDefault();void act({action:'step',step:'name',choice:'provided',displayName:name});}}><label htmlFor="one-story-name" className="one-onboarding-label">称呼（选填）</label><input id="one-story-name" autoComplete="nickname" placeholder="比如，小张" value={name} maxLength={40} onChange={e=>setName(e.target.value)} disabled={busy||!j}/><div className="one-onboarding-actions"><button type="submit" disabled={busy||!j||!name.trim()}>就这么叫我<ArrowUpRight size={16}/></button><button type="button" className="one-onboarding-quiet" disabled={busy||!j} onClick={()=>void act({action:'step',step:'name',choice:'skipped'})}>先不填</button></div></form>
    </>:stage==='knowledge'?<>
      <BookOpen size={25}/><h2 id="one-story-title">让你的资料，也来帮忙</h2><p>连接后，问问题时就能找你自己的资料。</p>
      <div className="story-status">{context?.platforms.length?<><Check size={16}/><span>已连接：{context.platforms.join('、')}</span></>:<span>还没连接也没关系，先聊天一样可以。</span>}</div>
      <div className="one-onboarding-actions">{context?.platforms.length?<button type="button" disabled={busy||!j} onClick={()=>void act({action:'step',step:'knowledge',choice:'connected'})}>继续<ArrowUpRight size={16}/></button>:<button type="button" disabled={busy} onClick={onKnowledge}>连接知识<ArrowUpRight size={16}/></button>}<button type="button" className="one-onboarding-quiet" disabled={busy||!j} onClick={()=>void act({action:'step',step:'knowledge',choice:'skipped'})}>这步先跳过</button>{context?.platforms.length?<button type="button" className="one-onboarding-quiet" disabled={busy} onClick={onKnowledge}>管理连接</button>:null}</div>
    </>:stage==='device'?<>
      <Monitor size={25}/><h2 id="one-story-title">要在这台电脑上做文件吗？</h2><p>先看看本机连接是否就绪，不会读取或修改文件。</p>
      <div className="one-onboarding-actions"><button type="button" disabled={busy||!j} onClick={()=>void act({action:'step',step:'device',choice:'checked'})}>检测本机，继续<ArrowUpRight size={16}/></button><button type="button" className="one-onboarding-quiet" disabled={busy||!j} onClick={()=>void act({action:'step',step:'device',choice:'skipped'})}>先只在 ONE 里用</button></div>
      <button type="button" className="story-later" disabled={busy} onClick={onDevice}>设置本机工作区 ↗</button>
    </>:<>
      <Sparkles size={25}/><h2 id="one-story-title">你主要想用 ONE 做什么？</h2><p>选一两个就好，之后随时能改。</p>
      <div className="story-feature-list story-purpose-list">{onboardingPurposes.map(p=><button type="button" key={p.id} disabled={busy||!chosen.includes(p.id)&&chosen.length>=2} aria-pressed={chosen.includes(p.id)} onClick={()=>setChosen(old=>old.includes(p.id)?old.filter(id=>id!==p.id):[...old,p.id])}><span><strong>{p.title}</strong><small>{p.description}</small></span>{chosen.includes(p.id)?<Check size={17}/>:null}</button>)}</div>
      <div className="one-onboarding-actions"><button type="button" disabled={busy||!j} onClick={()=>void finishWithChoice({action:'step',step:'features',choice:'purposes',purposeIds:chosen,experience:4})}>{busy?'正在保存设置…':'开始使用 ONE'}<ArrowUpRight size={16}/></button></div>
    </>}
    {busy?<p className="story-saving" role="status">{stage==='device'?'正在核对本机状态。':'在保存这一步，稍等一下。'}</p>:null}
    {error?<div className="one-onboarding-error" role="alert"><p>{error}</p></div>:null}
    {stage!=='name'?<button type="button" className="story-later" onClick={onDismiss}><ArrowLeft size={13}/>稍后继续，设置里能找回来</button>:null}
  </section>;
}
