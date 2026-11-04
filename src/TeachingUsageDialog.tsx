import {useEffect,useRef,useState} from 'react';
import {RefreshCw,X} from 'lucide-react';
import type {TeachingCourse} from '../server/teachingTypes';
import type {TeachingCourseUsage} from '../server/teachingUsage';
import type {TeachingRequest} from './teachingUploads';
import './teaching-usage-dialog.css';

type Props={course:TeachingCourse;request:TeachingRequest;onSaved:(course:TeachingCourse)=>void;onConfirmed:()=>void;onClose:()=>void};
const format=(micros:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(micros/1e6);

/** A native modal keeps the teaching page stationary and contains keyboard focus. */
export function TeachingUsageDialog({course,request,onSaved,onConfirmed,onClose}:Props){
  const dialog=useRef<HTMLDialogElement>(null),live=useRef(true),locked=useRef(false),current=useRef(course);
  const [usage,setUsage]=useState<TeachingCourseUsage>(),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
  const [budget,setBudget]=useState(course.budgetMicros>0?String(course.budgetMicros/1e6):''),[confirmed,setConfirmed]=useState(false),[teacherMode,setTeacherMode]=useState<'course'|'balance'>(course.teacherBudgetMode??'course');
  const amount=Number(budget),valid=Number.isFinite(amount)&&amount>=(teacherMode==='balance'?0:0.01)&&amount<=1000;
  async function load(){setLoading(true);setReady(false);setError('');try{const [result,saved]=await Promise.all([request<{usage:TeachingCourseUsage}>(`/api/teaching/courses/${encodeURIComponent(course.id)}/usage`),request<{course:TeachingCourse}>(`/api/teaching/courses/${encodeURIComponent(course.id)}`)]);if(live.current){setUsage(result.usage);current.current=saved.course;onSaved(saved.course);setBudget(saved.course.budgetMicros>0?String(saved.course.budgetMicros/1e6):'');setTeacherMode(saved.course.teacherBudgetMode??'course');setConfirmed(false);setReady(true);}}catch(error){if(live.current)setError(error instanceof Error?error.message:'暂时未能读取用量。');}finally{if(live.current)setLoading(false);}}
  useEffect(()=>{live.current=true;const element=dialog.current;element?.showModal();void load();return()=>{live.current=false;element?.close();};},[request,course.id]);
  function finish(saved:TeachingCourse){current.current=saved;onSaved(saved);onConfirmed();onClose();}
  async function save(){if(locked.current||!ready||!valid||!confirmed)return;locked.current=true;setBusy(true);setError('');const budgetMicros=Math.round(amount*1e6);try{
    if(budgetMicros!==current.current.budgetMicros||teacherMode!==(current.current.teacherBudgetMode??'course')){const result=await request<{course:TeachingCourse}>(`/api/teaching/courses/${encodeURIComponent(course.id)}`,{method:'PATCH',body:JSON.stringify({revision:current.current.revision,budgetMicros,teacherBudgetMode:teacherMode})});if(live.current)finish(result.course);}
    else if(live.current)finish(current.current);
  }catch(error){if(live.current){try{
      const result=await request<{course:TeachingCourse}>(`/api/teaching/courses/${encodeURIComponent(course.id)}`);if(!live.current)return;
      if(result.course.budgetMicros===budgetMicros&&(result.course.teacherBudgetMode??'course')===teacherMode)finish(result.course);
      else {current.current=result.course;onSaved(result.course);setBudget(result.course.budgetMicros>0?String(result.course.budgetMicros/1e6):'');setTeacherMode(result.course.teacherBudgetMode??'course');setConfirmed(false);setError(`${error instanceof Error?error.message:'未完成本次保存。'} 已重新读取当前设置，请核对后再确认。`);}
    }catch{if(live.current){setReady(false);setError(error instanceof Error?error.message:'未能核对保存结果，请重试读取。');}}}
  }finally{locked.current=false;if(live.current)setBusy(false);}}
  return <dialog ref={dialog} className="teaching-usage-dialog" aria-labelledby="teaching-usage-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header><div><h2 id="teaching-usage-title">课程 AI 用量</h2><p>{course.title}</p></div><button type="button" autoFocus aria-label="关闭课程 AI 用量" disabled={busy} onClick={onClose}><X size={20}/></button></header>
    <dl className="teaching-usage-metrics"><div><dt>累计已用电力</dt><dd>{usage?format(usage.spentMicros):'—'}</dd></div><div><dt>进行中预留</dt><dd>{usage?format(usage.reservedMicros):'—'}</dd></div></dl>
    {loading?<p role="status">正在读取用量…</p>:null}
    {error?<div className="teaching-usage-error" role="alert"><span>{error}</span>{!ready?<button type="button" disabled={loading} onClick={()=>void load()}><RefreshCw size={16}/>重试读取</button>:null}</div>:null}
    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <label className="teaching-usage-limit">教师手动操作<select value={teacherMode} disabled={busy||!ready} onChange={event=>{setTeacherMode(event.target.value as 'course'|'balance');setConfirmed(false);}}><option value="balance">按账户余额结算</option><option value="course">受课程累计上限限制</option></select></label>
      <label className="teaching-usage-limit">课程累计保护上限（电力）<input type="number" min={teacherMode==='balance'?'0':'0.01'} max="1000" step="any" placeholder="0：暂不开放学生 AI" value={budget} disabled={busy||!ready} onChange={event=>{setBudget(event.target.value);setConfirmed(false);}}/></label>
      <p className="teaching-usage-note">学生入口始终受此累计上限保护。</p>
      {usage?<p className="teaching-usage-available">此上限内还可使用 <strong>{format(Math.max(0,(valid?Math.round(amount*1e6):0)-usage.spentMicros-usage.reservedMicros))}</strong> 电力</p>:null}
      <label className="teaching-check"><input type="checkbox" checked={confirmed} disabled={busy||!ready||!valid} onChange={event=>setConfirmed(event.target.checked)}/>确认由当前账号支付本课程 AI 费用</label>
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="teaching-primary" disabled={busy||!ready||!valid||!confirmed}>{busy?'正在保存…':Math.round(amount*1e6)===current.current.budgetMicros&&teacherMode===(current.current.teacherBudgetMode??'course')?'确认':'保存并确认'}</button></footer>
    </form>
  </dialog>;
}
