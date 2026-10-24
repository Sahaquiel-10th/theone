import {useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {advanceSplitSpring,splitSpringAtRest,type SplitSpring} from './splitGeometry';
import {workLayerArrivalGeometry,workLayerUsesDirectTaskSplit,type WorkLayerRegion} from './workLayerArrivalGeometry';

/** A shared material enters first; header, scope and content stay fixed while
 * opposing clefts split it into their measured final surfaces. */
export function FluidWorkLayerArrival({open}:{open:boolean}){
 const anchor=useRef<HTMLSpanElement>(null),canvas=useRef<SVGSVGElement>(null),shape=useRef<SVGPathElement>(null),rim=useRef<SVGPathElement>(null),stage=useRef<SVGRectElement>(null);
 const [dialog,setDialog]=useState<HTMLDialogElement|null>(null),currentOpen=useRef(open);currentOpen.current=open;
 const gradient=`workflow-arrival-${useId().replace(/:/g,'')}`;
 useLayoutEffect(()=>{setDialog(anchor.current?.closest('dialog')??null);},[]);
 useLayoutEffect(()=>{
   if(!dialog||!canvas.current||!shape.current||!rim.current||!stage.current)return;
   const svg=canvas.current,material=shape.current,edge=rim.current,backing=stage.current;
   const preference=matchMedia('(prefers-reduced-motion: reduce)');
   let frame=0,lastTime=0,disposed=false,running=false,wasOpen=false;
   let motion:SplitSpring={position:0,velocity:0};
   let measured:{width:number;height:number;regions:WorkLayerRegion[]}|null=null;
   const observed=new Set<Element>(),resize=new ResizeObserver(()=>measure());
   function relative(element:HTMLElement,outer:DOMRect,inset=0):WorkLayerRegion{
     const rect=element.getBoundingClientRect();return {left:rect.left-outer.left+inset,top:rect.top-outer.top+inset,width:Math.max(2,rect.width-inset*2),height:Math.max(2,rect.height-inset*2),radius:parseFloat(getComputedStyle(element).borderTopLeftRadius)||28};
   }
   function observe(element:Element){if(!observed.has(element)){observed.add(element);resize.observe(element);}}
   function paint(){
     if(!measured)return;
     const geometry=workLayerArrivalGeometry({...measured,progress:motion.position});
     material.setAttribute('d',geometry.path);edge.setAttribute('d',geometry.path);
     svg.setAttribute('viewBox',`0 0 ${measured.width} ${measured.height}`);
     dialog!.dataset.fluidArrivalProgress=motion.position.toFixed(3);
     dialog!.dataset.fluidArrivalParts=String(geometry.components);
   }
   function finish(){
     if(frame)cancelAnimationFrame(frame);frame=0;running=false;motion={position:1,velocity:0};paint();
     dialog!.dataset.fluidArrivalActive='false';dialog!.dataset.fluidArrivalState='settled';svg.style.display='none';
   }
   function animate(now:number){
     frame=0;if(disposed||!running)return;
     motion=advanceSplitSpring(motion,1,(now-lastTime)/1000,preference.matches);lastTime=now;paint();
     if(splitSpringAtRest(motion,1))finish();else frame=requestAnimationFrame(animate);
   }
   function measure(){
     if(disposed)return;
     if(!dialog!.open||!currentOpen.current){if(frame)cancelAnimationFrame(frame);frame=0;running=false;wasOpen=false;measured=null;dialog!.dataset.fluidArrivalActive='false';svg.style.display='none';return;}
     const bounds=dialog!.getBoundingClientRect(),header=dialog!.querySelector<HTMLElement>(':scope > header'),body=dialog!.querySelector<HTMLElement>(':scope > .settings-dialog-body');
     if(!header||!body||bounds.width<20||bounds.height<20)return;
     const nav=body.querySelector<HTMLElement>('[data-fluid-arrival-nav],.fluid-task-scope');
     const content=body.querySelector<HTMLElement>('[data-fluid-arrival-body],.things-task-split,.fluid-task-feature-history,.feature-workflow-split,.knowledge-connections-split,.sharing-workspace-split');
     const regions=[relative(header,bounds,.65)];
     if(nav&&content){regions.push(relative(nav,bounds,.65),relative(content,bounds,2));}
     else regions.push(relative(content??body,bounds,content?2:.65));
     measured={width:bounds.width,height:bounds.height,regions};
     const background=relative(body,bounds,.65);for(const [name,value] of Object.entries({x:background.left,y:background.top,width:background.width,height:background.height,rx:31}))backing.setAttribute(name,String(value));
     observe(dialog!);observe(header);observe(body);if(nav)observe(nav);if(content)observe(content);
     const directTask=workLayerUsesDirectTaskSplit(dialog!.classList.contains('fluid-work-layer-things'),Boolean(content?.matches('.things-task-split[data-split-open="true"]')));
     dialog!.dataset.fluidArrivalMode=directTask?'direct-task-split':'surfaces';
     if(directTask){wasOpen=true;finish();return;}
     if(!wasOpen){
       wasOpen=true;motion={position:0,velocity:0};
       if(preference.matches||document.hidden){finish();return;}
       running=true;dialog!.dataset.fluidArrivalActive='true';dialog!.dataset.fluidArrivalState='separating';svg.style.display='block';lastTime=performance.now();
       if(!frame)frame=requestAnimationFrame(animate);
     }
     if(running)paint();
   }
   const mutation=new MutationObserver(records=>{if(records.some(record=>record.target===dialog||record.attributeName==='data-split-open'&&(record.target as Element).matches('.things-task-split')))measure();});mutation.observe(dialog,{attributes:true,subtree:true,attributeFilter:['open','class','data-split-open']});
   const preferenceChanged=()=>{if(preference.matches)finish();},visibilityChanged=()=>{if(document.hidden&&running)finish();};
   const interact=(event:PointerEvent)=>{if(running&&event.target instanceof Element&&event.target.closest('button,input,select,textarea,summary,a[href]'))finish();};
   const keyboard=(event:KeyboardEvent)=>{
     if(!running||!(event.target instanceof Element)||['Tab','Shift','Control','Alt','Meta','CapsLock'].includes(event.key))return;
     if(event.target.closest('button,input,select,textarea,summary,a[href],[role=option],[role=tab],[role=listbox]'))finish();
   };
   preference.addEventListener('change',preferenceChanged);document.addEventListener('visibilitychange',visibilityChanged);dialog.addEventListener('pointerdown',interact,{passive:true});dialog.addEventListener('keydown',keyboard,true);measure();
   return()=>{disposed=true;if(frame)cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();preference.removeEventListener('change',preferenceChanged);document.removeEventListener('visibilitychange',visibilityChanged);dialog.removeEventListener('pointerdown',interact);dialog.removeEventListener('keydown',keyboard,true);delete dialog.dataset.fluidArrivalActive;delete dialog.dataset.fluidArrivalState;delete dialog.dataset.fluidArrivalProgress;delete dialog.dataset.fluidArrivalParts;delete dialog.dataset.fluidArrivalMode;};
 },[dialog,open]);
 return <><span ref={anchor} data-fluid-arrival-anchor hidden aria-hidden="true"/>{dialog?createPortal(<svg ref={canvas} className="fluid-work-layer-arrival" aria-hidden="true" preserveAspectRatio="none" style={{display:'none'}}>
   <defs><linearGradient id={gradient} x1="0" y1="0" x2=".65" y2="1"><stop offset="0" stopColor="var(--fluid-menu-glint,#ffffffa0)"/><stop offset=".34" stopColor="var(--fluid-menu-edge,#52687625)"/><stop offset=".74" stopColor="transparent"/><stop offset="1" stopColor="var(--fluid-rim-shade,#293e4a35)"/></linearGradient></defs>
   <rect ref={stage} className="fluid-arrival-stage"/>
   <path ref={shape} className="fluid-arrival-fill"/>
   <path ref={rim} className="fluid-arrival-rim" fill="none" stroke={`url(#${gradient})`}/>
 </svg>,dialog):null}</>;
}
