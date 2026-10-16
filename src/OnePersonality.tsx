import {useEffect,useState} from 'react';
import {moreGreetings,moreWaiting,greetingEggs,waitingEggs} from './onePersonalityCopy';
export const greetings=['我在。','嗯，听着呢。','没睡。你说。','今天从哪件事开始？','说吧，闲聊也行。','先放这儿，一起想。','不急，一件件来。','想好开头了吗？没想好也行。','嗯，又见面了。','你说，我听着。'];
export const waitingLines=['让我捋一捋。','在呢，没溜。','嗯，还在想。','(¬_¬) 表情没变，脑子在转。','先想清楚，再开口。','我还在这儿。','换个角度想想。','先把思路理顺。','这句让我想想。','没睡，在等回复。'];
export function chooseCopy(lines:readonly string[],previous=-1,random=Math.random){const value=Math.floor(random()*(lines.length-(previous>=0?1:0)));return value>=previous&&previous>=0?value+1:value;}
greetings.push(...moreGreetings);waitingLines.push(...moreWaiting);
const greetingHistory:string[]=[],waitingHistory:string[]=[];
export function pickPersonality(lines:readonly string[],eggs:readonly string[],history:string[],random=Math.random){
 const pool=history.length>=4&&random()<.035?eggs:lines;
 const options=pool.filter(s=>!history.includes(s));const choices=options.length?options:pool;
 const next=choices[Math.floor(random()*choices.length)];history.push(next);if(history.length>12)history.shift();return next;
}
export function useOneGreeting(context=''){const [copy,setCopy]=useState(()=>pickPersonality(greetings,greetingEggs,greetingHistory));useEffect(()=>setCopy(pickPersonality(greetings,greetingEggs,greetingHistory)),[context]);return copy;}
export function OneWaitingCopy({compact=false}:{compact?:boolean}={}){
  const [copy,setCopy]=useState(()=>pickPersonality(waitingLines,waitingEggs,waitingHistory)),[slow,setSlow]=useState(false);
  useEffect(()=>{
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const slowTimer=setTimeout(()=>setSlow(true),25000);
    let timer:ReturnType<typeof setTimeout>;let live=true;
    function schedule(){if(reduced)return;timer=setTimeout(()=>{if(document.visibilityState==='visible')setCopy(pickPersonality(waitingLines,waitingEggs,waitingHistory));if(live)schedule();},9000+Math.random()*9000);}schedule();return()=>{live=false;clearTimeout(timer);clearTimeout(slowTimer);};
  },[]);
  return <div className={`studio-wait one-waiting-copy ${compact?'is-compact':''}`} role="status" aria-label="正在准备当前事情的回复" aria-live="off">{!compact?<span className="paper-wait-eye" aria-hidden="true">◉</span>:null}<div>{!compact?<small>{slow?'这次等待稍久，结果会显示在这里':'ONE · 正在准备回复'}</small>:null}<p key={copy}>{copy}</p></div></div>;
}
