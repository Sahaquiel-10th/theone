import {smoothProgress} from './geometry';
import type {FluidBounds} from './types';
const mix=(a: number,b: number,t: number)=>a+(b-a)*t;
const K=.5522847498;

/** Open to the top/left background; never a circular hole around an icon. */
export function openShoulderCut(bounds: FluidBounds,amount: number){
  const q=smoothProgress(amount),x=bounds.left,y=bounds.top;
  const point=(a:number,b:number)=>`${x+a} ${y+b}`;
  // Subdivide one 64px quarter circle into three equal arcs, then interpolate
  // toward the original active niche. At rest there is no tight S or step.
  const radius=64,k=4/3*Math.tan(Math.PI/24);
  const quiet:number[][]=[];
  for(let i=0;i<3;i++){
    const a=-Math.PI/2-i*Math.PI/6,b=a-Math.PI/6;
    quiet.push([radius+radius*(Math.cos(a)+k*Math.sin(a)),radius+radius*(Math.sin(a)-k*Math.cos(a)),radius+radius*(Math.cos(b)-k*Math.sin(b)),radius+radius*(Math.sin(b)+k*Math.cos(b)),radius+radius*Math.cos(b),radius+radius*Math.sin(b)]);
  }
  const active=[[76-28*K,0,48,20*(1-K),48,20],[48,20+28*K,20+28*K,48,20,48],[20*(1-K),48,0,76-28*K,0,76]];
  return `M ${point(0,0)} L ${point(mix(64,76,q),0)} `+quiet.map((curve,i)=>{
    const c=curve.map((v,j)=>mix(v,active[i][j],q));
    return `C ${point(c[0],c[1])} ${point(c[2],c[3])} ${point(c[4],c[5])}`;
  }).join(' ')+` L ${point(0,0)} Z`;
}

/** A short diagonal join between the shoulder and its own small piece. */
export function shoulderBridge(bounds: FluidBounds,eye: {x: number;y: number},phase: number){
  if(phase>=1)return '';
  const ax=bounds.left+48,ay=bounds.top+48,dx=eye.x-ax,dy=eye.y-ay;
  const length=Math.hypot(dx,dy);if(length<1)return '';
  const ux=dx/length,uy=dy/length;
  const pt=(u: number,v: number)=>`${ax+u*ux-v*uy} ${ay+u*uy+v*ux}`;
  const center=Math.max(1,length-24.5),half=5*(1-smoothProgress(phase,.30,.85))+.06;
  const separation=mix(-4,9,smoothProgress(phase,.82,.99));
  const retract=smoothProgress(phase,.95,1),left=mix(center-separation/2,0,retract),right=mix(center+separation/2,length,retract),span=7*(1-retract);
  return `M ${pt(0,-span)} C ${pt(6,-span)} ${pt(left-3,-half)} ${pt(left,-half)} Q ${pt(left+1,0)} ${pt(left,half)} C ${pt(left-3,half)} ${pt(6,span)} ${pt(0,span)} Z
    M ${pt(length,-span)} L ${pt(length,span)} C ${pt(length-6,span)} ${pt(right+3,half)} ${pt(right,half)} Q ${pt(right-1,0)} ${pt(right,-half)} C ${pt(right+3,-half)} ${pt(length-6,-span)} ${pt(length,-span)} Z`;
}
