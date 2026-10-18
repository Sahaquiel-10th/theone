import type {Database} from './types.js';
import {canReadKnowledge} from './enterprisePolicy.js';
export const knowledgeNames:Record<string,string>={notion:'Notion',getnote:'得到大脑',feishu:'飞书',flowus:'FlowUs',yinxiang:'印象笔记',flomo:'flomo'};
export type KnowledgePolicy={required:boolean;sourceIds:string[];requested:string[];missing:string[]};
/** These explicit source names constrain, never expand, the user's selection.
 * Semantic planning still decides the work; exact named-source requirements
 * and exhaustive authorized searches are checked by the server. */
export function knowledgePolicy(db:Database,scope:{workspaceId:string;userId:string},text:string,allowed?:readonly string[],choice?:string):KnowledgePolicy{
  text=text.replace(/(?:不要|不|无需|不用)(?:查找|查询|检索|搜索|查|读取)[^，。；;\n]{0,40}/g,'');
  const connected=db.knowledgeConnections.filter(c=>c.workspaceId===scope.workspaceId&&['connected','error'].includes(c.status)&&canReadKnowledge(db,scope,c.id)&&(allowed===undefined||allowed.includes(c.id)));
  const named=Object.entries(knowledgeNames).filter(([id,name])=>new RegExp(id+'|'+name,'i').test(text)).map(([id])=>id);
  const query=/(?:找|查|搜索|检索|看看|寻找)/.test(text);
  const all=choice==='all'||(!named.length&&((/(?:我记得|知识库|资料库|笔记|自己的资料|所有.*资料)/.test(text)&&query)||/我记得有(?:个|一|件)/.test(text)||/(?:昨天|前天|今天|上周|本周)(?:.{0,12}我的.{0,8}(?:会议|录音|笔记)|.{0,12}(?:会议记录|会议纪要|录音|笔记))/.test(text)));
  const requested=choice&&choice!=='none'&&choice!=='all'?[choice]:query?named:[];
  const required=all||requested.length>0;
  return {required,sourceIds:connected.filter(c=>all||requested.includes(c.provider)).map(c=>c.id),requested,missing:requested.filter(id=>!connected.some(c=>c.provider===id)).map(id=>knowledgeNames[id]||'指定资料来源')};
}
export function knowledgeResultComplete(result:unknown,expected:string[]){
  const r=result as {status?:string;coverage?:{connectionId?:string;status:string}[]};
  if(!r||['failed','partial','not_connected'].includes(r.status||''))return false;
  return !r.coverage||expected.every(id=>r.coverage!.some(c=>c.connectionId===id&&['used','no_match'].includes(c.status)));
}
export const knowledgeGuidance='用户点名的平台必须实际查询，不能用其他来源冒充。用户要找自己记得的资料但未指定来源时，按本轮授权范围查询全部可搜索来源。查询失败、授权失效、没有连接和搜索无命中是不同情况；有来源没查成时不能说全部没有。即使所有来源都没命中，也只说本次没找到，不断言资料不存在。';
