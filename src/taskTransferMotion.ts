export type NoteRect = Pick<DOMRect, 'left'|'top'|'width'|'height'>;
export type NoteFlightDirection = 'depart'|'return';

/** Both ends are measured on this screen; no assumed sidebar or conversation coordinates. */
export function noteFlightFrames(from:NoteRect,to:NoteRect,base:NoteRect,direction:NoteFlightDirection) {
  const centre=(rect:NoteRect)=>({x:rect.left+rect.width/2,y:rect.top+rect.height/2});
  const start=centre(from),end=centre(to),origin=centre(base);
  const dx=start.x-origin.x,dy=start.y-origin.y,ex=end.x-origin.x,ey=end.y-origin.y;
  const arc=Math.min(58,Math.hypot(ex-dx,ey-dy)*.1);
  return [
    {transform:`translate3d(${dx}px, ${dy}px, 0) rotate(${direction==='depart'?-3:0}deg) scale(.94)`,opacity:direction==='depart'?.35:1,offset:0},
    {transform:`translate3d(${(dx+ex)/2}px, ${(dy+ey)/2-arc}px, 0) rotate(${direction==='depart'?2:-2}deg) scale(1)`,opacity:1,offset:.5},
    {transform:`translate3d(${ex}px, ${ey}px, 0) rotate(0deg) scale(${direction==='return'?'.86':'1'})`,opacity:direction==='return'?0:1,offset:1},
  ];
}

/** Decorative clones cannot intercept clicks, enter keyboard navigation, or focus input. */
export function flyTaskNote(node:HTMLElement,from:NoteRect,to:NoteRect,direction:NoteFlightDirection,onFinish:()=>void,delay=0):()=>void {
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(reduced||!node.animate||!from.width||!from.height||!to.width||!to.height){queueMicrotask(onFinish);return()=>{};}
  const base=direction==='depart'?to:from;
  const ghost=node.cloneNode(true) as HTMLElement;
  ghost.classList.add('task-transfer-flight');ghost.classList.remove('is-departing','is-returning');
  ghost.dataset.taskFlight=direction;ghost.removeAttribute('id');ghost.setAttribute('aria-hidden','true');ghost.setAttribute('tabindex','-1');ghost.inert=true;
  for(const child of ghost.querySelectorAll('[id]'))child.removeAttribute('id');
  const style=getComputedStyle(node);
  Object.assign(ghost.style,{position:'fixed',left:`${base.left}px`,top:`${base.top}px`,width:`${base.width}px`,height:`${base.height}px`,margin:'0',pointerEvents:'none',zIndex:'40',backgroundColor:style.backgroundColor,color:style.color,borderColor:style.borderColor,font:style.font,opacity:'1'});
  (node.closest('.one-studio')||document.body).append(ghost);
  const animation=ghost.animate(noteFlightFrames(from,to,base,direction),{duration:direction==='return'?860:800,delay,easing:'cubic-bezier(.2,.62,.24,1)',fill:'both'});
  let done=false;
  const finish=()=>{if(done)return;done=true;ghost.remove();onFinish();};
  void animation.finished.then(finish,finish);
  return()=>{animation.cancel();finish();};
}
