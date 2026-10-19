import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database, ModelConfig} from './types.js';
import type {Store} from './db.js';
import {callNativeSearch, nativeSearchModel, nativeSearchResult,NativeSearchError} from './providerNativeSearch.js';
import {publicSearchOutcome} from './publicSearch.js';
import {createWorkspaceSearch, type PublicSearchContext} from './webSearch.js';

const model = {id:'model',name:'GPT',kind:'chat',protocol:'openai',model:'configured-model',baseUrl:'https://app.yylx.io/v1',apiKey:'TEST_SECRET',enabled:true,isDefault:true,systemPrompt:'PRIVATE_MODEL_PROMPT',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:.5,costOutputPowerPerMillion:.5} as ModelConfig;
test('search diagnostics classify timeout, incomplete stream and HTTP rejection without exposing upstream text or auto-replaying accepted requests',async()=>{
 const timeout=new NativeSearchError(false,'search_timeout');
 const result=await publicSearchOutcome(async()=>{throw timeout;},'public query');
 assert.ok('code' in result&&'message' in result);
 assert.equal(result.code,'search_timeout');assert.match(result.message!,/等得有点久/);
 await assert.rejects(()=>callNativeSearch(model,'public query',{fetch:async()=>new Response('TEST_SECRET',{status:400})}),error=>error instanceof NativeSearchError&&error.code==='search_http_rejected'&&error.httpStatus===400&&!error.retryable&&!error.message.includes('TEST_SECRET'));
 await assert.rejects(()=>callNativeSearch(model,'public query',{fetch:async()=>new Response('data: {"type":"response.created"}\n\n',{headers:{'content-type':'text/event-stream'}})}),error=>error instanceof NativeSearchError&&error.code==='search_stream_incomplete'&&!error.retryable);
});
const payload = () => ({status:'completed',usage:{input_tokens:100,output_tokens:10,total_tokens:110},output:[
  {type:'web_search_call',status:'completed',action:{sources:[{url:'https://example.com/reference'}]}},
  {type:'message',role:'assistant',content:[{type:'output_text',text:'公开资料摘要',annotations:[{type:'url_citation',title:'正式资料',url:'https://example.com/reference?utm_source=openai'}]}]},
]});
const streaming = (response = payload()) => new Response(`data: ${JSON.stringify({type:'response.completed',response})}\r\n\r\ndata: [DONE]\r\n\r\n`,{headers:{'content-type':'text/event-stream'}});

test('native search requires real completed search evidence and safe cited sources, never prose links alone',()=>{
  assert.equal(nativeSearchResult(payload()).searchCompleted,true);
  assert.equal(nativeSearchResult({...payload(),status:'incomplete'}).searchCompleted,false);
  assert.equal(nativeSearchResult({...payload(),output:payload().output.slice(1)}).searchCompleted,false);
  const result=nativeSearchResult(payload());assert.equal(result.sources.length,1);assert.equal(result.sources[0].title,'正式资料');
  assert.equal(result.sources[0].url,'https://example.com/reference');assert.match(result.sources[0].snippet,/不是网页逐字原文/);
  const bad=payload();(bad.output[1] as any).content[0].annotations=[{type:'url_citation',url:'https://example.com/?token=secret'}];(bad.output[0] as any).action.sources=[];
  assert.equal(nativeSearchResult(bad).searchCompleted,false);
});

test('native search uses only the reviewed endpoint, minimal public query and configured model; private prompts never travel',async()=>{
  let calls=0;
  const result=await callNativeSearch(model,'查公开资料',{fetch:async(url,init)=>{
    calls++;assert.equal(url,'https://app.yylx.io/v1/responses');assert.equal(init?.redirect,'error');
    const body=JSON.parse(init!.body as string);assert.equal(body.model,'configured-model');assert.equal(body.store,false);
    assert.deepEqual(body.include,['web_search_call.action.sources']);assert.equal(body.input,'查公开资料');assert.equal(body.tool_choice,'required');
    assert.doesNotMatch(JSON.stringify(body),/PRIVATE_MODEL_PROMPT|TEST_SECRET/);return streaming();
  }});
  assert.equal(calls,1);assert.equal(result.searchCompleted,true);assert.equal(result.usage?.inputTokens,100);
  assert.equal(nativeSearchModel({...model,baseUrl:'https://evil.example/v1'}),false);
  assert.equal(nativeSearchModel({...model,baseUrl:'https://app.yylx.io/v1?token=x'}),false);
  await assert.rejects(callNativeSearch(model,'api_key: sk-private12345678',{fetch:async()=>{throw Error('must not fetch')}}),/私人/);
  const leak=payload();(leak.output[1] as any).content[0].text=model.apiKey;
  await assert.rejects(callNativeSearch(model,'公开资料',{fetch:async()=>streaming(leak)}),error=>error instanceof Error&&!error.message.includes(model.apiKey));
});

test('native stream truncation, failure, oversize and body timeout remain bounded and never expose raw provider errors',async()=>{
  for(const response of [new Response('data: {"type":"response.created"}\n\n',{headers:{'content-type':'text/event-stream'}}),
    new Response('data: {"type":"error","error":{"message":"TEST_SECRET"}}\n\n',{headers:{'content-type':'text/event-stream'}}),
    new Response('TEST_SECRET',{status:401}),new Response('x'.repeat(2*1024*1024+1))]){
    await assert.rejects(callNativeSearch(model,'公开资料',{fetch:async()=>response}),error=>error instanceof Error&&!error.message.includes('TEST_SECRET'));
  }
  await assert.rejects(callNativeSearch(model,'公开资料',{timeoutMs:3000,fetch:async(_url,init)=>new Response(new ReadableStream({start(controller){init!.signal!.addEventListener('abort',()=>controller.error(Error('aborted')));}}),{headers:{'content-type':'text/event-stream'}})}),error=>error instanceof NativeSearchError&&error.code==='search_timeout'&&!error.retryable);
});

function fixture(){
  let db={users:[{id:'a',enabled:true},{id:'b',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{userId:'a',workspaceId:'wa'},{userId:'b',workspaceId:'wb'}],models:[structuredClone(model)],
    conversations:[{id:'ca',workspaceId:'wa',userId:'a',archived:false},{id:'cb',workspaceId:'wb',userId:'b',archived:false}],
    chatOperations:[{workspaceId:'wa',userId:'a',conversationId:'ca',requestId:'request-a',status:'pending'},{workspaceId:'wb',userId:'b',conversationId:'cb',requestId:'request-b',status:'pending'}],
    modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'pa',workspaceId:'wa',userId:'a',balanceMicros:1000000},{id:'pb',workspaceId:'wb',userId:'b',balanceMicros:1000000}]} as unknown as Database;
  const store:Store={read:async()=>db,mutate:async change=>{const before=structuredClone(db);try{return change(db);}catch(error){db=before;throw error;}}};
  const context:PublicSearchContext={workspaceId:'wa',userId:'a',conversationId:'ca',requestId:'request-a',verify:async()=>{}};
  return {store,context,db:()=>db};
}

test('scoped search rejects foreign membership, conversation, operation, stopped work and Key loss before fetch or billing',async()=>{
  const f=fixture();let calls=0;const service=createWorkspaceSearch(f.store,{env:{},fetch:async()=>{calls++;return streaming();}});
  for(const context of [{...f.context,workspaceId:'wb'},{...f.context,conversationId:'cb'},{...f.context,requestId:'request-b'},
    {...f.context,verify:async()=>{throw Error('Key removed')}}])await assert.rejects(service.search('公开资料',context));
  f.db().chatOperations![0].status='completed';await assert.rejects(service.search('公开资料',f.context));
  assert.equal(calls,0);assert.equal(f.db().modelUsageRecords.length,0);
});

test('search freezes existing rates, attributes actual usage once, honors budget and leaves the other workspace untouched',async()=>{
  const f=fixture();let calls=0;const service=createWorkspaceSearch(f.store,{env:{},fetch:async()=>{calls++;return streaming();}});
  assert.equal(service.enabled(f.db()),true);
  await assert.rejects(service.search('公开资料',{...f.context,beforeReserve:()=>{throw Error('budget exceeded')}}),/budget exceeded/);
  assert.equal(calls,0);
  const result=await service.search('公开资料',f.context);assert.equal((result as any[]).length,1);
  const row=f.db().modelUsageRecords[0];assert.equal(row.activity,'web_search');assert.equal(row.workspaceId,'wa');assert.equal(row.chargedMicros,110);
  assert.equal(row.inputPowerPerMillionSnapshot,1);assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(result),/TEST_SECRET|PRIVATE_MODEL_PROMPT/);
});

test('only rejected transient HTTP calls retry; accepted broken streams never silently replay, no fallback provider is purchased',async()=>{
  const f=fixture();let calls=0;const service=createWorkspaceSearch(f.store,{env:{},sleep:async()=>{},fetch:async()=>++calls===1?new Response('TEST_SECRET',{status:503}):streaming()});
  await service.search('公开资料',f.context);assert.equal(calls,2);assert.equal(f.db().modelUsageRecords.filter(row=>row.status==='success').length,1);
  const g=fixture();calls=0;const broken=createWorkspaceSearch(g.store,{env:{},sleep:async()=>{},fetch:async()=>{calls++;return new Response('data: {"type":"response.created"}\n\n',{headers:{'content-type':'text/event-stream'}})}});
  await assert.rejects(broken.search('公开资料',g.context));assert.equal(calls,1);
  assert.equal(createWorkspaceSearch(g.store,{env:{SEARCH_PROVIDER:'none'}}).enabled(g.db()),false);
  assert.equal(createWorkspaceSearch(g.store,{env:{SEARCH_PROVIDER:'tavily'}}).enabled(g.db()),false);
  assert.equal(createWorkspaceSearch(g.store,{env:{WEB_SEARCH_MODEL_ID:'not-configured'}}).enabled(g.db()),false);
});

test('a stopped owner cannot receive a late search result; actual completed usage stays with that owner',async()=>{
  const f=fixture();let calls=0;
  const service=createWorkspaceSearch(f.store,{env:{},fetch:async()=>{calls++;f.db().chatOperations![0].status='failed';return streaming();}});
  await assert.rejects(service.search('公开资料',f.context),/已停止/);
  assert.equal(calls,1);assert.equal(f.db().modelUsageRecords.length,1);
  assert.equal(f.db().modelUsageRecords[0].workspaceId,'wa');assert.equal(f.db().modelUsageRecords[0].status,'success');
  assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);
});
