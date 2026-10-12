import {useEffect,useState} from 'react';
import {Loader2} from 'lucide-react';
import {OneWaitingCopy} from './OnePersonality';
export function ResponseProgress({phase,startedAt,onStop}:{phase?:string;startedAt?:string;onStop?:()=>Promise<void>}) {
 const [now,setNow]=useState(Date.now()),[stopping,setStopping]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const seconds=startedAt?Math.max(0,Math.floor((now-Date.parse(startedAt))/1000)):0;
 return <div className="response-progress response-progress-live" role="status" aria-live="off"><div className="response-progress-heading"><Loader2 size={15} className="task-transfer-spinner" aria-hidden="true"/><strong>{phase||'正在理解你的要求'}</strong>{onStop?<button type="button" disabled={stopping} onClick={()=>{setStopping(true);void onStop().catch(e=>{setError(e instanceof Error?e.message:'停止未确认，请检查连接');setStopping(false);});}}>{stopping?'正在请求停止':'停止回复'}</button>:null}</div><div className="response-activity-track" aria-label="处理中，非实际完成百分比"><span/></div><OneWaitingCopy compact/>{seconds>=45?<small className="response-slow-notice">这次处理稍久，结果会直接显示在这里；你可以随时停止。</small>:null}{error?<small role="alert">{error}</small>:null}</div>;
}
