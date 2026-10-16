import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,BookOpen,Check,Image,Monitor,Sparkles,X} from 'lucide-react';
import type {AccountProfile} from '../server/betaProfile';
import type {JourneyInput,WelcomeContext} from '../server/onboardingJourney';
import type {OnboardingHandbookOffer} from '../server/onboardingHandbook';

export const welcomeBenefits=[
  {title:'用自己的资料找答案',description:'连接知识来源，需要时查找，并保留引用。'},
  {title:'把想法变成能用的内容',description:'写文章、理方案、做分析，直接说要求。'},
  {title:'把工作分给合适的帮手',description:'选择已开放的功能，任务区随时看进度。'},
  {title:'在电脑上交付成果',description:'本机就绪并选好工作区后，再让 ONE 创建文件。'}
];
const stages=['name','knowledge','device','features','ready'] as const;
export function StoryOnboarding({profile,context,offer,onBegin,onAction,onKnowledge,onDevice,onDismiss}: {
  profile:AccountProfile;context?:WelcomeContext;offer?:OnboardingHandbookOffer;
  onBegin:()=>Promise<unknown>;onAction:(input:JourneyInput)=>Promise<unknown>;
  onKnowledge:()=>void;onDevice:()=>void;onDismiss:()=>void;
}) {
  const j=profile.onboarding.journey,stage=j?.stage??'name';
  const [name,setName]=useState(profile.displayName),[chosen,setChosen]=useState<string[]>(j?.featureIds??[]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const started=useRef(false);
  const card=useRef<HTMLElement>(null);
  useEffect(()=>{if(j||started.current)return;started.current=true;setBusy(true);void onBegin().catch(e=>setError(e instanceof Error?e.message:'引导暂时没打开，再试一次？')).finally(()=>setBusy(false));},[j,onBegin]);
  useEffect(()=>{setName(profile.displayName);setChosen(j?.featureIds??[]);setError('');},[j?.id]);
  useEffect(()=>{card.current?.scrollIntoView({block:'start',behavior:'auto'});},[stage,j?.id]);
  async function act(input:JourneyInput){if(busy)return;setBusy(true);setError('');try{await onAction({...input,journeyId:j?.id});}catch(e){setError(e instanceof Error?e.message:'这一步没保存好，再试一次？');}finally{setBusy(false);}}
  const price=offer?.pricePower,canDraw=offer?.available===true&&typeof price==='number'&&price>0&&price<=.5;
  if(stage==='complete')return null;
  return <section ref={card} className="one-onboarding one-story-onboarding" aria-labelledby="one-story-title" aria-busy={busy}>
    <div className="one-onboarding-top"><span>认识一下 ONE</span><span>{stages.indexOf(stage as typeof stages[number])+1} / 5<button type="button" className="story-close" aria-label="稍后继续新手引导" onClick={onDismiss}><X size={17}/></button></span></div>
    {stage==='name'?<>
      <h2 id="one-story-title">我在。怎么称呼你？</h2><p>先走一小圈，最后把你的使用方式画成一张故事漫画。不想填的都可以跳过。</p>
      <details className="story-benefits"><summary>ONE 能帮我什么？</summary><div>{welcomeBenefits.map(b=><section key={b.title}><strong>{b.title}</strong><p>{b.description}</p></section>)}</div></details>
      <form onSubmit={e=>{e.preventDefault();void act({action:'step',step:'name',choice:'provided',displayName:name});}}><label htmlFor="one-story-name" className="one-onboarding-label">称呼（选填）</label><input id="one-story-name" autoComplete="nickname" placeholder="比如，小张" value={name} maxLength={40} onChange={e=>setName(e.target.value)} disabled={busy||!j}/><div className="one-onboarding-actions"><button type="submit" disabled={busy||!j||!name.trim()}>就这么叫我<ArrowUpRight size={16}/></button><button type="button" className="one-onboarding-quiet" disabled={busy||!j} onClick={()=>void act({action:'step',step:'name',choice:'skipped'})}>先不填</button></div></form>
    </>:stage==='knowledge'?<>
      <BookOpen size={25}/><h2 id="one-story-title">让你的资料，也来帮忙</h2><p>接好知识来源，以后问问题时，我就能去找你自己的资料。</p>
      <div className="story-status">{context?.platforms.length?<><Check size={16}/><span>已连接：{context.platforms.join('、')}</span></>:<span>还没连接也没关系，先聊天一样可以。</span>}</div>
      <div className="one-onboarding-actions"><button type="button" disabled={busy} onClick={onKnowledge}>去连接知识<ArrowUpRight size={16}/></button>{context?.platforms.length?<button type="button" disabled={busy||!j} onClick={()=>void act({action:'step',step:'knowledge',choice:'connected'})}>这些够了，继续</button>:null}<button type="button" className="one-onboarding-quiet" disabled={busy||!j} onClick={()=>void act({action:'step',step:'knowledge',choice:'skipped'})}>这步先跳过</button></div>
    </>:stage==='device'?<>
      <Monitor size={25}/><h2 id="one-story-title">这台电脑，能帮你做点什么？</h2><p>只核对 ONE 的本机连接、执行工具和工作文件夹。不扫描私人文件，不会开始执行任务。</p>
      <div className="one-onboarding-actions"><button type="button" disabled={busy||!j} onClick={()=>void act({action:'step',step:'device',choice:'checked'})}>{busy?'正在核对这台电脑…':'检测本机，继续'}<ArrowUpRight size={16}/></button><button type="button" className="one-onboarding-quiet" disabled={busy} onClick={onDevice}>先去设置工作区</button><button type="button" className="one-onboarding-quiet" disabled={busy||!j} onClick={()=>void act({action:'step',step:'device',choice:'skipped'})}>先只在 ONE 里用</button></div>
    </>:stage==='features'?<>
      <Sparkles size={25}/><h2 id="one-story-title">先挑一件你想试的事</h2><p>这些是你现在已开放的功能。选最多 3 个，让漫画用它们讲故事；选择不会运行或购买功能。</p>
      {j?.localChoice==='checked'?<p className="story-status">{j.local?.connected&&j.local.folderSelected&&j.local.executorReady?'本机已就绪，漫画里可以演示保存到工作区。':'本机还没完全就绪。这次先演示在 ONE 里拿到成果，以后随时能补设置。'}</p>:null}
      <div className="story-feature-list">{context?.features.map(f=><button type="button" key={f.id} disabled={busy||!chosen.includes(f.id)&&chosen.length>=3} aria-pressed={chosen.includes(f.id)} onClick={()=>setChosen(old=>old.includes(f.id)?old.filter(id=>id!==f.id):[...old,f.id])}><span><strong>{f.name}</strong><small>{f.description}</small></span>{chosen.includes(f.id)?<Check size={17}/>:<span>选择</span>}</button>)}</div>
      {!context?.features.length?<p>暂时没有已开放的专用功能。漫画会用聊天、写作整理和任务分派来讲故事。</p>:null}
      <div className="one-onboarding-actions"><button type="button" disabled={busy||!j} onClick={()=>void act({action:'step',step:'features',choice:chosen.length?'selected':'skipped',featureIds:chosen})}>{chosen.length?'就用这些':'先用基础能力'}<ArrowUpRight size={16}/></button>{chosen.length?<button type="button" className="one-onboarding-quiet" disabled={busy} onClick={()=>void act({action:'step',step:'features',choice:'skipped'})}>不选了，继续</button>:null}</div>
    </>:<>
      <Image size={25}/><h2 id="one-story-title">给你画一件，能用 ONE 做的小事</h2><p>主角是{profile.displayName||'你'}，搭档是一只看着没睡醒的猫。怎么开口、怎么分工、怎么拿到结果，放进同一个故事里。</p>
      <ul className="story-facts"><li>知识来源：{context?.platforms.join('、')||'暂未连接，故事从一个想法开始'}</li><li>功能：{context?.features.filter(f=>j?.featureIds.includes(f.id)).map(f=>f.name).join('、')||'聊天、写作整理与任务分派'}</li><li>交付位置：{j?.localChoice==='checked'&&j.local?.connected&&j.local.folderSelected&&j.local.executorReady?'演示保存到已选工作区':'先在 ONE 对话与任务里查看'}</li></ul>
      <div className="one-onboarding-guide"><Image size={22}/><div><strong>{profile.onboarding.completedAt?'这张漫画，也是一件任务':'漫画会成为你的第一件任务'}</strong><p>安排后就能开始聊天，不用守着等。画好会在任务区提醒你。</p><small>{canDraw?`1 张图片 · 使用现有额度 ${price.toLocaleString('zh-CN',{maximumFractionDigits:6})} 电力`:'图片通道暂时不可用，可以先开始使用，稍后从设置重做引导。'}<br/>只用称呼、连接状态和已开放功能名称，不读取你的知识内容或文件。故事是使用示意，不会真的替你创建 PPT。</small></div></div>
      <div className="one-onboarding-actions"><button type="button" disabled={busy||!j||!canDraw} onClick={()=>void act({action:'finish',budgetPower:price})}>{busy?'正在安排漫画任务…':'完成引导，画我的漫画'}<ArrowUpRight size={16}/></button>{!canDraw?<button type="button" className="one-onboarding-quiet" onClick={onDismiss}>先开始使用</button>:null}</div>
    </>}
    {busy?<p className="story-saving" role="status">{stage==='device'?'正在核对本机状态，不会操作文件。':'在保存这一步，稍等一下。'}</p>:null}
    {error?<div className="one-onboarding-error" role="alert"><p>{error}</p>{!j?<button type="button" onClick={()=>{setBusy(true);setError('');void onBegin().catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>重新打开</button>:null}</div>:null}
    {stage!=='name'?<button type="button" className="story-later" onClick={onDismiss}><ArrowLeft size={13}/>稍后继续，设置里能找回来</button>:null}
  </section>;
}
