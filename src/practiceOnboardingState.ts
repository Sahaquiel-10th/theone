import type {PracticeRound,PracticeView} from '../server/onboardingPractice';

export type PracticeRecord=NonNullable<PracticeView['practice']>;
export const practiceNodes=['直接开始','用你的资料','分头去办','成果变网页'] as const;
export function practiceRoundDone(round?:PracticeRound){
  return !!round&&round.state==='completed'&&!!round.resultMessageId&&['completed','returned'].includes(round.outcome??'');
}
export function practiceRoundPending(round?:PracticeRound){return !!round&&['queued','running','prepared'].includes(round.state);}
export function practiceWebDone(practice?:PracticeRecord){return practiceRoundDone(practice?.web)&&!!practice?.web?.attachment;}
export function practiceNode(practice?:PracticeRecord):number{
  if(!practice)return 1;
  return practiceRoundDone(practice.first)?3:2;
}
export function practiceStatus(round?:PracticeRound){
  if(!round)return '还没开始';
  if(practiceRoundDone(round))return '成果已返回';
  if(round.outcome==='needs_input')return '需要你补充一点信息';
  if(round.outcome==='partial')return '已有部分成果，还没全部完成';
  return ({queued:'任务已接到，等待处理',running:'正在处理这份资料',prepared:'等待确认后继续',failed:'这次还没做完',interrupted:'这轮处理已中断',cancelled:'任务已停止',completed:'已返回反馈，成果还需核对'} as const)[round.state];
}
/** Only HTTP sources or same-origin application paths may become links. */
export function practiceLink(value?:string){
  if(!value)return undefined;
  if(/^\/(?!\/)[^\s\\]*$/.test(value))return value;
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:undefined;}catch{return undefined;}
}
export function practiceRecap(practice:PracticeRecord){
  return [
    {label:'AI 已经可以直接用',done:true},
    {label:practice.source.sample?'用明确标记的示例整理了正文':'用你选中的真实资料整理了正文',done:practiceRoundDone(practice.first)},
    {label:'任务独立处理，主对话可以继续',done:!!practice.first.taskId},
    {label:practice.skipWeb?'这次先保留正文，网页以后再做':'把同一份成果做成了互动网页',done:practiceWebDone(practice)},
  ];
}
/** An uncertain HTTP response must retain its request ID across explicit retries. */
export function practiceSubmission(previous:{signature:string;operationId:string}|undefined,signature:string,createId:()=>string){
  return previous?.signature===signature?previous:{signature,operationId:createId()};
}
