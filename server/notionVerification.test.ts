import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import type {Store} from './db.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {NotionMcpService} from './knowledge/notionMcpService.js';
import {NotionDocuments} from './notionDocuments.js';
import {canonicalNotionDigest,legacyNotionNormalized,notionHash} from './notionCanonical.js';
import {runTaskOrchestrator} from './taskOrchestrator.js';
import {verifiedNotionCompletion} from './notionCompletion.js';
import {taskStepKey,type TaskStep,type TaskStepStore} from './taskSteps.js';
const scope={workspaceId:'wa',userId:'a'},parentId='a'.repeat(32),pageId='b'.repeat(32);
function fixture(){
 let now=Date.parse('2026-10-25T01:00:00Z'),body='旧正文',reads=0,writes=0;
 const args={title:'测试',content:'完整正文\n自然结尾。',final:true};
 const db={users:[{id:'a',enabled:true},{id:'b',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],knowledgeConnections:[{id:'notion',workspaceId:'wa',provider:'notion',status:'connected',notionWriting:{grantId:'grant',userId:'a',parentId}}],conversations:[{...scope,id:'task',archived:false,notionDocument:{connectionId:'notion',grantId:'grant',parentId}}],chatOperations:[],contextTraces:[]} as unknown as Database;
 const store={read:async()=>structuredClone(db),mutate:async<T>(fn:(d:Database)=>T)=>fn(db)} as Store;
 const job={state:'running',notionTarget:{connectionId:'notion',grantId:'grant',parentId,referenceIds:[]},steps:[],contract:{version:1,requiredFeatureIds:[],requiredTools:['save_notion_draft'],execution:'model'}} as unknown as WorkRun;
 db.chatOperations!.push({...scope,id:'op',operationId:'original',requestId:'request',conversationId:'task',createdAt:new Date(now).toISOString(),status:'pending',workRun:job} as any);
 const mcp={readDocument:async(ws:string,id:string)=>{assert.equal(ws,scope.workspaceId);assert.equal(id,pageId);reads++;return {text:`<page><content>${body}</content></page>`};},callDocumentTool:async(_ws:string,_c:string,_g:string,_u:string,name:string,value:any,before?:()=>Promise<void>)=>{assert.ok(['notion-create-pages','notion-update-page'].includes(name));await before?.();writes++;body=name==='notion-create-pages'?value.pages[0].content:body.replace(value.content_updates[0].old_str,value.content_updates[0].new_str);return {pages:[{id:pageId}]};}} as unknown as NotionMcpService;
 const docs=new NotionDocuments(store,mcp,{now:()=>now,delays:[10,20,30],deadlineMs:1000,leaseMs:50});
 const steps=job.steps!;const checkpoint:TaskStepStore={namespace:'worker',steps,save:async step=>{const i=steps.findIndex(s=>s.key===step.key);if(i<0)steps.push(step);else steps[i]=step;}};
 async function failWrite(value:unknown=args,existing=false){
  if(existing)job.notionTarget!.pageId=pageId;
  await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[docs.tool(scope,'op','task',job,async()=>{},existing?body:undefined)],checkpoints:checkpoint,maxSteps:2,beforeStep:async()=>{},call:async()=>({content:'',toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify(value)}}]})}));
  job.state='failed';db.chatOperations![0].status='failed';
 }
 return {db,store,job,mcp,docs,args,failWrite,body:()=>body,setBody:(v:string)=>body=v,reads:()=>reads,writes:()=>writes,advance:(n:number)=>now+=n,now:()=>now};
}
test('delayed read confirms the exact single write, repairs only its checkpoint, and reports once without changing write time',async()=>{
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);let initial=true;
 f.mcp.readDocument=async(...args)=>{if(initial){initial=false;throw Error('temporary');}return read(...args);};
 await f.failWrite();assert.equal(f.writes(),1);assert.equal(f.job.notionReceipt!.verification!.state,'scheduled');
 const savedAt=f.job.steps![0].updatedAt;f.job.steps!.push({key:'other',namespace:'worker',scopeId:'op',tool:'oneHtml',label:'另一个文件',effect:'artifact',state:'started',updatedAt:savedAt});
 assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);f.advance(10);
 const result=await f.docs.reconcileDue(scope,async()=>{});assert.equal(result[0].state,'verified');assert.equal(f.writes(),1);assert.equal(f.job.steps![0].state,'completed');assert.equal(f.job.steps![0].updatedAt,savedAt);assert.equal(f.job.steps![1].state,'started');assert.equal(f.job.notionReceipt!.verification,undefined);assert.equal(f.job.reportRevision,1);
 assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);assert.equal(f.job.reportRevision,1);
});
test('a source read after saving but before verification cannot retroactively satisfy source-before-save',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};await f.failWrite();
 f.job.steps![0].updatedAt='2026-10-25T01:00:00Z';f.job.steps!.push({key:'source',namespace:'worker',tool:'knowledge_search',label:'资料',effect:'read',state:'completed',output:{status:'used'},updatedAt:'2026-10-25T01:01:00Z'});
 f.mcp.readDocument=async()=>({text:f.body()});f.advance(10);await f.docs.reconcileDue(scope,async()=>{});
 assert.equal(f.job.steps![0].updatedAt,'2026-10-25T01:00:00Z');assert.equal(verifiedNotionCompletion(f.job.notionReceipt,f.job.steps!,['knowledge_search','save_notion_draft'],{scopeId:'op'}),undefined);
});
test('persistent mismatches exhaust the bounded readonly attempts and an expired deadline never performs a read',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>({text:'别的正文'});await f.failWrite();
 for(const delay of [10,20,30]){f.advance(delay);await f.docs.reconcileDue(scope,async()=>{});}
 assert.equal(f.job.notionReceipt!.verification!.state,'exhausted');assert.equal(f.job.notionReceipt!.verification!.attempt,3);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.writes(),1);assert.equal(f.job.steps![0].state,'started');
 assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);
 const g=fixture();g.mcp.readDocument=async()=>{throw Error('temporary');};await g.failWrite();let reads=0;g.mcp.readDocument=async()=>{reads++;return {text:g.body()};};g.advance(1001);
 assert.equal((await g.docs.reconcileDue(scope,async()=>{}))[0].state,'exhausted');assert.equal(reads,0);
});
test('an unknown create without a page is never enrolled, searched or repeated; a known-page update can be read back',async()=>{
 const f=fixture();f.mcp.callDocumentTool=async()=>{throw Error('lost create response');};await f.failWrite();assert.equal(f.job.notionReceipt!.pageId,undefined);assert.equal(f.job.notionReceipt!.verification,undefined);assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);assert.equal(f.reads(),0);
 const g=fixture(),write=g.mcp.callDocumentTool.bind(g.mcp);g.mcp.callDocumentTool=async(...args)=>{await write(...args);throw Error('lost update response');};
 await g.failWrite({old_str:'旧正文',new_str:'新正文',final:true},true);assert.equal(g.writes(),1);g.advance(10);assert.equal((await g.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(g.writes(),1);assert.equal(g.body(),'新正文');
});
test('authorization changes stop automatic verification before reading and do not loop scheduled forever',async()=>{
 for(const mode of ['revoked','parent','during'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};await f.failWrite();let reads=0;
  f.mcp.readDocument=async()=>{reads++;if(mode==='during')f.db.knowledgeConnections[0].notionWriting!.grantId='changed';return {text:f.body()};};
  if(mode==='revoked')f.db.knowledgeConnections[0].status='revoked';if(mode==='parent')f.db.knowledgeConnections[0].notionWriting!.parentId='c'.repeat(32);
  f.advance(10);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'exhausted');assert.equal(reads,mode==='during'?1:0);assert.equal(f.job.notionReceipt!.verification!.lastReason,'authorization');assert.equal(f.job.notionReceipt!.state,'uncertain');assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);
 }
});
test('cancellation, foreign scope, concurrent polls, expired leases and newer receipts cannot settle the wrong save',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};await f.failWrite();f.advance(10);
 assert.deepEqual(await f.docs.reconcileDue({workspaceId:'wb',userId:'b'},async()=>{}),[]);
 f.job.state='cancelled';assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);f.job.state='failed';
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let reads=0;
 f.mcp.readDocument=async()=>{reads++;entered();await gate;return {text:f.body()};};
 const pending=f.docs.reconcileDue(scope,async()=>{});await started;assert.deepEqual(await new NotionDocuments(f.store,f.mcp,{now:f.now,delays:[10,20,30]}).reconcileDue(scope,async()=>{}),[]);assert.equal(reads,1);
 f.job.notionReceipt!.expectedDigest='f'.repeat(64);f.job.notionReceipt!.verification!.version++;release();assert.equal((await pending)[0].state,'blocked');assert.equal(f.job.notionReceipt!.state,'uncertain');
 const g=fixture();g.mcp.readDocument=async()=>{throw Error('temporary');};await g.failWrite();g.job.notionReceipt!.verification!.state='checking';g.job.notionReceipt!.verification!.leaseUntil=new Date(g.now()-1).toISOString();g.advance(10);g.mcp.readDocument=async()=>({text:g.body()});assert.equal((await new NotionDocuments(g.store,g.mcp,{now:g.now,delays:[10,20,30]}).reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(g.writes(),1);
});
test('legacy formatting recovery requires exact owned create arguments and their original digest/checkpoint',async()=>{
 const expected='**标题**\n> 第一段\n>\n> 第二段\n|人|事|\n|---|---|\n|甲|乙|',actual='<b>标题</b>\n<quote>\n第一段\n\n第二段\n</quote>\n|人|事|\n| --- | --- |\n|甲|乙|';
 for(const mode of ['exact','foreign','wrong_key','changed_hash','update'] as const){
  const f=fixture(),args=mode==='update'?{old_str:'old',new_str:expected,final:true}:{title:'测试',content:expected,final:true},query=JSON.stringify(args),key=taskStepKey('worker','save_notion_draft',query);
  f.job.state='failed';f.job.notionReceipt={state:'uncertain',pageId,expectedDigest:mode==='changed_hash'?'0'.repeat(64):notionHash(legacyNotionNormalized(expected)),final:true};f.job.steps=[{key:mode==='wrong_key'?'other':key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-25T01:00:00Z'}];
  f.db.contextTraces.push({...scope,workspaceId:mode==='foreign'?'wb':'wa',conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);f.mcp.readDocument=async()=>({text:actual});
  if(mode==='exact'){const result=await f.docs.reconcile(scope,'task',async()=>{});assert.equal(result.operationId,'op');assert.equal(f.job.notionReceipt!.canonicalVersion,3);assert.equal(f.job.notionReceipt!.expectedDigest,notionHash(legacyNotionNormalized(expected)));assert.equal(f.job.steps[0].state,'completed');}
  else{await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,undefined);}
  assert.equal(f.writes(),0);
 }
});
test('new v3 receipts do not use the permissive legacy whitespace path for literal code',async()=>{
 const f=fixture(),body='```\nx \n\n```';f.mcp.readDocument=async()=>({text:'```\nx\n```'});await f.failWrite({title:'代码',content:body,final:true});
 assert.equal(f.job.notionReceipt!.canonicalVersion,3);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,canonicalNotionDigest(body));f.advance(10);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(f.job.notionReceipt!.state,'uncertain');
});
test('manual v2 create recovery reproves the original body before upgrading to v3 and persists the exact selection before a failed read',async()=>{
 for(const status of ['failed','completed'] as const){
  const f=fixture(),expected='**预算**\n|项目|费用|备注|\n|---|----|------|\n|场地|100|不变|',actual='<b>预算</b>\n|项目|费用|备注|\n| --- | --- | --- |\n|场地|100|不变|',query=JSON.stringify({title:'测试',content:expected,final:true}),key=taskStepKey('worker','save_notion_draft',query);
  f.job.state='failed';f.db.chatOperations![0].status=status;
  f.job.steps=[{key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-25T01:00:00Z'}];
  const legacyDigest=notionHash(legacyNotionNormalized(expected)),v2Digest=canonicalNotionDigest(expected,2);
  f.job.notionReceipt={state:'uncertain',delivery:'unknown',pageId,expectedDigest:legacyDigest,expectedCanonicalDigest:v2Digest,canonicalVersion:2,checkpointKey:key,final:true};
  f.db.contextTraces.push({...scope,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);
  f.mcp.readDocument=async()=>{assert.equal(f.job.notionReceipt!.canonicalVersion,3);assert.equal(f.job.notionVerificationSelection!.operationId,'op');assert.equal(f.job.notionVerificationSelection!.checkpointKey,key);throw Error('first read unavailable');};
  await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}),/稍后会继续只读核对/);
  assert.equal(f.job.notionReceipt!.expectedDigest,legacyDigest);assert.notEqual(f.job.notionReceipt!.expectedCanonicalDigest,v2Digest);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,canonicalNotionDigest(expected,3));
  assert.deepEqual(f.job.notionVerificationSelection,{operationId:'op',expectedDigest:legacyDigest,pageId,asyncTaskId:undefined,checkpointKey:key,version:f.job.notionReceipt!.verification!.version,connectionId:'notion',grantId:'grant',parentId,requestedAt:new Date(f.now()).toISOString()});
  f.mcp.readDocument=async()=>({text:actual});f.advance(20);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(f.job.steps[0].state,'completed');assert.equal(f.writes(),0);
 }
});
test('a v2 update without original complete create proof keeps its v2 digest instead of assuming v3 equivalence',async()=>{
 const f=fixture(),expected='|项目|费用|\n|----|------|\n|场地|100|',actual='|项目|费用|\n| --- | --- |\n|场地|100|',query=JSON.stringify({old_str:'旧正文',new_str:expected,final:true}),key=taskStepKey('worker','save_notion_draft',query),oldDigest=canonicalNotionDigest(expected,2);
 f.job.state='failed';f.db.chatOperations![0].status='failed';
 f.job.steps=[{key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-25T01:00:00Z'}];
 f.job.notionReceipt={state:'uncertain',delivery:'unknown',pageId,expectedDigest:notionHash(legacyNotionNormalized(expected)),expectedCanonicalDigest:oldDigest,canonicalVersion:2,checkpointKey:key,final:true};
 f.db.contextTraces.push({...scope,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);f.mcp.readDocument=async()=>({text:actual});
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.canonicalVersion,2);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,oldDigest);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.steps[0].state,'started');assert.equal(f.writes(),0);
});
test('manual reading a stopped, archived, cancelled or completed job never enrolls a completion selection',async()=>{
 for(const mode of ['stopped','archived','cancelled','completed'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('first read unavailable');};await f.failWrite();
  if(mode==='stopped')f.db.conversations[0].workPauseReason='user_stopped';if(mode==='archived')f.db.conversations[0].archived=true;if(mode==='cancelled')f.job.state='cancelled';if(mode==='completed')f.job.state='completed';
  await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionVerificationSelection,undefined,mode);assert.equal(f.writes(),1);
 }
});
test('known async handle only polls its read-only task result, then reads the returned exact page',async()=>{
 const f=fixture(),query=JSON.stringify(f.args),key=taskStepKey('worker','save_notion_draft',query);f.job.state='failed';f.setBody(f.args.content);
 f.job.steps=[{key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'started',updatedAt:'2026-10-25T01:00:00Z'}];
 f.job.notionReceipt={state:'uncertain',asyncTaskId:'async-test',expectedDigest:notionHash(legacyNotionNormalized(f.args.content)),canonicalVersion:2,expectedCanonicalDigest:canonicalNotionDigest(f.args.content,2),checkpointKey:key,final:true,verification:{state:'scheduled',version:1,attempt:0,nextCheckAt:new Date(f.now()).toISOString(),deadlineAt:new Date(f.now()+1000).toISOString()}};
 let polls=0;f.mcp.callDocumentTool=async(_w,_c,_g,_u,name,args)=>{assert.equal(name,'notion-get-async-task');assert.deepEqual(args,{task_id:'async-test'});polls++;return {status:'succeeded',result:{pages:[{id:pageId}]}};};
 assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(polls,1);assert.equal(f.reads(),1);assert.equal(f.writes(),0);assert.equal(f.job.notionReceipt.pageId,pageId);assert.equal(f.job.steps[0].state,'completed');
 assert.equal(f.job.notionTarget!.pageId,pageId);assert.equal(f.job.notionTarget!.url,`https://www.notion.so/${pageId}`);assert.equal(f.db.conversations[0].notionDocument!.pageId,pageId);assert.equal(f.db.conversations[0].notionDocument!.url,`https://www.notion.so/${pageId}`);
});
test('each authorized poll checks at most two enrolled operations, not historical unregistered failures',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};await f.failWrite();
 for(const id of ['second','third','historical']){
  const job=structuredClone(f.job);job.steps?.forEach(step=>step.scopeId=id);if(id==='historical')job.notionReceipt!.verification=undefined;
  f.db.conversations.push({...scope,id,archived:false} as any);f.db.chatOperations!.push({...scope,id,operationId:id,conversationId:id,createdAt:new Date(f.now()).toISOString(),status:'failed',workRun:job} as any);
 }
 let reads=0;f.mcp.readDocument=async()=>{reads++;return {text:f.body()};};f.advance(10);
 assert.equal((await f.docs.reconcileDue(scope,async()=>{})).length,2);assert.equal(reads,2);assert.equal(f.db.chatOperations![2].workRun!.notionReceipt!.state,'uncertain');
 assert.equal((await f.docs.reconcileDue(scope,async()=>{})).length,1);assert.equal(reads,3);assert.equal(f.db.chatOperations![3].workRun!.notionReceipt!.state,'uncertain');
});
test('incomplete readbacks and unavailable Key never become a successful receipt',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>({text:f.body(),truncated:true});await f.failWrite();f.advance(10);
 assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(f.job.notionReceipt!.verification!.lastReason,'incomplete');assert.equal(f.job.notionReceipt!.state,'uncertain');
 let read=false;f.mcp.readDocument=async()=>{read=true;return {text:f.body()};};
 await assert.rejects(()=>f.docs.reconcileDue(scope,async()=>{throw Error('Key unavailable');}),/Key unavailable/);assert.equal(read,false);assert.equal(f.job.notionReceipt!.state,'uncertain');
});
test('a manual check after an external edit does not leave an already verified historical save in an endless scheduled state',async()=>{
 const f=fixture();const tool=f.docs.tool(scope,'op','task',f.job,async()=>{}).structured!;await tool.run(tool.validate(f.args));f.job.state='completed';f.setBody('用户之后手动修改的正文');
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.state,'verified');assert.equal(f.job.notionReceipt!.verification!.state,'exhausted');assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);assert.equal(f.writes(),1);
});
test('late readback failure never schedules a cancelled, user-stopped or archived write',async()=>{
 for(const mode of ['cancelled','stopped','archived'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{
   if(mode==='cancelled'){f.job.state='cancelled';f.db.chatOperations![0].status='interrupted';}
   if(mode==='stopped'){f.db.conversations[0].workPaused=true;f.db.conversations[0].workPauseReason='user_stopped';}
   if(mode==='archived')f.db.conversations[0].archived=true;
   throw Error('late readback failure');
  };
  await assert.rejects(()=>f.docs.tool(scope,'op','task',f.job,async()=>{}).structured!.run(f.args));
  assert.equal(f.writes(),1);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.notionReceipt!.verification,undefined,mode);assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);
  if(mode==='cancelled')assert.equal(f.job.state,'cancelled');if(mode==='stopped')assert.equal(f.db.conversations[0].workPauseReason,'user_stopped');
 }
});
test('a newer unsent or rejected receipt neither hides the older unknown write nor supersedes its readonly verification',async()=>{
 for(const mode of ['not_sent','rejected','empty_pending'] as const)for(const manual of [false,true]){
  const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);let initial=true;f.mcp.readDocument=async(...args)=>{if(initial){initial=false;throw Error('temporary');}return read(...args);};await f.failWrite();
  const newer=structuredClone(f.job);newer.notionReceipt={state:mode==='empty_pending'?'pending':'uncertain',delivery:mode==='empty_pending'?undefined:mode,pageId,expectedDigest:'c'.repeat(64)};newer.steps=[];
  f.db.chatOperations!.push({...scope,id:'newer',conversationId:'task',createdAt:new Date(f.now()+1).toISOString(),status:'failed',workRun:newer} as any);
  if(manual){const result=await f.docs.reconcile(scope,'task',async()=>{});assert.equal(result.operationId,'op');}
  else{f.advance(10);const results=await f.docs.reconcileDue(scope,async()=>{});assert.equal(results.length,1);assert.equal(results[0].operationId,'op');assert.equal(results[0].state,'verified');}
  assert.equal(f.job.notionReceipt!.state,'verified');assert.equal(newer.notionReceipt!.state,mode==='empty_pending'?'pending':'uncertain');assert.equal(f.writes(),1);
 }
});
test('manual verification promises another automatic read only when one was actually scheduled',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};await f.failWrite();
 f.db.knowledgeConnections[0].status='revoked';
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}),error=>{assert.match((error as Error).message,/自动核对已停下/);assert.doesNotMatch((error as Error).message,/稍后会继续/);return true;});
 f.db.knowledgeConnections[0].status='connected';const v=f.job.notionReceipt!.verification!;v.state='checking';v.leaseId='another-check';v.leaseUntil=new Date(f.now()+100).toISOString();
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}),error=>{assert.match((error as Error).message,/尚未核对/);assert.doesNotMatch((error as Error).message,/稍后会继续/);return true;});
});
