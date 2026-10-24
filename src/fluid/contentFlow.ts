import {useCallback, useLayoutEffect, useRef, type RefObject} from 'react';
import {fluidMetrics, mainRightAt, sidebarOffset} from './geometry';
import {fluidReadingColumn,fluidReadingRight} from './readingLayout';
import type {FluidFrame, FluidLayout, FluidPhases} from './types';

/** The reading surface follows only the occupied part of the mother bubble. */
export function availableRight(layout:FluidLayout, phases:FluidPhases, top:number, bottom:number) {
  const metrics=fluidMetrics(layout,phases);
  let right=layout.width-32;
  for(let y=Math.max(0,top);y<=Math.min(layout.height,bottom);y+=6)right=Math.min(right,mainRightAt(layout,metrics,y)-32);
  right=Math.min(right,mainRightAt(layout,metrics,Math.max(0,Math.min(layout.height,bottom)))-32);
  return right;
}

/** A float ends at a complete line box, never at the glyph's shorter ink box. */
export function flowTextExtent(inkBottom:number,lineHeight:number){
  const line=Number.isFinite(lineHeight)&&lineHeight>0?lineHeight:27;
  return Math.max(line,Math.ceil(Math.max(0,inkBottom)/line)*line);
}

/** DOM measurements remain local; no streamed message or input is re-mounted. */
export function useFluidContentFlow(canvas:RefObject<HTMLDivElement|null>,enabled:boolean,layout:FluidLayout){
  const latest=useRef({layout,phases:{} as FluidPhases});latest.current.layout=layout;
  const refresh=useRef<(()=>void)|null>(null);
  const onFrame=useCallback((frame:FluidFrame)=>{
    const old=latest.current,changed=Math.abs((old.phases.activity||0)-frame.activity)>.00005||Math.abs((old.phases.local||0)-frame.local)>.00005||Math.abs((old.phases.sidebar||0)-frame.sidebar)>.00005||Math.abs(old.layout.activityBounds.height-frame.activityHeight)>.05||Math.abs(old.layout.localBounds.height-frame.localHeight)>.05;
    latest.current.phases={activity:frame.activity,local:frame.local,sidebar:frame.sidebar};
    const current=latest.current.layout;
    latest.current.layout={...current,activityBounds:{...current.activityBounds,height:frame.activityHeight},localBounds:{...current.localBounds,top:frame.localTop,height:frame.localHeight}};
    if(changed)refresh.current?.();
  },[]);
  useLayoutEffect(()=>{
    const root=canvas.current;if(!root||!enabled)return;
    let raf=0,disposed=false;
    const observer=new ResizeObserver(schedule);
    const ranges=new WeakMap<Element,Range>();
    let managedLog:HTMLElement|null=null;
    function schedule(){if(!disposed&&!raf)raf=requestAnimationFrame(paint);}
    function set(node:HTMLElement,key:string,value:string){if(node.style.getPropertyValue(key)!==value)node.style.setProperty(key,value);}
    function paint(){
      raf=0;if(disposed||!root)return;
      const {layout,phases}=latest.current,origin=root.getBoundingClientRect();
      const assistant=root.querySelector<HTMLElement>(':scope > .studio-assistant');if(!assistant)return;
      const assistantRect=assistant.getBoundingClientRect(),left=assistantRect.left-origin.left;
      const log=root.querySelector<HTMLElement>('.coordinator-messages');
      const logRight=log?log.getBoundingClientRect().right-origin.left-(parseFloat(getComputedStyle(log).paddingRight)||0):assistantRect.right-origin.left-4;
      const column=fluidReadingColumn(left,logRight,left-sidebarOffset(layout,phases.sidebar||0));
      if(log!==managedLog){
        if(managedLog)delete managedLog.dataset.fluidLayoutManaged;
        managedLog=log;if(log)log.dataset.fluidLayoutManaged='true';
      }
      const anchor=log?[...log.querySelectorAll<HTMLElement>('.coordinator-message > *')].find(el=>el.getBoundingClientRect().bottom>log.getBoundingClientRect().top):undefined;
      const anchorY=anchor?.getBoundingClientRect().top;
      const writes:Array<{node:HTMLElement;key:string;value:string}>=[];
      const plan=(node:HTMLElement,key:string,value:string)=>writes.push({node,key,value});
      plan(assistant,'--fluid-reading-offset',`${column.offset.toFixed(1)}px`);
      plan(assistant,'--fluid-reading-measure',`${column.width.toFixed(1)}px`);
      plan(assistant,'--fluid-reading-right-inset',`${Math.max(0,assistantRect.right-origin.left-column.right).toFixed(1)}px`);
      assistant.dataset.fluidReadingLeft=column.left.toFixed(1);
      assistant.dataset.fluidReadingRight=column.right.toFixed(1);
      assistant.dataset.fluidReadingWidth=column.width.toFixed(1);
      // Paragraphs get a local CSS shape: their individual lines can use the
      // recovered upper/lower region. Rich blocks keep a safe rectangular area.
      const blocks=assistant.querySelectorAll<HTMLElement>('.coordinator-message.user, .coordinator-message.assistant > *, .coordinator-history-button, .coordinator-messages > [data-task-dispatch-anchor], .studio-presence, .studio-composer, .studio-suggestions, .attention-receipt-slot');
      for(const block of blocks){
        const rect=block.getBoundingClientRect(),top=rect.top-origin.top,bottom=rect.bottom-origin.top;
        if(bottom<0||top>layout.height)continue;
        const blockLeft=column.left;
        if(block.matches('.coordinator-message.assistant > p')&&!block.querySelector('img,pre,table,button,iframe')){
          const full=column.width,maxCut=Math.max(0,Math.min(full,full-(layout.safeRight-32-column.left)));
          let range=ranges.get(block);if(!range){range=document.createRange();ranges.set(block,range);}range.selectNodeContents(block);
          const text=range.getBoundingClientRect();
          const lineHeight=parseFloat(getComputedStyle(block).lineHeight)||27;
          const height=flowTextExtent(text.bottom-rect.top,lineHeight);
          const points:string[]=[`${maxCut.toFixed(1)}px 0px`];
          for(let y=0;y<height;y+=8){const edge=fluidReadingRight(column,availableRight(layout,phases,top+y,top+y+lineHeight))-blockLeft;points.push(`${Math.max(0,Math.min(maxCut,edge-(full-maxCut))).toFixed(1)}px ${y.toFixed(1)}px`);}
          const edge=fluidReadingRight(column,availableRight(layout,phases,top+height,top+height+lineHeight))-blockLeft;
          points.push(`${Math.max(0,Math.min(maxCut,edge-(full-maxCut))).toFixed(1)}px ${height.toFixed(1)}px`,`${maxCut.toFixed(1)}px ${height.toFixed(1)}px`);
          plan(block,'--fluid-flow-cut',`${maxCut.toFixed(1)}px`);
          plan(block,'--fluid-flow-height',`${height.toFixed(1)}px`);
          plan(block,'--fluid-flow-shape',`polygon(${points.join(',')})`);
        }else{
          const right=fluidReadingRight(column,availableRight(layout,phases,top,bottom)),width=Math.max(0,right-blockLeft);
          plan(block,'--fluid-block-width',`${width.toFixed(1)}px`);
          if(block.matches('.coordinator-message.user')){
            plan(block,'--fluid-user-inset',`${Math.max(0,logRight-right).toFixed(1)}px`);
          }
        }
      }
      const newest=root.querySelector<HTMLElement>('.coordinator-new-message');
      if(newest){const rect=newest.getBoundingClientRect();plan(newest,'--fluid-new-inset',`${Math.max(0,assistantRect.right-origin.left-fluidReadingRight(column,availableRight(layout,phases,rect.top-origin.top,rect.bottom-origin.top))).toFixed(1)}px`);}
      // Measure every block before changing any widths. Otherwise downstream
      // measurements combine old and new layouts within the same frame.
      for(const {node,key,value} of writes)set(node,key,value);
      // Reflow is not incoming content. Preserve the visible reading anchor
      // even when the next genuine message should still follow to the end.
      if(log&&anchor&&anchorY!==undefined){const dy=anchor.getBoundingClientRect().top-anchorY;if(Math.abs(dy)>.5)log.scrollTop+=dy;}
    }
    function observe(){
      observer.disconnect();observer.observe(root!);
      root!.querySelectorAll<HTMLElement>('.studio-assistant,.coordinator-messages,.coordinator-message,.coordinator-message > *, .studio-composer').forEach(el=>observer.observe(el));
      schedule();
    }
    const mutations=new MutationObserver(observe);mutations.observe(root,{childList:true,subtree:true,characterData:true});
    root.addEventListener('scroll',schedule,true);root.addEventListener('load',schedule,true);
    refresh.current=schedule;observe();
    return()=>{disposed=true;cancelAnimationFrame(raf);observer.disconnect();mutations.disconnect();root.removeEventListener('scroll',schedule,true);root.removeEventListener('load',schedule,true);if(managedLog)delete managedLog.dataset.fluidLayoutManaged;refresh.current=null;};
  },[canvas,enabled]);
  useLayoutEffect(()=>{refresh.current?.();},[layout.width,layout.height,layout.activityBounds.height,layout.localBounds.height]);
  return onFrame;
}
