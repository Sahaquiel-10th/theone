import type { FluidBounds, FluidLayout, FluidPhases, BubbleKind, FluidSizing } from './types';
import {FLUID_MAIN_RADIUS,fluidPanelEye,fluidRestEntryY} from './surfaceMetrics';
import {boundedFluidActivityHeight} from './panelSizing';
/* V8: split an existing piece out of the mother; never grow a popup. */
const K=.5522847498;
export const clamp01=(v: number)=>Math.max(0,Math.min(1,v));
export function smoothProgress(v: number,a=0,b=1){const p=clamp01((v-a)/(b-a));return p*p*(3-2*p);}
const lerp=(a: number,b: number,p: number)=>a+(b-a)*p;
const n=(...v: number[])=>v.map(x=>Math.round(x*1000)/1000).join(' ');
export const clipPath=(d: string)=>`path("${d}")`;
export const travelProgress=(p: number)=>smoothProgress(p,.10,.93);
export function fluidAnchorPosition(width: number,bounds: FluidBounds,p: number,kind?:BubbleKind){const eye=fluidPanelEye(bounds),t=travelProgress(p);return {x:lerp(width-15,eye.x,t),y:lerp(fluidRestEntryY(bounds,kind),eye.y,t)};}
// Two rounded shoulders meet at a single extremum, without a flat cap.
function eyeContour(x: number,cy: number,span: number,depth: number){return [`L ${n(x,cy+span)}`,`C ${n(x,cy+span*.45,x+depth,cy+span*.55,x+depth,cy)}`,`C ${n(x+depth,cy-span*.55,x,cy-span*.45,x,cy-span)}`];}
export const sidebarOffset=(layout: FluidLayout,p: number)=>layout.sidebarTravel*clamp01(p);
export const seamTension=(p: number)=>Math.sin(Math.PI*clamp01(p))*(1-smoothProgress(p,.88,1));
const pulse=(p: number)=>p<=0||p>=1?0:Math.sin(Math.PI*p);
export function fluidMetrics(layout: FluidLayout,phases: FluidPhases={}){
 const a=clamp01(phases.activity||0),l=clamp01(phases.local||0),right=layout.width-.5;
 const ar=smoothProgress(a,.08,.90),lr=smoothProgress(l,.08,.90);
 const jointA=Math.max(layout.activityBounds.left-18,(layout.safeRight||0)+8),jointL=Math.max(layout.localBounds.left-18,(layout.safeRight||0)+8);
 const pressure=layout.compact?0:5*Math.max(pulse(a)*l,pulse(l)*a);
 // One child yields locally. Two children share a continuous right-hand dock;
 // the mother never pushes a decorative tongue between them.
 return {a,l,ar,lr,right,jointA,jointL,pressure,upper:layout.compact?right:lerp(right,jointA,ar),middle:layout.compact?right:lerp(right,Math.min(jointA,jointL),Math.min(ar,lr)),lower:layout.compact?right:lerp(right,jointL,lr),aBreak:layout.activityBounds.top+layout.activityBounds.height+30,lBreak:layout.localBounds.top-30};
}
export function mainRightAt(layout: FluidLayout,m: ReturnType<typeof fluidMetrics>,y: number){
 let x=m.upper+(m.middle-m.upper)*smoothProgress(y,m.aBreak-30,m.aBreak+30)+(m.lower-m.middle)*smoothProgress(y,m.lBreak-30,m.lBreak+30);
 return x;
}
function parentPath(layout: FluidLayout,phases: FluidPhases,inset: number){
 const m=fluidMetrics(layout,phases),press=sidebarOffset(layout,phases.sidebar||0);
 const left=.5+inset+press,top=.5+inset,bottom=layout.height-.5-inset,r=Math.max(2,FLUID_MAIN_RADIUS-inset);
 const upper=m.upper-inset,lower=m.lower-inset;
 const topPull=2.5*seamTension(m.a),bottomPull=2.5*seamTension(m.l);
 const commands=[`M ${n(left+r,top)}`,`L ${n(upper-r-72,top)}`,`C ${n(upper-r-40,top,upper-r-32,top+topPull,upper-r,top+topPull)}`,`C ${n(upper-r+r*K,top+topPull,upper,top+r-r*K,upper,top+r)}`];
 let edge=upper,lastY=top+r;
 function verticalTo(y: number){
  if(y<lastY-.001)throw Error('Parent shoulder would reverse vertically');
  commands.push(`L ${n(edge,y)}`);lastY=y;
 }
 function roundStep(to: number,center: number){
  const dx=to-edge;if(Math.abs(dx)<.001)return;
  const dir=Math.sign(dx),radius=Math.min(32-inset*.3,Math.abs(dx)/2);
  verticalTo(center-radius);
  commands.push(`C ${n(edge,center-radius*(1-K),edge+dir*radius*(1-K),center,edge+dir*radius,center)}`);
  commands.push(`L ${n(to-dir*radius,center)}`);
  commands.push(`C ${n(to-dir*radius*(1-K),center,to,center+radius*(1-K),to,center+radius)}`);
  edge=to;lastY=center+radius;
 }
 const firstDx=m.middle-inset-upper,secondDx=lower-(m.middle-inset);
 const firstRadius=Math.min(32-inset*.3,Math.abs(firstDx)/2),secondRadius=Math.min(32-inset*.3,Math.abs(secondDx)/2);
 const firstCenter=Math.abs(firstDx)>.001&&Math.abs(secondDx)>.001?Math.min(m.aBreak,m.lBreak-firstRadius-secondRadius-4):m.aBreak;
 roundStep(m.middle-inset,firstCenter);
 roundStep(lower,m.lBreak);
 verticalTo(bottom-r);
 commands.push(`C ${n(lower,bottom-r+r*K,lower-r+r*K,bottom-bottomPull,lower-r,bottom-bottomPull)}`,`C ${n(lower-r-32,bottom-bottomPull,lower-r-40,bottom,lower-r-72,bottom)}`,`L ${n(left+r,bottom)}`,`C ${n(left+r-r*K,bottom,left,bottom-r+r*K,left,bottom-r)}`);
 commands.push(`L ${n(left,top+r)}`,`C ${n(left,top+r-r*K,left+r-r*K,top,left+r,top)}`,'Z');return commands.join(' ');
}
export function childMetrics(bounds: FluidBounds,p: number,stageWidth: number){
 p=clamp01(p);
 // This volume is already inside the mother's surface in the first frame.
 // A background cleft reveals it; it never arrives from a trigger or scales up.
 // Preserve the resting dimensions. Only the near-side shoulder receives strain.
 const q=bounds.stableBody?1:smoothProgress(p,.84,1),breath=bounds.stableBody?0:Math.sin(Math.PI*smoothProgress(p,.12,1));
 const anchor=fluidAnchorPosition(stageWidth,bounds,p);
 const left=bounds.left+12*breath,right=bounds.left+bounds.width-.5+5*breath;
 const top=bounds.top-5*breath,bottom=bounds.top+bounds.height+5*breath;
 return {q,p,anchor,left,right,top,bottom,cy:(top+bottom)/2};
}
export function bubbleBodyGeometry(bounds: FluidBounds,p: number,active=0,inset=0,local=false){
 const stageWidth=bounds.stageWidth??bounds.width,b=childMetrics(bounds,p,stageWidth);
 if(p<=0)return '';
 const ox=local?bounds.left:0,oy=local?bounds.top:0;
 const x=b.left+inset+.5-ox,right=b.right-inset-ox,top=b.top+inset+.5-oy,bottom=b.bottom-inset-.5-oy,cy=fluidPanelEye(bounds).y-oy;
 if(right<=x||bottom<=top)return '';
 const stableRadius=Math.min(Math.max(2,32-inset),(right-x)/2,(bottom-top)/2);
 const rx=bounds.stableBody?stableRadius:lerp((right-x)/2,Math.min(48-inset,(right-x)/2),b.q),ry=bounds.stableBody?stableRadius:lerp((bottom-top)/2,Math.min(48-inset,(bottom-top)/2),b.q);
 const eye=clamp01(active)*smoothProgress(p,.97,1),span=Math.max(0,Math.min(12,cy-top-ry-1))*eye,depth=24*eye;
 const pull=bounds.stableBody?6*seamTension(p):0;
 const shoulder=Math.min(80,(right-x-2*rx)*.6);
 return [`M ${n(x+rx,top+pull)}`,`C ${n(x+rx+shoulder*.45,top+pull,x+rx+shoulder*.55,top,x+rx+shoulder,top)}`,`L ${n(right-rx,top)}`,`C ${n(right-rx+rx*K,top,right,top+ry-ry*K,right,top+ry)}`,`L ${n(right,bottom-ry)}`,`C ${n(right,bottom-ry+ry*K,right-rx+rx*K,bottom,right-rx,bottom)}`,`L ${n(x+rx+shoulder,bottom)}`,`C ${n(x+rx+shoulder*.55,bottom,x+rx+shoulder*.45,bottom-pull,x+rx,bottom-pull)}`,`C ${n(x+rx-rx*K,bottom-pull,x,bottom-ry+ry*K,x,bottom-ry)}`,...(span>.001?eyeContour(x,cy,span,depth):[]),`L ${n(x,top+ry)}`,`C ${n(x,top+ry-ry*K,x+rx-rx*K,top+pull,x+rx,top+pull)}`,'Z'].join(' ');
}
export function neckMetrics(layout: FluidLayout,bounds: FluidBounds,p: number,mainEdge: number,inset=0){
 const b=childMetrics(bounds,p,layout.width),start=mainEdge-.5+inset,end=b.left+.75-inset;
 if(p<=0||p>=1||end<=start)return null;
 // The bridge starts as a broad waist of the original material, centered on
 // the whole body rather than a tiny eye/control at the card's header.
 const retract=smoothProgress(p,.992,1),span=Math.max(0,(Math.min(bounds.height/2-34,140)-inset)*(1-retract)),half=(span*.92*(1-smoothProgress(p,.58,.97))+.12)*(1-retract);
 const center=(start+end)/2,separation=lerp(-10,(end-start)*.78,smoothProgress(p,.97,.992));
 return {start,end,cy:b.cy,span,half,center,separation,retract};
}
export function neckGeometry(layout: FluidLayout,bounds: FluidBounds,p: number,mainEdge: number,inset=0){
 const b=neckMetrics(layout,bounds,p,mainEdge,inset);if(!b)return '';
 const {start,end,cy,span,half,center,separation,retract}=b,lt=lerp(center-separation/2,start,retract),rt=lerp(center+separation/2,end,retract),cap=Math.min(4,half*.5);
 return [`M ${n(start,cy-span)}`,`C ${n(start,cy-span*.38,lt-(lt-start)*.45,cy-half,lt,cy-half)}`,`C ${n(lt+cap,cy-half,lt+cap,cy+half,lt,cy+half)}`,`C ${n(lt-(lt-start)*.45,cy+half,start,cy+span*.38,start,cy+span)}`,'Z',`M ${n(end,cy-span)}`,`L ${n(end,cy+span)}`,`C ${n(end,cy+span*.38,rt+(end-rt)*.45,cy+half,rt,cy+half)}`,`C ${n(rt-cap,cy+half,rt-cap,cy-half,rt,cy-half)}`,`C ${n(rt+(end-rt)*.45,cy-half,end,cy-span*.38,end,cy-span)}`,'Z'].join(' ');
}
export function createFluidGeometry(layout: FluidLayout,phases: FluidPhases={},inset=0){
 if(layout.width<20||layout.height<20)return '';
 const m=fluidMetrics(layout,phases),paths=[parentPath(layout,phases,inset)];
 if(!layout.compact)for(const kind of ['activity','local'] as const){const p=kind==='activity'?m.a:m.l,eye=kind==='activity'?(phases.activityEye||0):(phases.localEye||0);const bounds={...getBubbleBounds(layout,kind),stageWidth:layout.width};paths.push(bubbleBodyGeometry(bounds,p,eye,inset));paths.push(neckGeometry(layout,bounds,p,mainRightAt(layout,m,bounds.top+bounds.height/2),inset));}
 if(layout.paired){
  const a=layout.activityBounds,l=layout.localBounds,gap=l.top-a.top-a.height;
  const join=smoothProgress(Math.min(m.a,m.l),.92,1)*smoothProgress(64-gap,0,64);
  if(join>0){const x=a.left+.5+inset+(1-join)*32,right=a.left+a.width-.5-inset-(1-join)*32,top=a.top+a.height-32+inset,bottom=l.top+32-inset;paths.push(`M ${n(x,top)} L ${n(right,top)} L ${n(right,bottom)} L ${n(x,bottom)} Z`);}
 }
 return paths.filter(Boolean).join(' ');
}
export function createFluidRimGeometry(layout:FluidLayout,phases:FluidPhases,inset=0){
 const a=layout.activityBounds,l=layout.localBounds;
 if(layout.paired&&(phases.activity||0)>=.9999&&(phases.local||0)>=.9999&&Math.abs(l.top-a.top-a.height)<.5){
  return parentPath(layout,phases,inset)+' '+bubbleBodyGeometry({...a,height:l.top+l.height-a.top},1,0,inset);
 }
 return createFluidGeometry(layout,phases,inset);
}
export function createMainGeometry(layout: FluidLayout,phases: FluidPhases={},inset=0){return createFluidGeometry(layout,phases,inset);}
export const contentReveal=(p: number)=>smoothProgress(p,.94,.997);

/** All positions are pixels within the material canvas, excluding the left rail. */
export function getFluidLayout(width: number,height: number,sizing: FluidSizing={}): FluidLayout {
 const w=Math.max(360,width),h=Math.max(400,height);
 const childWidth=Math.min(300,Math.max(260,w*.24));
 const left=w-childWidth-24;
 const top=0;
 const localHeight=Math.min(h*.34,Math.max(208,sizing.localHeight??224));
 const activityHeight=sizing.paired?h-localHeight-top:boundedFluidActivityHeight(sizing.activityHeight??236,h);
 const safeRight=left-30;
 const sidebarTravel=Math.min(176,Math.max(120,120+(w-1180)*.3));
 return {width:w,height:h,safeRight,compact:false,sidebarTravel,paired:!!sizing.paired,
 activityBounds:{left,top,width:childWidth,height:activityHeight,stableBody:true},
 localBounds:{left,top:h-localHeight,width:childWidth,height:localHeight,stableBody:true},
 mainContentBounds:{left:48,top:28,width:Math.max(200,Math.min(900,safeRight-sidebarTravel-72)),height:h-56}};
}
export function getBubbleBounds(layout: FluidLayout,kind: BubbleKind): FluidBounds {
 return kind==='activity'?layout.activityBounds:layout.localBounds;
}
