import {useEffect,useState} from 'react';
import {Loader2} from 'lucide-react';
import {OneWaitingCopy} from './OnePersonality';
import {waitingProgress} from './responseProgressState';
import {friendlyResponsePhase} from './friendlyTaskStatus';
export function ResponseProgress({phase,startedAt,onStop,completed=false}:{phase?:string;startedAt?:string;onStop?:()=>Promise<void>;completed?:boolean}) {
 const [began]=useState(Date.now()),[fill,setFill]=useState(3);
 const [now,setNow]=useState(Date.now()),[stopping,setStopping]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const seconds=startedAt?Math.max(0,Math.floor((now-Date.parse(startedAt))/1000)):0;
 useEffect(()=>{if(completed){setFill(100);return;}const timer=setInterval(()=>setFill(old=>waitingProgress(Date.now()-(startedAt?Date.parse(startedAt):began),old)),400);return()=>clearInterval(timer);},[startedAt,began,completed]);
return <div className="response-progress response-progress-live" role="status" aria-live="off">
  <div className="response-progress-heading"><Loader2 size={15} className="task-transfer-spinner" aria-hidden="true"/><strong>{completed?'回复回来了':friendlyResponsePhase(phase)}</strong>{onStop&&!completed?<button type="button" disabled={stopping} onClick={()=>{setStopping(true);void onStop().catch(e=>{setError(e instanceof Error?e.message:'还没确认停下来，请检查连接');setStopping(false);});}}>{stopping?'正在让它停下来':'停止回复'}</button>:null}</div>
  <div className="response-activity-track" aria-label="等待进度示意，非实际完成比例"><span style={{width:`${fill}%`}}/></div><OneWaitingCopy compact/>
  {seconds>=45?<small className="response-slow-notice">这次想得久一点，结果会直接放在这里；你随时可以停。</small>:null}{error?<small role="alert">{error}</small>:null}
</div>;
}
