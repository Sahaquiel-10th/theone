import {splitSmooth} from './splitGeometry';

export type WorkLayerRegion={left:number;top:number;width:number;height:number;radius?:number};
export type WorkLayerArrivalOptions={width:number;height:number;regions:readonly WorkLayerRegion[];progress:number};
/** A selected task already has one meaningful split to show. Its list/detail
 * surface owns the entry, so a decorative parent must not make it wait. */
export function workLayerUsesDirectTaskSplit(taskLayer:boolean,selectedDetail:boolean){return taskLayer&&selectedDetail;}
const K=.5522847498;
const finite=(n:number,fallback:number)=>Number.isFinite(n)?n:fallback;
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const n=(...values:number[])=>values.map(value=>Math.round(value*1000)/1000).join(' ');

/** Header, navigation and content keep their final DOM positions. Only this
 * common material changes topology, with actual measured gaps as its targets. */
export function workLayerArrivalGeometry(options:WorkLayerArrivalOptions){
 const width=Math.max(80,finite(options.width,1040)),height=Math.max(80,finite(options.height,640));
 const p=clamp(finite(options.progress,0),0,1);
 const input=options.regions.filter(region=>Number.isFinite(region.left)&&Number.isFinite(region.top)&&region.width>1&&region.height>1).slice(0,3);
 const raw=input.length?input:[{left:1,top:1,width:width-2,height:height-2,radius:28}];
 const source=raw.map(region=>({left:clamp(region.left,0,width-2),right:clamp(region.left+region.width,2,width),top:clamp(region.top,0,height-2),bottom:clamp(region.top+region.height,2,height),radius:clamp(finite(region.radius??28,28),2,40)}));
 const overall={left:Math.min(...source.map(r=>r.left)),right:Math.max(...source.map(r=>r.right)),top:source[0].top,bottom:source.at(-1)!.bottom};
 const edge=splitSmooth(p,.16,1),center=(overall.left+overall.right)/2;
 const seams=source.slice(0,-1).map((region,index)=>{
   const next=source[index+1],middle=(region.bottom+next.top)/2,gap=Math.max(2,next.top-region.bottom);
   // The first cut becomes legible before the second finishes dividing the body.
   const phase=source.length===3?splitSmooth(p,index===0?.12:.32,index===0?.88:1):splitSmooth(p,.12,1);
   const opening=splitSmooth(phase,.015,.73),actualGap=gap*opening;
   return {phase,middle,gap,top:middle-actualGap/2,bottom:middle+actualGap/2,connected:phase<.93};
 });
 const regions=source.map((region,index)=>({
   left:mix(overall.left,region.left,edge),right:mix(overall.right,region.right,edge),
   top:index?seams[index-1].bottom:overall.top,bottom:index<source.length-1?seams[index].top:overall.bottom,
   radius:mix(28,region.radius,edge),
 }));
 const groups:{first:number;last:number}[]=[];let first=0;
 for(let index=0;index<seams.length;index++)if(!seams[index].connected){groups.push({first,last:index});first=index+1;}
 groups.push({first,last:regions.length-1});
 const radius=(index:number)=>Math.max(.1,Math.min(regions[index].radius,(regions[index].bottom-regions[index].top)/2,(regions[index].right-regions[index].left)/4));
 function lip(index:number){
   const seam=seams[index],retract=splitSmooth(seam.phase,.93,1);
   return {reach:Math.max(0,seam.gap/2-.22)*(1-retract),span:Math.min(76,(overall.right-overall.left)*.12)*(1-retract)};
 }
 function topEdge(index:number,left:number,right:number,y:number,r:number){
   const commands=[`M ${n(left+r,y)}`];
   if(index){const l=lip(index-1);commands.push(`L ${n(center-l.span,y)}`,`C ${n(center-l.span*.4,y,center-l.span*.3,y-l.reach,center,y-l.reach)}`,`C ${n(center+l.span*.3,y-l.reach,center+l.span*.4,y,center+l.span,y)}`);}
   commands.push(`L ${n(right-r,y)}`,`C ${n(right-r+r*K,y,right,y+r-r*K,right,y+r)}`);return commands;
 }
 const paths=groups.map(group=>{
   const upper=regions[group.first],lower=regions[group.last],ur=radius(group.first),lr=radius(group.last);
   const path=topEdge(group.first,upper.left,upper.right,upper.top,ur);
   for(let index=group.first;index<group.last;index++){
     const a=regions[index],b=regions[index+1],seam=seams[index],half=(overall.right-overall.left)/2*(1-splitSmooth(seam.phase,.015,.93));
     const neck=Math.min(Math.min(a.right,b.right),center+Math.max(.15,half));
     const depth=Math.max(0,Math.min(a.right,b.right)-neck),r=Math.min(radius(index),radius(index+1),depth*.4);
     const shoulder=Math.min(80,Math.max(0,depth-r)),cap=Math.min((seam.bottom-seam.top)/2,depth*.2);
     path.push(`L ${n(a.right,seam.top-r)}`,`C ${n(a.right,seam.top-r+r*K,a.right-r+r*K,seam.top,a.right-r,seam.top)}`,
       `L ${n(neck+shoulder,seam.top)}`,`C ${n(neck+shoulder*(1-K),seam.top,neck,seam.top+cap*(1-K),neck,seam.top+cap)}`,
       `L ${n(neck,seam.bottom-cap)}`,`C ${n(neck,seam.bottom-cap+cap*K,neck+shoulder*(1-K),seam.bottom,neck+shoulder,seam.bottom)}`,
       `L ${n(b.right-r,seam.bottom)}`,`C ${n(b.right-r+r*K,seam.bottom,b.right,seam.bottom+r-r*K,b.right,seam.bottom+r)}`);
   }
   path.push(`L ${n(lower.right,lower.bottom-lr)}`,`C ${n(lower.right,lower.bottom-lr+lr*K,lower.right-lr+lr*K,lower.bottom,lower.right-lr,lower.bottom)}`);
   if(group.last<regions.length-1){const l=lip(group.last);path.push(`L ${n(center+l.span,lower.bottom)}`,`C ${n(center+l.span*.4,lower.bottom,center+l.span*.3,lower.bottom+l.reach,center,lower.bottom+l.reach)}`,`C ${n(center-l.span*.3,lower.bottom+l.reach,center-l.span*.4,lower.bottom,center-l.span,lower.bottom)}`);}
   path.push(`L ${n(lower.left+lr,lower.bottom)}`,`C ${n(lower.left+lr-lr*K,lower.bottom,lower.left,lower.bottom-lr+lr*K,lower.left,lower.bottom-lr)}`);
   for(let index=group.last-1;index>=group.first;index--){
     const a=regions[index],b=regions[index+1],seam=seams[index],half=(overall.right-overall.left)/2*(1-splitSmooth(seam.phase,.015,.93));
     const neck=Math.max(Math.max(a.left,b.left),center-Math.max(.15,half));
     const depth=Math.max(0,neck-Math.max(a.left,b.left)),r=Math.min(radius(index),radius(index+1),depth*.4);
     const shoulder=Math.min(80,Math.max(0,depth-r)),cap=Math.min((seam.bottom-seam.top)/2,depth*.2);
     path.push(`L ${n(b.left,seam.bottom+r)}`,`C ${n(b.left,seam.bottom+r-r*K,b.left+r-r*K,seam.bottom,b.left+r,seam.bottom)}`,
       `L ${n(neck-shoulder,seam.bottom)}`,`C ${n(neck-shoulder*(1-K),seam.bottom,neck,seam.bottom-cap*(1-K),neck,seam.bottom-cap)}`,
       `L ${n(neck,seam.top+cap)}`,`C ${n(neck,seam.top+cap-cap*K,neck-shoulder*(1-K),seam.top,neck-shoulder,seam.top)}`,
       `L ${n(a.left+r,seam.top)}`,`C ${n(a.left+r-r*K,seam.top,a.left,seam.top-r+r*K,a.left,seam.top-r)}`);
   }
   path.push(`L ${n(upper.left,upper.top+ur)}`,`C ${n(upper.left,upper.top+ur-ur*K,upper.left+ur-ur*K,upper.top,upper.left+ur,upper.top)}`,'Z');
   return path.join(' ');
 });
 return {path:paths.join(' '),components:groups.length,seams,regions,progress:p};
}
