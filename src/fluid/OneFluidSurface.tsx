import { useId, useLayoutEffect, useRef } from 'react';
import { createEyeAttention } from './attention';
import { fluidMetrics, mainRightAt, seamTension, clamp01, createFluidGeometry, fluidAnchorPosition, getBubbleBounds, getFluidLayout, sidebarOffset, smoothProgress } from './geometry';
import {fissionOrder} from './motionOrder';
import {entryPocketPath,sidebarEntryGeometry} from './entry';
import {FluidCompanionLogo} from './FluidCompanionLogo';
import {createSurfaceOptics} from './surfaceOptics';
import {openShoulderCut,shoulderBridge} from './shoulder';
import {FLUID_EYE_RADIUS,FLUID_EYE_SIZE,fluidPanelEye,fluidRestEntryY} from './surfaceMetrics';
import type { BubbleKind, EyeOwner, FluidFrame, FluidLayout, FluidPhases, FluidSizing } from './types';

export { getFluidLayout } from './geometry';
export type { BubbleKind, EyeOwner, FluidFrame, FluidLayout } from './types';

export interface OneFluidSurfaceProps {
  executionActive?: boolean;
  accent?: 'solar'|'iris'|'jade';
  scene?: 'silver'|'graphite';
  width: number;
  height: number;
  activityOpen: boolean;
  localOpen: boolean;
  sidebarOpen: boolean;
  sizing?: FluidSizing;
  onActivityToggle: () => void;
  onLocalToggle: () => void;
  onSidebarToggle: () => void;
  attentionTarget: EyeOwner;
  /** Increment for a new signal or deliberate interaction, even on the same panel. */
  attentionVersion: number;
  onEyeReturn?: () => void;
  /** Mutate CSS variables here; do not put per-frame values in React state. */
  onProgress?: (frame: FluidFrame) => void;
}

interface BubbleMotion {
  p: number;
  v: number;
  target: number;
  recoil: number;
  recoilV: number;
  released: boolean;
  waitFor?: BubbleKind;
}
interface EyeFrom { x: number; y: number; r: number; blink: number; join: number }
interface EyeMotion extends EyeFrom {
  owner: EyeOwner;
  next: EyeOwner;
  stage: 'rest' | 'sink' | 'wait' | 'rise';
  elapsed: number;
  from: EyeFrom;
}
const KINDS: readonly BubbleKind[] = ['activity', 'local'];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const circle = (x: number, y: number, r: number) => r < .01 ? '' : `M ${x-r} ${y} a ${r} ${r} 0 1 1 ${r*2} 0 a ${r} ${r} 0 1 1 ${-r*2} 0 Z`;
const initialBubble = (): BubbleMotion => ({ p: 0, v: 0, target: 0, recoil: 0, recoilV: 0, released: false });
const setAttr=(node:Element|null,name:string,value:string)=>{if(node&&node.getAttribute(name)!==value)node.setAttribute(name,value);};

/** Material only. Keep business content in unfiltered sibling layers above it. */
export function OneFluidSurface(props: OneFluidSurfaceProps) {
  const instanceId = useId().replace(/:/g, '');
  const ids={sockets:`${instanceId}-sockets`,rim:`${instanceId}-rim`,edge:`${instanceId}-edge`,shine:`${instanceId}-shine`};
  const latest = useRef(props);
  latest.current = props;
  const controller = useRef<(() => void) | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  const opticalCanvas=useRef<HTMLCanvasElement>(null);
  const material = useRef<SVGPathElement>(null);
  const railMaterial=useRef<SVGPathElement>(null);
  const eyeMaterial = useRef<SVGPathElement>(null);
  const eyeArt=useRef<HTMLDivElement>(null);
  const activityRestSocket=useRef<SVGPathElement>(null);
  const localRestSocket=useRef<SVGPathElement>(null);
  const materialRim = useRef<SVGPathElement>(null);
  const materialBevel=useRef<SVGPathElement>(null);
  const sourceSocket = useRef<SVGPathElement>(null);
  const activitySocket = useRef<SVGPathElement>(null);
  const localSocket = useRef<SVGPathElement>(null);
  const joinedLocalSocket=useRef<SVGPathElement>(null);
  const activityHit = useRef<HTMLButtonElement>(null);
  const localHit = useRef<HTMLButtonElement>(null);
  const sourceHit = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const root = scene.current;
    if (!root) return;
    const optics=opticalCanvas.current?createSurfaceOptics(opticalCanvas.current,()=>{root.dataset.optical='false';}):null;
    root.dataset.optical=String(!!optics);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let layout = getFluidLayout(latest.current.width, latest.current.height, latest.current.sizing);
    const bubbles: Record<BubbleKind, BubbleMotion> = { activity: initialBubble(), local: initialBubble() };
    const sizes = {
      activity: {value:layout.activityBounds.height,target:layout.activityBounds.height,v:0},
      local: {value:layout.localBounds.height,target:layout.localBounds.height,v:0},
    };
    const sidebar = { p: 0, v: 0, target: 0 };
    const mainEye=sidebarEntryGeometry(-12,layout.height/2,1).eye;
    const eye: EyeMotion = { owner: 'main', next: 'main', stage: 'rest', elapsed: 0, ...mainEye, r: FLUID_EYE_RADIUS, blink: 1, join: 1, from: { ...mainEye, r: FLUID_EYE_RADIUS, blink: 1, join: 1 } };
    let frame = 0;
    let lastTime = 0;
    let disposed = false;
    let previousTarget: EyeOwner = 'main';
    let previousVersion = Number.NaN;
    const attention = createEyeAttention({ onChange: ({ owner }) => {
      handoff(owner);
      if (owner === 'main') latest.current.onEyeReturn?.();
    } });

    function motionLayout(): FluidLayout {
      return { ...layout,
        activityBounds: { ...layout.activityBounds, height:sizes.activity.value, left: layout.activityBounds.left + bubbles.activity.recoil },
        localBounds: { ...layout.localBounds, height:sizes.local.value, top:layout.height-sizes.local.value, left: layout.localBounds.left + bubbles.local.recoil },
      };
    }
    function destination(kind: EyeOwner, current: FluidLayout) {
      if (kind === 'main') return sidebarEntryGeometry(-12+sidebarOffset(current,sidebar.p),current.height/2,1).eye;
      const b = getBubbleBounds(current, kind);
      return fluidPanelEye(b);
    }
    function seed(kind: EyeOwner, current: FluidLayout) {
      if (kind === 'main') return { x: -20 + sidebarOffset(current,sidebar.p), y: current.height/2 };
      const d = destination(kind, current);
      return { x: d.x + 10, y: d.y + 10 };
    }
    function handoff(owner: EyeOwner) {
      eye.next = owner;
      // Renewing attention in-place must not replay a sink/rise cycle.
      if (eye.owner === owner && eye.stage === 'rest') return;
      if (reduced.matches) {
        eye.owner = owner; eye.stage = 'rest'; eye.join = 1; eye.blink = 1;
        Object.assign(eye, destination(owner, motionLayout()));
        paint();
        return;
      }
      eye.from = { x: eye.x, y: eye.y, r: eye.r, blink: eye.blink, join: eye.join };
      eye.elapsed = 0; eye.stage = 'sink'; start();
    }
    function advanceEye(dt: number, current: FluidLayout) {
      eye.elapsed += dt;
      if (eye.stage === 'sink') {
        const t = smoothProgress(eye.elapsed/.20), to = seed(eye.owner, current);
        eye.x = mix(eye.from.x,to.x,t); eye.y = mix(eye.from.y,to.y,t); eye.r = mix(eye.from.r,FLUID_EYE_RADIUS,t);
        eye.blink = eye.from.blink * (1-smoothProgress(t,0,.6)); eye.join = eye.from.join*(1-t);
        if (t === 1) { eye.owner = eye.next; eye.stage = 'wait'; eye.elapsed = 0; eye.join = 0; eye.blink = 0; }
      }
      if (eye.stage === 'wait') {
        Object.assign(eye, seed(eye.owner,current));
        if (eye.owner === 'main' || bubbles[eye.owner].p >= .94) { eye.stage = 'rise'; eye.elapsed = 0; }
      }
      if (eye.stage === 'rise') {
        const t = smoothProgress(eye.elapsed/.36), from = seed(eye.owner,current), to = destination(eye.owner,current);
        eye.x = mix(from.x,to.x,t); eye.y = mix(from.y,to.y,t); eye.r = FLUID_EYE_RADIUS;
        eye.join = t; eye.blink = smoothProgress(t,.58,.98);
        if (t === 1) { eye.stage = 'rest'; eye.elapsed = 0; if (eye.owner !== 'main') attention.activate(eye.owner); }
      }
      if (eye.stage === 'rest') {
        Object.assign(eye,destination(eye.owner,current)); eye.r = FLUID_EYE_RADIUS; eye.join = 1; eye.blink = 1;
      }
    }
    function paint() {
      if (disposed) return;
      const current = motionLayout();
      const phases: FluidPhases = { activity: clamp01(bubbles.activity.p), local: clamp01(bubbles.local.p), sidebar: clamp01(sidebar.p), mainEye: 0 };
      const outline=createFluidGeometry(current,phases);
      setAttr(material.current,'d',outline);
      // Each edge filter sees the union of the masked material, not separate
      // rounded card strokes. Joined components therefore have no internal rim.
      setAttr(materialRim.current,'d',outline);
      setAttr(materialBevel.current,'d',outline);
      const main = destination('main',current), mainAmount = eye.owner === 'main' ? eye.join : 0;
      const shift=sidebarOffset(current,sidebar.p),railRight=-12+shift;
      const mainEntry=sidebarEntryGeometry(railRight,main.y,mainAmount);
      setAttr(sourceSocket.current,'d',mainEntry.clearancePath);
      const rr=30,x=-76,y=0,bottom=current.height;
      const railOutline=`M ${x+rr} ${y} L ${railRight-rr} ${y} Q ${railRight} ${y} ${railRight} ${rr} L ${railRight} ${bottom-rr} Q ${railRight} ${bottom} ${railRight-rr} ${bottom} L ${x+rr} ${bottom} Q ${x} ${bottom} ${x} ${bottom-rr} L ${x} ${rr} Q ${x} ${y} ${x+rr} ${y} Z `+mainEntry.supportPath;
      setAttr(railMaterial.current,'d',railOutline);
      for (const kind of KINDS) {
        const bounds = getBubbleBounds(current,kind), b = bubbles[kind];
        const amount = eye.owner === kind ? eye.join : 0;
        const socket = kind === 'activity' ? activitySocket.current : localSocket.current;
        const pocket=smoothProgress(b.p,.94,1);
        const joinedLocal=kind==='local'&&current.paired?smoothProgress(Math.min(phases.activity!,phases.local!),.92,1):0;
        setAttr(socket,'d',openShoulderCut(bounds,amount));setAttr(socket,'opacity',String(pocket*(1-joinedLocal)));
        if(kind==='local'){setAttr(joinedLocalSocket.current,'d',entryPocketPath(bounds.left,fluidPanelEye(bounds).y,amount,1));setAttr(joinedLocalSocket.current,'opacity',String(pocket*joinedLocal));}
        const rest=kind==='activity'?activityRestSocket.current:localRestSocket.current;
        const restAmount=1-smoothProgress(b.p,.02,.90),restX=current.width-14,restY=fluidRestEntryY(bounds,kind);
        const restOutline=entryPocketPath(current.width-.5,restY,0,-1);
        setAttr(rest,'d',restOutline);setAttr(rest,'opacity',String(restAmount));
        const anchor = fluidAnchorPosition(current.width,bounds,clamp01(b.p),kind);
        const point = b.target && b.p > .96 ? destination(kind,current) : b.p<.02?{x:restX-1,y:restY}:anchor;
        const button = kind === 'activity' ? activityHit.current : localHit.current;
        if (button) { button.style.left = `${point.x}px`; button.style.top = `${point.y}px`; }
        root!.dataset[`${kind}Progress`] = clamp01(b.p).toFixed(4);
        root!.dataset[`${kind}Recoil`] = b.recoil.toFixed(3);
      }
      const eyeOutline=circle(eye.x,eye.y,eye.r)+(eye.owner==='main'?'':shoulderBridge(getBubbleBounds(current,eye.owner),eye,eye.join));
      setAttr(eyeMaterial.current,'d',eyeOutline);
      setAttr(eyeMaterial.current,'opacity',String(smoothProgress(eye.join,.10,.88)));
      if(eyeArt.current){
        eyeArt.current.style.left=`${eye.x}px`;eyeArt.current.style.top=`${eye.y}px`;
        eyeArt.current.style.opacity=String(smoothProgress(eye.join,.1,.88));
        eyeArt.current.style.transform=`translate(-50%,-50%) scaleY(${eye.blink})`;
      }
      if (sourceHit.current) { sourceHit.current.style.left = `${main.x}px`; sourceHit.current.style.top = `${main.y}px`; }
      if(optics){
        const rect=root!.getBoundingClientRect();
        const path=(node:SVGPathElement|null)=>({path:node?.getAttribute('d')||'',opacity:Number(node?.getAttribute('opacity')??1)});
        const metrics=fluidMetrics(current,phases);
        const seams=KINDS.map(kind=>{const bounds=getBubbleBounds(current,kind),y=bounds.top+bounds.height/2;return{x:(mainRightAt(current,metrics,y)+bounds.left)/2,y,tension:seamTension(phases[kind]||0)};}) as [{x:number;y:number;tension:number},{x:number;y:number;tension:number}];
        optics.draw({seams,origin:{x:rect.left,y:rect.top},fills:[{path:outline}],cuts:[sourceSocket,activitySocket,localSocket,joinedLocalSocket,activityRestSocket,localRestSocket].map(ref=>path(ref.current)),foreground:[path(railMaterial.current)],eye:path(eyeMaterial.current),night:!!latest.current.executionActive,accent:latest.current.accent,scene:latest.current.scene});
      }
      root!.dataset.eyeOwner = eye.owner; root!.dataset.eyeStage = eye.stage;
      latest.current.onProgress?.({ activity: phases.activity!, local: phases.local!, sidebar: phases.sidebar!, activityRecoil: bubbles.activity.recoil, localRecoil: bubbles.local.recoil, eyeOwner: eye.owner, activityHeight:current.activityBounds.height,localHeight:current.localBounds.height,localTop:current.localBounds.top });
    }
    function tick(time: number) {
      if (disposed) return;
      const dt = Math.min(.032,Math.max(0,(time-lastTime)/1000)); lastTime = time;
      const count = Math.max(1,Math.ceil(dt/.008)), step = dt/count;
      let moving = false;
      for (const size of Object.values(sizes)) {
        for(let i=0;i<count;i++){size.v+=(100*(size.target-size.value)-20*size.v)*step;size.value+=size.v*step;}
        if(Math.abs(size.target-size.value)<.03&&Math.abs(size.v)<.05){size.value=size.target;size.v=0;}else moving=true;
      }
      for (const b of Object.values(bubbles)) {
        if(b.waitFor){const leading=bubbles[b.waitFor];if(leading.target&&leading.p<.55){moving=true;continue;}b.waitFor=undefined;}
        for (let i=0;i<count;i++) {
          const stiffness=b.target?38:46,damping=b.target?12.5:14;
          b.v += (stiffness*(b.target-b.p)-damping*b.v)*step; b.p += b.v*step;
          if (b.p < 0 || b.p > 1) { b.p = clamp01(b.p); b.v = 0; }
          b.recoilV += (-170*b.recoil-13*b.recoilV)*step; b.recoil += b.recoilV*step;
        }
        if (b.target && b.p >= .995 && !b.released) { b.released = true; b.recoilV = 42; }
        if (Math.abs(b.target-b.p)<.0005 && Math.abs(b.v)<.005) { b.p=b.target; b.v=0; } else moving=true;
        if (Math.abs(b.recoil)<.015 && Math.abs(b.recoilV)<.04) { b.recoil=0; b.recoilV=0; } else moving=true;
      }
      for (let i=0;i<count;i++) { sidebar.v += (38*(sidebar.target-sidebar.p)-12.5*sidebar.v)*step; sidebar.p += sidebar.v*step; }
      if (Math.abs(sidebar.target-sidebar.p)<.0005 && Math.abs(sidebar.v)<.005) { sidebar.p=sidebar.target; sidebar.v=0; } else moving=true;
      advanceEye(dt,motionLayout()); if (eye.stage !== 'rest') moving=true;
      paint(); frame=moving?requestAnimationFrame(tick):0;
    }
    function start() { if (!disposed && !frame) { lastTime=performance.now(); frame=requestAnimationFrame(tick); } }
    function settleImmediately() {
      cancelAnimationFrame(frame); frame=0;
      for (const b of Object.values(bubbles)) { b.p=b.target; b.v=0; b.recoil=0; b.recoilV=0; b.released=!!b.target;b.waitFor=undefined; }
      for (const size of Object.values(sizes)) {size.value=size.target;size.v=0;}
      sidebar.p=sidebar.target; sidebar.v=0;
      eye.stage='rest'; eye.owner=eye.next; eye.join=1; eye.blink=1;
      Object.assign(eye,destination(eye.owner,motionLayout())); paint();
    }
    function update() {
      const next=latest.current;
      const resized=next.width!==layout.width||next.height!==layout.height;
      layout=getFluidLayout(next.width,next.height,next.sizing);
      for(const kind of KINDS){sizes[kind].target=getBubbleBounds(layout,kind).height;if(resized){sizes[kind].value=sizes[kind].target;sizes[kind].v=0;}}
      const requested={activity:next.activityOpen,local:next.localOpen};
      const opening=fissionOrder(requested,{activity:bubbles.activity.p,local:bubbles.local.p},next.attentionTarget);
      const underway=KINDS.find(kind=>bubbles[kind].target&&bubbles[kind].p>.01&&bubbles[kind].p<.55);
      for (const kind of KINDS) {
        const target=Number(kind === 'activity'?next.activityOpen:next.localOpen), b=bubbles[kind];
        if (target !== b.target) { b.target=target; b.released=false;b.waitFor=target?(underway&&underway!==kind?underway:opening.length>1&&opening[1]===kind?opening[0]:undefined):undefined; }
        if (!target) attention.release(kind);
      }
      sidebar.target=Number(next.sidebarOpen);
      const target = next.attentionTarget === 'main' || (next.attentionTarget === 'activity'?next.activityOpen:next.localOpen) ? next.attentionTarget : 'main';
      if (target !== previousTarget || next.attentionVersion !== previousVersion) {
        previousTarget=target; previousVersion=next.attentionVersion;
        if (target === 'main') attention.release(attention.snapshot().owner); else attention.activate(target);
      }
      if (reduced.matches) settleImmediately(); else { paint(); start(); }
    }
    function preferenceChanged() { if (reduced.matches) settleImmediately(); }
    function pageHidden(event: PageTransitionEvent) { cancelAnimationFrame(frame); frame=0; if (!event.persisted) attention.dispose(); }
    function visibilityChanged(){if(document.hidden){cancelAnimationFrame(frame);frame=0;}else start();}
    function pageShown(event: PageTransitionEvent) { if (event.persisted) start(); }
    controller.current=update;
    reduced.addEventListener('change',preferenceChanged);
    window.addEventListener('pagehide',pageHidden);
    window.addEventListener('pageshow',pageShown);
    document.addEventListener('visibilitychange',visibilityChanged);
    update();
    return () => {
      disposed=true; cancelAnimationFrame(frame); attention.dispose(); optics?.dispose(); controller.current=null;
      reduced.removeEventListener('change',preferenceChanged);
      document.removeEventListener('visibilitychange',visibilityChanged);
      window.removeEventListener('pagehide',pageHidden); window.removeEventListener('pageshow',pageShown);
    };
  }, []);

  useLayoutEffect(() => { controller.current?.(); }, [props.executionActive,props.accent,props.scene,props.width,props.height,props.activityOpen,props.localOpen,props.sidebarOpen,props.attentionTarget,props.attentionVersion,props.sizing?.activityHeight,props.sizing?.localHeight,props.sizing?.paired]);

  const hitStyle = { position: 'absolute' as const, width: 64, height: 64, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', transform: 'translate(-50%,-50%)', pointerEvents: 'auto' as const, touchAction: 'manipulation' };
  return <div ref={scene} className="one-fluid-surface" data-one-fluid-surface style={{ position:'absolute',inset:0,width:props.width,height:props.height,pointerEvents:'none' }}>
    <canvas ref={opticalCanvas} className="one-fluid-optics" aria-hidden="true"/>
    <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`} aria-hidden="true" style={{display:'block',overflow:'visible',pointerEvents:'none'}}>
      <defs>
        <linearGradient id={ids.rim} x1="0" y1="0" x2=".8" y2="1">
          <stop offset="0" stopColor="#fbfdff"/><stop offset=".12" stopColor="#7a8998"/>
          <stop offset=".25" stopColor="#eaf1f7"/><stop offset=".43" stopColor="#566674"/>
          <stop offset=".57" stopColor="#d1dce5"/><stop offset=".74" stopColor="#fff"/>
          <stop offset=".87" stopColor="#657683"/><stop offset="1" stopColor="#c8d4dd"/>
        </linearGradient>
        <filter id={ids.edge} filterUnits="userSpaceOnUse" x="-60" y="-60" width={props.width+120} height={props.height+120} colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="erode" radius="8" result="inner"/>
          <feComposite in="SourceGraphic" in2="inner" operator="out"/>
        </filter>
        <filter id={ids.shine} filterUnits="userSpaceOnUse" x="-60" y="-60" width={props.width+120} height={props.height+120} colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="erode" radius="1.3" result="inner"/>
          <feComposite in="SourceGraphic" in2="inner" operator="out"/>
        </filter>
        <mask id={ids.sockets} maskUnits="userSpaceOnUse" x="-60" y="-60" width={props.width+120} height={props.height+120}>
          <rect x="-60" y="-60" width={props.width+120} height={props.height+120} fill="white" />
          <path ref={sourceSocket} fill="black" data-entry-pocket="main"/><path ref={activitySocket} fill="black" /><path ref={localSocket} fill="black" /><path ref={joinedLocalSocket} fill="black" />
          <path ref={activityRestSocket} fill="black" data-entry-pocket="activity"/><path ref={localRestSocket} fill="black" data-entry-pocket="local"/>
        </mask>
      </defs>
      <path ref={railMaterial} fill="var(--fluid-rail-fill)"/>
      <path ref={material} fill="var(--fluid-material)" fillRule="nonzero" mask={`url(#${ids.sockets})`}/>
      <g filter={`url(#${ids.edge})`}><path ref={materialRim} fill={`url(#${ids.rim})`} mask={`url(#${ids.sockets})`}/></g>
      <g filter={`url(#${ids.shine})`} opacity=".75"><path ref={materialBevel} fill="var(--fluid-edge-glint,#fff)" mask={`url(#${ids.sockets})`}/></g>
      <path ref={eyeMaterial} fill="var(--fluid-material)"/>
    </svg>
    <div ref={eyeArt} className="one-fluid-eye-art" aria-hidden="true" style={{width:FLUID_EYE_SIZE,height:FLUID_EYE_SIZE}}><FluidCompanionLogo/></div>
    <button ref={activityHit} type="button" title="任务动态" className="one-fluid-trigger" data-fluid-trigger="activity" aria-expanded={props.activityOpen} aria-label={props.activityOpen?'收起任务进度':'展开任务进度'} style={hitStyle} onClick={props.onActivityToggle} />
    <button ref={localHit} type="button" title="本机执行" className="one-fluid-trigger" data-fluid-trigger="local" aria-expanded={props.localOpen} aria-label={props.localOpen?'收起本机执行':'展开本机执行'} style={hitStyle} onClick={props.onLocalToggle} />
    <button ref={sourceHit} type="button" title="任务与导航" className="one-fluid-trigger" data-fluid-trigger="main" aria-expanded={props.sidebarOpen} aria-label={props.sidebarOpen?'收起侧边栏':'展开侧边栏'} style={{...hitStyle,width:56}} onClick={props.onSidebarToggle} />
  </div>;
}
