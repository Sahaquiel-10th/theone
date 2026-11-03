export type WorkflowStepState='queued'|'running'|'completed'|'waiting'|'needs_input'|'failed'|'skipped';
/** Reviewed, user-facing projection only; execution tools and arguments never
 * belong in this DTO or its rendering. */
export type TaskWorkflowView={version:1;phase:string;steps:{id:string;title:string;state:WorkflowStepState;summary?:string;waitingFor?:'inputs'|'result';recovery?:{state:'scheduled'|'checking'|'exhausted';attempt?:number;nextRetryAt?:string};resultAvailable?:boolean}[];next?:string};

const labels:Record<WorkflowStepState,string>={queued:'等待开始',running:'正在处理',completed:'已完成',waiting:'等待前一步',needs_input:'等你补充',failed:'这步没做完',skipped:'已跳过'};
export const workflowStepLabel=(state:string)=>labels[state as WorkflowStepState]??'状态待确认';
const text=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max):'';

/** The public schema is intentionally projected again, rather than spreading
 * a job or a step into the DOM. Old jobs have no workflow and remain unchanged. */
export function taskWorkflowView(workflow?:TaskWorkflowView){
 if(!workflow||workflow.version!==1||!Array.isArray(workflow.steps))return;
 const steps=workflow.steps.flatMap(step=>{
  if(!step||typeof step!=='object')return [];
  const title=text(step.title,160),id=text(step.id,200);
  const recovering=['running','waiting'].includes(step.state)&&(step.recovery?.state==='scheduled'||step.recovery?.state==='checking');
  const label=recovering?'正在自动恢复':step.state==='waiting'&&step.waitingFor==='result'?'正在核对结果':workflowStepLabel(step.state);
  return title&&id?[{id,title,state:step.state,label,summary:text(step.summary,320),waitingFor:step.waitingFor==='inputs'||step.waitingFor==='result'?step.waitingFor:undefined,resultAvailable:step.state==='completed'&&step.resultAvailable===true,recovering}]:[];
 });
 if(!steps.length)return;
 const completed=steps.filter(step=>step.state==='completed').length;
 const current=steps.find(step=>step.state==='running')??steps.find(step=>step.state==='needs_input')??steps.find(step=>step.state==='failed')??steps.find(step=>step.state==='waiting')??steps.find(step=>step.state==='queued');
 return {steps,completed,total:steps.length,current:current?`${current.label}：${current.title}`:undefined,next:text(workflow.next,320)};
}

/** The rail is a progress feed, not a copy of the full plan: future queued
 * stages appear when they start. The complete plan remains in task details. */
export function taskWorkflowActivityView(workflow?:TaskWorkflowView){
 const view=taskWorkflowView(workflow);if(!view)return;
 const lastVisible=view.steps.reduce((last,step,index)=>step.state==='queued'||step.state==='waiting'&&step.waitingFor==='inputs'?last:index,-1);
 const steps=view.steps.slice(0,Math.max(1,lastVisible+1));
 return {...view,steps};
}
