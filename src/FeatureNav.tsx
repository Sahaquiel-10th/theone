import {useEffect,useState} from 'react';
export function FeatureNav({quiet,active,onClick}:{quiet:boolean;active:boolean;onClick:()=>void}){
 const [peek,setPeek]=useState(false);
 useEffect(()=>{setPeek(false);if(quiet)return;const media=matchMedia('(prefers-reduced-motion: reduce)');let timer:ReturnType<typeof setTimeout>;let disposed=false;
  function schedule(){if(disposed||media.matches)return;timer=setTimeout(()=>{if(!document.hidden)setPeek(true);timer=setTimeout(()=>{setPeek(false);schedule();},3400);},14000+Math.random()*22000);}
  function reset(){clearTimeout(timer);setPeek(false);if(!document.hidden)schedule();}media.addEventListener('change',reset);document.addEventListener('visibilitychange',reset);schedule();
  return()=>{disposed=true;clearTimeout(timer);media.removeEventListener('change',reset);document.removeEventListener('visibilitychange',reset);};
 },[quiet]);
 return <button type="button" className={`feature-nav ${quiet?'is-quiet':''} ${peek?'is-peeking':''}`} aria-current={active?'page':undefined} onClick={onClick}><span>功能</span><span className="nav-peek-clip" aria-hidden="true"><svg className="nav-peek-eye" viewBox="0 0 40 40"><rect x="2" y="2" width="36" height="36" rx="11" fill="currentColor"/><ellipse className="nav-peek-white" cx="20" cy="20" rx="13" ry="14" fill="#fffefa"/><path className="nav-peek-pupil" d="M22 11Q19 20 20 29" stroke="#292b25" strokeWidth="2.7" fill="none" strokeLinecap="round"/></svg></span></button>;
}
