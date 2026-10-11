import {directJourney, edgeJourney, overheadJourney, type EyeRoute} from './oneEdgeMotion';

/** Animate only a decorative clone. Live navigation never waits for an overlay. */
export function createEyeMotion() {
  let ghost: HTMLElement | null = null;
  let target: HTMLElement | null = null;
  let animations: Animation[] = [];
  const clear = () => {
    animations.forEach(animation => animation.cancel()); animations = [];
    ghost?.remove(); ghost = null;
    if (target) target.style.removeProperty('opacity');
    target = null;
  };
  return {
    clear,
    move(update: () => void, route: EyeRoute, duration: number) {
      const visible = () => Array.from(document.querySelectorAll<HTMLElement>('.studio-presence > .one-presence')).find(element => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
      });
      const before = (ghost || visible())?.getBoundingClientRect();
      const interrupted = Boolean(ghost);
      clear();
      update();
      const next = visible(), after = next?.getBoundingClientRect();
      if (!next || !before || !after || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !next.animate) return;
      if (Math.hypot(before.left-after.left, before.top-after.top) < 12) return;
      const node = next.cloneNode(true) as HTMLElement;
      node.removeAttribute('id'); node.querySelectorAll('[id]').forEach(element=>element.removeAttribute('id'));
      node.setAttribute('aria-hidden', 'true'); node.inert = true;
      Object.assign(node.style, {position:'fixed', left:'0px', top:'0px', margin:'0', pointerEvents:'none', zIndex:'100', opacity:'1', viewTransitionName:'none'});
      next.closest('.one-studio')?.append(node);
      ghost = node; target = next; next.style.opacity = '0';
      // A second click redirects from the actual current position, not an old endpoint.
      const journey = !interrupted && route === 'edge' ? edgeJourney(before, after, window.innerWidth, true)
        : !interrupted && route === 'overhead' ? overheadJourney(before, after) : null;
      if (journey) {
        Object.assign(node.style, {left:`${after.left}px`,top:`${after.top}px`,width:`${after.width}px`,height:`${after.height}px`});
        animations = [node.animate([...journey.departure, ...journey.arrival].map(({offset: _offset, ...frame})=>frame), {duration:850,fill:'both',easing:'ease-in-out'})];
      } else animations = [node.animate(directJourney(before, after), {duration,fill:'both'})];
      const last = animations[0];
      last.finished.then(() => {if (ghost === node) clear();}).catch(()=>{});
    }
  };
}
