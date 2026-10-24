import {advanceEyeSpring,companionGaze} from '../oneEyeMotion';

export interface LogoTarget { x:number; y:number; openness:number; warmth:number; nearby:boolean; shy:boolean }
export interface LogoAxis { position:number; velocity:number }
export interface LogoMotion { x:LogoAxis; y:LogoAxis; lid:LogoAxis; warmth:LogoAxis }
const smooth=(value:number)=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};

/** A look from a distance becomes a small, continuous retreat only up close.
 * All coordinates affect the pupil/lids in a 100-unit logo, never its hit target. */
export function fluidLogoTarget(dx:number,dy:number,{focused=false,pressed=false,reduced=false,available=true}:{focused?:boolean;pressed?:boolean;reduced?:boolean;available?:boolean}={}):LogoTarget {
  const neutral={x:0,y:0,openness:focused?1.025:1,warmth:focused?.10:0,nearby:false,shy:false};
  if(reduced||!available||!Number.isFinite(dx)||!Number.isFinite(dy))return neutral;
  const gaze=companionGaze(dx,dy,360),distance=Math.hypot(dx,dy);
  const closeness=1-smooth((distance-16)/48);
  // Soft normalization avoids a direction flip/singularity under the pupil.
  const retreat=closeness*4/(distance+16);
  return {
    x:gaze.x*(1-closeness)-dx*retreat,
    y:gaze.y*(1-closeness)-dy*retreat*.52,
    openness:pressed?.94:focused?1.025:1-.13*closeness,
    warmth:focused?.10:.10*closeness,
    nearby:gaze.nearby,
    shy:closeness>.12,
  };
}

export function restingLogoMotion():LogoMotion {
  return {x:{position:0,velocity:0},y:{position:0,velocity:0},lid:{position:1,velocity:0},warmth:{position:0,velocity:0}};
}

export function advanceFluidLogo(motion:LogoMotion,target:LogoTarget,seconds:number):LogoMotion {
  return {
    x:advanceEyeSpring(motion.x.position,motion.x.velocity,target.x,seconds,target.nearby?19:13),
    y:advanceEyeSpring(motion.y.position,motion.y.velocity,target.y,seconds,target.nearby?19:13),
    lid:advanceEyeSpring(motion.lid.position,motion.lid.velocity,target.openness,seconds,17),
    warmth:advanceEyeSpring(motion.warmth.position,motion.warmth.velocity,target.warmth,seconds,15),
  };
}

/** Settle once, then stop requesting frames until a real interaction occurs. */
export function fluidLogoNeedsFrame(motion:LogoMotion,target:LogoTarget) {
  const error=Math.abs(motion.x.position-target.x)+Math.abs(motion.y.position-target.y)
    +Math.abs(motion.lid.position-target.openness)+Math.abs(motion.warmth.position-target.warmth);
  const velocity=Math.abs(motion.x.velocity)+Math.abs(motion.y.velocity)+Math.abs(motion.lid.velocity)+Math.abs(motion.warmth.velocity);
  return error+velocity>.012;
}
