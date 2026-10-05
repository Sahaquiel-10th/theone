import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sendThingMessage } from './sendThingMessage';
import { api, ApiError } from './oneApi';

test('Things continues the selected conversation, not the workbench, and awaits pending results', async () => {
  const calls: {path:string;body?:string}[] = [];
  let polls=0;
  const request = (async (path:string,options?:RequestInit) => {
    calls.push({path,body:options?.body as string});
    if(path==='/api/chat') return {pending:true};
    if(++polls===1) throw new ApiError('pending',undefined,409,'CHAT_OPERATION_PENDING');
    return {conversation:{id:'selected',messages:['answer']}};
  }) as typeof api;
  const result=await sendThingMessage<{id:string}>(request,randomUUID(),{conversationId:'selected',modelId:'original-model',agentId:'original-agent',content:'follow-up'},async()=>{});
  assert.equal(result.id,'selected');
  assert.deepEqual(JSON.parse(calls[0].body!).conversationId,'selected');
  assert.equal(JSON.parse(calls[0].body!).agentId,'original-agent');
  assert.equal(calls.length,3);
});

test('Things ambiguous failures retain the operation ID; accounts and conversations never share it', async () => {
  const ids:string[]=[];
  let fail=true;
  const request=(async(_path:string,options:RequestInit)=>{
    const payload=JSON.parse(options.body as string);ids.push(payload.operationId);
    if(fail)throw new Error('timeout');
    return {conversation:{id:payload.conversationId}};
  }) as typeof api;
  const owner=randomUUID(),payload={conversationId:'task-a',modelId:'model',content:'same'};
  await assert.rejects(sendThingMessage(request,owner,payload));
  fail=false;
  await sendThingMessage(request,owner,payload);
  await sendThingMessage(request,randomUUID(),payload);
  await sendThingMessage(request,owner,{...payload,conversationId:'task-b'});
  assert.equal(ids[0],ids[1]);
  assert.notEqual(ids[1],ids[2]);
  assert.notEqual(ids[1],ids[3]);
});

test('Things does not clear an unconfirmed response or submit a missing model', async()=>{
  const request=(async()=>({})) as typeof api;
  await assert.rejects(sendThingMessage(request,randomUUID(),{conversationId:'task',modelId:'model',content:'hi'}),/尚未确认/);
  await assert.rejects(sendThingMessage(request,randomUUID(),{conversationId:'task',modelId:'',content:'hi'}),/模型暂不可用/);
});
