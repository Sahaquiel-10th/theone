import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,ArrowUpRight} from 'lucide-react';
import type {PracticeView} from '../server/onboardingPractice';
import {api} from './oneApi';
import {OneEye} from './OneEye';
import {practiceRoundDone,practiceRoundPending,practiceWebDone} from './practiceOnboardingState';

export function practiceResumeCopy(view:PracticeView){
  const p=view.practice;
  if(!p)return '接着挑一份资料，和 ONE 做成一件事。';
  if(p.completedAt)return '这次体验已经记录，回来收个尾就好。';
  if(practiceWebDone(p))return '网页做好了，打开看看，再回顾这次体验。';
  if(p.web){
    if(p.web.state==='queued')return '网页任务已经接到，刚才的正文已经保留。';
    if(p.web.state==='prepared')return '网页任务等你确认，打开任务继续。';
    if(p.web.state==='running')return '网页正在制作，刚才的正文已经保留。';
    return '网页这次还没做完，先核对已有结果。';
  }
  if(practiceRoundDone(p.first))return '正文做好了，接着把这份成果变成网页。';
  const goal=p.goal==='article'?'文章':'方案';
  if(p.first.state==='queued')return `${goal}任务已经接到，你可以继续聊。`;
  if(p.first.state==='prepared')return `${goal}任务等你确认，打开任务继续。`;
  if(p.first.state==='running')return `${goal}在独立处理，你可以继续聊。`;
  return p.first.outcome==='needs_input'?'这件事还需要你补充一点信息。':'这件事还没做完，原要求和已有内容都在。';
}
type PracticeResumeProps={
  request?:typeof api;
  onResume:()=>void;
  onOpenTask?:(id:string)=>void;
  refreshKey?:string|number;
  initialView?:PracticeView;
};
/** The parent renders this only for a hidden, unfinished experience-five journey.
 * It reads receipts, never submits tasks or automatically opens a surface. */
export function PracticeResume({request=api,onResume,onOpenTask,refreshKey,initialView}:PracticeResumeProps){
  const [view,setView]=useState<PracticeView|undefined>(initialView),[error,setError]=useState(false);
  const live=useRef(false),loading=useRef<{request:typeof api;revision:number}|undefined>(undefined),revision=useRef(0);
  const refresh=useCallback(async()=>{
    if(loading.current?.request===request)return;const current=++revision.current;loading.current={request,revision:current};
    try{const next=await request<PracticeView>('/api/me/onboarding-practice');if(live.current&&current===revision.current){setView(next);setError(false);}}
    catch{if(live.current&&current===revision.current)setError(true);}
    finally{if(loading.current?.revision===current)loading.current=undefined;}
  },[request]);
  useEffect(()=>{live.current=true;void refresh();const focus=()=>void refresh();window.addEventListener('focus',focus);return()=>{live.current=false;revision.current++;loading.current=undefined;window.removeEventListener('focus',focus);};},[refresh]);
  useEffect(()=>{if(refreshKey!==undefined)void refresh();},[refreshKey,refresh]);
  const p=view?.practice,round=p?.web??p?.first,pending=practiceRoundPending(round);
  useEffect(()=>{if(!pending)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},6000);return()=>clearInterval(timer);},[pending,refresh]);
  const text=error?'体验进度暂时没连上，已有任务会保留。':view?practiceResumeCopy(view):'正在核对刚才体验的进度…';
  return <aside className="practice-resume" aria-label="继续新手体验"><span className="practice-resume-eye"><OneEye size="xs" mood={pending?'thinking':practiceWebDone(p)?'pleased':'idle'} decorative/></span><div className="practice-resume-copy"><strong>刚才那件事，还在这里</strong><p role="status">{text}</p></div><div className="practice-resume-actions">{round?.taskId&&onOpenTask?<button type="button" className="practice-resume-task" onClick={()=>onOpenTask(round.taskId)}>查看任务<ArrowUpRight size={13}/></button>:null}<button type="button" className="practice-resume-continue" onClick={onResume}>继续体验<ArrowRight size={14}/></button></div></aside>;
}
