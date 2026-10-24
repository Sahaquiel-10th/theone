import {useId,useLayoutEffect,useRef,type CSSProperties,type ReactNode} from 'react';
import {advanceSplitSpring,createSplitCompletion,splitSpringAtRest,splitWorkspaceGeometry,type SplitSpring} from './splitGeometry';
import {workLayerUsesDirectTaskSplit} from './workLayerArrivalGeometry';
import './fluid-split-workspace.css';

export type FluidSplitWorkspaceProps = {
  open:boolean;
  primary:ReactNode;
  secondary:ReactNode;
  /** Changing the selected object starts its detail at the top; reopening the
   * same draft keeps its reading position. This never resets the primary list. */
  detailKey?:string;
  ratio?:number;
  className?:string;
  primaryLabel?:string;
  secondaryLabel?:string;
  /** Fixed-height compact children; large workspaces otherwise size to the viewport. */
  height?:number;
  compact?:boolean;
  style?:CSSProperties;
  onSettled?:(open:boolean)=>void;
};

/** One material changes topology; content is never blurred, scaled or remounted. */
export function FluidSplitWorkspace({open,primary,secondary,detailKey,ratio=.34,className='',primaryLabel='列表',secondaryLabel='详情',height,compact=false,style,onSettled}:FluidSplitWorkspaceProps){
  const root=useRef<HTMLDivElement>(null),shape=useRef<SVGPathElement>(null),rim=useRef<SVGPathElement>(null),svg=useRef<SVGSVGElement>(null);
  const first=useRef<HTMLElement>(null),second=useRef<HTMLElement>(null),wake=useRef<()=>void>(()=>{});
  const safeRatio=Number.isFinite(ratio)?Math.max(.28,Math.min(.66,ratio)):.34;
  const latest=useRef({open,ratio:safeRatio,compact,onSettled});latest.current={open,ratio:safeRatio,compact,onSettled};
  // Callers often clear selected detail as they close. Keep its last subtree
  // until it has physically rejoined, so drafts never disappear mid-motion.
  const retained=useRef(secondary);if(open&&secondary!=null)retained.current=secondary;
  const glint=`fluid-split-${useId().replace(/:/g,'')}`;

  useLayoutEffect(()=>{
    const container=root.current,material=shape.current,edge=rim.current,canvas=svg.current,left=first.current,right=second.current;
    if(!container||!material||!edge||!canvas||!left||!right)return;
    const preference=matchMedia('(prefers-reduced-motion: reduce)');
    const workLayer=container.closest<HTMLDialogElement>('dialog.fluid-formal-work-layer');
    const hasArrivalHost=Boolean(workLayer?.querySelector('[data-fluid-arrival-anchor]'));
    const directTaskEntry=()=>workLayerUsesDirectTaskSplit(Boolean(workLayer?.classList.contains('fluid-work-layer-things')),container!.classList.contains('things-task-split')&&latest.current.open);
    // Flattened wrappers (for example the Twins tab) do not own a material.
    // Only its first visible split waits; compact children keep their own flow.
    const isMaterialOwner=()=>{
      let ancestor=container!.parentElement?.closest<HTMLElement>('.fluid-split-workspace');
      while(ancestor){const material=ancestor.querySelector<SVGSVGElement>(':scope > .fluid-split-material');if(material&&getComputedStyle(material).display!=='none')return false;ancestor=ancestor.parentElement?.closest<HTMLElement>('.fluid-split-workspace')??null;}
      return true;
    };
    let nativeWasOpen=Boolean(workLayer?.open);
    let entryPending=hasArrivalHost&&workLayer?.dataset.fluidArrivalState!=='settled';
    let disposed=false,frame=0,lastTime=0,awaitingFocus=latest.current.open;
    let lastFocusInChild=right.contains(document.activeElement);
    let openingSource=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const completion=createSplitCompletion(latest.current.open,target=>latest.current.onSettled?.(target));
    let motion:SplitSpring={position:0,velocity:0},proportion:SplitSpring={position:latest.current.ratio,velocity:0};
    const bounds=container.getBoundingClientRect();let width=bounds.width||1040,bodyHeight=bounds.height||560;
    function paint(){
      const current=latest.current;
      const geometry=splitWorkspaceGeometry({width,height:bodyHeight,progress:motion.position,ratio:proportion.position,compact:current.compact});
      const m=geometry.metrics;material!.setAttribute('d',geometry.path);edge!.setAttribute('d',geometry.path);
      canvas!.setAttribute('viewBox',`0 0 ${m.width} ${m.height}`);
      container!.style.setProperty('--fluid-split-primary-width',`${m.primaryWidth.toFixed(2)}px`);
      container!.style.setProperty('--fluid-split-secondary-left',`${m.secondaryLeft.toFixed(2)}px`);
      container!.style.setProperty('--fluid-split-secondary-width',`${m.secondaryWidth.toFixed(2)}px`);
      container!.style.setProperty('--fluid-split-reveal',`${m.contentReveal.toFixed(3)}`);
      const interactive=current.open&&m.contentReveal>.08;
      right!.hidden=!current.open&&motion.position===0;right!.inert=!interactive;right!.setAttribute('aria-hidden',String(!interactive));
      if(interactive&&awaitingFocus){
        awaitingFocus=false;
        // Focus moves with the new detail only if the person has not already
        // chosen another control while its material is separating.
        if(document.activeElement===openingSource){
          right!.querySelector<HTMLElement>('[data-split-focus],h2[tabindex],h3[tabindex],h4[tabindex],input:not([type=hidden]):not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus({preventScroll:true});
        }
      }
      container!.dataset.splitState=motion.position===0?'merged':motion.position===1?'split':current.open?'separating':'joining';
      container!.dataset.splitTopology=m.connected?'connected':'separated';
    }
    function notify(){completion.settle(latest.current.open);}
    function animate(now:number){
      frame=0;if(disposed)return;
      const dt=(now-lastTime)/1000;lastTime=now;
      motion=advanceSplitSpring(motion,latest.current.open?1:0,dt,preference.matches);
      proportion=advanceSplitSpring(proportion,latest.current.ratio,dt,preference.matches);paint();
      if(!splitSpringAtRest(motion,latest.current.open?1:0)||!splitSpringAtRest(proportion,latest.current.ratio))frame=requestAnimationFrame(animate);else notify();
    }
    function start(){
      if(disposed)return;
      if(completion.retarget(latest.current.open)){
        awaitingFocus=latest.current.open;
        if(latest.current.open)openingSource=document.activeElement instanceof HTMLElement?document.activeElement:null;
      }
      if(!latest.current.open){
        const active=document.activeElement;
        // A successful form commonly disables/removes its focused submit before
        // the owner changes `open`, so the browser has already fallen to body.
        // Remember child ownership, but never override another chosen control.
        const lostChildFocus=lastFocusInChild&&(active===document.body||active===document.documentElement||active===null);
        if(right!.contains(active)||lostChildFocus){
          const candidate=openingSource?.isConnected&&left!.contains(openingSource)&&!openingSource.matches(':disabled')?openingSource:left;
          candidate!.focus({preventScroll:true});
        }
        lastFocusInChild=false;
      }
      if(latest.current.open&&entryPending&&isMaterialOwner()&&!directTaskEntry()){
        if(frame)cancelAnimationFrame(frame);frame=0;
        motion={position:0,velocity:0};container!.dataset.splitArrivalWait='true';paint();return;
      }
      container!.dataset.splitArrivalWait='false';
      if(preference.matches||document.hidden){motion={position:latest.current.open?1:0,velocity:0};proportion={position:latest.current.ratio,velocity:0};if(frame)cancelAnimationFrame(frame);frame=0;paint();notify();return;}
      paint();if(!frame){lastTime=performance.now();frame=requestAnimationFrame(animate);}
    }
    wake.current=start;
    const observer=new ResizeObserver(entries=>{const size=entries[0]?.contentRect;if(size){width=size.width;bodyHeight=size.height;paint();}});observer.observe(container);
    const preferenceChanged=()=>start(),visibilityChanged=()=>{if(document.hidden)start();};
    const arrivalObserver=hasArrivalHost&&workLayer?new MutationObserver(()=>{
      const isOpen=workLayer.open;
      if(isOpen&&!nativeWasOpen){entryPending=true;if(isMaterialOwner()&&!directTaskEntry())motion={position:0,velocity:0};}
      if(!isOpen)entryPending=true;
      else if(workLayer.dataset.fluidArrivalState==='settled')entryPending=false;
      nativeWasOpen=isOpen;start();
    }):null;
    arrivalObserver?.observe(workLayer!,{attributes:true,attributeFilter:['open','data-fluid-arrival-state','data-fluid-arrival-active']});
    function rememberFocus(event:FocusEvent){
      if(!(event.target instanceof Node))return;
      if(right!.contains(event.target))lastFocusInChild=true;
      else if(event.target!==document.body&&event.target!==document.documentElement)lastFocusInChild=false;
    }
    function respectOtherAction(event:PointerEvent){
      const target=event.target instanceof Element?event.target:null;
      const control=target?.closest('button,a[href],input,textarea,select,summary,[tabindex]:not([tabindex="-1"])');
      if(control&&!right!.contains(control))lastFocusInChild=false;
    }
    preference.addEventListener('change',preferenceChanged);document.addEventListener('visibilitychange',visibilityChanged);
    document.addEventListener('focusin',rememberFocus,true);document.addEventListener('pointerdown',respectOtherAction,true);start();
    return()=>{disposed=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();arrivalObserver?.disconnect();preference.removeEventListener('change',preferenceChanged);document.removeEventListener('visibilitychange',visibilityChanged);document.removeEventListener('focusin',rememberFocus,true);document.removeEventListener('pointerdown',respectOtherAction,true);wake.current=()=>{};};
  },[]);
  const lastDetail=useRef<string|undefined>(undefined);
  useLayoutEffect(()=>{
    if(open&&detailKey!==undefined&&detailKey!==lastDetail.current){
      if(second.current)second.current.scrollTop=0;
      lastDetail.current=detailKey;
    }
    wake.current();
  },[open,detailKey,ratio,compact,height]);

  return <div ref={root} className={`fluid-split-workspace${compact?' is-compact':''}${className?` ${className}`:''}`} data-fluid-split-workspace data-split-open={open} data-split-state="merged" style={{...style,...(height&&Number.isFinite(height)?{'--fluid-split-height':`${Math.max(120,height)}px`}: {})} as CSSProperties}>
    <svg ref={svg} className="fluid-split-material" viewBox="0 0 1040 560" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id={glint} x1="0" y1="0" x2=".65" y2="1"><stop offset="0" stopColor="var(--fluid-rim-light,#ffffffb0)"/><stop offset=".3" stopColor="var(--fluid-line,#52687625)"/><stop offset=".72" stopColor="transparent"/><stop offset="1" stopColor="var(--fluid-rim-shade,#293e4a35)"/></linearGradient></defs>
      <path ref={shape} className="fluid-split-fill" d={splitWorkspaceGeometry({width:1040,height:560,progress:0,ratio,compact}).path}/>
      <path ref={rim} className="fluid-split-rim" fill="none" stroke={`url(#${glint})`}/>
    </svg>
    <section ref={first} className="fluid-split-primary" aria-label={primaryLabel} tabIndex={-1}>{primary}</section>
    <section ref={second} className="fluid-split-secondary" aria-label={secondaryLabel} aria-hidden="true" hidden inert>{retained.current}</section>
  </div>;
}
