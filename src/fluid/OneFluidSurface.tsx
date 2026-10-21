import { useId, useLayoutEffect, useRef } from 'react';
import { createEyeAttention } from './attention';
import { clamp01, createFluidGeometry, fluidAnchorPosition, getBubbleBounds, getFluidLayout, smoothProgress } from './geometry';
import { openShoulderCut, shoulderBridge } from './shoulder';
import type { BubbleKind, EyeOwner, FluidFrame, FluidLayout, FluidPhases } from './types';

export { getFluidLayout } from './geometry';
export type { BubbleKind, EyeOwner, FluidFrame, FluidLayout } from './types';

export interface OneFluidSurfaceProps {
  width: number;
  height: number;
  activityOpen: boolean;
  localOpen: boolean;
  sidebarOpen: boolean;
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
const PUPIL = 'M34.4 16.5c-1.4-.2-2.8.8-3 2.2-1.7 9.5-2.3 18.6-1.7 27.4.1 1.5 1.4 2.6 2.9 2.5 1.5-.1 2.6-1.4 2.5-2.9-.5-8.3 0-17 1.6-26.1.3-1.5-.8-2.9-2.3-3.1Z';

/** Material only. Keep business content in unfiltered sibling layers above it. */
export function OneFluidSurface(props: OneFluidSurfaceProps) {
  const instanceId = useId().replace(/:/g, '');
  const ids = { tension: `${instanceId}-tension`, sockets: `${instanceId}-sockets`, iris: `${instanceId}-iris` };
  const latest = useRef(props);
  latest.current = props;
  const controller = useRef<(() => void) | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  const material = useRef<SVGPathElement>(null);
  const eyeMaterial = useRef<SVGPathElement>(null);
  const blur = useRef<SVGFEGaussianBlurElement>(null);
  const glyph = useRef<SVGGElement>(null);
  const lid = useRef<SVGEllipseElement>(null);
  const nubs = useRef<SVGPathElement>(null);
  const sourceSocket = useRef<SVGCircleElement>(null);
  const activitySocket = useRef<SVGPathElement>(null);
  const localSocket = useRef<SVGPathElement>(null);
  const activityHit = useRef<HTMLButtonElement>(null);
  const localHit = useRef<HTMLButtonElement>(null);
  const eyeHit = useRef<HTMLButtonElement>(null);
  const sourceHit = useRef<HTMLButtonElement>(null);
  const returnEye = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const root = scene.current;
    if (!root) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let layout = getFluidLayout(latest.current.width, latest.current.height);
    const bubbles: Record<BubbleKind, BubbleMotion> = { activity: initialBubble(), local: initialBubble() };
    const sidebar = { p: 0, v: 0, target: 0 };
    const eye: EyeMotion = { owner: 'main', next: 'main', stage: 'rest', elapsed: 0, x: 4, y: layout.height/2, r: 21, blink: 1, join: 1, from: { x: 4, y: layout.height/2, r: 21, blink: 1, join: 1 } };
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
        activityBounds: { ...layout.activityBounds, left: layout.activityBounds.left + bubbles.activity.recoil },
        localBounds: { ...layout.localBounds, left: layout.localBounds.left + bubbles.local.recoil },
      };
    }
    function destination(kind: EyeOwner, current: FluidLayout) {
      if (kind === 'main') return { x: 4 + 10*clamp01(sidebar.p), y: current.height/2 };
      const b = getBubbleBounds(current, kind);
      return { x: b.left + 20, y: b.top + 20 };
    }
    function seed(kind: EyeOwner, current: FluidLayout) {
      if (kind === 'main') return { x: 27 + 10*clamp01(sidebar.p), y: current.height/2 };
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
        eye.x = mix(eye.from.x,to.x,t); eye.y = mix(eye.from.y,to.y,t); eye.r = mix(eye.from.r,21,t);
        eye.blink = eye.from.blink * (1-smoothProgress(t,0,.6)); eye.join = eye.from.join*(1-t);
        if (t === 1) { eye.owner = eye.next; eye.stage = 'wait'; eye.elapsed = 0; eye.join = 0; eye.blink = 0; }
      }
      if (eye.stage === 'wait') {
        Object.assign(eye, seed(eye.owner,current));
        if (eye.owner === 'main' || bubbles[eye.owner].p >= .83) { eye.stage = 'rise'; eye.elapsed = 0; }
      }
      if (eye.stage === 'rise') {
        const t = smoothProgress(eye.elapsed/.30), from = seed(eye.owner,current), to = destination(eye.owner,current);
        eye.x = mix(from.x,to.x,t); eye.y = mix(from.y,to.y,t); eye.r = 21;
        eye.join = t; eye.blink = smoothProgress(t,.58,.98);
        if (t === 1) { eye.stage = 'rest'; eye.elapsed = 0; if (eye.owner !== 'main') attention.activate(eye.owner); }
      }
      if (eye.stage === 'rest') {
        Object.assign(eye,destination(eye.owner,current)); eye.r = 21; eye.join = 1; eye.blink = 1;
      }
    }
    function paint() {
      if (disposed) return;
      const current = motionLayout();
      const phases: FluidPhases = { activity: clamp01(bubbles.activity.p), local: clamp01(bubbles.local.p), sidebar: clamp01(sidebar.p), mainEye: 0 };
      material.current?.setAttribute('d',createFluidGeometry(current,phases));
      const tension = Math.max(Math.sin(Math.PI*phases.activity!),Math.sin(Math.PI*phases.local!),eye.stage === 'rest' ? 0 : Math.sin(Math.PI*eye.join));
      blur.current?.setAttribute('stdDeviation',(tension*5).toFixed(3));
      const main = destination('main',current), mainAmount = eye.owner === 'main' ? eye.join : 0;
      sourceSocket.current?.setAttribute('cx',String(main.x)); sourceSocket.current?.setAttribute('cy',String(main.y));
      sourceSocket.current?.setAttribute('r',String(27*smoothProgress(mainAmount,.25,1)));
      const quiet: string[] = [];
      for (const kind of KINDS) {
        const bounds = getBubbleBounds(current,kind), b = bubbles[kind];
        const amount = eye.owner === kind ? eye.join : 0;
        const socket = kind === 'activity' ? activitySocket.current : localSocket.current;
        socket?.setAttribute('d',openShoulderCut(bounds,amount));
        const q = smoothProgress(b.p,.96,1)*(eye.owner === kind ? 1-eye.join : 1);
        quiet.push(circle(bounds.left+9.37,bounds.top+9.37,3.5*q));
        const anchor = fluidAnchorPosition(current.width,bounds,clamp01(b.p));
        const point = b.target && b.p > .96 ? { x: bounds.left+9.37,y: bounds.top+9.37 } : anchor;
        const button = kind === 'activity' ? activityHit.current : localHit.current;
        if (button) { button.style.left = `${point.x}px`; button.style.top = `${point.y}px`; }
        root!.dataset[`${kind}Progress`] = clamp01(b.p).toFixed(4);
        root!.dataset[`${kind}Recoil`] = b.recoil.toFixed(3);
      }
      nubs.current?.setAttribute('d',quiet.join(' '));
      eyeMaterial.current?.setAttribute('d',circle(eye.x,eye.y,eye.r)+(eye.owner === 'main' ? '' : shoulderBridge(getBubbleBounds(current,eye.owner),eye,eye.join)));
      glyph.current?.setAttribute('transform',`translate(${eye.x-28} ${eye.y-28}) scale(.875)`);
      lid.current?.setAttribute('cx',String(eye.x)); lid.current?.setAttribute('cy',String(eye.y));
      lid.current?.setAttribute('rx','21'); lid.current?.setAttribute('ry',String(21*eye.blink));
      if (sourceHit.current) { sourceHit.current.style.left = `${main.x}px`; sourceHit.current.style.top = `${main.y}px`; }
      if (eyeHit.current) { eyeHit.current.style.left = `${eye.x}px`; eyeHit.current.style.top = `${eye.y}px`; eyeHit.current.style.display = eye.owner === 'main' ? 'none' : 'block'; }
      root!.dataset.eyeOwner = eye.owner; root!.dataset.eyeStage = eye.stage;
      latest.current.onProgress?.({ activity: phases.activity!, local: phases.local!, sidebar: phases.sidebar!, activityRecoil: bubbles.activity.recoil, localRecoil: bubbles.local.recoil, eyeOwner: eye.owner });
    }
    function tick(time: number) {
      if (disposed) return;
      const dt = Math.min(.032,Math.max(0,(time-lastTime)/1000)); lastTime = time;
      const count = Math.max(1,Math.ceil(dt/.008)), step = dt/count;
      let moving = false;
      for (const b of Object.values(bubbles)) {
        for (let i=0;i<count;i++) {
          b.v += (38*(b.target-b.p)-12.5*b.v)*step; b.p += b.v*step;
          if (b.p < 0 || b.p > 1) { b.p = clamp01(b.p); b.v = 0; }
          b.recoilV += (-170*b.recoil-13*b.recoilV)*step; b.recoil += b.recoilV*step;
        }
        if (b.target && b.p >= .91 && !b.released) { b.released = true; b.recoilV = 90; }
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
      for (const b of Object.values(bubbles)) { b.p=b.target; b.v=0; b.recoil=0; b.recoilV=0; b.released=!!b.target; }
      sidebar.p=sidebar.target; sidebar.v=0;
      eye.stage='rest'; eye.owner=eye.next; eye.join=1; eye.blink=1;
      Object.assign(eye,destination(eye.owner,motionLayout())); paint();
    }
    function update() {
      const next=latest.current;
      layout=getFluidLayout(next.width,next.height);
      for (const kind of KINDS) {
        const target=Number(kind === 'activity'?next.activityOpen:next.localOpen), b=bubbles[kind];
        if (target !== b.target) { b.target=target; b.released=false; }
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
    function pageShown(event: PageTransitionEvent) { if (event.persisted) start(); }
    controller.current=update;
    returnEye.current=()=>attention.release(attention.snapshot().owner);
    reduced.addEventListener('change',preferenceChanged);
    window.addEventListener('pagehide',pageHidden);
    window.addEventListener('pageshow',pageShown);
    update();
    return () => {
      disposed=true; cancelAnimationFrame(frame); attention.dispose(); controller.current=null; returnEye.current=null;
      reduced.removeEventListener('change',preferenceChanged);
      window.removeEventListener('pagehide',pageHidden); window.removeEventListener('pageshow',pageShown);
    };
  }, []);

  useLayoutEffect(() => { controller.current?.(); }, [props.width,props.height,props.activityOpen,props.localOpen,props.sidebarOpen,props.attentionTarget,props.attentionVersion]);

  const hitStyle = { position: 'absolute' as const, width: 44, height: 44, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', transform: 'translate(-50%,-50%)', pointerEvents: 'auto' as const, touchAction: 'manipulation' };
  return <div ref={scene} className="one-fluid-surface" data-one-fluid-surface style={{ position:'absolute',inset:0,width:props.width,height:props.height,pointerEvents:'none' }}>
    <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`} aria-hidden="true" style={{display:'block',overflow:'visible',pointerEvents:'none'}}>
      <defs>
        <filter id={ids.tension} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feGaussianBlur ref={blur} in="SourceGraphic" stdDeviation="0" result="surface-soft" />
          <feColorMatrix in="surface-soft" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 24 -11" />
        </filter>
        <mask id={ids.sockets} maskUnits="userSpaceOnUse" x="-60" y="-60" width={props.width+120} height={props.height+120}>
          <rect x="-60" y="-60" width={props.width+120} height={props.height+120} fill="white" />
          <circle ref={sourceSocket} fill="black" /><path ref={activitySocket} fill="black" /><path ref={localSocket} fill="black" />
        </mask>
        <clipPath id={ids.iris}><ellipse ref={lid} /></clipPath>
      </defs>
      <g filter={`url(#${ids.tension})`} fill="var(--one-fluid-material,#f5f2e8)">
        <path ref={material} fillRule="nonzero" mask={`url(#${ids.sockets})`} />
        <path ref={eyeMaterial} /><path ref={nubs} />
      </g>
      <g clipPath={`url(#${ids.iris})`}><g ref={glyph}><path d={PUPIL} fill="var(--one-fluid-ink,#0b0b0a)" /></g></g>
    </svg>
    <button ref={activityHit} type="button" className="one-fluid-trigger" data-fluid-trigger="activity" aria-expanded={props.activityOpen} aria-label={props.activityOpen?'收起任务进度':'展开任务进度'} style={hitStyle} onClick={props.onActivityToggle} />
    <button ref={localHit} type="button" className="one-fluid-trigger" data-fluid-trigger="local" aria-expanded={props.localOpen} aria-label={props.localOpen?'收起本机执行':'展开本机执行'} style={hitStyle} onClick={props.onLocalToggle} />
    <button ref={sourceHit} type="button" className="one-fluid-trigger" data-fluid-trigger="main" aria-expanded={props.sidebarOpen} aria-label={props.sidebarOpen?'收起侧边栏':'展开侧边栏'} style={hitStyle} onClick={props.onSidebarToggle} />
    <button ref={eyeHit} type="button" className="one-fluid-trigger one-fluid-eye-return" data-fluid-eye-return aria-label="让眼睛回到主对话" style={{...hitStyle,display:'none'}} onClick={()=>returnEye.current?.()} />
  </div>;
}
