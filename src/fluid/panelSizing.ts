const finite=(value:number,fallback:number)=>Number.isFinite(value)?value:fallback;
export type NaturalStackChild={height:number;marginTop?:number;marginBottom?:number};
/** Deliberately excludes the current flex viewport height: stretched empty
 * containers and constrained scrollers must not feed old size back as content. */
export function naturalStackHeight(children:readonly NaturalStackChild[],gap=0,padding=0,border=0){
  if(!children.length)return Math.max(0,finite(padding,0)+finite(border,0));
  return Math.max(0,finite(padding,0)+finite(border,0)+Math.max(0,finite(gap,0))*(children.length-1)
    +children.reduce((height,child)=>height+Math.max(0,finite(child.height,0))+finite(child.marginTop??0,0)+finite(child.marginBottom??0,0),0));
}
export function fluidActivityHeightLimits(canvasHeight:number){
  const height=Math.max(400,finite(canvasHeight,776));
  const min=Math.min(176,height*.38),max=Math.max(min,Math.min(520,Math.round(height*.56)));
  return {min,max};
}
export function boundedFluidActivityHeight(naturalHeight:number,canvasHeight:number){
  const {min,max}=fluidActivityHeightLimits(canvasHeight);
  return Math.max(min,Math.min(max,Math.ceil(finite(naturalHeight,236))));
}
