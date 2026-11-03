import {Check,Loader2,AlertCircle,Clock3,Minus,ArrowUpRight} from 'lucide-react';
import {useFollowLatest} from './useFollowLatest';
import {taskWorkflowActivityView,type TaskWorkflowView} from './taskWorkflowView';

/** Passive, server-owned progress. A result action only opens the real task;
 * it cannot acknowledge a receipt or execute/retry any stage. */
export function TaskWorkflowActivity({taskId,workflow,onOpen}:{taskId:string;workflow?:TaskWorkflowView;onOpen:()=>void}){
 const view=taskWorkflowActivityView(workflow);
 const {scroll,onScroll,newMessages,showLatest}=useFollowLatest<HTMLUListElement>(taskId,Boolean(view),8);
 if(!view)return null;
 return <div className="task-workflow-activity">
  <ul ref={scroll} onScroll={onScroll} className="task-workflow-feed" aria-label="步骤进展" tabIndex={view.steps.length>3?0:undefined}>
   {view.steps.map(step=>{
    const working=step.recovering||step.state==='running'||step.state==='waiting';
    const detail=['needs_input','failed'].includes(step.state)&&step.summary?step.summary:step.label;
    const icon=step.state==='completed'?<Check size={14}/>:working?<Loader2 size={14} className="task-transfer-spinner"/>:step.state==='queued'?<Clock3 size={14}/>:step.state==='skipped'?<Minus size={14}/>:<AlertCircle size={14}/>;
    return <li key={step.id} data-step-state={step.state}>
     <span className="task-workflow-feed-icon" aria-hidden="true">{icon}</span>
     <span className="task-workflow-feed-copy"><span title={step.title}>{step.title}</span><small title={detail}>{detail}</small></span>
     {step.resultAvailable?<button type="button" onClick={onOpen} aria-label={`查看任务成果：${step.title}`} title="在任务中查看已有成果">查看 <ArrowUpRight size={11} aria-hidden="true"/></button>:null}
    </li>;
   })}
  </ul>
  {newMessages?<button type="button" className="task-workflow-latest" onClick={showLatest}>最新进展 ↓</button>:null}
 </div>;
}
