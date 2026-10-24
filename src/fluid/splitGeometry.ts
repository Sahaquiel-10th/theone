/** A work surface separates by opening a cleft, rather than growing another card. */
const K = .5522847498;
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const mix = (a: number, b: number, p: number) => a + (b - a) * p;
const point = (...values: number[]) => values.map(value => Math.round(value * 1000) / 1000).join(' ');
export function splitSmooth(value: number, start = 0, end = 1) {
  const p = clamp((value - start) / (end - start), 0, 1);
  return p * p * (3 - 2 * p);
}

export type SplitGeometryOptions = { width: number; height: number; progress: number; ratio?: number; compact?: boolean };
export function splitWorkspaceMetrics(options: SplitGeometryOptions) {
  const width = Math.max(280, finite(options.width, 1040)), height = Math.max(120, finite(options.height, 560));
  const p = clamp(finite(options.progress, 0), 0, 1), inset = 2;
  const left = inset, top = inset, right = width - inset, bottom = height - inset;
  const bodyWidth = right - left, bodyHeight = bottom - top;
  const gap = Math.min(20, bodyWidth * .022);
  // On desktop both panes retain useful reading/form widths. Compact children may
  // share a smaller source card, while still keeping enough room for a link.
  const minPrimary = Math.min(options.compact ? 140 : 250, bodyWidth * .43);
  const minSecondary = Math.min(options.compact ? 180 : 320, bodyWidth * .51);
  const desired = bodyWidth * clamp(finite(options.ratio ?? .34, .34), .28, .66);
  const primaryTarget = clamp(desired - gap / 2, minPrimary, bodyWidth - gap - minSecondary);
  const seam = left + primaryTarget + gap / 2;
  const opening = splitSmooth(p, .015, .73), actualGap = gap * opening;
  const nearLeft = seam - actualGap / 2, nearRight = seam + actualGap / 2;
  const radius = Math.min(options.compact ? 20 : 28, bodyHeight / 4, primaryTarget / 3, (bodyWidth - primaryTarget - gap) / 3);
  const centerY = (top + bottom) / 2;
  const connected = p < .93;
  const neckHalf = p === 0 ? bodyHeight / 2 : Math.max(.12, bodyHeight / 2 * (1 - splitSmooth(p, .015, .93)));
  const notchDepth = centerY - neckHalf - top;
  const notchRadius = Math.min(radius, Math.max(0, notchDepth * .45));
  const capRadius = Math.min(actualGap / 2, Math.max(0, notchDepth - notchRadius));
  // Surface tension is local to the seam: long, shallow shoulders feed the
  // remaining neck, rather than a mechanically straight slit ending in a U.
  const capHeight = Math.min(options.compact ? 42 : 72, Math.max(0, notchDepth-notchRadius));
  const retract = splitSmooth(p, .93, 1);
  const lipReach = connected ? actualGap / 2 : gap / 2 * (1 - retract);
  const lipShoulder = connected ? capHeight : Math.max(.1, (options.compact ? 42 : 72) * (1 - retract));
  const lipHalf = connected ? neckHalf : .12 * (1 - retract);
  const primaryWidth = mix(bodyWidth, primaryTarget, splitSmooth(p, .015, .72));
  const secondaryLeft = left + primaryTarget + gap;
  return { width, height, p, left, top, right, bottom, radius, centerY, seam, gap, actualGap,
    nearLeft, nearRight, connected, neckHalf, notchDepth, notchRadius, capRadius, capHeight,
    lipReach, lipShoulder, lipHalf, primaryWidth, secondaryLeft,
    secondaryWidth: right - secondaryLeft, contentReveal: splitSmooth(p, .2, .69) };
}

export function splitWorkspaceGeometry(options: SplitGeometryOptions) {
  const m = splitWorkspaceMetrics(options);
  const { left: x, top: y, right, bottom, radius: r, centerY: cy, nearLeft: a, nearRight: b } = m;
  const roundTopLeft = [`M ${point(x + r, y)}`];
  const outerRight = [`L ${point(right - r, y)}`, `C ${point(right-r+r*K,y,right,y+r-r*K,right,y+r)}`,
    `L ${point(right,bottom-r)}`, `C ${point(right,bottom-r+r*K,right-r+r*K,bottom,right-r,bottom)}`];
  const outerLeft = [`L ${point(x+r,bottom)}`, `C ${point(x+r-r*K,bottom,x,bottom-r+r*K,x,bottom-r)}`,
    `L ${point(x,y+r)}`, `C ${point(x,y+r-r*K,x+r-r*K,y,x+r,y)}`, 'Z'];

  if (m.connected) {
    const nr=m.notchRadius,cr=m.capRadius,ch=m.capHeight,nt=cy-m.neckHalf,nb=cy+m.neckHalf;
    // A single outline with two opposing U-shaped incisions. At p=0 all
    // incision points coincide with the original straight top/bottom edges.
    const path = [...roundTopLeft, `L ${point(a-nr,y)}`,
      `C ${point(a-nr+nr*K,y,a,y+nr-nr*K,a,y+nr)}`, `L ${point(a,nt-ch)}`,
      `C ${point(a,nt-ch+ch*K,a+cr-cr*K,nt,a+cr,nt)}`,
      `L ${point(b-cr,nt)}`, `C ${point(b-cr+cr*K,nt,b,nt-ch+ch*K,b,nt-ch)}`,
      `L ${point(b,y+nr)}`, `C ${point(b,y+nr-nr*K,b+nr-nr*K,y,b+nr,y)}`,
      ...outerRight, `L ${point(b+nr,bottom)}`,
      `C ${point(b+nr-nr*K,bottom,b,bottom-nr+nr*K,b,bottom-nr)}`, `L ${point(b,nb+ch)}`,
      `C ${point(b,nb+ch-ch*K,b-cr+cr*K,nb,b-cr,nb)}`,
      `L ${point(a+cr,nb)}`, `C ${point(a+cr-cr*K,nb,a,nb+ch-ch*K,a,nb+ch)}`,
      `L ${point(a,bottom-nr)}`, `C ${point(a,bottom-nr+nr*K,a-nr+nr*K,bottom,a-nr,bottom)}`,
      ...outerLeft].join(' ');
    return { path, metrics: m };
  }

  const lipLeft=a+m.lipReach,lipRight=b-m.lipReach,shoulder=m.lipShoulder,half=m.lipHalf,cap=Math.min(.08,half*.5);
  const leftPath=[...roundTopLeft, `L ${point(a-r,y)}`, `C ${point(a-r+r*K,y,a,y+r-r*K,a,y+r)}`,
    `L ${point(a,cy-shoulder)}`, `C ${point(a,cy-shoulder*.35,lipLeft-cap,cy-half,lipLeft,cy-half)}`,
    `C ${point(lipLeft+cap,cy-half,lipLeft+cap,cy+half,lipLeft,cy+half)}`,
    `C ${point(lipLeft-cap,cy+half,a,cy+shoulder*.35,a,cy+shoulder)}`,
    `L ${point(a,bottom-r)}`, `C ${point(a,bottom-r+r*K,a-r+r*K,bottom,a-r,bottom)}`, ...outerLeft];
  const rightPath=[`M ${point(b+r,y)}`, ...outerRight, `L ${point(b+r,bottom)}`,
    `C ${point(b+r-r*K,bottom,b,bottom-r+r*K,b,bottom-r)}`, `L ${point(b,cy+shoulder)}`,
    `C ${point(b,cy+shoulder*.35,lipRight+cap,cy+half,lipRight,cy+half)}`,
    `C ${point(lipRight-cap,cy+half,lipRight-cap,cy-half,lipRight,cy-half)}`,
    `C ${point(lipRight+cap,cy-half,b,cy-shoulder*.35,b,cy-shoulder)}`,
    `L ${point(b,y+r)}`, `C ${point(b,y+r-r*K,b+r-r*K,y,b+r,y)}`, 'Z'];
  return { path: [...leftPath,...rightPath].join(' '), metrics: m };
}

export type SplitSpring = { position: number; velocity: number };
/** Auxiliary work surfaces are deliberately calmer than the main canvas. */
export const AUXILIARY_SPLIT_TEMPO=1.25;
/** A reversed request is still a new transition, even if its end state matches
 * the last fully rendered state. Consumers wait for that merge to route focus
 * or release a queued child. Initial closed surfaces emit no completion. */
export function createSplitCompletion(initialOpen:boolean,onComplete:(open:boolean)=>void){
  let requested=initialOpen,reported:boolean|undefined=initialOpen?undefined:false;
  return {
    retarget(open:boolean){if(open===requested)return false;requested=open;reported=undefined;return true;},
    settle(open:boolean){if(open!==requested||reported===open)return;reported=open;onComplete(open);},
  };
}
export const splitSpringAtRest = (state: SplitSpring, target: number) => Math.abs(state.position-target)<.00035 && Math.abs(state.velocity)<.004;
/** Continuous position and velocity survive re-targeting, including mid-pinch. */
export function advanceSplitSpring(state: SplitSpring, target: number, seconds: number, reduced = false): SplitSpring {
  target=clamp(finite(target,0),0,1);
  if(reduced)return {position:target,velocity:0};
  let position=clamp(finite(state.position,target),0,1),velocity=finite(state.velocity,0);
  let remaining=clamp(finite(seconds,0),0,.15)/AUXILIARY_SPLIT_TEMPO;
  while(remaining>0){const dt=Math.min(remaining,1/150);remaining-=dt;velocity+=(target-position)*144*dt-velocity*24*dt;position+=velocity*dt;}
  if(position<0||position>1){position=clamp(position,0,1);velocity=0;}
  const next={position,velocity};return splitSpringAtRest(next,target)?{position:target,velocity:0}:next;
}
