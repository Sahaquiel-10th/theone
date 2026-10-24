import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {boundedFluidActivityHeight,naturalStackHeight} from './panelSizing';

const px=(value:string)=>Number.parseFloat(value)||0;
const naturalColumns='.fluid-panel-content,.fluid-panel-empty,.task-transfer-rail,.fluid-feature-runs';
const visibleChildren=(element:HTMLElement)=>Array.from(element.children).filter((child):child is HTMLElement=>child instanceof HTMLElement&&!child.hidden&&getComputedStyle(child).display!=='none'&&!['absolute','fixed'].includes(getComputedStyle(child).position));

/** Measure the actual rendered activity body without cloning private content,
 * modifying form/layout styles or reacting to the glass's per-frame height. */
export function useFluidActivityHeight(canvasRef:RefObject<HTMLDivElement|null>,{enabled,canvasHeight}:{enabled:boolean;canvasHeight:number}){
  const [measured,setMeasured]=useState<number>();
  const latest=useRef(canvasHeight);latest.current=canvasHeight;
  const invalidate=useRef<()=>void>(()=>{});
  useLayoutEffect(()=>{
    const canvas=canvasRef.current,panel=canvas?.querySelector<HTMLElement>('.fluid-activity-panel');
    if(!enabled||!canvas||!panel){setMeasured(undefined);return;}
    let disposed=false,frame=0;
    const observed=new Set<Element>(),sizes=new WeakMap<Element,{width:number;height:number}>();
    function natural(element:HTMLElement):number{
      const style=getComputedStyle(element);
      if(style.display==='none'||element.hidden)return 0;
      if(!element.matches(naturalColumns))return element.getBoundingClientRect().height;
      const children=visibleChildren(element),padding=px(style.paddingTop)+px(style.paddingBottom),border=px(style.borderTopWidth)+px(style.borderBottomWidth);
      const height=naturalStackHeight(children.map(child=>{const css=getComputedStyle(child);return {height:natural(child),marginTop:px(css.marginTop),marginBottom:px(css.marginBottom)};}),px(style.rowGap),padding,border);
      const maximum=Number.parseFloat(style.maxHeight);
      return Number.isFinite(maximum)?Math.min(height,maximum):height;
    }
    function collect(){
      const next=new Set<Element>([panel!]);
      const body=panel!.querySelector<HTMLElement>(':scope > .fluid-panel-content');
      function add(element:HTMLElement){next.add(element);if(element.matches(naturalColumns))for(const child of visibleChildren(element))add(child);}
      if(body)add(body);else for(const child of visibleChildren(panel!))add(child);
      for(const element of observed)if(!next.has(element)){observer.unobserve(element);observed.delete(element);}
      for(const element of next)if(!observed.has(element)){observed.add(element);observer.observe(element);}
      return body;
    }
    function measure(){
      frame=0;if(disposed)return;
      const body=collect(),style=getComputedStyle(panel!),padding=px(style.paddingTop)+px(style.paddingBottom),border=px(style.borderTopWidth)+px(style.borderBottomWidth);
      // Absolute headings do not consume body flow. The wrapper is optional so
      // the hook remains safe during a staged integration or empty fixture.
      const children=body?[body]:visibleChildren(panel!);
      const naturalHeight=naturalStackHeight(children.map(child=>{const css=getComputedStyle(child);return {height:natural(child),marginTop:px(css.marginTop),marginBottom:px(css.marginBottom)};}),body?0:px(style.rowGap),padding,border);
      const target=boundedFluidActivityHeight(naturalHeight,latest.current);
      panel!.dataset.fluidNaturalHeight=naturalHeight.toFixed(1);panel!.dataset.fluidDesiredHeight=String(target);
      setMeasured(previous=>previous!==undefined&&Math.abs(previous-target)<1?previous:target);
    }
    function schedule(){if(!disposed&&!frame)frame=requestAnimationFrame(measure);}
    const observer=new ResizeObserver(entries=>{
      let changed=false;
      for(const entry of entries){const next={width:entry.contentRect.width,height:entry.contentRect.height},before=sizes.get(entry.target);sizes.set(entry.target,next);
        // Geometry stretches these containers each frame. Intrinsic leaf sizes,
        // content mutations and widths are the only useful changes to observe.
        const isViewport=entry.target===panel||entry.target instanceof Element&&entry.target.matches(naturalColumns);
        if(!before||Math.abs(before.width-next.width)>.5||!isViewport&&Math.abs(before.height-next.height)>.5)changed=true;
      }
      if(changed)schedule();
    });
    const mutation=new MutationObserver(schedule);mutation.observe(panel,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','hidden','open','aria-expanded']});
    panel.addEventListener('load',schedule,true);window.addEventListener('resize',schedule,{passive:true});
    invalidate.current=schedule;measure();void document.fonts?.ready.then(()=>{if(!disposed)schedule();});
    return()=>{disposed=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();mutation.disconnect();panel.removeEventListener('load',schedule,true);window.removeEventListener('resize',schedule);invalidate.current=()=>{};delete panel.dataset.fluidNaturalHeight;delete panel.dataset.fluidDesiredHeight;};
  },[canvasRef,enabled]);
  useLayoutEffect(()=>{invalidate.current();},[canvasHeight]);
  return measured;
}
