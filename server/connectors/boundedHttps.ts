import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { publicIpv4, StandardToolError } from "./standardHttp.js";

export type ToolExchange = (url: URL, input: { method: "GET" | "POST"; headers: Record<string,string>; body?: string }, signal: AbortSignal) => Promise<{ status: number; contentType: string; sessionId?: string; text: string }>;
export function safeToolEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || isIP(url.hostname) || !url.hostname.includes('.') || /\.(local|internal|localhost)\.?$/i.test(url.hostname)) throw new StandardToolError('UNSAFE_ENDPOINT');
  return url;
}
export function createBoundedHttps(deps = {resolve4,request}): ToolExchange {
  return async (url,input,signal) => {
    // Queries belong to the validated HTTP adapter, never credentials.
    const base=new URL(url);base.search='';safeToolEndpoint(base.href);
    const addresses=await deps.resolve4(url.hostname);signal.throwIfAborted();
    if(!addresses.length||addresses.some(a=>!publicIpv4(a)))throw new StandardToolError('UNSAFE_ADDRESS');
    return new Promise((resolve,reject)=>{
      const req=deps.request(url,{method:input.method,agent:false,signal,family:4,lookup:(_h,_o,cb)=>cb(null,addresses[0],4),headers:{...input.headers,'Accept-Encoding':'identity'}},res=>{
        if(![200,202].includes(res.statusCode??0)){res.destroy();reject(new StandardToolError(res.statusCode===401||res.statusCode===403?'TOOL_AUTH_REQUIRED':'INVALID_HTTP_RESPONSE'));return;}
        let size=0;const chunks:Buffer[]=[];
        const result=(text:string)=>({status:res.statusCode!,contentType:String(res.headers['content-type']??''),sessionId:typeof res.headers['mcp-session-id']==='string'?res.headers['mcp-session-id']:undefined,text});
        let requestId:unknown;try{requestId=JSON.parse(input.body??'{}').id;}catch{/* GET has no RPC body */}
        res.on('data',(chunk:Buffer)=>{
          size+=chunk.length;if(size>262144){res.destroy(new StandardToolError('RESULT_TOO_LARGE'));return;}chunks.push(chunk);
          // Streamable HTTP may keep its stream open after the response. Finish
          // at a complete matching event; never wait for an idle server to close.
          if(requestId!==undefined&&/^text\/event-stream(?:\s*;|$)/i.test(String(res.headers['content-type']??''))){
            const text=Buffer.concat(chunks).toString('utf8').replace(/\r\n/g,'\n');const end=text.lastIndexOf('\n\n');
            if(end>=0){const complete=text.slice(0,end+2);try{
              const messages=complete.split('\n\n').map(block=>block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(s=>JSON.parse(s));
              if(messages.some(m=>m?.id===requestId&&!m.method)){resolve(result(complete));res.destroy();}
            }catch{res.destroy(new StandardToolError('MCP_INVALID_RESPONSE'));}}
          }
        });
        res.on('error',reject);
        res.on('end',()=>resolve(result(Buffer.concat(chunks).toString('utf8'))));
      });req.on('error',reject);req.end(input.body);
    });
  };
}
export const boundedHttps=createBoundedHttps();
export async function timedExchange(exchange:ToolExchange,url:URL,input:Parameters<ToolExchange>[1],timeoutMs=10000){
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([exchange(url,input,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new StandardToolError('TOOL_TIMEOUT'));},timeoutMs);})]);}
  catch(e){throw e instanceof StandardToolError?e:new StandardToolError('TOOL_UNAVAILABLE');}
  finally{clearTimeout(timer);controller.abort();}
}
