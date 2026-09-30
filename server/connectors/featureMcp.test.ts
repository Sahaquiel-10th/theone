import test from 'node:test';
import assert from 'node:assert/strict';
import {openFeatureMcp,mcpDefinition,mcpDigest} from './featureMcp.js';
import type {ToolExchange} from './boundedHttps.js';
const tool=mcpDefinition({name:'read-item',inputSchema:{type:'object',properties:{id:{type:'integer'}},required:['id']},annotations:{readOnlyHint:true}});
test('MCP initialize, session headers, discovery without execution and JSON/SSE results',async()=>{
  const calls:string[]=[];
  const exchange:ToolExchange=async(url,input)=>{
    assert.equal(url.href,'https://example.com/mcp');assert.equal(input.headers.Authorization,'Bearer synthetic');
    const r=JSON.parse(input.body!);calls.push(r.method);
    if(r.method!=='initialize'){assert.equal(input.headers['MCP-Session-Id'],'session');assert.equal(input.headers['MCP-Protocol-Version'],'2025-11-25');}
    if(r.method==='notifications/initialized')return {status:202,contentType:'',text:''};
    const result=r.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:r.method==='tools/list'?{tools:[tool]}:{content:[{type:'text',text:'synthetic result'}]};
    return {status:200,contentType:r.method==='tools/call'?'text/event-stream':'application/json',sessionId:'session',text:r.method==='tools/call'?`data: ${JSON.stringify({jsonrpc:'2.0',id:r.id,result})}\n\n`:JSON.stringify({jsonrpc:'2.0',id:r.id,result})};
  };
  const client=await openFeatureMcp('https://example.com/mcp',{Authorization:'Bearer synthetic'},exchange);
  assert.deepEqual(await client.list(),[tool]);assert.equal(calls.includes('tools/call'),false);
  assert.deepEqual(await client.call(tool,{id:1}),{content:[{type:'text',text:'synthetic result'}]});
  await assert.rejects(client.call(tool,{id:'wrong'}));assert.equal(calls.filter(c=>c==='tools/call').length,1);
});
test('definitions require readonly, supported schemas and canonical pinning',()=>{
  assert.throws(()=>mcpDefinition({...tool,annotations:{}}));
  assert.throws(()=>mcpDefinition({...tool,inputSchema:{type:'object',properties:{nested:{type:'object'}}}}));
  assert.equal(mcpDigest(tool),mcpDigest({...tool,name:tool.name}));
  assert.notEqual(mcpDigest(tool),mcpDigest({...tool,description:'changed'}));
});
