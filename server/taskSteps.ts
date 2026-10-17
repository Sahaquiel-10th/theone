import {createHash} from 'node:crypto';

/** Private, task-scoped checkpoints. Never included in the public task payload. */
export type TaskStep = {key:string;namespace:string;tool:string;label:string;effect:'read'|'artifact'|'model'|'external_write';state:'started'|'completed'|'failed';output?:unknown;updatedAt:string};
export type TaskStepStore = {namespace:string;steps:TaskStep[];save:(step:TaskStep)=>Promise<void>;onReuse?:(output:unknown)=>void};
export const taskStepKey=(namespace:string,tool:string,args:string)=>createHash('sha256').update(JSON.stringify([namespace,tool,args])).digest('hex');
export function toolSucceeded(value:unknown){
  if(!value||typeof value!=='object')return true;
  const v=value as {status?:string;outcome?:string};
  return !['failed','partial','rejected','uncertain','not_connected','truncated'].includes(v.status||'')&&!['failed','needs_input','partial'].includes(v.outcome||'');
}
export function completedSteps(steps:TaskStep[]){return steps.filter(s=>s.state==='completed'&&toolSucceeded(s.output));}
export const stepProgress=(steps:TaskStep[])=>({completed:[...new Set(completedSteps(steps).map(s=>s.label))],pending:[...new Set(steps.filter(s=>s.state!=='completed').map(s=>s.label))]});
export const taskExecutionGuidance='一件任务可以组合多个功能。先确定用户必须得到的成果、必须使用的平台与工具，以及可选工具。执行模型只在理解、判断或创作时需要；已有结构化材料的网页/流程图生成可直接调用代码工具，不为保存或导出再套一层模型。每步以真实结果为准，复用已经完成的步骤，只补缺失部分。独立部分继续做；真正依赖失败步骤的部分等待，不能编造前置结果。面向用户只讲做成了什么、哪里卡住及能怎样继续，不复述工具编号、协议、回执、错误码、调用链或内部验收标准。没有证据不能说大部分完成，也不要把技术错误直接贴给用户。';
