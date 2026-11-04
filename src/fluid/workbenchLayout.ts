import {fluidMetrics,sidebarOffset} from './geometry';
import type {FluidFrame,FluidLayout} from './types';

/** Forms need a rectangle within the same live contour that bounds the chat.
 * The rail and eye keep their own geometry; a workbench only follows its inset. */
export function fluidWorkbenchInsets(layout:FluidLayout,frame:FluidFrame){
  const current={...layout,activityBounds:{...layout.activityBounds,height:frame.activityHeight},localBounds:{...layout.localBounds,top:frame.localTop,height:frame.localHeight}};
  const metrics=fluidMetrics(current,frame);
  const rightEdge=Math.min(metrics.upper,metrics.middle,metrics.lower);
  return {left:48+sidebarOffset(current,frame.sidebar),right:32+current.width-rightEdge,top:24,bottom:24};
}
