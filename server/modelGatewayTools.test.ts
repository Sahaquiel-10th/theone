import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { callModel, callModelWithTools, fetchWithTimeout, parseProviderUsage, safeProviderReason } from "./modelGateway.js";
import type { ModelConfig } from "./types.js";
import {runTaskOrchestrator} from './taskOrchestrator.js';

test('native correction after assistant prose ends with server continuation, not unsupported assistant prefill',async t=>{
 const requests:any[]=[];
 const server=createServer((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
  const data=JSON.parse(text);requests.push(data);res.setHeader('Content-Type','application/json');
  if(data.messages.at(-1)?.role==='assistant'){res.writeHead(400);res.end(JSON.stringify({error:{message:'This model does not support assistant message prefill. The conversation must end with a user message.'}}));return;}
  const content=requests.length===1?[{type:'text',text:'我已经查过了。'}]:requests.length===2?[{type:'tool_use',id:'real-search',name:'web_search',input:{query:'公开合成天气'}}]:[{type:'text',text:'已实际搜索，合成结果22度。'}];
  res.end(JSON.stringify({content,stop_reason:requests.length===2?'tool_use':'end_turn',usage:{input_tokens:10,output_tokens:10}}));
 });});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const model={id:'native-test',kind:'chat',enabled:true,apiKey:'fixture-secret',model:'fixture',protocol:'anthropic',baseUrl:`http://127.0.0.1:${(server.address() as any).port}`} as ModelConfig;
 let searches=0;
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[{role:'system',cacheScope:'stable',content:'固定范围'},{role:'user',content:'实际查合成天气'}],tools:[{name:'web_search',run:async()=>{searches++;return {status:'used',temperature:22};}}],maxSteps:4,maxCorrections:2,beforeStep:async()=>{},actionRequired:()=>searches?undefined:'尚未搜索，请实际调用工具。',call:(messages,tools,options)=>callModelWithTools(model,messages,tools,'continuation-fixture',options)});
 assert.equal(searches,1);assert.equal(requests.length,3);assert.match(result.content,/22/);
 assert.equal(requests[1].messages.at(-1).role,'user');assert.match(requests[1].messages.at(-1).content[0].text,/ONE 服务端续接/);
 assert.match(JSON.stringify(requests[1].system),/尚未搜索/);assert.deepEqual(requests[0].system[0],requests[1].system[0]);
 assert.match(safeProviderReason({error:{message:'This model does not support assistant message prefill.'}},400),/续接格式/);
});

for(const protocol of ['openai','anthropic'] as const)test(`${protocol}: final answer retains native tool history schemas, forbids another call and omits empty tool fields`,async()=>{
 const requests:any[]=[];
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const data=JSON.parse(body);requests.push(data);res.setHeader('Content-Type','application/json');
  const final=data.tool_choice==='none'||data.tool_choice?.type==='none';
  if(requests.length===2&&(!data.tools?.length||!final)){res.writeHead(400);res.end(JSON.stringify({error:{message:'tool_use history requires tools'}}));return;}
  const response=protocol==='openai'?{choices:[{message:final||!data.tools?{content:'查好了',tool_calls:[]}:{content:null,tool_calls:[{id:'call-search',type:'function',function:{name:'web_search',arguments:'{"query":"MDN"}'}}]},finish_reason:final?'stop':'tool_calls'}]}:{content:final||!data.tools?[{type:'text',text:'查好了'}]:[{type:'tool_use',id:'call-search',name:'web_search',input:{query:'MDN'}}],stop_reason:final?'end_turn':'tool_use'};
  res.end(JSON.stringify(response));
 });});server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();if(!addr||typeof addr==='string')throw Error('no address');
 const model={id:'test',kind:'chat',enabled:true,apiKey:'test',model:'fixture',baseUrl:`http://127.0.0.1:${addr.port}`,protocol} as ModelConfig;
 let executions=0,verified=0;
 try{
  const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[{role:'user',content:'查MDN'}],tools:[{name:'web_search',run:async()=>{executions++;return {sources:[{url:'https://developer.mozilla.org/'}]};}}],maxSteps:2,beforeStep:async()=>{verified++;},call:(messages,tools,options)=>callModelWithTools(model,messages,tools,'final-test',{...options,maxOutputTokens:10000})});
  assert.equal(result.content,'查好了');assert.equal(executions,1);assert.equal(verified,3);
  assert.equal(requests[1].max_tokens,10000);assert.equal(requests[1].tools.length,1);
  await assert.rejects(()=>callModelWithTools(model,[],[],undefined,{finalSummaryTools:[],requiredTool:'web_search'}),/不能同时/);
  await assert.rejects(()=>callModelWithTools(model,[],[],undefined,{maxOutputTokens:12001}),/输出上限/);
  await callModelWithTools(model,[{role:'user',content:'只回答'}],[]);
  assert.equal(requests[2].tools,undefined);assert.equal(requests[2].tool_choice,undefined);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("passes OpenAI function tools and returns tool calls", async () => {
  let received: any;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const model = {
    id: "model-a", name: "Test", provider: "test", kind: "chat", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "server-only-key", model: "test-model", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString()
  } satisfies ModelConfig;
  try {
    const result = await callModelWithTools(model, [{ role: "user", content: "查看文件", inputImageDataUrls:["data:image/png;base64,aGVsbG8="] }], [{
      type: "function", function: { name: "list_files", description: "list", parameters: { type: "object" } }
    }], "tool-test");
    assert.equal(received.tool_choice, "auto");
    assert.deepEqual(received.messages[0].content,[{type:"text",text:"查看文件"},{type:"image_url",image_url:{url:"data:image/png;base64,aGVsbG8="}}]);
    assert.equal(received.messages[0].inputImageDataUrls,undefined);
    assert.equal(received.tools[0].function.name, "list_files");
    assert.equal(result.toolCalls[0].function.name, "list_files");
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16, source: "provider" });
    const tools = [{ type: "function" as const, function: { name: "list_files", description: "list", parameters: { type: "object" } } }];
    await callModelWithTools(model, [{ role: "user", content: "明确查看" }], tools, "required-openai", { requiredTool: "list_files" });
    assert.deepEqual(received.tool_choice, { type: "function", function: { name: "list_files" } });
    await assert.rejects(callModelWithTools(model, [], tools, "invalid", { requiredTool: "foreign_tool" }), /指定工具未授权/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("translates Anthropic tool use and tool results", async () => {
  let received: any;
  let requestPath = "";
  let apiKey = "";
  const server = createServer((request, response) => {
    requestPath = request.url || "";
    apiKey = String(request.headers["x-api-key"] || "");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        content: [
          { type: "text", text: "继续检查。" },
          { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "README.md" } }
        ],
        usage: { input_tokens: 18, output_tokens: 7 }
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const model = {
    id: "model-b", name: "Claude", provider: "test", kind: "chat", protocol: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "anthropic-server-key", model: "claude-test", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString()
  } satisfies ModelConfig;
  try {
    const result = await callModelWithTools(model, [
      { role: "system", content: "只操作授权目录" },
      { role: "user", content: "查看文件", inputImageDataUrls:["data:image/png;base64,aGVsbG8="] },
      { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "list_files", arguments: "{\"path\":\".\"}" } }] },
      { role: "tool", tool_call_id: "tool-1", content: "README.md" }
    ], [{
      type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }
    }], "anthropic-tool-test");
    assert.equal(requestPath, "/messages");
    assert.equal(apiKey, "anthropic-server-key");
    assert.equal(received.system, "只操作授权目录");
    assert.ok(received.messages[0].content.some((block:any)=>block.type==="image"&&block.source.media_type==="image/png"&&block.source.data==="aGVsbG8="));
    assert.equal(received.messages[0].inputImageDataUrls,undefined);
    assert.equal(received.tool_choice.type, "auto");
    assert.equal(received.tools[0].name, "read_file");
    assert.equal(received.tools[0].input_schema.type, "object");
    assert.equal(received.messages[1].content[0].type, "tool_use");
    assert.equal(received.messages[2].content[0].type, "tool_result");
    assert.equal(received.messages[2].content[0].tool_use_id, "tool-1");
    assert.equal(result.content, "继续检查。");
    assert.equal(result.toolCalls[0].function.name, "read_file");
    assert.equal(result.toolCalls[0].function.arguments, "{\"path\":\"README.md\"}");
    assert.deepEqual(result.usage, { inputTokens: 18, outputTokens: 7, totalTokens: 25, source: "provider" });
    await callModelWithTools(model, [{ role: "user", content: "明确读取" }], [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }], "required-anthropic", { requiredTool: "read_file" });
    assert.deepEqual(received.tool_choice, { type: "tool", name: "read_file", disable_parallel_tool_use: true });
    await callModelWithTools(model,[{role:'user',content:'仅回答，不调用工具'}],[],'anthropic-no-tools');
    assert.equal(received.tools,undefined);
    assert.equal(received.tool_choice,undefined);
    assert.equal(received.temperature,undefined);
    await callModel(model,[{role:'user',content:'仅回答',createdAt:new Date().toISOString()}],'','anthropic-plain');
    assert.equal(received.temperature,undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('provider diagnostics use reviewed reasons and never echo secrets or user content',()=>{
  assert.match(safeProviderReason({error:{message:'tool_choice requires tools sk-secret user-private'}},400),/工具调用/);
  assert.doesNotMatch(safeProviderReason({error:{message:'sk-secret user-private https://private'}},400),/sk-secret|user-private|https/);
});

test("leaves usage unknown when a gateway omits token counts instead of inventing a charge", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "完成", tool_calls: [] } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未启动");
  const model = {
    id: "model-c", name: "No usage", provider: "test", kind: "chat", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "server-only-key", model: "test-model", systemPrompt: "",
    enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1,
    costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: new Date().toISOString()
  } satisfies ModelConfig;
  try {
    const result = await callModelWithTools(model, [{ role: "user", content: "做一件事" }], [], "estimated-usage-test");
    assert.equal(result.usage, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("invalid and partial provider usage cannot become billable zero or negative tokens", () => {
  for (const usage of [undefined, {}, { prompt_tokens: null, completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: "12", completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 2 }]) {
    assert.equal(parseProviderUsage(usage), undefined);
  }
  assert.deepEqual(parseProviderUsage({ input_tokens: 0, output_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, source: "provider" });
});

test("OpenAI cache reads are a subset, while Anthropic cache counters are independent", () => {
  assert.deepEqual(parseProviderUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 600 } }), { inputTokens: 400, outputTokens: 200, totalTokens: 1200, cacheUsage: { read: 600, write: 0, write5m: 0, write1h: 0 }, source: "provider" });
  assert.deepEqual(parseProviderUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 20 } }), { inputTokens: 100, outputTokens: 20, totalTokens: 420, cacheUsage: { read: 200, write: 100, write5m: 80, write1h: 20 }, source: "provider" });
  const aggregate = parseProviderUsage({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50 });
  assert.deepEqual(aggregate?.cacheUsage, { read: 0, write: 50, write5m: 0, write1h: 0 });
  assert.equal(parseProviderUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } })?.inputTokens, 40);
});
test("malformed or contradictory cache counters cannot enter billing", () => {
  for (const usage of [
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } },
    { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: -1 },
    { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 3 } },
    { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: "2" },
    { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: null },
    { input_tokens: 10, output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: null } },
    { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 10, total_tokens: 11 },
    { prompt_tokens: 10, completion_tokens: 1, cache_creation_input_tokens: 2 },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1 }, cache_read_input_tokens: 2 }
  ]) assert.equal(parseProviderUsage(usage), undefined);
});

test("the gateway deadline also covers a stalled response body", async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  try { await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, 80), /超时/); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("provider error bodies do not leak echoed credentials or prompts into user errors and logs", async () => {
  const secret = "DO_NOT_EXPOSE_PRIVATE_PROMPT_OR_KEY";
  const server = createServer((_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: secret } })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  const errors: unknown[] = []; const original = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    await assert.rejects(callModelWithTools({ id: "test", enabled: true, apiKey: secret, kind: "chat", protocol: "openai", baseUrl: `http://127.0.0.1:${address.port}`, model: "test" } as ModelConfig, [{ role: "user", content: secret }], []), (error: Error) => !error.message.includes(secret) && error.message.includes("403"));
    assert.equal(JSON.stringify(errors).includes(secret), false);
  } finally { console.error = original; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
