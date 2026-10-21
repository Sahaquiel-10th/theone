import {smoothProgress} from './geometry';
import type {FluidBounds} from './types';
const mix=(a: number,b: number,t: number)=>a+(b-a)*t;
const K=.5522847498;

/** Open to the top/left background; never a circular hole around an icon. */
export function openShoulderCut(bounds: FluidBounds,amount: number){
  if(amount<=0)return '';
  const q=smoothProgress(amount),x=bounds.left,y=bounds.top;
  const point=(a: number,b: number)=>`${x+a} ${y+b}`;
  const top=mix(32,76,q),right=mix(0,48,q),ry=mix(32,20,q);
  return `M ${point(0,0)} L ${point(top,0)}
    C ${point(mix(32*(1-K),76-28*K,q),0)} ${point(right,mix(32*(1-K),20*(1-K),q))} ${point(right,ry)}
    C ${point(right,mix(32,20+28*K,q))} ${point(mix(0,20+28*K,q),mix(32,48,q))} ${point(mix(0,20,q),mix(32,48,q))}
    C ${point(mix(0,20*(1-K),q),mix(32,48,q))} ${point(0,mix(32,76-28*K,q))} ${point(0,mix(32,76,q))}
    L ${point(0,0)} Z`;
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
