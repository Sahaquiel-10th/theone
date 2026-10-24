import {useEffect,useId,useRef} from 'react';
import {companionAperture,companionBlink} from '../oneEyeMotion';
import {advanceFluidLogo,fluidLogoNeedsFrame,fluidLogoTarget,restingLogoMotion} from './logoMotion';
import './fluid-companion-logo.css';

/** Decorative character only. Surface geometry owns position, migration and hits. */
export function FluidCompanionLogo() {
  const clipId=`fluid-logo-${useId().replace(/:/g,'')}`;
  const art=useRef<SVGSVGElement>(null),aperture=useRef<SVGPathElement>(null),pupil=useRef<SVGGElement>(null);

  useEffect(()=>{
    const logo=art.current,opening=aperture.current,iris=pupil.current;
    const scene=logo?.closest<HTMLElement>('[data-one-fluid-surface]');
    if(!logo||!opening||!iris||!scene)return;
    const reducedQuery=matchMedia('(prefers-reduced-motion: reduce)'),fineQuery=matchMedia('(hover: hover) and (pointer: fine)');
    let disposed=false,frame=0,lastTime=0,focused=false,pressed=false;
    let pointer:{x:number;y:number}|null=null,blinkAt:number|null=null,lastBlinkAt=-Infinity;
    let owner=scene.dataset.eyeOwner,stage=scene.dataset.eyeStage;
    let motion=restingLogoMotion(),target=fluidLogoTarget(NaN,NaN);

    const currentTrigger=(element:EventTarget|null)=>element instanceof Element
      ?element.closest<HTMLElement>(`[data-fluid-trigger="${scene.dataset.eyeOwner}"]`):null;
    function state(value:string){if(logo!.dataset.logoState!==value)logo!.dataset.logoState=value;}
    function render(blink=1) {
      opening!.setAttribute('d',companionAperture(motion.lid.position*blink,motion.warmth.position));
      iris!.setAttribute('transform',`translate(${motion.x.position.toFixed(3)} ${motion.y.position.toFixed(3)})`);
    }
    function wake(){if(!disposed&&!document.hidden&&!reducedQuery.matches&&!frame){lastTime=performance.now();frame=requestAnimationFrame(animate);}}
    function resolveTarget() {
      const available=stage==='rest'&&!document.hidden&&fineQuery.matches;
      // No layout reads at rest. Measure only on pointer, focus or migration events.
      const bounds=pointer&&available?logo!.getBoundingClientRect():null;
      target=fluidLogoTarget(bounds&&pointer?pointer.x-bounds.left-bounds.width/2:NaN,bounds&&pointer?pointer.y-bounds.top-bounds.height/2:NaN,{focused,pressed,reduced:reducedQuery.matches,available});
      state(stage!=='rest'?'migrating':pressed?'pressed':focused?'focused':target.shy?'shy':target.nearby?'watching':'resting');
      if(reducedQuery.matches){
        motion=restingLogoMotion();motion.lid.position=target.openness;motion.warmth.position=target.warmth;render();
      }else if(blinkAt!==null||fluidLogoNeedsFrame(motion,target))wake();
    }
    function animate(now:number) {
      frame=0;if(disposed||document.hidden||reducedQuery.matches)return;
      motion=advanceFluidLogo(motion,target,(now-lastTime)/1000);lastTime=now;
      const blink=blinkAt===null?1:companionBlink(now-blinkAt,false);
      if(blinkAt!==null&&now-blinkAt>=265)blinkAt=null;
      render(blink);
      if(blinkAt!==null||fluidLogoNeedsFrame(motion,target))frame=requestAnimationFrame(animate);
    }
    function follow(event:PointerEvent){if(event.pointerType!=='mouse'||!fineQuery.matches||reducedQuery.matches)return;pointer={x:event.clientX,y:event.clientY};resolveTarget();}
    function release(){pointer=null;pressed=false;resolveTarget();}
    function press(event:PointerEvent){
      if(!currentTrigger(event.target)||stage!=='rest')return;
      pressed=true;focused=false;
      const now=performance.now();
      // A click is acknowledged once. Passing over the logo never replays a greeting.
      if(!reducedQuery.matches&&now-lastBlinkAt>500){blinkAt=now;lastBlinkAt=now;}
      resolveTarget();
    }
    function lift(){if(pressed){pressed=false;resolveTarget();}}
    function focus(event:FocusEvent){const trigger=currentTrigger(event.target);focused=!!trigger?.matches(':focus-visible');resolveTarget();}
    function blur(){focused=false;resolveTarget();}
    function preferences(){if(frame)cancelAnimationFrame(frame);frame=0;blinkAt=null;pointer=null;motion=restingLogoMotion();resolveTarget();render();}
    function visibility(){
      if(document.hidden){if(frame)cancelAnimationFrame(frame);frame=0;blinkAt=null;pointer=null;pressed=false;motion=restingLogoMotion();render();}
      else resolveTarget();
    }
    // Geometry remains the authority; only react when its actual owner/stage changes.
    const observer=new MutationObserver(()=>{
      if(owner===scene.dataset.eyeOwner&&stage===scene.dataset.eyeStage)return;
      owner=scene.dataset.eyeOwner;stage=scene.dataset.eyeStage;focused=false;pressed=false;
      if(stage!=='rest'){blinkAt=null;pointer=null;motion=restingLogoMotion();render();}
      resolveTarget();
    });
    observer.observe(scene,{attributes:true,attributeFilter:['data-eye-owner','data-eye-stage']});
    window.addEventListener('pointermove',follow,{passive:true});
    window.addEventListener('pointerup',lift,{passive:true});
    window.addEventListener('pointercancel',release,{passive:true});
    window.addEventListener('blur',release);
    document.addEventListener('pointerleave',release);
    document.addEventListener('visibilitychange',visibility);
    scene.addEventListener('pointerdown',press,{passive:true});
    scene.addEventListener('focusin',focus);scene.addEventListener('focusout',blur);
    reducedQuery.addEventListener('change',preferences);fineQuery.addEventListener('change',preferences);
    resolveTarget();render();
    return ()=>{
      disposed=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();
      window.removeEventListener('pointermove',follow);window.removeEventListener('pointerup',lift);window.removeEventListener('pointercancel',release);window.removeEventListener('blur',release);
      document.removeEventListener('pointerleave',release);document.removeEventListener('visibilitychange',visibility);
      scene.removeEventListener('pointerdown',press);scene.removeEventListener('focusin',focus);scene.removeEventListener('focusout',blur);
      reducedQuery.removeEventListener('change',preferences);fineQuery.removeEventListener('change',preferences);
    };
  },[]);

  return <svg ref={art} className="one-fluid-logo one-fluid-character" viewBox="0 0 100 100" aria-hidden="true" data-logo-state="resting" style={{width:'100%',height:'100%'}}>
    <defs><clipPath id={clipId}><path ref={aperture} d={companionAperture(1)}/></clipPath></defs>
    <circle className="fluid-character-shell" cx="50" cy="50" r="50"/>
    <g clipPath={`url(#${clipId})`}>
      <rect className="fluid-character-white" x="10" y="9" width="80" height="82"/>
      <g ref={pupil}><path className="fluid-character-pupil" d="M53 26C49.3 40.2 47.9 57.7 48.9 75"/></g>
    </g>
  </svg>;
}
