import {useEffect,useState} from 'react';
import {Check,Loader2} from 'lucide-react';
import {responseElapsedSeconds,responseWaitLabel} from './responseProgressState';
import {friendlyResponsePhase} from './friendlyTaskStatus';

export function ResponseProgress({phase,startedAt,onStop,completed=false}:{phase?:string;startedAt?:string;onStop?:()=>Promise<void>;completed?:boolean}) {
 const [now,setNow]=useState(Date.now),[stopping,setStopping]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  if(completed||responseElapsedSeconds(startedAt,Date.now())===null)return;
  setNow(Date.now());
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[startedAt,completed]);
 const elapsed=responseWaitLabel(responseElapsedSeconds(startedAt,now));
 const stop=async()=>{
  if(!onStop||stopping)return;
  setError('');setStopping(true);
  try{await onStop();}
  catch{setError('尚未确认停止，请检查连接后重试。');setStopping(false);}
 };
 return <div className="response-progress response-progress-live" data-state={completed?'completed':stopping?'stopping':'waiting'}>
  <div className="response-progress-heading">
   {completed?<Check size={15} className="response-progress-icon" aria-hidden="true"/>:<Loader2 size={15} className="response-progress-icon task-transfer-spinner" aria-hidden="true"/>}
   <strong className="response-progress-stage" role="status" aria-live="polite" aria-atomic="true">{completed?'回复已返回':friendlyResponsePhase(phase)}</strong>
   {!completed&&elapsed?<span className="response-progress-elapsed" aria-live="off">{elapsed}</span>:null}
   {onStop&&!completed?<button type="button" className="response-progress-stop" disabled={stopping} aria-busy={stopping} onClick={()=>{void stop();}}>{stopping?'正在停止…':'停止回复'}</button>:null}
  </div>
  {!completed&&error?<p className="response-progress-error" role="alert">{error}</p>:null}
 </div>;
}
