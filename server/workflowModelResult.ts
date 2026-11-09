import {parseTaskOutcome,type TaskOutcome} from './dispatchPlan.js';

const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** Some models emit literal line breaks inside their JSON string values.
 * Escape only those control characters, preserving every manuscript byte
 * after JSON decoding. Ambiguous quotes and invalid escapes remain errors. */
function escapeStringLineBreaks(raw:string):string|undefined{
 let quoted=false,escaped=false,changed=false,result='';
 for(const char of raw){
  if(escaped){result+=char;escaped=false;continue;}
  if(quoted&&char==='\\'){result+=char;escaped=true;continue;}
  if(char==='"')quoted=!quoted;
  if(quoted&&(char==='\n'||char==='\r'||char==='\t')){
   result+=char==='\n'?'\\n':char==='\r'?'\\r':'\\t';changed=true;
  }else result+=char;
 }
 return changed&&!quoted?result:undefined;
}
function guidedEnvelopeShape(raw:string){
 if(!/^\{\s*"(?:outcome|content|summary)"\s*:/.test(raw)
  || !/"outcome"\s*:\s*"(?:completed|partial|needs_input|failed)"/.test(raw)
  || !/"content"\s*:/.test(raw)||!/"summary"\s*:/.test(raw))return false;
 // Several objects or prose after a result can be an authored example.
 // Only one outer object belongs to this recovery boundary.
 let quoted=false,escaped=false,depth=0,closingIndex=-1;
 for(let index=0;index<raw.length;index++){
  const char=raw[index];
  if(closingIndex>=0&&char.trim()){
   const prefix=raw.slice(0,closingIndex+1);
   try{JSON.parse(escapeStringLineBreaks(prefix)??prefix);return false;}
   catch{return true;}
  }
  if(escaped){escaped=false;continue;}
  if(quoted&&char==='\\'){escaped=true;continue;}
  if(char==='"'){quoted=!quoted;continue;}
  if(quoted)continue;
  if(char==='{'||char==='[')depth++;
  if(char==='}'||char===']'){depth--;if(depth===0)closingIndex=index;}
 }
 return true;
}
function duplicateOuterKeys(raw:string){
 const keys=new Set<string>();let depth=0;
 for(let index=0;index<raw.length;index++){
  const char=raw[index];
  if(char==='{'||char==='[')depth++;
  else if(char==='}'||char===']')depth--;
  else if(char==='"'){
   const start=index;let escaped=false;
   for(index++;index<raw.length;index++){
    if(escaped){escaped=false;continue;}
    if(raw[index]==='\\'){escaped=true;continue;}
    if(raw[index]==='"')break;
   }
   if(depth===1&&/^\s*:/.test(raw.slice(index+1))){
    const key=JSON.parse(raw.slice(start,index+1)) as string;
    if(keys.has(key))return true;
    keys.add(key);
   }
  }
 }
 return false;
}
function envelope(raw:string):TaskOutcome|undefined{
 try{
  let value:unknown,parsedRaw=raw;
  try{value=JSON.parse(raw);}catch{
   if(!guidedEnvelopeShape(raw))return;
   const repaired=escapeStringLineBreaks(raw);
   if(!repaired)return {outcome:'failed',content:raw,summary:'这一步的正文格式未能解析，已有输出已保留。'};
   try{value=JSON.parse(repaired);parsedRaw=repaired;}catch{return {outcome:'failed',content:raw,summary:'这一步的正文格式未能解析，已有输出已保留。'};}
  }
  const v=object(value);
  if(v&&Object.keys(v).sort().join()==='content,outcome,summary'&&['completed','partial','needs_input','failed'].includes(String(v.outcome))){
   if(duplicateOuterKeys(parsedRaw))return {outcome:'failed',content:raw,summary:'这一步返回了重复的结果字段，已有输出已保留。'};
   // At this guided boundary the exact reserved shape is a result, not an
   // authored JSON example. Keep malformed payloads as private failed-step
   // diagnostics; never promote them to a completed manuscript.
   if(typeof v.content!=='string'||typeof v.summary!=='string')return {outcome:'failed',content:raw,summary:'这一步返回的结果格式不完整，后续保存未开始。'};
   if(v.outcome==='completed'&&!v.content.trim())return {outcome:'failed',content:'',summary:'这一步没有返回可用正文，后续保存未开始。'};
   return {outcome:v.outcome as TaskOutcome['outcome'],content:v.content,summary:v.summary.slice(0,500)};
  }
 }catch{}
}
function unread(raw:string):TaskOutcome|undefined{
 try{const v=object(JSON.parse(raw));if(v&&Object.keys(v).sort().join()==='outcome,read_performed,reason'&&v.outcome==='not_completed'&&v.read_performed===false&&typeof v.reason==='string'&&v.reason.trim())return parseTaskOutcome(raw);}catch{}
}
function stepExplanation(prefix:string,title:string){
 if(!title.trim()||!prefix.trim()||prefix.length>1500||!prefix.includes(title)||/(?:示例|例如|例子|样例|教程|演示|example|sample|demonstrat)/i.test(prefix)||/(?:`{3,}|~{3,})|(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(prefix))return false;
 return /(?:步骤|阶段|\bstep\b|\bstage\b)/i.test(prefix)&&/(?:这是|本步|当前|以下|下面|结果|返回|输出|\bthis\b|\bhere\b|\bresult\b|\boutput\b)/i.test(prefix);
}
/** This parser belongs only at a server-guided workflow model boundary. It is
 * deliberately not used to search arbitrary articles/history for JSON. One
 * exact result envelope may follow a short explanation of this actual stage;
 * examples, multiple objects, extra fields and unrelated prose stay intact.
 * Once normalized, content is manuscript data and must never be parsed again. */
export function parseWorkflowModelOutcome(raw:string,stageTitle:string):TaskOutcome{
 const trimmed=raw.trim(),direct=envelope(trimmed)??unread(trimmed);if(direct)return direct;
 const fenced=/^(?:([\s\S]*?)\r?\n)?(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\2[ \t]*$/i.exec(trimmed);
 if(fenced){
  const prefix=fenced[1]?.trim()??'',value=envelope(fenced[3])??unread(fenced[3]);
  if(value&&(!prefix||stepExplanation(prefix,stageTitle)))return value;
 }
 // Preserve the existing exact-duplicate compatibility without treating an
 // arbitrary JSON example or a second, different body as a delivery envelope.
 const boundary=raw.lastIndexOf('\n{');
 if(boundary>=0){const value=envelope(raw.slice(boundary+1));if(value&&value.content.trim()===raw.slice(0,boundary).trim())return value;}
 return {outcome:'returned',content:raw,summary:raw.split('\n').find(line=>line.trim())?.slice(0,500)||'本轮已返回内容，请查看成果。'};
}
