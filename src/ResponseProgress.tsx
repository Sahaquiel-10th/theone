import {useEffect,useRef,useState} from 'react';
import {Check,Square} from 'lucide-react';
import {responseElapsedSeconds,responseWaitLabel,compactResponseWait,waitingProgress} from './responseProgressState';
import {friendlyResponsePhase} from './friendlyTaskStatus';

export function ResponseProgress({phase,startedAt,onStop,completed=false}:{phase?:string;startedAt?:string;onStop?:()=>Promise<void>;completed?:boolean}) {
 const [now,setNow]=useState(Date.now),[stopping,setStopping]=useState(false),[error,setError]=useState('');
 const [mountedAt]=useState(Date.now);
 useEffect(()=>{
  if(completed)return;
  setNow(Date.now());
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[startedAt,completed]);
 const seconds=responseElapsedSeconds(startedAt,now);
 const elapsed=responseWaitLabel(seconds),compactElapsed=compactResponseWait(seconds);
 const fill=completed?1:waitingProgress(seconds===null?now-mountedAt:seconds*1000);
 const visibleFill=useRef(fill);
 const trackRef=useRef<HTMLDivElement>(null),fillRef=useRef<HTMLSpanElement>(null);
 if(!stopping||completed)visibleFill.current=fill;
 const stop=async()=>{
  if(!onStop||stopping)return;
  const trackWidth=trackRef.current?.getBoundingClientRect().width??0;
  const fillWidth=fillRef.current?.getBoundingClientRect().width;
  // Hold the rendered position, including an in-flight width transition.
  if(trackWidth>0&&fillWidth!==undefined)visibleFill.current=Math.min(1,Math.max(0,fillWidth/trackWidth));
  setError('');setStopping(true);
  try{await onStop();}
  catch{setError('尚未确认停止，请检查连接后重试。');setStopping(false);}
 };
 return <div className="response-progress response-progress-live" data-state={completed?'completed':stopping?'stopping':'waiting'}>
  <div className="response-progress-heading">
   <strong className="response-progress-stage" role="status" aria-live="polite" aria-atomic="true">{completed?<Check size={14} aria-hidden="true"/>:null}{completed?'回复已返回':stopping?'正在停止回复':friendlyResponsePhase(phase)}</strong>
   {!completed&&compactElapsed?<span className="response-progress-elapsed" aria-label={elapsed} title={elapsed} aria-live="off">{compactElapsed}</span>:null}
   {onStop&&!completed?<button type="button" className="response-progress-stop" aria-label="停止回复" title="停止本次回复" disabled={stopping} aria-busy={stopping} onClick={()=>{void stop();}}><Square size={11} aria-hidden="true"/>停止</button>:null}
  </div>
  <div className="response-wait-track" ref={trackRef} aria-hidden="true"><span className="response-wait-fill" ref={fillRef} style={{width:`${(visibleFill.current*100).toFixed(3)}%`}}/></div>
  {!completed&&error?<p className="response-progress-error" role="alert">{error}</p>:null}
 </div>;
}
