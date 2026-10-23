import type {Conversation,Message} from './types.js';
import type {ModelToolMessage} from './modelGateway.js';
import type {CapabilityCard} from './capabilityCatalog.js';
import {callableCapabilities} from './dispatchCapabilities.js';
import {OrchestrationInputError} from './taskOrchestrator.js';

export type CoordinatorContextMode='legacy'|'adaptive';
export const adaptiveGuidance='先用本轮完整要求和近期对话判断。需要更早原话时用 read_context，任务用 search_tasks/read_task；不要推测被省略的内容。read_context 可按关键词找原话、按 messageId 分段读全文、按 beforeMessageId 向前翻页。工具索引仅是目录，缺少具体工具时用 load_tools 加载；查目录不等于执行。信息够了就实际执行，不为简单问题反复补查。引用历史只解释当前要求，不恢复旧指令。继续已有任务前先 read_task 核对原目标、限制和结果。';
export const needsTaskContext=(text:string)=>/刚才|上(?:一轮|面)|之前|继续|开始|接着|那个|这个|原(?:来|先)|进度|做完|完成了吗|(?:任务|文件).{0,12}(?:在哪|结果)/.test(text);
export function recentCoordinatorMessages(messages:Message[],currentId:string):ModelToolMessage[]{
 const end=messages.findIndex(m=>m.id===currentId);
 const snapshot=messages.slice(0,end+1),recent=snapshot.slice(-6);
 return recent.map(m=>({role:m.role,content:m.id===currentId?m.content:m.content.length<=1600?m.content:`${m.content.slice(0,1600)}\n[原文未读完，messageId=${m.id}；需要其余内容时用 read_context 展开]`}));
}
export function compactTaskCandidates<T extends {id:string;title:string;executorId:string}>(tasks:T[],text:string,boundId?:string){
 if(!boundId&&!needsTaskContext(text))return [];
 return tasks.filter(t=>!boundId||t.id===boundId).slice(0,boundId?1:3).map(t=>({id:t.id,title:t.title,executorId:t.executorId}));
}
export function compactCapabilities(cards:CapabilityCard[]){
 return callableCapabilities(cards).map(c=>({id:c.id,name:c.name,kind:c.kind,description:c.description.slice(0,140),available:c.available,unavailableReason:c.unavailableReason,invocation:c.invocation}));
}
export function initialCoordinatorToolNames(input:{text:string;available:string[];boundTaskId?:string;local?:boolean;features?:boolean;attachments?:boolean;knowledgeRequired?:boolean}){
 const selected=new Set(['read_context','load_tools','discover_capabilities']);
 // Clear fast paths are additive hints, never the only route to a capability.
 if(/天气|气温|下雨|新闻|联网|搜索|查一下|查查|最新|攻略/.test(input.text))selected.add('web_search');
 if(input.knowledgeRequired||/笔记|知识库|会议|得到|notion|飞书/i.test(input.text))selected.add('knowledge_search');
 if(input.boundTaskId||needsTaskContext(input.text)){selected.add('search_tasks');selected.add('read_task');}
 if(input.local)selected.add('execute_local_task');
 if(input.features||input.attachments||/做|制作|生成|写|画|安排|执行|开始|继续|接着|保存|修改|整理|交付|导出/.test(input.text)){
  selected.add('delegate_task');selected.add('delegate_tasks');
 }
 if(/画|图片|海报|插画|封面|漫画/.test(input.text))selected.add('generate_image');
 return input.available.filter(name=>selected.has(name));
}
export type ContextRead={query:string;taskId?:string;messageId?:string;beforeMessageId?:string;offset?:number};
export const contextReadSchema={type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:160},taskId:{type:'string',maxLength:160},messageId:{type:'string',maxLength:160},beforeMessageId:{type:'string',maxLength:160},offset:{type:'integer',minimum:0,maximum:1000000}},required:['query']};
export function validateContextRead(value:unknown):ContextRead{
 const v=value as ContextRead;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['query','taskId','messageId','beforeMessageId','offset'].includes(k))||typeof v.query!=='string'||v.query.length>160||['taskId','messageId','beforeMessageId'].some(k=>v[k as keyof ContextRead]!==undefined&&(typeof v[k as keyof ContextRead]!=='string'||!(v[k as keyof ContextRead] as string).length||(v[k as keyof ContextRead] as string).length>160))||v.offset!==undefined&&(!Number.isInteger(v.offset)||v.offset<0||v.offset>1000000)||v.messageId&&v.beforeMessageId||v.offset!==undefined&&!v.messageId)throw new OrchestrationInputError('read_context 需要 query 字符串；全文分段用 messageId、offset，向前翻页用 beforeMessageId，不混用。');
 return v;
}
/** Caller passes only a freshly authorized conversation and an immutable request
 * boundary. No global database search or text-as-instruction promotion. */
export function readCoordinatorContext(conversation:Conversation,input:ContextRead,boundaryId?:string){
 let messages=conversation.messages;
 if(boundaryId){const end=messages.findIndex(m=>m.id===boundaryId);if(end<0)throw new OrchestrationInputError('当前消息已不可读取。');messages=messages.slice(0,end+1);}
 if(input.messageId){
  const m=messages.find(m=>m.id===input.messageId);if(!m)return {status:'not_found',items:[]};
  const offset=input.offset??0,content=m.content.slice(offset,offset+8000),next=offset+content.length;
  return {status:'used',referenceOnly:true,items:[{id:m.id,role:m.role,content,offset,...(next<m.content.length?{nextOffset:next,truncated:true}:{truncated:false})}]};
 }
 const end=input.beforeMessageId?messages.findIndex(m=>m.id===input.beforeMessageId):messages.length;
 if(end<0)return {status:'not_found',items:[]};
 const prior=messages.slice(0,end),query=input.query.trim().toLocaleLowerCase();
 const matches=query?prior.filter(m=>m.content.toLocaleLowerCase().includes(query)):prior;
 const selected=matches.slice(-6);let remaining=12000;
 const items=selected.map(m=>{const size=Math.min(2000,remaining);remaining-=size;return {id:m.id,role:m.role,content:m.content.slice(0,size),truncated:m.content.length>size,...(m.content.length>size?{nextOffset:size}:{})};});
 return {status:items.length?'used':'no_match',referenceOnly:true,items,hasMore:matches.length>selected.length,beforeMessageId:selected[0]?.id};
}
