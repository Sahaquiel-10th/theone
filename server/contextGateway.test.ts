import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {callModelWithTools,type ModelToolMessage} from './modelGateway.js';
import {compileOneContext} from './oneContext.js';
import type {ModelConfig} from './types.js';
for(const protocol of ['openai','anthropic'] as const)test(`${protocol}: stable prefix is explicit, dynamic facts remain after it, no internal annotation leaks`,async t=>{
 const bodies:any[]=[];
 const server=createServer((req,res)=>{let text='';req.on('data',data=>text+=data);req.on('end',()=>{bodies.push(JSON.parse(text));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(protocol==='anthropic'?{content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:3,output_tokens:2}}:{choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}));});});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const model={id:'m',enabled:true,kind:'chat',apiKey:'fixture-secret',model:'fixture',baseUrl:`http://127.0.0.1:${(server.address() as any).port}`,protocol} as ModelConfig;
 for(const day of ['2026-10-22','2026-10-23']){
  const messages:ModelToolMessage[]=[{role:'system',content:`日期：${day}；本轮参考资料`},{role:'system',cacheScope:'stable',content:'固定权限和职责'},{role:'user',content:'用公开合成资料回答'}];
  await callModelWithTools(model,compileOneContext(messages),[],'cache-fixture');
 }
 assert.doesNotMatch(JSON.stringify(bodies),/cacheScope|fixture-secret/);
 if(protocol==='anthropic'){
  assert.deepEqual(bodies[0].system[0],bodies[1].system[0]);assert.equal(bodies[0].system[0].cache_control.ttl,'5m');
  assert.equal(bodies[0].system.filter((b:any)=>b.cache_control).length,1);assert.match(bodies[0].system[1].text,/2026-10-22/);assert.match(bodies[1].system[1].text,/2026-10-23/);
 }else assert.equal(bodies[0].messages[0].content,'固定权限和职责');
});
