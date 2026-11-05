import {useEffect,useRef,useState} from 'react';
import {RefreshCw,X} from 'lucide-react';
import type {TeachingCourse} from '../server/teachingTypes';
import type {TeachingCourseUsage} from '../server/teachingUsage';
import type {TeachingRequest} from './teachingUploads';
import './teaching-usage-dialog.css';
const format=(micros:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(micros/1e6);
export function TeachingUsageDialog({course,request,onClose}:{course:TeachingCourse;request:TeachingRequest;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),live=useRef(true);
 const [usage,setUsage]=useState<TeachingCourseUsage>(),[loading,setLoading]=useState(true),[error,setError]=useState('');
 async function load(){setLoading(true);setError('');try{const result=await request<{usage:TeachingCourseUsage}>(`/api/teaching/courses/${encodeURIComponent(course.id)}/usage`);if(live.current)setUsage(result.usage);}catch(error){if(live.current)setError(error instanceof Error?error.message:'暂时未能读取用量。');}finally{if(live.current)setLoading(false);}}
 useEffect(()=>{live.current=true;const element=dialog.current;element?.showModal();void load();return()=>{live.current=false;element?.close();};},[request,course.id]);
 return <dialog ref={dialog} className="teaching-usage-dialog" aria-labelledby="teaching-usage-title" onCancel={event=>{event.preventDefault();onClose();}}><header><div><h2 id="teaching-usage-title">课程 AI 用量</h2><p>{course.title}</p></div><button type="button" autoFocus aria-label="关闭课程 AI 用量" onClick={onClose}><X size={20}/></button></header><dl className="teaching-usage-metrics"><div><dt>累计已用电力</dt><dd>{usage?format(usage.spentMicros):'—'}</dd></div><div><dt>进行中预留</dt><dd>{usage?format(usage.reservedMicros):'—'}</dd></div></dl>{loading?<p role="status">正在读取用量…</p>:null}{error?<p role="alert">{error}</p>:null}<footer><button type="button" disabled={loading} onClick={()=>void load()}><RefreshCw size={16}/>刷新用量</button><button type="button" onClick={onClose}>关闭</button></footer></dialog>;
}
