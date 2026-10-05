import type { Store } from './db.js';
import { featureToolEndpoint,resolveFeatureTool,type FeatureToolChoice } from './featureTools.js';
import { toolCredential,redactToolSecret } from './featureCredentials.js';
import { openFeatureMcp,mcpDefinition,mcpDigest,mcpValidate } from './connectors/featureMcp.js';
import { boundedHttps,timedExchange,type ToolExchange } from './connectors/boundedHttps.js';
import { callReadOnlyHttp,validateFields,StandardToolError,type JsonTransport } from './connectors/standardHttp.js';
import { OrchestrationToolError, type OrchestrationTool } from './taskOrchestrator.js';

export function executableFeatureTools(store:Store,scope:{workspaceId:string;userId:string},choices:FeatureToolChoice[],verify:()=>Promise<void>,deps:{transport?:JsonTransport;exchange?:ToolExchange}={}):OrchestrationTool[]{
  return choices.map(choice=>{
    const endpoint=featureToolEndpoint(choice),http=choice.mcp?undefined:resolveFeatureTool(choice),mcp=choice.mcp?.tool;
    return{name:choice.id,description:choice.description,run:async()=>{throw new Error('需要结构化参数');},structured:{
      schema:mcp?{...mcp.inputSchema,additionalProperties:false}:{type:'object',additionalProperties:false,properties:http!.input,required:http!.required},
      validate:input=>mcp?mcpValidate(mcp,input):validateFields(input,http!.input,http!.required),
      run:async input=>{
        await verify();const credential=toolCredential(await store.read(),scope,endpoint,choice.auth);let output:unknown;
        try{
          if(mcp){
            const client=await openFeatureMcp(endpoint,credential.headers,deps.exchange);
            await verify();const listed=await client.list();const matches=listed.filter(t=>t.name===mcp.name);
            try { if(matches.length!==1||mcpDigest(mcpDefinition(matches[0]))!==mcpDigest(mcp))throw new Error('changed'); }
            catch { throw new StandardToolError('MCP_TOOL_CHANGED'); }
            await verify();output=await client.call(mcp,input);
          }else if(choice.auth){
            const transport:JsonTransport=async(url,_signal)=>{
              const r=await timedExchange(deps.exchange??boundedHttps,url,{method:'GET',headers:{...credential.headers,Accept:'application/json'}});
              if(r.status!==200||!/^application\/json(?:\s*;|$)/i.test(r.contentType))throw new StandardToolError('INVALID_HTTP_RESPONSE');
              return JSON.parse(r.text);
            };
            output=await callReadOnlyHttp(http!,input,transport);
          }else output=await callReadOnlyHttp(http!,input,deps.transport);
        }catch(e){
          // Definition drift must stop the task, not let an answer hide the change.
          if(e instanceof StandardToolError&&e.code==='MCP_TOOL_CHANGED')throw new OrchestrationToolError('TOOL_DEFINITION_CHANGED','MCP 工具定义已变化，请管理员重新发现并认定');
          output={status:'failed',code:e instanceof StandardToolError?e.code:'TOOL_UNAVAILABLE'};
        }
        await verify();return redactToolSecret(output,credential.secret);
      }
    }};
  });
}
