import {taskWorkflowView,type TaskWorkflowView} from './taskWorkflowView';

/** Native disclosure retains its open/closed state as refreshed props arrive.
 * This view has no API, acknowledgement, retry or per-step start action. */
export function TaskWorkflowProgress({workflow}:{workflow?:TaskWorkflowView}){
 const view=taskWorkflowView(workflow);
 if(!view)return null;
 return <details className="execution-step-history task-workflow" aria-label="任务处理步骤">
  <summary style={{fontSize:'inherit',color:'inherit'}}><strong>处理步骤</strong><span role="status"> · 已完成 {view.completed}/{view.total}{view.current?` · ${view.current}`:''}</span></summary>
  <ol style={{fontSize:'inherit'}}>{view.steps.map((step,index)=><li key={`${step.id}:${index}`}>
   <strong>{step.title}</strong> <span>{step.label}</span>
   {step.summary?<p>{step.summary}</p>:null}
  </li>)}</ol>
  {view.next?<p>下一步：{view.next}</p>:null}
 </details>;
}
