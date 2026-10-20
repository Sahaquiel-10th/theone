import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { createNotionFetch, notionTransportOptions } from './notionTransport.js';

test('Notion transport preserves headers and signals, denies redirect and non-reviewed hosts', async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const request = createNotionFetch(async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://mcp.notion.com/mcp');
    assert.equal(init?.signal, signal);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture');
    assert.equal(init?.redirect, 'error');
    assert.ok((init as RequestInit & {dispatcher?:unknown}).dispatcher);
    return new Response('ok');
  });
  assert.equal(await (await request('https://mcp.notion.com/mcp', {headers:{Authorization:'Bearer fixture'}, signal, redirect:'follow'})).text(), 'ok');
  for(const url of ['http://mcp.notion.com/mcp','https://evil.example/mcp','https://mcp.notion.com.evil.example/mcp','https://user:password@mcp.notion.com/mcp'])
    assert.throws(()=>request(url), /./);
  assert.equal(calls, 1);
});

test('Notion connection options try another DNS address before sending one HTTP mutation', async () => {
  let writes = 0, lookups = 0;
  const server = http.createServer((req,res)=>{writes++;assert.equal(req.method,'POST');res.end('saved once');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agent = new Agent({...notionTransportOptions, connect:{...notionTransportOptions.connect,
    lookup:((_host:unknown,options:{all?:boolean},callback:Function)=>{
      lookups++;assert.equal(options.all,true);
      callback(null,[{address:'127.0.0.2',family:4},{address:'127.0.0.1',family:4}]);
    }) as any,
  }});
  try {
    const response = await undiciFetch(`http://one-fixture.example:${(server.address() as AddressInfo).port}`, {method:'POST',body:'synthetic',dispatcher:agent,signal:AbortSignal.timeout(4000)});
    assert.equal(await response.text(),'saved once');assert.equal(writes,1);assert.equal(lookups,1);
  } finally { await agent.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
});
