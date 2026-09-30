import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createBoundedHttps,timedExchange} from './boundedHttps.js';
test('bounded HTTPS pins public DNS, rejects redirects/private addresses/oversize and completes live SSE',async()=>{
  for(const scenario of ['ok','sse','private','redirect','large']){
    let requested=false;
    const exchange=createBoundedHttps({resolve4:(async()=>scenario==='private'?['8.8.8.8','127.0.0.1']:['8.8.8.8']) as any,request:((_url:URL,options:any,receive:any)=>{
      requested=true;options.lookup('example.com',{},(_e:unknown,ip:string)=>assert.equal(ip,'8.8.8.8'));assert.equal(options.agent,false);
      const req=new EventEmitter() as any;req.end=()=>{
        const body=scenario==='large'?'a'.repeat(262145):scenario==='sse'?'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n':'{}';
        const res=(scenario==='sse'?new Readable({read(){this.push(Buffer.from(body));this._read=()=>{};}}):Readable.from([Buffer.from(body)])) as any;
        res.statusCode=scenario==='redirect'?302:200;res.headers={'content-type':scenario==='sse'?'text/event-stream':'application/json'};receive(res);
      };return req;
    }) as any});
    const run=()=>timedExchange(exchange,new URL('https://example.com/mcp'),{method:'POST',headers:{},body:'{"id":1}'},200);
    if(['ok','sse'].includes(scenario))assert.equal((await run()).status,200);else await assert.rejects(run(),/UNSAFE_ADDRESS|INVALID_HTTP_RESPONSE|RESULT_TOO_LARGE/);
    assert.equal(requested,scenario!=='private');
  }
});
