/** The desktop starting measure, shared by both speakers and the composer. */
export const FLUID_READING_MEASURE=800;
export type FluidReadingColumn={left:number;right:number;width:number;offset:number};

/** Return half of each former outer margin to the conversation. Below the
 * starting measure use all available room, without imposing a minimum width. */
export function fluidReadingMeasure(available:number,base=FLUID_READING_MEASURE){
 const room=Number.isFinite(available)?Math.max(0,available):0;
 const starting=Number.isFinite(base)&&base>0?base:FLUID_READING_MEASURE;
 return room<=starting?room:starting+(room-starting)/2;
}

/** Keep the idle reading center while material yields around it. A sidebar
 * only moves the left edge once it actually reaches this reading column. */
export function fluidReadingColumn(left:number,right:number,idleLeft=left,measure=FLUID_READING_MEASURE):FluidReadingColumn{
 const end=Number.isFinite(right)?Math.max(0,right):0;
 const start=Number.isFinite(left)?Math.max(0,Math.min(end,left)):0;
 const idle=Number.isFinite(idleLeft)?Math.max(0,Math.min(end,idleLeft)):start;
 const limit=Number.isFinite(measure)&&measure>0?measure:FLUID_READING_MEASURE;
 const width=fluidReadingMeasure(end-idle,limit),preferredLeft=idle+(end-idle-width)/2;
 const columnLeft=Math.min(end,Math.max(start,preferredLeft));
 const columnRight=Math.max(columnLeft,Math.min(end,preferredLeft+width));
 return {left:columnLeft,right:columnRight,width:columnRight-columnLeft,offset:columnLeft-start};
}

/** A child owns only its local slice. The unused upper/lower region still
 * belongs to the same reading column instead of reserving an empty rail. */
export function fluidReadingRight(column:FluidReadingColumn,availableRight:number){
 const edge=Number.isFinite(availableRight)?availableRight:column.right;
 return Math.max(column.left,Math.min(column.right,edge));
}
