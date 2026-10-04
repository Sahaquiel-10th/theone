type Bounds = {left:number;top:number;width:number;height:number};
type Journey = {departure:(Keyframe&{transform:string})[];arrival:(Keyframe&{transform:string})[]};
export function edgeJourney(before:Bounds,after:Bounds,viewport:number,forced=false):Journey|null{
 if(!forced&&(viewport<1000||Math.abs(before.left-after.left)<viewport*.4))return null;
 const exitLeft=before.left<after.left;
 const oldX=before.left-after.left;
 const exitX=exitLeft?-before.width-after.left:viewport+before.width-after.left;
 const entranceX=exitLeft?viewport-after.left:-after.width-after.left;
 const peekX=exitLeft?viewport-after.left-after.width*.3:-after.left-after.width*.7;
 return {
  departure:[{transform:`translate(${oldX}px, ${before.top-after.top}px) scale(1.04,.94)`,opacity:1},{transform:`translate(${exitX}px, ${before.top-after.top}px) scale(1.16,.82)`,opacity:0}],
  arrival:[
   {transform:`translateX(${entranceX}px) rotate(${exitLeft?-16:16}deg)`,opacity:0,offset:0},
   {transform:`translateX(${peekX}px) rotate(${exitLeft?-12:12}deg) scale(.95,1.05)`,opacity:1,offset:.2},
   {transform:`translateX(${peekX}px) rotate(${exitLeft?-12:12}deg) scale(.95,1.05)`,opacity:1,offset:.36},
   {transform:`translateX(${entranceX*.97}px) rotate(0deg)`,opacity:.5,offset:.45},
   {transform:`translateX(${peekX}px) rotate(${exitLeft?9:-9}deg) scale(1.08,.9)`,opacity:1,offset:.56},
   {transform:`translateX(${peekX}px) rotate(${exitLeft?9:-9}deg) scale(1.08,.9)`,opacity:1,offset:.7,easing:'cubic-bezier(.65,0,.2,1)'},
   {transform:'translateX(0px) scale(1.13,.86)',opacity:1,offset:.91},
   {transform:'translateX(0px) rotate(0deg)',opacity:1,offset:1}
  ]
 };
}
export type EyeRoute = 'direct' | 'edge' | 'overhead';
/** Opening the adjacent shelf moves the conversation itself, not ONE to another work area. */
export function isConversationShelfMove(from:string,to:string,home=false):boolean {
 return !home&&((from==='chat'&&to==='features')||(from==='features'&&to==='chat'));
}
export function eyeDistance(a:Bounds,b:Bounds):number {
 return Math.hypot(a.left+a.width/2-b.left-b.width/2,a.top+a.height/2-b.top-b.height/2);
}
/** Every entry point uses the same measured home → settings limit. */
export function resolveEyeRoute(preferred:EyeRoute,before:Bounds,after:Bounds,limit:number,viewport:number):EyeRoute {
 if(preferred!=='direct')return preferred;
 if(eyeDistance(before,after)<=limit+.5)return 'direct';
 const a=before.left+before.width/2,b=after.left+after.width/2;
 return Math.min(a,b)<viewport*.3&&Math.max(a,b)>viewport*.6?'edge':'overhead';
}
/** A hidden UI-only probe follows responsive layout, without cloning any task conversations. */
export function homeSettingsDistance(root:HTMLElement):number|null {
 const presence=root.querySelector('.studio-assistant .studio-presence');
 if(!presence)return null;
 const probe=root.cloneNode(false) as HTMLElement;
 probe.classList.remove('studio-open','studio-idle','studio-things','studio-discover','studio-focused','execution-shell','coordinator-preview','coordinator-task-open','coordinator-tools-open');
 probe.classList.add('studio-idle');
 Object.assign(probe.style,{position:'fixed',inset:'0',visibility:'hidden',pointerEvents:'none',viewTransitionName:'none'});
 probe.setAttribute('aria-hidden','true');probe.inert=true;
 const chrome=document.createElement('header');chrome.className='one-chrome';
 const layout=document.createElement('div');layout.className='studio-layout';
 const surface=document.createElement('section');surface.className='studio-surface';surface.hidden=true;
 const assistant=document.createElement('aside');assistant.className='studio-assistant';
 const marker=document.createElement('div');marker.className='studio-presence';
 const eye=document.createElement('span');eye.className='one-presence';eye.style.viewTransitionName='none';
 marker.append(eye);assistant.append(marker);layout.append(surface,assistant);probe.append(chrome,layout);
 root.parentElement?.append(probe);
 try {
  const home=eye.getBoundingClientRect();
  probe.classList.replace('studio-idle','studio-open');surface.hidden=false;
  const copy=document.createElement('div');copy.className='studio-presence-copy';
  const heading=document.createElement('h2');heading.textContent='我在。';copy.append(heading);marker.append(copy);
  const composer=root.querySelector('.studio-assistant .studio-composer')?.cloneNode(true) as HTMLElement|undefined;
  // Keep the input's footprint on stacked layouts. Do not load cloned attachment images.
  if(composer){
   composer.querySelectorAll('img,video,audio,iframe').forEach(element=>element.remove());
   composer.querySelectorAll('[id]').forEach(element=>element.removeAttribute('id'));
   composer.querySelectorAll('input,textarea').forEach(element=>(element as HTMLInputElement).value='');
   assistant.append(composer);
  }
  const receipt=document.createElement('div');receipt.className='attention-receipt-slot';assistant.append(receipt);
  const footer=document.createElement('footer');footer.className='studio-assistant-footer';assistant.append(footer);
  const settings=eye.getBoundingClientRect();
  return home.width&&settings.width?eyeDistance(home,settings):null;
 } finally {probe.remove();}
}
/** Page identity decides special routes; distance thresholds must never override them. */
export function eyeRoute(from:string,to:string,home=false):EyeRoute {
 if((from==='features'&&to==='account')||(from==='account'&&to==='features'))return 'edge';
 if(home&&to==='features')return 'overhead';
 return 'direct';
}
export function overheadJourney(before:Bounds,after:Bounds):Journey{
 const x=before.left-after.left,y=before.top-after.top;
 const lean=before.left<after.left?1:-1;
 const top=-after.top-after.height;
 return {
  departure:[
   {transform:`translate(${x}px,${y}px)`,opacity:1,offset:0},
   {transform:`translate(${x-lean*4}px,${y+4}px) scale(1.05,.94)`,opacity:1,offset:.22,easing:'cubic-bezier(.45,0,.7,1)'},
   {transform:`translate(${x+lean*12}px,${-after.top-before.height*.35}px) rotate(${lean*5}deg) scale(.96,1.04)`,opacity:1,offset:.85},
   {transform:`translate(${x+lean*18}px,${-after.top-before.height}px) rotate(${lean*5}deg)`,opacity:0,offset:1}
  ],
  arrival:[
   {transform:`translate(10px,${top}px) rotate(-7deg)`,opacity:0,offset:0},
   {transform:`translate(5px,${-after.top-after.height*.65}px) rotate(-7deg) scale(1.02,.98)`,opacity:1,offset:.23},
   {transform:`translate(5px,${-after.top-after.height*.65}px) rotate(-4deg)`,opacity:1,offset:.4,easing:'cubic-bezier(.35,0,.25,1)'},
   {transform:'translate(0px,3px) scale(1.04,.96)',opacity:1,offset:.87},
   {transform:'translate(0px,0px) scale(1,1)',opacity:1,offset:1}
  ]
 };
}
/** Ordinary routes never take the screen-edge shortcut. The target itself is already laid out. */
export function directJourney(before:Bounds,after:Bounds,pause=false):Keyframe[]{
 const frame=(x:number,y:number,width:number,height:number,offset:number)=>({transform:`translate(${x}px, ${y}px)`,width:`${width}px`,height:`${height}px`,offset,easing:'cubic-bezier(.4,0,.2,1)'});
 const first=frame(before.left,before.top,before.width,before.height,0);
 const last=frame(after.left,after.top,after.width,after.height,1);
 if(!pause)return [first,{...first,offset:.12},last];
 const middle=frame(before.left+(after.left-before.left)*.56,before.top+(after.top-before.top)*.56,(before.width+after.width)/2,(before.height+after.height)/2,.45);
 return [first,middle,{...middle,offset:.62},last];
}
