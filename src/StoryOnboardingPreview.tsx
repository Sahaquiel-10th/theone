import {useEffect,useId,useReducer,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,BookOpen,Check,CheckCheck,FileText,MessageCircle,Monitor,Plus,Sparkles,X} from 'lucide-react';
import {FluidSplitWorkspace} from './fluid/FluidSplitWorkspace';
import {companionAperture} from './oneEyeMotion';
import {onboardingPurposes} from './onboardingPurposes';
import {createOnboardingPreview,onboardingPreviewReducer,onboardingPreviewSteps} from './onboardingPreviewState';

/** Effect-only walkthrough: intentionally cannot access JourneyInput or request APIs. */
export default function StoryOnboardingPreview({initialName,onDismiss}:{initialName:string;onDismiss:()=>void}) {
  const [state,dispatch]=useReducer(onboardingPreviewReducer,initialName,createOnboardingPreview);
  const [wink,setWink]=useState(0),[aside,setAside]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null),finishRef=useRef(onDismiss),done=useRef(false);
  finishRef.current=onDismiss;
  const id=useId().replace(/:/g,''),step=onboardingPreviewSteps[state.step];
  const finish=()=>{if(done.current)return;done.current=true;finishRef.current();};
  useEffect(()=>{
    // Only a new guide step starts at the top. The shared split primitive keeps
    // other workflows' list positions, and all local choices remain untouched.
    heading.current?.closest<HTMLElement>('.fluid-split-primary')?.scrollTo({top:0,behavior:'instant'});
    heading.current?.focus({preventScroll:true});
  },[state.step]);
  useEffect(()=>{if(!aside)return;const timer=setTimeout(()=>setAside(false),2000);return()=>clearTimeout(timer);},[wink,aside]);
  useEffect(()=>{if(!state.ending)return;const timer=setTimeout(finish,1400);return()=>clearTimeout(timer);},[state.ending]);
  function close(){if(state.step===3){if(!state.expanded)finish();else dispatch({type:'finish'});}else finish();}
  const demoLabel=state.step===1?'看看资料引用':state.step===2?'看看文件怎么交付':'看看任务怎么出现';
  const primary=<div className="guide-preview-primary">
    <div className="guide-preview-eyeline">
      <button type="button" className="guide-preview-eye" aria-label="和 ONE 打个招呼" onClick={()=>{setWink(value=>value+1);setAside(true);}}>
        <svg viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id={`guide-eye-${id}`}><path key={wink} className={wink?'guide-eye-aperture is-winking':'guide-eye-aperture'} d={companionAperture(1,.12)}/></clipPath></defs><g clipPath={`url(#guide-eye-${id})`}><rect className="guide-preview-eye-white" x="10" y="9" width="80" height="82" fill="var(--fluid-accent,#efcf57)"/><path className="guide-preview-eye-pupil" d="M53 26C49.3 40.2 47.9 57.7 48.9 75" fill="none" stroke="#17212a" strokeWidth="9" strokeLinecap="round"/></g></svg>
      </button>
      <span className="guide-preview-thought" role="status">{aside?'不急，我们一步一步来。':'ONE · 一起想，一起做'}</span>
    </div>
    <div className="guide-preview-copy" key={step.id}>
      <span className="guide-preview-step-label">{String(state.step+1).padStart(2,'0')} / 04 · {step.label}</span>
      <h2 ref={heading} tabIndex={-1}>{step.title}</h2><p>{step.description}</p>
      {state.step===0?<div className="guide-preview-name"><label htmlFor={`guide-name-${id}`}>怎么叫你？<span>选填</span></label><input id={`guide-name-${id}`} value={state.name} autoComplete="nickname" maxLength={40} placeholder="留个称呼，或者直接继续" onChange={event=>dispatch({type:'name',value:event.target.value})}/><small>这次只演示效果，不会修改你的个人资料。</small></div>:null}
      {state.step===3?<div className="guide-preview-purposes" aria-label="想体验的方向，最多两项">{onboardingPurposes.map(purpose=><button type="button" key={purpose.id} aria-pressed={state.purposes.includes(purpose.id)} disabled={!state.purposes.includes(purpose.id)&&state.purposes.length>=2} onClick={()=>dispatch({type:'purpose',id:purpose.id})}>{state.purposes.includes(purpose.id)?<Check size={14}/>:<Plus size={14}/>}<span>{purpose.title}</span></button>)}</div>:null}
      {state.step>0?<button type="button" className="guide-preview-demonstrate" aria-expanded={state.expanded} onClick={()=>dispatch({type:'toggle-preview'})}>{state.expanded?<X size={15}/>:state.step===1?<BookOpen size={16}/>:state.step===2?<Monitor size={16}/>:<Sparkles size={16}/>}<span>{state.expanded?'收回这颗泡泡':demoLabel}</span></button>:null}
    </div>
    <div className="guide-preview-anchor"><MessageCircle size={14}/><span>主对话一直在，你随时可以继续聊。</span></div>
  </div>;
  const secondary=<div className={`guide-preview-example guide-preview-example-${step.id}`} key={step.id}>
    <header><span>{state.step===1?'带着引用的回答':state.step===2?'这台电脑':'任务与成果'}</span><span className="guide-preview-example-label">效果演示</span></header>
    {state.step===1?<><div className="guide-preview-mini-user">上次讨论定了什么？</div><p className="guide-preview-mini-answer">先完成核心页面，让主对话保持连续。任务有进展时，再从旁边告诉你。</p><div className="guide-preview-citation"><BookOpen size={17}/><div><strong>项目笔记</strong><small>引用位置 · 第 2 段</small></div><span>01</span></div><small className="guide-preview-safety">示意内容，没有读取任何真实资料。连接时会单独授权。</small></>:state.step===2?<><div className="guide-preview-file"><FileText size={31}/><div><strong>本周工作清单.md</strong><small>准备放进你选择的工作区</small></div></div><div className="guide-preview-local-line"><Check size={15}/><span>需要你先选好文件夹</span></div><div className="guide-preview-local-line"><Check size={15}/><span>执行时显示进度，做好后能找回文件</span></div><small className="guide-preview-safety">这里只展示交付过程，不会连接或操作你的电脑。</small></>:<><div className="guide-preview-task"><span className="guide-preview-task-icon">{state.demoComplete?<CheckCheck size={20}/>:<Sparkles size={20}/>}</span><div><strong>{state.demoComplete?'周计划已经整理好':'整理一份周计划'}</strong><small>{state.demoComplete?'成果回来了，主对话还在。':'交给 ONE 后，你仍然可以继续聊。'}</small></div></div><ol className="guide-preview-task-steps"><li><Check size={13}/>接住你的要求</li><li><Check size={13}/>分出一颗任务泡泡</li><li className={state.demoComplete?'is-complete':''}>{state.demoComplete?<Check size={13}/>:<span/>}做好后把成果带回来</li></ol><button type="button" className="guide-preview-complete-demo" onClick={()=>dispatch({type:'complete-demo'})} disabled={state.demoComplete}>{state.demoComplete?'已体验成果反馈':'演示一次完成反馈'}{state.demoComplete?<Check size={14}/>:<ArrowRight size={14}/>}</button><small className="guide-preview-safety">合成任务，不会调用模型或使用电力。</small></>}
  </div>;
  return <section className="guide-preview" aria-label="ONE 新人引导效果预览" aria-busy={state.ending}>
    <header className="guide-preview-top"><div><strong>认识 ONE</strong><span>本地效果预览 · 不会连接服务或使用电力</span></div><button type="button" aria-label="结束新人引导预览" onClick={finish}><X size={18}/></button></header>
    <FluidSplitWorkspace open={state.expanded} ratio={.57} className="guide-preview-workspace" primary={primary} secondary={secondary} primaryLabel="引导步骤" secondaryLabel="当前步骤的效果示意" detailKey={step.id} height={410} onSettled={open=>{if(!open&&state.ending)finish();}}/>
    <footer className="guide-preview-footer"><div className="guide-preview-progress" aria-label={`第 ${state.step+1} 步，共 4 步`}>{onboardingPreviewSteps.map((item,index)=><span key={item.id} aria-current={index===state.step?'step':undefined} data-complete={index<state.step}/>)}</div><div className="guide-preview-navigation"><button type="button" className="guide-preview-back" disabled={state.step===0||state.ending} onClick={()=>dispatch({type:'back'})}><ArrowLeft size={15}/>上一步</button><button type="button" className="guide-preview-next" disabled={state.ending} onClick={()=>state.step===3?close():dispatch({type:'next'})}>{state.ending?'回到你的对话…':state.step===3?'结束预览，回到对话':'下一步'}{state.step===3?<Check size={15}/>:<ArrowRight size={15}/>}</button></div></footer>
  </section>;
}
