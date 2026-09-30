import test from 'node:test';
import assert from 'node:assert/strict';
import {executableFeatureTools} from './featureToolExecution.js';
import {syntheticMcpTool} from './mcpSandbox.js';
import {sandboxMcpEndpoint} from './featureTools.js';
import {setFeatureCredential} from './featureCredentials.js';
import type {Database} from './types.js';
import type {Store} from './db.js';
import type {ToolExchange} from './connectors/boundedHttps.js';
test('execution uses own auth, redacts reflected secrets and stops before calling drifted tools',async()=>{
  const db={users:[{id:'u',enabled:true}],workspaces:[{id:'w',status:'active'}],workspaceMembers:[{workspaceId:'w',userId:'u'}]} as unknown as Database;
  const scope={workspaceId:'w',userId:'u'},store:Store={read:async()=>db,mutate:async fn=>fn(db)};
  setFeatureCredential(db,scope,sandboxMcpEndpoint,'bearer','synthetic-secret');
  let drift=false,calls=0;
  const exchange:ToolExchange=async(_url,input)=>{
    assert.equal(input.headers.Authorization,'Bearer synthetic-secret');const b=JSON.parse(input.body!);
    if(b.method==='notifications/initialized')return {status:202,contentType:'',text:''};
    if(b.method==='tools/call')calls++;
    const result=b.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:b.method==='tools/list'?{tools:[drift?{...syntheticMcpTool,annotations:{readOnlyHint:false}}:syntheticMcpTool]}:{content:[{type:'text',text:'synthetic-secret'}]};
    return {status:200,contentType:'application/json',text:JSON.stringify({jsonrpc:'2.0',id:b.id,result})};
  };
  const tool=executableFeatureTools(store,scope,[{id:'lookup',description:'read',auth:'bearer',mcp:{endpoint:sandboxMcpEndpoint,tool:syntheticMcpTool,reviewedReadOnly:true}}],async()=>{}, {exchange})[0];
  const result=await tool.structured!.run({itemId:101});assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);assert.equal(calls,1);
  drift=true;await assert.rejects(tool.structured!.run({itemId:101}),/定义已变化/);assert.equal(calls,1);
});
