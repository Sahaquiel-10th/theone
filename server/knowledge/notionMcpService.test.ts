import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { decryptCredential, encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import { NotionMcpService, NotionWriteError } from "./notionMcpService.js";

function fixture() {
  const database = { knowledgeConnections: [], auditLogs: [] } as unknown as Database;
  const store = {
    async read() { return database; },
    async mutate<T>(fn: (db: Database) => T) { return fn(database); }
  } as Store;
  return { database, store };
}

test("Notion OAuth uses PKCE, stores only encrypted tokens and rejects state replay", async () => {
  const f = fixture();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/register")) return new Response(JSON.stringify({ client_id: "notion-client" }));
    if (String(input).endsWith("/token")) return new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, workspace_id: "notion-space", workspace_name: "My Notion", user_id: "notion-user" }));
    throw new Error("unexpected request");
  };
  const createClient = async (token: string) => ({
    async listTools() { return { tools: [{ name: "notion-fetch" }] }; },
    async callTool() { assert.equal(token, "access-secret"); return { content: [{ type: "text", text: "verified" }] }; },
    async close() {}
  });
  const service = new NotionMcpService(f.store, { fetch: fetcher as typeof fetch, createClient });
  const started = await service.beginAuthorization({ workspaceId: "workspace-a", userId: "user-a", appOrigin: "https://one.example" });
  const authorization = new URL(started.authorizationUrl);
  const state = authorization.searchParams.get("state")!;
  assert.equal(authorization.origin, "https://mcp.notion.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), "https://one.example/api/knowledge/connections/notion/oauth/callback");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("code_challenge"));
  const registrationBody = JSON.parse(String(requests[0].init?.body));
  assert.equal(registrationBody.token_endpoint_auth_method, "none");

  // A different service instance can finish the callback after a restart.
  const restarted = new NotionMcpService(f.store, { fetch: fetcher as typeof fetch, createClient });
  const connection = await restarted.completeAuthorization(state, "one-time-code");
  assert.equal(connection.workspaceId, "workspace-a");
  assert.equal(connection.providerSpaceName, "My Notion");
  assert.equal(decryptCredential(connection.encryptedAccessToken!, knowledgeCredentialContext("workspace-a", "notion", "access_token")), "access-secret");
  assert.equal(decryptCredential(connection.encryptedRefreshToken!, knowledgeCredentialContext("workspace-a", "notion", "refresh_token")), "refresh-secret");
  assert.doesNotMatch(JSON.stringify(connection), /access-secret|refresh-secret|client-secret/);
  const tokenBody = String(requests[1].init?.body);
  assert.match(tokenBody, /code_verifier=/);
  assert.doesNotMatch(tokenBody, /resource=/);
  assert.equal(new Headers(requests[1].init?.headers).get("Authorization"), null);
  await assert.rejects(service.completeAuthorization(state, "replayed-code"), /无效|使用/);
});

test("cancelling a reconnect keeps the existing working Notion connection", async () => {
  const f = fixture();
  f.database.knowledgeConnections.push({
    id: "notion-a", workspaceId: "workspace-a", provider: "notion", status: "connected", clientId: "client-a",
    encryptedAccessToken: encryptCredential("still-valid"), oauthTokenAuthMethod: "none", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const service = new NotionMcpService(f.store);
  const started = await service.beginAuthorization({ workspaceId: "workspace-a", userId: "user-a", appOrigin: "https://one.example" });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  assert.equal(f.database.knowledgeConnections[0].status, "connected");
  await service.cancelAuthorization(state);
  assert.equal(f.database.knowledgeConnections[0].status, "connected");
  assert.equal(decryptCredential(f.database.knowledgeConnections[0].encryptedAccessToken!), "still-valid");
});

test("Notion search calls only the reviewed read-only tools and parses fetched pages", async () => {
  const f = fixture();
  f.database.knowledgeConnections.push({
    id: "notion-a", workspaceId: "workspace-a", provider: "notion", status: "connected", clientId: "client-a",
    encryptedAccessToken: encryptCredential("workspace-a-token"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const calls: string[] = [];let fetches=0;
  const service = new NotionMcpService(f.store, {
    createClient: async token => {
      assert.equal(token, "workspace-a-token");
      return {
        async listTools() { return { tools: [{ name: "notion-search" }, { name: "notion-fetch" }, { name: "notion-create-pages" }, { name: "notion-update-page" }] }; },
        async callTool(params) {
          calls.push(params.name);
          if (params.name === 'notion-search') assert.equal(params.arguments?.sort, 'last_edited');
          if (params.name === "notion-search") return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "page-a", title: "Project A", url: "https://www.notion.so/page-a", highlight: "search excerpt" }] }) }] };
          if (params.name === "notion-fetch") {fetches++;return { content: [{ type: "text", text: JSON.stringify({ title: "Project A", url: "https://www.notion.so/page-a", text: fetches===1?"trusted as reference only":`Here is the page as of 2026-10-22T04:3${fetches}:00Z:\n<page><ancestor-path>NOT_PAGE_BODY</ancestor-path><content>\ntrusted as reference only\n</content></page>` }) }] };}
          throw new Error("write tool must never be called");
        },
        async close() {}
      };
    }
  });
  const chunks = await service.search("workspace-a", "project", 5);
  assert.deepEqual(calls, ["notion-search", "notion-fetch"]);
  assert.equal(chunks[0].provider, "notion");
  assert.equal(chunks[0].content, "trusted as reference only");
  assert.equal(chunks[0].sourceUrl, "https://www.notion.so/page-a");
  for(let i=0;i<2;i++){
    const repeated=await service.search('workspace-a','project',5);
    assert.equal(repeated[0].content,chunks[0].content,'fetch wrappers and as-of metadata are not page content or a material update');
    assert.doesNotMatch(repeated[0].content,/as of|NOT_PAGE_BODY/);
    assert.equal(repeated[0].sourceUrl,chunks[0].sourceUrl);
  }
  assert.deepEqual(calls,['notion-search','notion-fetch','notion-search','notion-fetch','notion-search','notion-fetch']);
  await assert.rejects(service.search("workspace-b", "project", 5), /连接 Notion/);
});

test("Notion refresh stays scoped to the exact workspace connection", async () => {
  const f = fixture();
  const expired = new Date(Date.now() - 60_000).toISOString();
  for (const workspaceId of ["workspace-a", "workspace-b"]) f.database.knowledgeConnections.push({
    id: `notion-${workspaceId}`, workspaceId, provider: "notion", status: "connected", clientId: `client-${workspaceId}`,
    encryptedAccessToken: encryptCredential(`old-${workspaceId}`), encryptedRefreshToken: encryptCredential(`refresh-${workspaceId}`),
    credentialExpiresAt: expired, createdAt: expired, updatedAt: expired
  });
  const usedTokens: string[] = [];
  const service = new NotionMcpService(f.store, {
    fetch: (async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("refresh_token"), "refresh-workspace-a");
      return new Response(JSON.stringify({ access_token: "new-workspace-a", refresh_token: "rotated-a", expires_in: 3600 }));
    }) as typeof fetch,
    createClient: async token => ({
      async listTools() { usedTokens.push(token); return { tools: [{ name: "notion-fetch" }] }; },
      async callTool() { return { content: [{ type: "text", text: "self" }] }; },
      async close() {}
    })
  });
  await service.verify("workspace-a");
  assert.deepEqual(usedTokens, ["new-workspace-a"]);
  assert.equal(decryptCredential(f.database.knowledgeConnections[0].encryptedAccessToken!, knowledgeCredentialContext("workspace-a", "notion", "access_token")), "new-workspace-a");
  assert.equal(decryptCredential(f.database.knowledgeConnections[1].encryptedAccessToken!), "old-workspace-b");
});

const dateRange={from:'2026-10-24',to:'2026-10-24',timeZone:'Asia/Shanghai',anchorAt:'2026-10-25T02:00:00Z',basis:'event' as const};
const dateSchema={type:'object',properties:{query:{type:'string'},filters:{type:'object',properties:{created_date_range:{type:'object',properties:{start_date:{type:'string'},end_date:{type:'string'}}}}}}};
const textResult=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
test('Notion discovers native date filters and separately searches event-date content in older pages',async()=>{
  const f=writingFixture(),calls:Array<{name:string;arguments?:Record<string,unknown>}>=[];
  const service=new NotionMcpService(f.store,{createClient:async()=>({
    listTools:async()=>({tools:[{name:'notion-search',inputSchema:dateSchema},{name:'notion-fetch'}]}),
    callTool:async params=>{
      calls.push(params);
      if(params.name==='notion-search')return textResult({results:params.arguments?.filters?[{id:'new-page',title:'昨天新建的页面',created_time:'2026-10-24T02:00:00Z'}]:[{id:'old-page',title:'长期日记',created_time:'2026-01-01T00:00:00Z'}]});
      return textResult({title:'资料',text:params.arguments?.id==='old-page'?'2026-10-24：社区计划讨论':'这页讲的是以前的事'});
    },close:async()=>{}
  })});
  const found=await service.searchWithDiagnostics('workspace-a','昨天思考',10,{dateRange});
  assert.deepEqual(calls.filter(c=>c.name==='notion-search').map(c=>c.arguments),[
    {query:'',sort:'last_edited',filters:{created_date_range:{start_date:'2026-10-23',end_date:'2026-10-25'}}},
    {query:'2026-10-24 思考',sort:'last_edited'}
  ]);
  assert.equal(found.dateSearch?.method,'native_date_filter');assert.equal(found.dateSearch?.field,'created');assert.equal(found.dateSearch?.complete,false);
  assert.deepEqual(found.chunks.map(c=>c.id),['new-page','old-page']);
  assert.equal(found.chunks[1].createdAt,'2026-01-01T00:00:00Z');
});
test('Notion date fallback never invents fields, treats plan notices as dropped filters and excludes empty metadata blobs',async()=>{
  for(const mode of ['unsupported','notice','validation'] as const){
    const f=writingFixture(),calls:Array<Record<string,unknown>>=[];
    const service=new NotionMcpService(f.store,{createClient:async()=>({
      listTools:async()=>({tools:[{name:'notion-search',inputSchema:mode==='unsupported'?{type:'object',properties:{query:{type:'string'}}}:dateSchema}]}),
      callTool:async({arguments:args})=>{
        calls.push(args!);
        if(args?.filters&&mode==='validation')return {...textResult({code:'validation_error'}),isError:true};
        return textResult({results:[],...(mode==='notice'&&args?.filters?{notices:[{fields:['filters.created_date_range'],message:'upgrade required PRIVATE_PROVIDER_TEXT'}]}:{})});
      },close:async()=>{}
    })});
    const result=await service.searchWithDiagnostics('workspace-a','昨天会议',10,{dateRange});
    assert.deepEqual(result.chunks,[]);assert.equal(result.dateSearch?.filterApplied,false);
    assert.equal(calls.length,mode==='unsupported'?1:2);
    assert.equal(calls.at(-1)?.query,'2026-10-24 会议');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER_TEXT/);
  }
  const f=writingFixture();
  const service=new NotionMcpService(f.store,{createClient:async()=>({listTools:async()=>({tools:[{name:'notion-search'}]}),callTool:async()=>textResult({results:[]}),close:async()=>{}})});
  assert.deepEqual(await service.search('workspace-a','不命中',5),[]);
});
test('Notion date pipeline checks authorization between read steps and never crosses workspaces',async()=>{
  const f=writingFixture();let calls=0;
  const service=new NotionMcpService(f.store,{createClient:async token=>{
    assert.equal(token,'own-token');
    return {listTools:async()=>({tools:[{name:'notion-search',inputSchema:dateSchema},{name:'notion-fetch'}]}),callTool:async()=>{
      calls++;f.database.knowledgeConnections[0].status='revoked';
      return textResult({results:[{id:'must-not-fetch',title:'private',created_time:'2026-10-24T02:00:00Z'}]});
    },close:async()=>{}};
  }});
  await assert.rejects(service.searchWithDiagnostics('workspace-b','会议',5,{dateRange}),/连接 Notion/);assert.equal(calls,0);
  await assert.rejects(service.searchWithDiagnostics('workspace-a','会议',5,{dateRange}),/撤销|改变/);assert.equal(calls,1);
});

test('Notion keeps native date candidates when secondary recall fails, but never keeps them after revocation',async()=>{
  for(const failure of ['timeout','rate_limited','revoked','permission','unauthorized','permission_sdk'] as const){
    const f=writingFixture();let searches=0,fetches=0;
    const service=new NotionMcpService(f.store,{createClient:async()=>({
      listTools:async()=>({tools:[{name:'notion-search',inputSchema:dateSchema},{name:'notion-fetch'}]}),
      callTool:async({name})=>{
        if(name==='notion-fetch'){fetches++;return {structuredContent:{title:'原生日期候选',text:'2026-10-24 当天的思考'}};}
        if(++searches===1)return {structuredContent:{results:[{id:'native',title:'原生日期候选',created_time:'2026-10-24T03:00:00Z'}]}};
        if(failure==='revoked')f.database.knowledgeConnections[0].status='revoked';
        if(failure==='permission_sdk')throw Object.assign(new Error('HTTP error status 403 Forbidden'),{code:-32000});
        if(failure==='permission'||failure==='unauthorized')return {isError:true,structuredContent:{code:failure==='permission'?'restricted_resource':'unauthorized'}};
        throw Object.assign(new Error('PRIVATE_PROVIDER_DETAIL'),{code:failure==='timeout'?'ETIMEDOUT':429,status:failure==='rate_limited'?429:undefined});
      },close:async()=>{}
    })});
    if(['revoked','permission','unauthorized','permission_sdk'].includes(failure)){
      await assert.rejects(service.searchWithDiagnostics('workspace-a','思考',10,{dateRange}));
      assert.equal(fetches,0);
    }else{
      const found=await service.searchWithDiagnostics('workspace-a','思考',10,{dateRange});
      assert.equal(found.chunks[0].content,'2026-10-24 当天的思考');
      assert.equal(found.dateSearch?.partial,true);assert.equal(found.dateSearch?.secondaryFailure,failure);assert.equal(fetches,1);
      assert.doesNotMatch(JSON.stringify(found),/PRIVATE_PROVIDER_DETAIL/);
    }
    assert.equal(searches,2,'no retry of the entire successful native branch');
  }
});

test('Notion honors nonempty query schemas and safely degrades SDK InvalidParams exceptions',async()=>{
  for(const minLength of [undefined,1]){
    const f=writingFixture(),calls:Array<Record<string,unknown>>=[];
    const schema={...dateSchema,properties:{...dateSchema.properties,query:{type:'string',...(minLength?{minLength}:{})}}};
    const service=new NotionMcpService(f.store,{createClient:async()=>({
      listTools:async()=>({tools:[{name:'notion-search',inputSchema:schema}]}),
      callTool:async({arguments:args})=>{
        calls.push(args!);
        if(args?.filters)throw Object.assign(new Error('MCP InvalidParams PRIVATE_RAW'),{code:-32602});
        return {structuredContent:{results:[]}};
      },close:async()=>{}
    })});
    const found=await service.searchWithDiagnostics('workspace-a','会议',10,{dateRange});
    assert.equal(calls.length,2);assert.equal(calls[0].query,minLength?'2026-10-24 会议':'');
    assert.equal(calls[1].query,'2026-10-24 会议');assert.equal(calls[1].filters,undefined);
    assert.equal(found.dateSearch?.filterApplied,false);assert.equal(found.dateSearch?.filterDropped,true);
    assert.doesNotMatch(JSON.stringify(found),/PRIVATE_RAW/);
  }
});

test('Notion reads structured-only responses and resolves only bounded local schema references',async()=>{
  const schema={type:'object',properties:{query:{$ref:'#/$defs/query'},filters:{$ref:'#/$defs/filters'}},$defs:{query:{type:'string',minLength:1},filters:{type:'object',properties:{created_date_range:{$ref:'#/$defs/range'}}},range:{type:'object',properties:{start_date:{type:'string'},end_date:{type:'string'}}}}};
  const f=writingFixture(),calls:Array<Record<string,unknown>>=[];
  const service=new NotionMcpService(f.store,{createClient:async()=>({
    listTools:async()=>({tools:[{name:'notion-search',inputSchema:schema},{name:'notion-fetch'}]}),
    callTool:async({name,arguments:args})=>{
      if(name==='notion-fetch')return {structuredContent:{title:'计划',text:'2026-10-24 计划正文'}};
      calls.push(args!);return {structuredContent:{results:[{id:'page',title:'计划',created_time:'2026-10-24T01:00:00Z'}],...(args?.filters?{notices:[{fields:['filters.created_date_range'],message:'filter dropped'}]}:{})}};
    },close:async()=>{}
  })});
  const found=await service.searchWithDiagnostics('workspace-a','计划',10,{dateRange});
  assert.equal(calls[0].query,'2026-10-24 计划');assert.ok(calls[0].filters);
  assert.equal(found.chunks[0].content,'2026-10-24 计划正文');
  assert.equal(found.dateSearch?.filterDropped,true,'structured notices remain visible');
  for(const reference of ['#/$defs/loop','https://unreviewed.example/schema.json']){
    const g=writingFixture();let calls=0;
    const guarded=new NotionMcpService(g.store,{createClient:async()=>({
      listTools:async()=>({tools:[{name:'notion-search',inputSchema:{properties:{filters:{$ref:reference}},$defs:{loop:{$ref:'#/$defs/loop'}}}}]}),
      callTool:async({arguments:args})=>{calls++;assert.equal(args?.filters,undefined);return {structuredContent:{results:[]}};},close:async()=>{}
    })});
    assert.equal((await guarded.searchWithDiagnostics('workspace-a','会议',10,{dateRange})).dateSearch?.method,'semantic_date_hint');
    assert.equal(calls,1);
  }
});

test('Notion explicit writing OAuth grants only the authorizing user, rejects unavailable write tools and never invokes Notion AI', async () => {
  const f=fixture();let writesAvailable=true;
  const calls:string[]=[];
  const service=new NotionMcpService(f.store,{
    fetch:(async input=>new Response(JSON.stringify(String(input).endsWith('/register')?{client_id:'client'}:{access_token:'access-test'}))) as typeof fetch,
    createClient:async()=>({listTools:async()=>({tools:['notion-fetch','notion-search','notion-ai-search',...(writesAvailable?['notion-create-pages','notion-update-page']:[])].map(name=>({name}))}),callTool:async({name})=>{calls.push(name);return {content:[{type:'text',text:'verified'}]};},close:async()=>{}})
  });
  const start=await service.beginAuthorization({workspaceId:'wa',userId:'a',appOrigin:'https://one.example',enableWriting:true});
  const c=await service.completeAuthorization(new URL(start.authorizationUrl).searchParams.get('state')!,'code');
  assert.equal(c.notionWriting?.userId,'a');assert.ok(c.notionWriting?.grantId);assert.equal(c.notionWriting?.parentId,undefined);
  await assert.rejects(()=>service.callDocumentTool('wa',c.id,c.notionWriting!.grantId,'b','notion-create-pages',{}),/授权已改变/);
  await assert.rejects(()=>service.callDocumentTool('wb',c.id,c.notionWriting!.grantId,'a','notion-create-pages',{}));
  await assert.rejects(()=>service.callDocumentTool('wa',c.id,c.notionWriting!.grantId,'a','notion-ai-search',{}),/未授权/);
  const grant=c.notionWriting!.grantId;
  writesAvailable=false;
  const denied=await service.beginAuthorization({workspaceId:'wa',userId:'a',appOrigin:'https://one.example',enableWriting:true});
  await assert.rejects(()=>service.completeAuthorization(new URL(denied.authorizationUrl).searchParams.get('state')!,'code2'),/不支持写入/);
  assert.equal(f.database.knowledgeConnections[0].notionWriting?.grantId,grant);
  assert.equal(f.database.knowledgeConnections[0].status,'connected');
  assert.ok(calls.every(n=>n==='notion-fetch'));
});

function writingFixture() {
  const f=fixture();
  f.database.knowledgeConnections.push({id:'notion-a',workspaceId:'workspace-a',provider:'notion',status:'connected',clientId:'client-a',encryptedAccessToken:encryptCredential('own-token'),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),notionWriting:{userId:'user-a',grantId:'grant-a',authorizedAt:new Date().toISOString(),parentId:'parent-a',referenceIds:[]}});
  return f;
}

test('Notion reconnects once before sending a write, with the same workspace token', async () => {
  const f=writingFixture();let connects=0,writes=0,closed=0;
  const service=new NotionMcpService(f.store,{createClient:async token=>{
    assert.equal(token,'own-token');connects++;
    if(connects===1)throw new TypeError('fetch failed',{cause:new AggregateError([Object.assign(new Error('network'),{code:'ETIMEDOUT'})])});
    return {listTools:async()=>({tools:[{name:'notion-update-page'}]}),callTool:async()=>{writes++;return {content:[]};},close:async()=>{closed++;}};
  }});
  await assert.rejects(service.callDocumentTool('workspace-b','notion-a','grant-a','user-a','notion-update-page',{}));
  await assert.rejects(service.callDocumentTool('workspace-a','notion-a','grant-a','other-user','notion-update-page',{}));
  assert.equal(connects,0);
  await service.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-update-page',{});
  assert.equal(connects,2);assert.equal(writes,1);assert.equal(closed,1);
});

test('Notion persistent connection failure is bounded and never sends a write', async () => {
  const f=writingFixture();let connects=0;
  const service=new NotionMcpService(f.store,{createClient:async()=>{connects++;throw Object.assign(new Error('network'),{code:'ENETUNREACH'});}});
  await assert.rejects(service.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-create-pages',{}));
  assert.equal(connects,2);
});

test('Notion never retries tool writes or authorization failures', async () => {
  const f=writingFixture();let connects=0,writes=0;
  const service=new NotionMcpService(f.store,{createClient:async()=>{connects++;return {listTools:async()=>({tools:[{name:'notion-update-page'}]}),callTool:async()=>{writes++;throw Object.assign(new Error('network'),{code:'ECONNRESET'});},close:async()=>{}};}});
  await assert.rejects(service.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-update-page',{}));
  assert.equal(connects,1);assert.equal(writes,1);
  connects=0;
  const denied=new NotionMcpService(f.store,{createClient:async()=>{connects++;throw new Error('HTTP 401 unauthorized');}});
  await assert.rejects(denied.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-update-page',{}));assert.equal(connects,1);
});

test('Notion reconnect cannot cross a revoked connection or changed writing grant', async () => {
  const f=writingFixture();let connects=0,writes=0;
  const revoked=new NotionMcpService(f.store,{createClient:async()=>{connects++;f.database.knowledgeConnections[0].status='revoked';throw Object.assign(new Error('network'),{code:'ETIMEDOUT'});}});
  await assert.rejects(revoked.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-update-page',{}),/连接已改变/);assert.equal(connects,1);
  f.database.knowledgeConnections[0].status='connected';
  const changed=new NotionMcpService(f.store,{createClient:async()=>({listTools:async()=>{f.database.knowledgeConnections[0].notionWriting!.grantId='changed';return {tools:[{name:'notion-update-page'}]};},callTool:async()=>{writes++;return {};},close:async()=>{}})});
  await assert.rejects(changed.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-update-page',{}),/授权已改变/);assert.equal(writes,0);
});

test('Notion records pre-send, explicit rejection and uncertain delivery separately without provider text', async () => {
  for (const scenario of ['connect','tools','validation','permission','server','disconnect'] as const) {
    const f=writingFixture();let sends=0,checkpoints=0;
    const service=new NotionMcpService(f.store,{createClient:async()=>{
      if(scenario==='connect')throw Object.assign(new Error('token=PRIVATE'),{code:'ECONNREFUSED'});
      return {listTools:async()=>{
        if(scenario==='tools')throw new Error('token=PRIVATE');
        return {tools:[{name:'notion-create-pages'}]};
      },callTool:async()=>{sends++;if(scenario==='disconnect')throw Error('token=PRIVATE');
        return {isError:true,content:[{type:'text',text:JSON.stringify({code:scenario==='validation'?'validation_error':scenario==='permission'?'restricted_resource':'internal_server_error',message:'token=PRIVATE article=PRIVATE'})}]};
      },close:async()=>{}};
    }});
    await assert.rejects(service.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-create-pages',{},async()=>{checkpoints++;}),error=>{
      assert.ok(error instanceof NotionWriteError);
      assert.equal(error.delivery,['connect','tools'].includes(scenario)?'not_sent':['validation','permission'].includes(scenario)?'rejected':'unknown');
      assert.doesNotMatch(JSON.stringify(error)+error.message,/PRIVATE/);return true;
    });
    assert.equal(sends,['connect','tools'].includes(scenario)?0:1);assert.equal(checkpoints,sends);
  }
});
test('Notion rechecks the exact parent immediately before sending a document mutation', async()=>{
  const f=writingFixture();let sends=0;
  const service=new NotionMcpService(f.store,{createClient:async()=>({listTools:async()=>({tools:[{name:'notion-create-pages'}]}),callTool:async()=>{sends++;return{};},close:async()=>{}})});
  await assert.rejects(service.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-create-pages',{},async()=>{throw Error('parent changed');}),error=>error instanceof NotionWriteError&&error.delivery==='not_sent');
  assert.equal(sends,0);
});
test('Notion retries failed discovery and readback, but sends a mutation only once',async()=>{
  const f=writingFixture();let discoveries=0,sends=0,reads=0;
  const service=new NotionMcpService(f.store,{createClient:async()=>({listTools:async()=>{
    discoveries++;if(discoveries===1)throw Object.assign(Error('network'),{code:'ECONNRESET'});
    return {tools:[{name:'notion-create-pages'},{name:'notion-fetch'}]};
  },callTool:async({name})=>{if(name==='notion-create-pages'){sends++;return {pages:[]};}reads++;if(reads===1)throw Object.assign(Error('network'),{code:'ECONNREFUSED'});return {text:'合成正文'};},close:async()=>{}})});
  await service.callDocumentTool('workspace-a','notion-a','grant-a','user-a','notion-create-pages',{});
  await service.readDocument('workspace-a','page');assert.equal(sends,1);assert.equal(reads,2);
});
