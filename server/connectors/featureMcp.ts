import { createHash } from "node:crypto";
import { StandardToolError, validateFields } from "./standardHttp.js";
import { boundedHttps, safeToolEndpoint, timedExchange, type ToolExchange } from "./boundedHttps.js";

export type McpDefinition={name:string;description?:string;inputSchema:{type:'object';properties:Record<string,{type:'string'|'integer'|'number'|'boolean';description?:string}>;required?:string[];additionalProperties?:false};annotations?:Record<string,unknown>;outputSchema?:unknown};
const bad=(code:string):never=>{throw new StandardToolError(code);};
function canonical(value:unknown):string{return Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as any)[k])).join(',')}}`:JSON.stringify(value);}
export const mcpDigest=(tool:McpDefinition)=>createHash('sha256').update(canonical(tool)).digest('hex');
export function mcpDefinition(raw:any):McpDefinition{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['name','description','inputSchema','annotations','outputSchema'].includes(k))||typeof raw.name!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.name)||JSON.stringify(raw).length>40000)bad('MCP_UNSUPPORTED_TOOL');
  if(raw.description!==undefined&&(typeof raw.description!=='string'||raw.description.length>4000))bad('MCP_UNSUPPORTED_TOOL');
  if(!raw.annotations||raw.annotations.readOnlyHint!==true||raw.annotations.destructiveHint===true)bad('MCP_READ_ONLY_REQUIRED');
  const s=raw.inputSchema;
  if(!s||s.type!=='object'||Object.keys(s).some(k=>!['type','properties','required','additionalProperties'].includes(k))||(s.additionalProperties!==undefined&&s.additionalProperties!==false)||!s.properties||typeof s.properties!=='object'||Array.isArray(s.properties)||Object.keys(s.properties).length>20)bad('MCP_UNSUPPORTED_SCHEMA');
  for(const[name,p]of Object.entries<any>(s.properties))if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)||['constructor','prototype'].includes(name)||!p||Object.keys(p).some(k=>!['type','description'].includes(k))||!['string','number','integer','boolean'].includes(p.type)||(p.description!==undefined&&typeof p.description!=='string'))bad('MCP_UNSUPPORTED_SCHEMA');
  if(s.required!==undefined&&(!Array.isArray(s.required)||s.required.some((k:unknown)=>typeof k!=='string'||!Object.hasOwn(s.properties,k))))bad('MCP_UNSUPPORTED_SCHEMA');
  return structuredClone(raw);
}
export function mcpValidate(tool:McpDefinition,input:unknown){return validateFields(input,tool.inputSchema.properties,tool.inputSchema.required??[]);}

function rpcResponse(response:Awaited<ReturnType<ToolExchange>>,id:number){
  if(response.status!==200)bad('MCP_INVALID_RESPONSE');
  let messages:any[]=[];
  if(/^application\/json(?:\s*;|$)/i.test(response.contentType)){try{messages=[JSON.parse(response.text)];}catch{bad('MCP_INVALID_RESPONSE');}}
  else if(/^text\/event-stream(?:\s*;|$)/i.test(response.contentType)){
    try{messages=response.text.replace(/\r\n/g,'\n').split('\n\n').map(block=>block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(text=>JSON.parse(text));}catch{bad('MCP_INVALID_RESPONSE');}
  }else return bad('MCP_UNSUPPORTED_TRANSPORT');
  if(messages.some(m=>!m||m.jsonrpc!=='2.0'||(m.method&&m.id!==undefined)))bad('MCP_SERVER_REQUEST_UNSUPPORTED');
  const matches=messages.filter(m=>m.id===id&&!m.method);
  if(matches.length!==1||matches[0].error||!matches[0].result)bad('MCP_REMOTE_ERROR');
  return matches[0].result;
}
export async function openFeatureMcp(endpoint:string,headers:Record<string,string>={},exchange:ToolExchange=boundedHttps){
  const url=safeToolEndpoint(endpoint);let sessionId:string|undefined,version='2025-11-25',sequence=0;
  const post=async(method:string,params:unknown,notification=false)=>{
    const id=++sequence;
    const response=await timedExchange(exchange,url,{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(sessionId?{'MCP-Session-Id':sessionId}:{}),...(method==='initialize'?{}:{'MCP-Protocol-Version':version})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
    if(method==='initialize'&&response.sessionId){if(!/^[\x21-\x7e]{1,512}$/.test(response.sessionId))bad('MCP_INVALID_SESSION');sessionId=response.sessionId;}
    if(notification){if(response.status!==202)bad('MCP_INVALID_RESPONSE');return;}
    return rpcResponse(response,id);
  };
  const init=await post('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'ONE-reviewed-tools',version:'0.4'}});
  if(!['2025-11-25','2025-06-18','2025-03-26'].includes(init.protocolVersion)||!init.capabilities?.tools)bad('MCP_UNSUPPORTED_VERSION');
  version=init.protocolVersion;await post('notifications/initialized',{},true);
  return {list:async()=>{
    const items:any[]=[];let cursor:string|undefined;
    for(let page=0;page<3;page++){
      const result=await post('tools/list',cursor?{cursor}:{});
      if(!Array.isArray(result.tools)||result.tools.length>100||items.length+result.tools.length>100)bad('MCP_TOOL_LIMIT');items.push(...result.tools);
      if(result.nextCursor===undefined)return items;
      if(typeof result.nextCursor!=='string'||result.nextCursor.length>1000)bad('MCP_INVALID_RESPONSE');cursor=result.nextCursor;
    }return bad('MCP_TOOL_LIMIT');
  },call:async(tool:McpDefinition,input:unknown)=>{
    const result=await post('tools/call',{name:tool.name,arguments:mcpValidate(tool,input)});
    if(result.isError)bad('MCP_TOOL_FAILED');
    if(!Array.isArray(result.content)||result.content.length>50||result.content.some((c:any)=>c.type!=='text'||typeof c.text!=='string'))bad('MCP_UNSUPPORTED_RESULT');
    return {content:result.content.map((c:any)=>({type:'text',text:c.text})),...(result.structuredContent!==undefined?{structuredContent:result.structuredContent}:{})};
  }};
}
