import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callChatImage, ChatImageGatewayError, parseChatImageResponse, parseChatImageSse } from './responsesImageGateway.js';
import type { ModelConfig } from './types.js';

const result = Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
const payload = { status: 'completed', output: [{ type:'image_generation_call', status:'completed', output_format:'png', result }], usage: { input_tokens:12, output_tokens:3 } };
const model = { enabled:true, kind:'chat', protocol:'openai', apiKey:'synthetic-only', model:'selected-model', baseUrl:'https://example.invalid/v1', systemPrompt:'' } as ModelConfig;
test('completed image and text preserve provider usage without exposing upstream URL', () => {
  const response = parseChatImageResponse({...payload,output:[...payload.output,{type:'message',content:[{type:'output_text',text:'测试图'}]}]});
  assert.equal(response.content,'测试图'); assert.equal(response.imageCount,1); assert.equal(response.usage?.inputTokens,12);
  assert.equal(response.imageUrl,`data:image/png;base64,${result}`);
});
test('partial, missing, duplicate and malformed image results never become success', () => {
  for(const value of [{...payload,status:'incomplete'},{...payload,output:[]},{...payload,output:[...payload.output,...payload.output]},
    {...payload,output:[{...payload.output[0],status:'failed'}]}, {...payload,output:[{...payload.output[0],result:'https://example.invalid/private'}]},
    {...payload,output:[{...payload.output[0],result:Buffer.from('not an image').toString('base64')}]},
    {...payload,output:[{...payload.output[0],output_format:'jpeg'}]}]) assert.throws(()=>parseChatImageResponse(value),ChatImageGatewayError);
});
test('SSE accepts complete output, not partial image or completion notification alone', () => {
  const event = `data: ${JSON.stringify({type:'response.completed',response:payload})}\r\n\r\n`;
  assert.equal(parseChatImageSse(event).imageCount,1);
  assert.throws(()=>parseChatImageSse('data: {"type":"response.image_generation_call.completed"}\n\n'));
  assert.throws(()=>parseChatImageSse(event+event));
  assert.throws(()=>parseChatImageSse(event+'data: {"type":"response.failed"}\n\n'));
});
test('gateway keeps selected chat model, confines image tool, and does not retry auth failure', async () => {
  const previous=globalThis.fetch; let calls=0;
  globalThis.fetch=async(url,init)=>{
    calls++; assert.equal(String(url),'https://example.invalid/v1/responses'); assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,'selected-model'); assert.equal(body.store,false); assert.equal(body.parallel_tool_calls,false);
    assert.deepEqual(body.tool_choice,{type:'image_generation'}); assert.equal(body.tools.length,1); assert.equal(body.tools[0].model,undefined);
    return new Response(JSON.stringify({error:{message:'Forbidden synthetic-only secret echo'}}),{status:502});
  };
  try { await assert.rejects(()=>callChatImage(model,[{role:'user',content:'test',createdAt:''}]),e=>e instanceof ChatImageGatewayError && e.code==='authorization' && !e.message.includes('synthetic-only')); assert.equal(calls,1); }
  finally { globalThis.fetch=previous; }
});
test('body-read timeout remains active after headers arrive', async () => {
  const previous=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>new Response(new ReadableStream({start(c){init?.signal?.addEventListener('abort',()=>c.error(new Error('aborted')));}}),{headers:{'content-type':'text/event-stream'}});
  try { await assert.rejects(()=>callChatImage(model,[],{timeoutMs:20}),e=>e instanceof ChatImageGatewayError && e.code==='timeout'); }
  finally { globalThis.fetch=previous; }
});
test('reference images cannot introduce external URLs before authentication is sent', async () => {
  const previous=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('must not fetch');};
  try { await assert.rejects(()=>callChatImage(model,[{role:'user',content:'edit',createdAt:'',inputImageDataUrls:['https://example.invalid/private']}]),e=>e instanceof ChatImageGatewayError && e.code==='invalid_input_image'); assert.equal(calls,0); }
  finally { globalThis.fetch=previous; }
});

test('an explicit image rate limit retries before acceptance but cancellation prevents the next call',async()=>{
 let calls=0,checked=0;const notices:number[]=[];
 const response=await callChatImage(model,[],{retry:{fetch:async()=>++calls===1?new Response('',{status:429}):Response.json(payload),wait:async()=>{},beforeRetry:async()=>{checked++;},onRetry:async n=>{notices.push(n.attempt);}}});
 assert.equal(response.imageCount,1);assert.equal(calls,2);assert.equal(checked,1);assert.deepEqual(notices,[1]);
 calls=0;await assert.rejects(callChatImage(model,[],{retry:{fetch:async()=>{calls++;return new Response('',{status:429});},wait:async()=>{},beforeRetry:async()=>{throw new Error('stopped');}}}),ChatImageGatewayError);assert.equal(calls,1);
});
