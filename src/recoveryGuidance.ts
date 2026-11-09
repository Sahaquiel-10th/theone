import {taskWorkflowView,type TaskWorkflowView} from './taskWorkflowView';
import type {TaskRecovery} from './taskRecovery';

/** A read-only explanation of durable facts. This never authorizes or retries
 * work, and it never treats a returned document as a completed whole task. */
export type RecoveryGuidance={completed:string[];step?:string;reason:string;automatic:boolean;statusLabel:string;next:string;actionLabel?:string};
const clean=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max):'';
export function recoveryGuidance(input:{recovery:TaskRecovery;workflow?:TaskWorkflowView}):RecoveryGuidance {
 const view=taskWorkflowView(input.workflow),kind=input.recovery.kind;
 const current=view?.steps.find(step=>['running','needs_input','failed'].includes(step.state))??view?.steps.find(step=>step.state==='waiting'&&step.waitingFor==='result');
 const automatic=kind==='reconciling'||kind==='none'&&Boolean(view?.steps.some(step=>step.recovering));
 const actions:Partial<Record<TaskRecovery['kind'],{next:string;label?:string}>>={
  connection:{next:'连接恢复后点“继续这件事”，或直接在主对话说继续。ONE 会先重新检查，再从断点接着做。',label:'继续这件事'},
  input:{next:'补充下方明确缺少的资料后，ONE 会重新检查并接着处理。',label:'补充所需资料'},
  support:{next:'这一步已停止，需要 ONE 支持人员检查。你暂时不用操作，可以先查看已有成果。'},
  review_notion:{next:'只核对原保存结果；不会重新生成或保存。'},
  review_local:{next:'先核对原电脑的结束反馈；未确认前不会另起一轮修改文件。'},
  retry:{next:'当前已暂停。需要继续时，只处理未完成部分；已有成果保留。'},
  resume:{next:'这一条尚未开始。确认继续后再执行，较早的待办仍保留在历史中。'},
  review_image:{next:'先查看已有图片和用量；重新生成前会确认本次范围与用量。'},
 };
 const selected=actions[kind];
 const savedNotion=input.recovery.writeAcknowledged===true&&(kind==='review_notion'||kind==='reconciling');
 const completed=view?.steps.filter(step=>step.state==='completed').map(step=>step.title)??[];
 if(savedNotion&&!completed.includes('保存到 Notion'))completed.push('保存到 Notion');
 const statusLabel=automatic?'ONE 正在自动恢复':kind==='connection'?'连接恢复后可继续':kind==='input'?'需要你补充资料':kind==='support'?'内部问题，已停止':kind==='review_notion'?(savedNotion?'正文待核对':'保存结果待核对'):kind==='review_local'?'原电脑结果待核对':'本轮已暂停';
 return {completed,step:savedNotion?'核对 Notion 正文':current?.title,statusLabel,
  reason:clean(input.recovery.message,1600),automatic,
  next:automatic?'ONE 正在后台继续核对或恢复，暂时不用你操作。':selected?.next??'查看当前结果；有新的要求可以继续补充。',
  ...(!automatic&&selected?.label?{actionLabel:selected.label}:{})};
}
