import {useEffect,useRef,useState} from 'react';
import {Lightbulb,X} from 'lucide-react';
import type {Task} from './dispatchPreviewState';
export function ResultSignal({tasks,busy,ambient,onOpen,onDismiss}:{tasks:Task[];busy:boolean;ambient:boolean;onOpen:(id:string)=>void;onDismiss:()=>void}) {
 const [open,setOpen]=useState(false),[peek,setPeek]=useState(false),[flash,setFlash]=useState(false);
 const shown=useRef(new Set<string>());
 const key=tasks.map(task=>`${task.id}:${task.messages.filter(m=>m.role==='assistant').at(-1)?.id}`).join('|');
 useEffect(()=>{
  setOpen(false);
  if(busy||!key){setPeek(false);setFlash(false);return;}
  const rounds=key.split('|');
  if(rounds.every(round=>shown.current.has(round)))return;
  rounds.forEach(round=>shown.current.add(round));setPeek(true);setFlash(true);
  const pulse=setTimeout(()=>setFlash(false),1200),timer=setTimeout(()=>setPeek(false),6000);
  return()=>{clearTimeout(pulse);clearTimeout(timer);};
 },[key,busy]);
 if(!tasks.length)return null;
 return <div className={`one-result-signal ${flash?'is-lit':''}`}>
  <button type="button" className="result-signal-button" aria-label={`查看已完成任务 · ${tasks.length} 件`} aria-expanded={open} onClick={()=>{if(open)onDismiss();setOpen(!open);setPeek(false);}}><Lightbulb size={19}/>{tasks.length>1?<small>{tasks.length}</small>:null}</button>
  {ambient&&peek&&!busy&&!open?<button type="button" className="result-side-whisper" onClick={()=>{setOpen(true);setPeek(false);}}><Lightbulb size={14}/><span>{tasks.length===1?`${tasks[0].title}${tasks[0].status==='failed'?'需要看一下':'好了'}`:`${tasks.length} 件事有进展`}</span></button>:null}
  {open?<div className="result-signal-popover" aria-label="已完成的任务"><header><span>好了，随时来看</span><button type="button" aria-label="收起任务提醒" onClick={()=>{setOpen(false);onDismiss();}}><X size={12}/></button></header>{tasks.map(task=><button key={task.id} type="button" onClick={()=>{setOpen(false);onOpen(task.id);}}><Lightbulb size={13}/><span>{task.title}</span><span aria-hidden="true">↗</span></button>)}</div>:null}
 </div>;
}
