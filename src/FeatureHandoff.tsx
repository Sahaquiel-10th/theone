import {useEffect,useId,useRef,useState,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import {FEATURE_HANDOFF_MS,featureHandoffFrame,type FeatureHandoffFrame,type HandoffRect} from './featureHandoffMotion';
import './feature-handoff.css';

export type FeatureHandoffTransfer={id:string;featureId:string;name:string;caption:string;source:HandoffRect;material:{fill:string;input:string;ink:string;edge:string;accent:string}};
const rect=(value:DOMRect):HandoffRect=>({left:value.left,top:value.top,width:value.width,height:value.height});
/** Capture the local control; selecting keeps the feature surface open. */
export function captureFeatureHandoff(feature:{id:string;name:string},source?:HTMLElement):FeatureHandoffTransfer|null{
 if(!source)return null;const bounds=source.getBoundingClientRect();if(bounds.width<1||bounds.height<1)return null;
 const style=getComputedStyle(source),token=(name:string,fallback:string)=>style.getPropertyValue(name).trim()||fallback;
 const label=source.getAttribute('role')==='option'?feature.name:source.textContent?.trim()||'下一条使用';
 return{id:crypto.randomUUID(),featureId:feature.id,name:feature.name,caption:label.length>24?label.slice(0,23)+'…':label,source:rect(bounds),material:{fill:token('--fluid-menu-fill','#edf1f2'),input:token('--fluid-input','#e7edf0'),ink:token('--fluid-ink','#233540'),edge:token('--fluid-menu-edge','#ffffffa0'),accent:token('--fluid-accent','#f0d45b')}};
}

/** A brief arrival cue. The composer itself and its text never scale or move. */
export function pulseFeatureComposer(target:HTMLElement|null){
 if(!target||document.visibilityState==='hidden'||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const rim=target.querySelector<HTMLElement>('.feature-armed-rim');
 if(rim&&typeof rim.animate==='function'){
  const motion=rim.animate([{opacity:1},{opacity:.78},{opacity:1}],{duration:420,easing:'cubic-bezier(.2,.8,.2,1)'});void motion.finished.catch(()=>{});
 }else if(typeof target.animate==='function'){
  const style=getComputedStyle(target),motion=target.animate([{borderColor:style.getPropertyValue('--fluid-accent')||'#f0d45b'},{borderColor:style.borderColor}],{duration:800,easing:'ease-out'});void motion.finished.catch(()=>{});
 }
}

type HandoffProps={transfer:FeatureHandoffTransfer|null;target:()=>HTMLElement|null;onDepart?:()=>void;onArrive?:()=>void;onComplete?:()=>void};
/** A bounded, local material response. It never owns picker visibility,
 * selection, focus or execution; rapid selections replace only decoration. */
export function FeatureHandoff({transfer,target,onDepart,onArrive,onComplete}:HandoffProps){
 const host=useRef<HTMLDivElement>(null),handlers=useRef({target,onDepart,onArrive,onComplete});handlers.current={target,onDepart,onArrive,onComplete};
 const [painting,setPainting]=useState<{id:string;frame:FeatureHandoffFrame}|null>(null);
 useEffect(()=>{
  if(!transfer)return;const element=host.current;if(!element)return;
  const preference=window.matchMedia('(prefers-reduced-motion: reduce)');let raf=0,start:number|undefined,departed=false,arrived=false,completed=false,refreshTarget=false;
  let destination=handlers.current.target(),bounds=destination?rect(destination.getBoundingClientRect()):null;
  const hide=()=>{try{element.hidePopover();}catch{/* Unsupported popovers use the fixed portal. */}};
  const depart=()=>{if(departed)return;departed=true;handlers.current.onDepart?.();refreshTarget=true;};
  const arrive=()=>{if(arrived)return;arrived=true;pulseFeatureComposer(handlers.current.target());handlers.current.onArrive?.();};
  const finish=()=>{if(completed)return;completed=true;cancelAnimationFrame(raf);depart();arrive();hide();setPainting(null);handlers.current.onComplete?.();};
  const change=()=>{if(preference.matches||document.visibilityState==='hidden')finish();};
  const resize=()=>{destination=handlers.current.target();if(destination)bounds=rect(destination.getBoundingClientRect());};
  if(preference.matches||document.visibilityState==='hidden'||!bounds){finish();return;}
  try{if(!element.matches(':popover-open'))element.showPopover();}catch{/* The app remains usable without top-layer support. */}
  setPainting({id:transfer.id,frame:featureHandoffFrame(transfer.source,bounds,0)});
  const tick=(time:number)=>{
   if(completed||!bounds)return;start??=time;
   if(refreshTarget){resize();refreshTarget=false;}
   const progress=Math.min(1,(time-start)/FEATURE_HANDOFF_MS),frame=featureHandoffFrame(transfer.source,bounds,progress);
   setPainting({id:transfer.id,frame});if(frame.departed)depart();if(frame.arrived)arrive();
   if(progress<1)raf=requestAnimationFrame(tick);else finish();
  };
  raf=requestAnimationFrame(tick);preference.addEventListener('change',change);document.addEventListener('visibilitychange',change);window.addEventListener('resize',resize);
  return()=>{completed=true;cancelAnimationFrame(raf);hide();preference.removeEventListener('change',change);document.removeEventListener('visibilitychange',change);window.removeEventListener('resize',resize);};
 },[transfer?.id]);
 if(!transfer||typeof document==='undefined')return null;
 const frame=painting?.id===transfer.id?painting.frame:null,material=transfer.material;
 const style={'--handoff-fill':material.fill,'--handoff-input':material.input,'--handoff-ink':material.ink,'--handoff-edge':material.edge,'--handoff-accent':material.accent} as CSSProperties;
 return createPortal(<div ref={host} popover="manual" className="feature-handoff" style={style} aria-hidden="true" data-feature-transfer={transfer.featureId} data-feature-transfer-phase={frame?.phase||'starting'}>
  {frame?<svg className="feature-handoff-canvas" width="100%" height="100%">
   <circle className="feature-handoff-halo" cx={frame.origin.x} cy={frame.origin.y} r={frame.haloRadius} opacity={frame.haloOpacity}/>
   {frame.sourceNeck?<path className="feature-handoff-neck" d={frame.sourceNeck}/>:null}
   <ellipse className="feature-handoff-drop" cx={frame.bubble.left+frame.bubble.width/2} cy={frame.bubble.top+frame.bubble.height/2} rx={frame.bubble.width/2} ry={frame.bubble.height/2} opacity={frame.bubbleOpacity}/>
  </svg>:null}
 </div>,document.body);
}

/** A persistent complete rim means “armed for the next message”.
 * Its tiny CSS stroke animation pauses in hidden/reduced-motion workspaces. */
export function FeatureArmedRim(){
 const [visible,setVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden');
 const gradient=`feature-rim-${useId().replace(/:/g,'')}`;
 useEffect(()=>{const update=()=>setVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update);},[]);
 return <span className="feature-armed-rim" aria-hidden="true" data-page-visible={visible}><svg width="100%" height="100%"><defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--fluid-accent,#f0d45b)"/><stop offset=".5" stopColor="var(--fluid-rim-light,#fff)"/><stop offset="1" stopColor="var(--fluid-accent,#f0d45b)"/></linearGradient></defs><rect className="feature-rim-track" x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="22" pathLength="100"/><rect className="feature-rim-flow" x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="22" pathLength="100" stroke={`url(#${gradient})`}/></svg></span>;
}
