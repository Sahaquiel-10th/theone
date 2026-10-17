import { CoordinatorError } from './executorProfiles.js';
import {validateVisualDocument,visualDocumentSchema,type VisualDocument} from './visualDocument.js';
export type PlannedTask = { taskId: string|null; title: string; instruction: string; executorId: string; outputKind: 'text'|'image'|'local_file'; featureIds: string[]; dependsOn: number[];knowledge?:string;requiredTools?:string[];direct?:{tool:'oneHtml'|'oneFlowchart';document:VisualDocument} };
export const dispatchPlanSchema = {type:'object',additionalProperties:false,properties:{tasks:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,properties:{taskId:{type:['string','null']},title:{type:'string',maxLength:80},instruction:{type:'string',maxLength:4000},executorId:{type:'string'},outputKind:{type:'string',enum:['text','image','local_file']},featureIds:{type:'array',maxItems:8,items:{type:'string'}},dependsOn:{type:'array',maxItems:3,items:{type:'integer',minimum:0,maximum:3}},knowledge:{type:'string',enum:['none','all','notion','getnote','feishu','flowus','yinxiang','flomo']},requiredTools:{type:'array',maxItems:6,items:{type:'string'}},direct:{type:'object',additionalProperties:false,properties:{tool:{type:'string',enum:['oneHtml','oneFlowchart']},document:visualDocumentSchema},required:['tool','document']}},required:['taskId','title','instruction','executorId','outputKind','featureIds','dependsOn']}}},required:['tasks']};
export function validateDispatchPlan(value:unknown): {tasks:PlannedTask[]} {
  const v=value as {tasks:PlannedTask[]};
  if(!v||Object.keys(v).join()!=='tasks'||!Array.isArray(v.tasks)||!v.tasks.length||v.tasks.length>4)throw new CoordinatorError('一次安排 1–4 个任务，更多要求可分批处理',400);
  const existing=new Set<string>();
  v.tasks.forEach((t,i)=>{
    if(!t||Object.keys(t).some(k=>!['dependsOn','executorId','featureIds','instruction','outputKind','taskId','title','knowledge','requiredTools','direct'].includes(k))||(t.taskId!==null&&typeof t.taskId!=='string')||typeof t.title!=='string'||!t.title.trim()||t.title.length>80||typeof t.instruction!=='string'||!t.instruction.trim()||t.instruction.length>4000||typeof t.executorId!=='string'||!['text','image','local_file'].includes(t.outputKind))throw new CoordinatorError('任务安排格式无效',400);
    if(t.knowledge!==undefined&&!['none','all','notion','getnote','feishu','flowus','yinxiang','flomo'].includes(t.knowledge))throw new CoordinatorError('知识范围无效',400);
    if(t.requiredTools!==undefined&&(!Array.isArray(t.requiredTools)||t.requiredTools.length>6||t.requiredTools.some(n=>typeof n!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(n))||new Set(t.requiredTools).size!==t.requiredTools.length))throw new CoordinatorError('必用工具无效',400);
    if(t.direct){if(Object.keys(t.direct).sort().join()!=='document,tool'||!['oneHtml','oneFlowchart'].includes(t.direct.tool)||t.outputKind!=='text'||t.knowledge&&t.knowledge!=='none')throw new CoordinatorError('直接操作范围无效',400);t.direct.document=validateVisualDocument(t.direct.document);}
    if(!Array.isArray(t.featureIds)||t.featureIds.length>8||t.featureIds.some(id=>typeof id!=='string'||!id)||new Set(t.featureIds).size!==t.featureIds.length)throw new CoordinatorError('任务功能选择无效',400);
    if(!Array.isArray(t.dependsOn)||t.dependsOn.some(n=>!Number.isInteger(n)||n<0||n>=i)||new Set(t.dependsOn).size!==t.dependsOn.length)throw new CoordinatorError('依赖只能指向本批已经列出的任务',400);
    if(t.taskId){if(existing.has(t.taskId))throw new CoordinatorError('同一任务的补充请合并成一条要求',400);existing.add(t.taskId);}
  });
  return v;
}
export function isImageInstruction(title:string) {
  if(!/(?:图片|海报|插画|封面|漫画)/.test(title)&&/(?:表格|分析表|统计表|对比表|战力表|报表|文档|文章|方案|流程)/.test(title))return false;
  return /^(?:画图|绘图|生图|画一|生成图片|生成海报|绘制(?!表|报表|流程)|制作.{0,30}(?:图片|海报|插画|封面))/.test(title.trim());
}
export type TaskOutcome = {outcome:'completed'|'partial'|'needs_input'|'failed'|'returned'; content:string; summary:string};
export const taskOutcomeGuidance='最终成果请用 JSON 返回（不要代码围栏）：{"outcome":"completed|partial|needs_input|failed","content":"面向用户的完整正文，Markdown 可放在字符串内","summary":"一两句话说明实际完成和未完成事项"}。无法执行、缺少工具或关键资料时不得返回 completed。仅讨论无需产物时直接给正文。外部写入必须以真实工具回执核定，不能凭自己的宣称完成。';
export function parseTaskOutcome(raw:string):TaskOutcome {
  try{const v=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));if(v&&['completed','partial','needs_input','failed'].includes(v.outcome)&&typeof v.content==='string'&&v.content.trim()&&typeof v.summary==='string')return {outcome:v.outcome,content:v.content,summary:v.summary.slice(0,500)};}catch{}
  return {outcome:'returned',content:raw,summary:raw.split('\n').find(line=>line.trim())?.slice(0,500)||'本轮已返回内容，请查看成果。'};
}
