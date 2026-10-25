import type {Database} from './types.js';
import { dateSearchQuery, validCalendarDay, type KnowledgeDateRange } from './knowledge/temporal.js';

export type ContextPreferences={workspaceId:string;userId:string;timeZone:string;city:string};
export type RuntimeContext={at:string;timeZone:string;today:string;yesterday:string;city?:string};
export function validTimeZone(value:unknown):value is string{
  if(typeof value!=='string'||value.length>80)return false;
  try{new Intl.DateTimeFormat('en',{timeZone:value}).format();return true;}catch{return false;}
}
export function calendarDay(at:string,timeZone:string){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  return ['year','month','day'].map(key=>p.find(p=>p.type===key)!.value).join('-');
}
export function addDays(day:string,n:number){return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function runtimeContext(db:Database,scope:{workspaceId:string;userId:string},at=new Date().toISOString(),clientTimeZone?:unknown):RuntimeContext{
  const preference=db.users.find(u=>u.id===scope.userId)?.contextPreferences?.find(p=>p.workspaceId===scope.workspaceId&&p.userId===scope.userId);
  const timeZone=validTimeZone(preference?.timeZone)?preference.timeZone:validTimeZone(clientTimeZone)?clientTimeZone:'Asia/Shanghai';
  const today=calendarDay(at,timeZone);
  return {at,timeZone,today,yesterday:addDays(today,-1),...(preference?.city?{city:preference.city}:{})};
}
export function runtimeContextText(context:RuntimeContext,now=new Date().toISOString()){
  // Task time is immutable across retries. Wall-clock milliseconds add no
  // useful date context and used to invalidate otherwise stable prefixes.
  return `任务日期参考：${JSON.stringify(context)}。相对日期沿用此任务日期；城市为常驻设置，非实时定位。事件日期核对正文。`;
}
/** Only server-known facts, for independent questions in an otherwise failed search. */
export function requestedRuntimeFacts(request:string,context:RuntimeContext){
  const facts:string[]=[];
  if(/(?:今天|昨天|今日|昨日).{0,10}(?:日期|几号|哪一天|几月几日)/.test(request))facts.push(`今天是 ${context.today}，昨天是 ${context.yesterday}`);
  if(/时区/.test(request))facts.push(`时区是 ${context.timeZone}`);
  if(/(?:设置|常驻).{0,6}城市/.test(request))facts.push(context.city?`设置的常驻城市是 ${context.city}`:'还没有设置常驻城市');
  return facts.length?facts.join('；')+'。':'';
}
export function requestedDateRange(text:string,context:RuntimeContext){
  // A date in a title or in "the old proposal we mentioned yesterday" is a
  // retrieval clue, not a constraint on when that document was created/evented.
  text=text.replace(/《[^》\n]{0,300}》|「[^」\n]{0,300}」|『[^』\n]{0,300}』/g,' ');
  text=text.replace(/(?:今天|今日|昨天|昨日)(?:先|就|请)?(?=帮我|给我|替我|麻烦|请你|能不能)/g,'');
  const explicitField=/(?:按|依据|根据|筛选|限定|限制).{0,10}(?:创建|新建|编辑|修改|更新|记录|事件|发生)?(?:时间|日期)|(?:创建|修改|编辑|更新)(?:时间|日期)/.test(text);
  if(!explicitField&&/(?:昨天|昨日|前天|今天|今日|上周|本周|这周|20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)[^。！？\n]{0,16}(?:提到|说过|说到|聊过|谈过|给你看过|发给你|分享过)[^。！？\n]{0,20}(?:那份|那篇|那个|旧|以前|去年|之前|资料|方案|文档|报告|文章|链接|书)/.test(text))return;
  const exact=[...text.matchAll(/(?<!\d)(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?!\d)/g)].map(match=>`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`);
  if(!exact.length&&!explicitField){
    const temporal='(?:昨天|昨日|前天|今天|今日|上周|本周|这周|最近(?:一周|1周|七天|7天)|过去(?:一周|七天|7天))';
    const subject='(?:会议|开(?:过|了)?(?:的)?会|思考|想法|碎碎念|笔记|记录|日记|讨论|发生|做了|聊了|工作|资料|文章|事情|的事|创建|新建|新增|录入|更新|修改|编辑)';
    if(!new RegExp(`^\\s*${temporal}\\s*$`).test(text)&&!new RegExp(`${temporal}[^。！？\\n]{0,12}${subject}`).test(text))return;
  }
  let from=exact[0],to=exact[1]??from;
  if(!from&&/昨天|昨日/.test(text))from=to=context.yesterday;
  else if(!from&&/前天/.test(text))from=to=addDays(context.today,-2);
  else if(!from&&/今天|今日/.test(text))from=to=context.today;
  else if(!from&&/最近(?:一周|1周|七天|7天)|过去(?:一周|七天|7天)/.test(text)){from=addDays(context.today,-6);to=context.today;}
  else if(!from&&/上周|本周|这周/.test(text)){const weekday=new Date(context.today+'T12:00:00Z').getUTCDay();from=addDays(context.today,-((weekday+6)%7)-(/上周/.test(text)?7:0));to=/上周/.test(text)?addDays(from,6):context.today;}
  if(!validCalendarDay(from)||!validCalendarDay(to)||from>to)return;
  return {from,to,timeZone:context.timeZone};
}
export function knowledgeRecallOptions(request:string,context:RuntimeContext,retry=true):{retry:boolean;dateRange?:KnowledgeDateRange}{
  const range=requestedDateRange(request,context);
  const basis=/(?:创建|新建|新增|录入|记录)(?:时间|日期)|(?:昨天|昨日|今天|今日|前天|\d{1,2}日)(?:刚|所)?(?:创建|新建|新增|录入)(?:的)?(?:笔记|页面|文档|资料)/.test(request)?'created':/(?:修改|更新|编辑)(?:时间|日期)|(?:昨天|昨日|今天|今日|前天|\d{1,2}日)(?:刚|所)?(?:修改|更新|编辑)(?:的)?(?:笔记|页面|文档|资料)/.test(request)?'updated':'event';
  return {retry,...(range?{dateRange:{...range,anchorAt:context.at,basis}}:{})};
}
export function datedKnowledgeQuery(query:string,request:string,context:RuntimeContext){
  const range=knowledgeRecallOptions(request,context).dateRange;
  return range?dateSearchQuery(query,range):query;
}
export function temporalKnowledgeResult(result:unknown,request:string,context:RuntimeContext){
  const range=requestedDateRange(request,context);
  return range?{...(result as object),timeConstraint:{...range,strictFilter:false,complete:false,...(result&&typeof result==='object'&&'temporal' in result?{retrieval:result.temporal}:{}),note:'只说明本次有限检索中核对到的日期与内容，不能据此说该日期没有资料。创建/编辑日期仅定位候选，事件日期须核对正文；缺少素材时先询问，不自行保存占位说明。'}}:result;
}
