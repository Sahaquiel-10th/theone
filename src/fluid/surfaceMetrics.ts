import type {BubbleKind,FluidBounds} from './types';

/** Material and brand geometry use one coordinate contract, in CSS pixels. */
export const FLUID_SURFACE_EDGE=.5;
export const FLUID_MAIN_RADIUS=48;
export const FLUID_EYE_SIZE=44;
export const FLUID_EYE_RADIUS=FLUID_EYE_SIZE/2;
// Quiet entries sit below the mother's outer corner. Opening follows the local
// shoulder upward; the logo's top tangent then aligns with its own module.
export const FLUID_REST_ENTRY_INSET=FLUID_MAIN_RADIUS+12;
export function fluidPanelEye(bounds:Pick<FluidBounds,'left'|'top'>){
  return {x:bounds.left+FLUID_SURFACE_EDGE+FLUID_EYE_RADIUS,y:bounds.top+FLUID_SURFACE_EDGE+FLUID_EYE_RADIUS};
}
export function fluidRestEntryY(bounds:Pick<FluidBounds,'top'>,kind?:BubbleKind){
  // A quiet activity entry keeps the earlier, lower seat. This does not move
  // the opened module or its eye, whose top tangent remains at the canvas top.
  const activity=kind==='activity'||kind===undefined&&bounds.top===0;
  return bounds.top+FLUID_REST_ENTRY_INSET+(activity?FLUID_MAIN_RADIUS:0);
}
