export const FEATURE_HANDOFF_MS=540;
export const FEATURE_DEPART_PROGRESS=.20;
export type HandoffRect={left:number;top:number;width:number;height:number};
export type HandoffPoint={x:number;y:number};
export type FeatureHandoffFrame={phase:'gathering'|'absorbing'|'complete';bubble:HandoffRect;origin:HandoffPoint;haloRadius:number;haloOpacity:number;bubbleOpacity:number;sourceNeck:string;departed:boolean;arrived:boolean};
const clamp=(n:number,min=0,max=1)=>Math.max(min,Math.min(max,n));
const smooth=(n:number,start=0,end=1)=>{const t=clamp((n-start)/(end-start));return t*t*(3-2*t);};
const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
const point=(rect:HandoffRect)=>({x:rect.left+rect.width/2,y:rect.top+rect.height/2});
const around=(p:HandoffPoint,width:number,height:number):HandoffRect=>({left:p.x-width/2,top:p.y-height/2,width,height});
const values=(...parts:number[])=>parts.map(n=>Number(n.toFixed(3))).join(' ');

/** Selection is immediate and independent of decorative motion or API calls. */
export function featureSelectionTransition<T extends{id:string}>(previous:readonly T[],feature:T,max=8):{features:T[];action:'added'|'removed'|'limit'}{
 const features=[...new Map(previous.map(item=>[item.id,item])).values()];
 if(features.some(item=>item.id===feature.id))return{features:features.filter(item=>item.id!==feature.id),action:'removed'};
 const limit=Number.isFinite(max)?Math.max(1,Math.floor(max)):8;
 if(features.length>=limit)return{features,action:'limit'};
 return{features:[...features,feature],action:'added'};
}

function boundary(rect:HandoffRect,d:HandoffPoint){
 const hx=rect.width/2,hy=rect.height/2,r=Math.min(22,hx,hy);let low=0,high=Math.hypot(hx,hy)+r;
 for(let i=0;i<20;i++){const t=(low+high)/2,qx=Math.abs(d.x*t)-hx+r,qy=Math.abs(d.y*t)-hy+r,sdf=Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;if(sdf>0)high=t;else low=t;}
 return(low+high)/2;
}
/** Two rounded rectangles share a material neck; the split opens at its waist. */
export function handoffMaterialNeck(a:HandoffRect,b:HandoffRect,pinch:number){
 const ca=point(a),cb=point(b),distance=Math.hypot(cb.x-ca.x,cb.y-ca.y);if(distance<.01||pinch>=1)return'';
 const d={x:(cb.x-ca.x)/distance,y:(cb.y-ca.y)/distance},normal={x:-d.y,y:d.x};
 const first=boundary(a,d)-3,last=distance-boundary(b,{x:-d.x,y:-d.y})+3,length=last-first;
 if(length<1)return'';
 const origin={x:ca.x+d.x*first,y:ca.y+d.y*first},span=Math.min(15,a.height*.34,b.height*.34),half=Math.max(.15,span*(1-smooth(pinch,.06,.85))),gap=length*.82*smooth(pinch,.70,1),left=length/2-gap/2,right=length/2+gap/2,cap=Math.min(.6,half*.45);
 const p=(x:number,y:number)=>values(origin.x+d.x*x+normal.x*y,origin.y+d.y*x+normal.y*y);
 return[`M ${p(0,-span)}`,`C ${p(length*.20,-span)} ${p(left-length*.16,-half)} ${p(left,-half)}`,`C ${p(left+cap,-half)} ${p(left+cap,half)} ${p(left,half)}`,`C ${p(left-length*.16,half)} ${p(length*.20,span)} ${p(0,span)}`,'Z',`M ${p(length,-span)}`,`L ${p(length,span)}`,`C ${p(length*.8,span)} ${p(right+length*.16,half)} ${p(right,half)}`,`C ${p(right-cap,half)} ${p(right-cap,-half)} ${p(right,-half)}`,`C ${p(right+length*.16,-half)} ${p(length*.8,-span)} ${p(length,-span)}`,'Z'].join(' ');
}

/** A small drop gathers beside the chosen control and is absorbed locally.
 * Target geometry deliberately cannot turn this feedback into a cross-screen flight. */
export function featureHandoffFrame(source:HandoffRect,_target:HandoffRect,progress:number):FeatureHandoffFrame{
 const p=clamp(Number.isFinite(progress)?progress:1),origin={x:source.left+source.width-12,y:source.top+source.height/2};
 const gather=smooth(p,0,.20),absorb=smooth(p,.20,.88),fade=1-smooth(p,.62,1);
 const center={x:origin.x+lerp(3,14,gather)*(1-absorb),y:origin.y-5*Math.sin(Math.PI*smooth(p,0,.88))};
 const radius=lerp(3.2,5.5,gather)*lerp(1,.18,absorb),bubble=around(center,radius*2,radius*2*(1+.18*Math.sin(Math.PI*absorb)));
 const anchor=around(origin,7,7),neck=p>.03&&p<.78?handoffMaterialNeck(anchor,bubble,0):'';
 return{phase:p>=1?'complete':p<.20?'gathering':'absorbing',bubble,origin,haloRadius:7+12*smooth(p,0,.6),haloOpacity:.42*(1-smooth(p,.05,.65)),bubbleOpacity:fade,sourceNeck:neck,departed:p>=FEATURE_DEPART_PROGRESS,arrived:p>=.72};
}
