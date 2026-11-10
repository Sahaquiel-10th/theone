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
import {notionWriteAcknowledged} from './notionCompletion.js';
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
 // An explicit unknown-response fixture exercises the legacy/uncertain path.
 // It must never be confused with a trusted provider success acknowledgement.
 async function failWrite(value:unknown=args,existing=false){
  if(existing)job.notionTarget!.pageId=pageId;
  const call=mcp.callDocumentTool;
  mcp.callDocumentTool=async(...params)=>({...await call(...params) as object,status:'accepted'});
  try{await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[docs.tool(scope,'op','task',job,async()=>{},existing?body:undefined)],checkpoints:checkpoint,maxSteps:2,beforeStep:async()=>{},call:async()=>({content:'',toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify(value)}}]})}));}finally{mcp.callDocumentTool=call;}
  job.state='failed';db.chatOperations![0].status='failed';
 }
 async function saveAcknowledged(value:unknown=args){
  const query=JSON.stringify(value);
  await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[docs.tool(scope,'op','task',job,async()=>{})],checkpoints:checkpoint,maxSteps:2,beforeStep:async()=>{},completeAfterTools:()=> 'done',call:async()=>({content:'',toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:query}}]})});
  const receipt=job.notionReceipt!,result=steps.find(step=>step.key===receipt.checkpointKey)!.output as {state:string};
  db.contextTraces.push({...scope,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);
  job.state='completed';db.chatOperations![0].status='completed';return result;
 }
 return {db,store,job,mcp,docs,args,failWrite,saveAcknowledged,body:()=>body,setBody:(v:string)=>body=v,reads:()=>reads,writes:()=>writes,advance:(n:number)=>now+=n,now:()=>now};
}
test('acknowledged writes retain separate readback state across restart, concurrent wake and delayed success',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};assert.equal((await f.saveAcknowledged()).state,'delivered');assert.equal(f.reads(),0);
 const ack=structuredClone(f.job.notionReceipt!.writeAcknowledgement);assert.equal(notionWriteAcknowledged(f.job.notionReceipt,'op'),true);
 let reads=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 f.mcp.readDocument=async()=>{reads++;await gate;return {text:f.body()};};
 const restarted=new NotionDocuments(f.store,f.mcp,{now:f.now,delays:[10,20,30],deadlineMs:1000,leaseMs:50});f.advance(10);
 const first=restarted.reconcileDue(scope,async()=>{});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);release();
 assert.equal((await first)[0].state,'verified');assert.equal(reads,1);assert.equal(f.writes(),1);
 assert.deepEqual(f.job.notionReceipt!.writeAcknowledgement,ack);assert.deepEqual(await restarted.reconcileDue(scope,async()=>{}),[]);
});
test('every trusted ACK completes its write checkpoint before any background read, including intermediate drafts',async()=>{
 for(const final of [true,false,undefined]){
  const f=fixture(),value={title:'测试',content:f.args.content,...(final===undefined?{}:{final})};
  assert.equal((await f.saveAcknowledged(value)).state,'delivered');
  assert.equal(f.reads(),0);assert.equal(f.job.steps![0].state,'completed');assert.equal(f.job.notionReceipt!.integrity?.state,'pending');assert.equal(f.job.notionReceipt!.verification?.attempt,0);
  assert.equal(notionWriteAcknowledged(f.job.notionReceipt,'op'),true);
  f.advance(10);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');
  assert.equal(f.job.notionReceipt!.state,'delivered');assert.equal(f.job.notionReceipt!.integrity?.state,'covered');assert.equal(f.writes(),1);
 }
});
test('background missing, incomplete and unavailable reads exhaust three checks without undoing delivery or asking for another write',async()=>{
 for(const mode of ['missing','incomplete','unavailable'] as const){
  const f=fixture();await f.saveAcknowledged();const ack=structuredClone(f.job.notionReceipt!.writeAcknowledgement),sourceDigest=f.job.notionReceipt!.expectedRawDigest;
  let reads=0;f.mcp.readDocument=async()=>{reads++;if(mode==='unavailable')throw Error('PRIVATE_TRANSPORT_ERROR');return {text:mode==='missing'?'另一篇文稿':f.body(),...(mode==='incomplete'?{truncated:true}:{})};};
  for(const delay of [10,20,30]){f.advance(delay);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'delivered');}
  const receipt=f.job.notionReceipt!;assert.equal(reads,3);assert.equal(receipt.verification?.state,'exhausted');assert.equal(receipt.state,'delivered');assert.equal(receipt.integrity?.state,mode==='missing'?'missing':'inconclusive');
  assert.equal(f.job.state,'completed');assert.equal(f.job.steps![0].state,'completed');assert.deepEqual(receipt.writeAcknowledgement,ack);assert.equal(receipt.expectedRawDigest,sourceDigest);assert.equal(f.writes(),1);
  assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);assert.equal(reads,3);assert.doesNotMatch(JSON.stringify(receipt.integrity),/PRIVATE_TRANSPORT_ERROR|另一篇文稿/);
 }
});
test('an async success acknowledgement is persisted before a failing read and survives the next wake',async()=>{
 const f=fixture(),write=f.mcp.callDocumentTool.bind(f.mcp);let polls=0;
 f.mcp.callDocumentTool=async(...args)=>{
  if(args[4]==='notion-create-pages'){await write(...args);return {object:'async_task',id:'async_same_write',status:'queued'};}
  assert.equal(args[4],'notion-get-async-task');assert.deepEqual(args[5],{task_id:'async_same_write'});polls++;
  if(polls===1)throw Error('poll unavailable');
  return {status:'succeeded',result:{pages:[{id:pageId}]}};
 };
 f.mcp.readDocument=async()=>{
  assert.equal(notionWriteAcknowledged(f.job.notionReceipt,'op'),true,'successful response must be durable before readback starts');
  throw Error('read unavailable');
 };
 await f.failWrite();assert.equal(f.job.notionReceipt!.writeAcknowledgement,undefined);assert.equal(f.job.notionReceipt!.pageId,undefined);
 f.advance(10);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'delivered');
 assert.equal(f.job.notionReceipt!.state,'delivered');assert.equal(f.job.notionReceipt!.pageId,pageId);assert.equal(notionWriteAcknowledged(f.job.notionReceipt,'op'),true);
 assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);assert.equal(polls,2);
 f.mcp.readDocument=async()=>({text:f.body()});f.advance(20);
 assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(polls,2);assert.equal(f.writes(),1);
});
test('old v9 escaped punctuation is reproved only from exact original arguments under a manual read',async()=>{
 const expected='{"outcome":"completed","content":"合成正文\n完整结尾","summary":"完成"}';
 const actual='\\'+expected.slice(0,-1)+'\\}';
 for(const evidence of ['exact','missing','foreign','corrupt_raw'] as const){
  const f=fixture(),query=JSON.stringify({title:'合成稿',content:expected,final:true}),key=taskStepKey('worker','save_notion_draft',query);
  f.job.state='failed';f.db.chatOperations![0].status='failed';
  f.job.steps=[{key,namespace:'worker',scopeId:'op',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'started',updatedAt:new Date(f.now()).toISOString()}];
  f.job.notionReceipt={state:'uncertain',delivery:'unknown',pageId,checkpointKey:key,canonicalVersion:9,expectedRawDigest:evidence==='corrupt_raw'?'e'.repeat(64):notionHash(expected),expectedLength:expected.length,expectedDigest:notionHash(legacyNotionNormalized(expected)),expectedCanonicalDigest:canonicalNotionDigest(expected,9),final:true};
  if(evidence!=='missing')f.db.contextTraces.push({...scope,workspaceId:evidence==='foreign'?'foreign':scope.workspaceId,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);
  f.mcp.readDocument=async()=>({text:actual});const original=structuredClone(f.job.notionReceipt);
  if(evidence==='exact'){
   assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified');
   assert.equal(f.job.notionReceipt!.comparison!.comparatorVersion,11);assert.equal(f.job.notionReceipt!.canonicalVersion,9);
   assert.equal(f.job.notionReceipt!.expectedRawDigest,original.expectedRawDigest);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,original.expectedCanonicalDigest);
  }else{
   await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.state,'uncertain');
  }
  assert.equal(notionWriteAcknowledged(f.job.notionReceipt,'op'),false,'a readback never fabricates a historical write acknowledgement');assert.equal(f.writes(),0);
 }
});
test('manual known-page v11 reproof rechecks the exact old source at its final durable update',async()=>{
 const expected='方法 {开始}，金额 $3000。',actual='方法 \\{开始\\}，金额 \\$3000。';
 for(const removal of ['during_read','before_commit'] as const){
  const f=fixture(),query=JSON.stringify({title:'合成稿',content:expected,final:true}),key=taskStepKey('worker','save_notion_draft',query);
  f.job.state='failed';f.db.chatOperations![0].status='failed';
  f.job.steps=[{key,namespace:'worker',scopeId:'op',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'started',updatedAt:new Date(f.now()).toISOString()}];
  f.job.notionReceipt={state:'uncertain',delivery:'unknown',pageId,checkpointKey:key,canonicalVersion:9,expectedRawDigest:notionHash(expected),expectedLength:expected.length,expectedDigest:notionHash(legacyNotionNormalized(expected)),expectedCanonicalDigest:canonicalNotionDigest(expected,9),final:true};
  f.db.contextTraces.push({...scope,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);
  f.mcp.readDocument=async()=>{if(removal==='during_read')f.db.contextTraces=[];return {text:actual};};
  if(removal==='before_commit'){
   let commits=0;const mutate=f.store.mutate.bind(f.store);
   f.store.mutate=async fn=>{if(++commits===2)f.db.contextTraces=[];return mutate(fn);};
  }
  await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));
  assert.equal(f.job.notionReceipt.state,'uncertain');assert.equal(f.job.notionReceipt.verification!.lastReason,'stale');assert.equal(f.job.steps[0].state,'started');assert.equal(f.writes(),0);
 }
});
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
test('persistent mismatches exhaust bounded attempts, while a suspended deadline permits one remaining fresh read',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>({text:'别的正文'});await f.failWrite();
 for(const delay of [10,20,30]){f.advance(delay);await f.docs.reconcileDue(scope,async()=>{});}
 assert.equal(f.job.notionReceipt!.verification!.state,'exhausted');assert.equal(f.job.notionReceipt!.verification!.attempt,3);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.writes(),1);assert.equal(f.job.steps![0].state,'started');
 assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);
 const g=fixture();g.mcp.readDocument=async()=>{throw Error('temporary');};await g.failWrite();let reads=0;g.mcp.readDocument=async()=>{reads++;return {text:g.body()};};g.advance(1001);
 assert.equal((await g.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(reads,1);assert.equal(g.writes(),1);
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

test('a changed raw-source binding or expected length during readback cannot settle the old write',async()=>{
 for(const field of ['expectedRawDigest','expectedLength'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};await f.failWrite();f.advance(10);
  f.mcp.readDocument=async()=>{if(field==='expectedRawDigest')f.job.notionReceipt!.expectedRawDigest='0'.repeat(64);else f.job.notionReceipt!.expectedLength=(f.job.notionReceipt!.expectedLength??0)+1;return {text:f.body()};};
  assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'blocked');assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.steps![0].state,'started');assert.equal(f.writes(),1);
 }
});
test('legacy formatting recovery requires exact owned create arguments and their original digest/checkpoint',async()=>{
 const expected='**标题**\n> 第一段\n>\n> 第二段\n|人|事|\n|---|---|\n|甲|乙|',actual='<b>标题</b>\n<quote>\n第一段\n\n第二段\n</quote>\n|人|事|\n| --- | --- |\n|甲|乙|';
 for(const mode of ['exact','foreign','wrong_key','changed_hash','update'] as const){
  const f=fixture(),args=mode==='update'?{old_str:'old',new_str:expected,final:true}:{title:'测试',content:expected,final:true},query=JSON.stringify(args),key=taskStepKey('worker','save_notion_draft',query);
  f.job.state='failed';f.job.notionReceipt={state:'uncertain',pageId,expectedDigest:mode==='changed_hash'?'0'.repeat(64):notionHash(legacyNotionNormalized(expected)),final:true};f.job.steps=[{key:mode==='wrong_key'?'other':key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-25T01:00:00Z'}];
  f.db.contextTraces.push({...scope,workspaceId:mode==='foreign'?'wb':'wa',conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);f.mcp.readDocument=async()=>({text:actual});
  if(mode==='exact'){const result=await f.docs.reconcile(scope,'task',async()=>{});assert.equal(result.operationId,'op');assert.equal(f.job.notionReceipt!.canonicalVersion,4);assert.equal(f.job.notionReceipt!.expectedDigest,notionHash(legacyNotionNormalized(expected)));assert.equal(f.job.steps[0].state,'completed');}
  else{await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,undefined);}
  assert.equal(f.writes(),0);
 }
});
test('new v11 receipts do not use the permissive legacy whitespace path for literal code',async()=>{
 const f=fixture(),body='```\nx \n\n```';f.mcp.readDocument=async()=>({text:'```\nx\n```'});await f.failWrite({title:'代码',content:body,final:true});
 assert.equal(f.job.notionReceipt!.canonicalVersion,11);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,canonicalNotionDigest(body,11));f.advance(10);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(f.job.notionReceipt!.state,'uncertain');
});
test('manual v2 or v3 create recovery reproves the original body before upgrading to v4 and persists the exact selection before a failed read',async()=>{
 for(const status of ['failed','completed'] as const)for(const version of [2,3] as const){
  const f=fixture(),expected='**预算**\n|项目|费用|备注|\n|---|----|---:|\n|场地|100|不变|',actual='<b>预算</b>\n|项目|费用|备注|\n| --- | --- | --- |\n|场地|100|不变|',query=JSON.stringify({title:'测试',content:expected,final:true}),key=taskStepKey('worker','save_notion_draft',query);
  f.job.state='failed';f.db.chatOperations![0].status=status;
  f.job.steps=[{key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-25T01:00:00Z'}];
  const legacyDigest=notionHash(legacyNotionNormalized(expected)),oldDigest=canonicalNotionDigest(expected,version);
  f.job.notionReceipt={state:'uncertain',delivery:'unknown',pageId,expectedDigest:legacyDigest,expectedCanonicalDigest:oldDigest,canonicalVersion:version,checkpointKey:key,final:true};
  f.db.contextTraces.push({...scope,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);
  f.mcp.readDocument=async()=>{assert.equal(f.job.notionReceipt!.canonicalVersion,4);assert.equal(f.job.notionVerificationSelection!.operationId,'op');assert.equal(f.job.notionVerificationSelection!.checkpointKey,key);throw Error('first read unavailable');};
  await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}),/稍后会继续只读核对/);
  assert.equal(f.job.notionReceipt!.expectedDigest,legacyDigest);assert.notEqual(f.job.notionReceipt!.expectedCanonicalDigest,oldDigest);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,canonicalNotionDigest(expected,4));
  assert.deepEqual(f.job.notionVerificationSelection,{operationId:'op',expectedDigest:legacyDigest,pageId,asyncTaskId:undefined,checkpointKey:key,version:f.job.notionReceipt!.verification!.version,connectionId:'notion',grantId:'grant',parentId,requestedAt:new Date(f.now()).toISOString()});
  f.mcp.readDocument=async()=>({text:actual});f.advance(20);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(f.job.steps[0].state,'completed');assert.equal(f.writes(),0);
 }
});
test('v2 and v3 updates without original complete create proof keep their own digest instead of assuming v4 equivalence',async()=>{
 for(const version of [2,3] as const){
 const f=fixture(),expected='|项目|费用|\n|----|---:|\n|场地|100|',actual='|项目|费用|\n| --- | --- |\n|场地|100|',query=JSON.stringify({old_str:'旧正文',new_str:expected,final:true}),key=taskStepKey('worker','save_notion_draft',query),oldDigest=canonicalNotionDigest(expected,version);
 f.job.state='failed';f.db.chatOperations![0].status='failed';
 f.job.steps=[{key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-25T01:00:00Z'}];
 f.job.notionReceipt={state:'uncertain',delivery:'unknown',pageId,expectedDigest:notionHash(legacyNotionNormalized(expected)),expectedCanonicalDigest:oldDigest,canonicalVersion:version,checkpointKey:key,final:true};
 f.db.contextTraces.push({...scope,conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query}]} as any);f.mcp.readDocument=async()=>({text:actual});
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.canonicalVersion,version);assert.equal(f.job.notionReceipt!.expectedCanonicalDigest,oldDigest);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.steps[0].state,'started');assert.equal(f.writes(),0);
 }
});
test('a new aligned table save verifies a plain-delimiter readback immediately under v11 without a second write',async()=>{
 const f=fixture(),expected='**预算**\n|项目|费用|备注|\n|---|---|---:|\n|场地|-100|+200:结余|',actual='<b>预算</b>\n|项目|费用|备注|\n| --- | --- | --- |\n|场地|-100|+200:结余|';
 f.mcp.readDocument=async()=>({text:actual});const tool=f.docs.tool(scope,'op','task',f.job,async()=>{}).structured!;
 const result=await tool.run(tool.validate({title:'预算',content:expected,final:true})) as {state:string};
 assert.equal(result.state,'delivered');assert.equal(f.writes(),1);assert.equal(f.job.notionReceipt!.state,'delivered');assert.equal(f.reads(),0);assert.equal(f.job.notionReceipt!.canonicalVersion,11);assert.equal(f.job.notionReceipt!.verification?.state,'scheduled');f.job.state='completed';f.advance(10);assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');assert.equal(f.job.notionReceipt!.state,'delivered');assert.equal(f.job.notionReceipt!.verification,undefined);assert.notEqual(f.job.notionReceipt!.expectedCanonicalDigest,canonicalNotionDigest(expected,3));
});

test('deadline recovery is single-use across restart and concurrent polling, and never resets the total read budget',async()=>{
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial read unavailable');};await f.failWrite();
 const original=structuredClone(f.job.notionReceipt!.verification!);f.advance(1001);let reads=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve);
 f.mcp.readDocument=async()=>{reads++;await gate;return {text:'实际仍是不同正文'};};
 await assert.rejects(()=>f.docs.reconcileDue(scope,async()=>{throw Error('Key unavailable');}));assert.equal(reads,0);assert.equal(f.job.notionReceipt!.verification!.attempt,0);
 const checking=f.docs.reconcileDue(scope,async()=>{});while(!reads)await new Promise(resolve=>setTimeout(resolve,0));
 const v=f.job.notionReceipt!.verification!;assert.equal(v.resumeCheckUsed,true);assert.equal(v.attempt,1);assert.equal(v.deadlineAt,original.deadlineAt);assert.equal(v.version,original.version);
 assert.deepEqual(await new NotionDocuments(f.store,f.mcp,{now:f.now,delays:[10,20,30]}).reconcileDue(scope,async()=>{}),[]);release();assert.equal((await checking)[0].state,'exhausted');
 f.advance(1001);assert.deepEqual(await f.docs.reconcileDue(scope,async()=>{}),[]);assert.equal(reads,1);assert.equal(f.writes(),1);assert.equal(f.job.notionReceipt!.comparison?.kind,'body_mismatch');
 const g=fixture();g.mcp.readDocument=async()=>{throw Error('initial unavailable');};await g.failWrite();g.job.notionReceipt!.verification!.attempt=3;g.advance(1001);let cappedReads=0;g.mcp.readDocument=async()=>{cappedReads++;return {text:g.body()};};assert.equal((await g.docs.reconcileDue(scope,async()=>{}))[0].state,'exhausted');assert.equal(cappedReads,0);
});

test('deadline recovery preserves cancellation, archive and exact Notion authorization before any read',async()=>{
 for(const mutation of ['cancelled','archived','revoked','different-parent'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};await f.failWrite();f.advance(1001);let reads=0;
  f.mcp.readDocument=async()=>{reads++;return {text:f.body()};};
  if(mutation==='cancelled')f.job.state='cancelled';if(mutation==='archived')f.db.conversations[0].archived=true;if(mutation==='revoked')f.db.knowledgeConnections[0].status='revoked';if(mutation==='different-parent')f.db.knowledgeConnections[0].notionWriting!.parentId='c'.repeat(32);
  await f.docs.reconcileDue(scope,async()=>{});assert.equal(reads,0);assert.equal(f.writes(),1);assert.equal(f.job.notionReceipt!.state,'uncertain');
 }
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
test('a manual check after an external edit preserves prior delivery and exposes independent background attention',async()=>{
 const f=fixture();await f.saveAcknowledged();f.advance(10);await f.docs.reconcileDue(scope,async()=>{});f.setBody('用户之后手动修改的正文');
 assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'delivered');assert.equal(f.job.notionReceipt!.state,'delivered');assert.notEqual(f.job.notionReceipt!.integrity?.state,'covered');assert.equal(f.job.state,'completed');assert.equal(f.writes(),1);
});
test('late readback failure never schedules a cancelled, user-stopped or archived write',async()=>{
 for(const mode of ['cancelled','stopped','archived'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{
   if(mode==='cancelled'){f.job.state='cancelled';f.db.chatOperations![0].status='interrupted';}
   if(mode==='stopped'){f.db.conversations[0].workPaused=true;f.db.conversations[0].workPauseReason='user_stopped';}
   if(mode==='archived')f.db.conversations[0].archived=true;
   throw Error('late readback failure');
  };
  const call=f.mcp.callDocumentTool.bind(f.mcp);f.mcp.callDocumentTool=async(...params)=>({...await call(...params) as object,status:'accepted'});
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
