import {useEffect,useState} from 'react';
import {Loader2} from 'lucide-react';
export function ResponseProgress({phase,startedAt,onStop}:{phase?:string;startedAt?:string;onStop?:()=>Promise<void>}) {
 const [now,setNow]=useState(Date.now()),[stopping,setStopping]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const seconds=startedAt?Math.max(0,Math.floor((now-Date.parse(startedAt))/1000)):0;
 return <div className="response-progress" role="status" aria-live="off"><Loader2 size={15} className="task-transfer-spinner" aria-hidden="true"/><div><strong>{phase||'正在处理你的要求'}</strong><small>{Number.isFinite(seconds)?`已等待 ${seconds} 秒`:'等待结果'}{seconds>=30?' · 仍在等待，暂未取得最终结果':''}</small>{error?<small role="alert">{error}</small>:null}</div>{onStop?<button type="button" disabled={stopping} onClick={()=>{setStopping(true);void onStop().catch(e=>{setError(e instanceof Error?e.message:'停止未确认，请检查连接');setStopping(false);});}}>{stopping?'正在请求停止':'停止回复'}</button>:null}</div>;
}
