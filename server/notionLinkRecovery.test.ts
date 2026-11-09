import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import type {Store} from './db.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {NotionMcpService} from './knowledge/notionMcpService.js';
import {NotionDocuments} from './notionDocuments.js';
import {notionLinkRecoveryOffer,parseNotionLinkRecovery,selectNotionLinkRecovery,type NotionLinkRecoveryRequest} from './notionLinkRecovery.js';
import {runTaskOrchestrator} from './taskOrchestrator.js';
import {taskStepKey,type TaskStepStore} from './taskSteps.js';
import {canonicalNotionDigest} from './notionCanonical.js';
import {createWorkflowRun} from './taskWorkflow.js';
const scope={workspaceId:'wa',userId:'a'},parentId='a'.repeat(32),pageId='b'.repeat(32),otherId='c'.repeat(32);
const url=`https://www.notion.so/${pageId}`;
async function fixture(content?:string){
 let now=Date.parse('2026-11-03T01:00:00.000Z'),writes=0;
 const args={title:'合成未知回执',content:content??'完整正文\n\n**原样** `紫色_42`\n\n|甲|乙|\n|---|---|\n|金额|3200|\n\n自然结尾。',final:true},reads:string[]=[];
 const db={users:[{id:'a',enabled:true},{id:'b',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[scope,{workspaceId:'wb',userId:'b'},{workspaceId:'wa',userId:'b'}],knowledgeConnections:[{id:'notion',workspaceId:'wa',provider:'notion',status:'connected',notionWriting:{grantId:'grant',userId:'a',parentId}}],conversations:[{...scope,id:'task',title:args.title,archived:false,messages:[],notionDocument:{connectionId:'notion',grantId:'grant',parentId}}],chatOperations:[],contextTraces:[]} as unknown as Database;
 const store={read:async()=>structuredClone(db),mutate:async<T>(fn:(d:Database)=>T)=>fn(db)} as Store;
 const job={state:'running',notionTarget:{connectionId:'notion',grantId:'grant',parentId,referenceIds:[]},steps:[],contract:{version:1,requiredFeatureIds:[],requiredTools:['save_notion_draft'],execution:'model'}} as unknown as WorkRun;
 const op={...scope,id:'op',operationId:'original-operation',requestId:'request',conversationId:'task',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),status:'pending',workRun:job} as NonNullable<Database['chatOperations']>[number];db.chatOperations!.push(op);
 const page=()=>({properties:{title:args.title},text:`<page><content>\n${args.content}\n</content></page>`});
 const parent=()=>({text:`<page><content>\n<page url="${url}">${args.title}</page>\n</content></page>`});
 const mcp={readDocument:async(ws:string,id:string)=>{assert.equal(ws,scope.workspaceId);reads.push(id);return id===parentId?parent():page();},callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,name:string,_args:unknown,before?:()=>Promise<void>)=>{assert.equal(name,'notion-create-pages');await before?.();writes++;throw Error('lost create acknowledgement');}} as unknown as NotionMcpService;
 const docs=new NotionDocuments(store,mcp,{now:()=>now});
 const steps=job.steps!,checkpoints:TaskStepStore={namespace:'worker',steps,save:async cp=>{const i=steps.findIndex(s=>s.key===cp.key);if(i<0)steps.push(cp);else steps[i]=cp;}};
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[docs.tool(scope,'op','task',job,async()=>{})],checkpoints,maxSteps:2,beforeStep:async()=>{},call:async()=>({content:'',toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify(args)}}]})}));
 job.state='failed';op.status='failed';now+=1000;
 const input:NotionLinkRecoveryRequest={sourceJobId:'op',expectedUpdatedAt:op.updatedAt,pageUrl:url,selectionId:'selection-original'};
 return {db,store,op,job,docs,mcp,args,input,reads,page,parent,writes:()=>writes,advance:()=>now+=1000,check:()=>docs.reconcile(scope,'task',async()=>{},input)};
}

test('link recovery supports immutable v9/v10 and new v11 exact receipts while rejecting unknown comparator versions before reads',async()=>{
 for(const version of [9,10,11] as const){
  const f=await fixture(),receipt=f.job.notionReceipt!;
  receipt.canonicalVersion=version;receipt.expectedCanonicalDigest=canonicalNotionDigest(f.args.content,version);
  const original=structuredClone(receipt);
  assert.ok(notionLinkRecoveryOffer(f.db,scope,f.op));
  assert.equal((await f.check()).state,'verified');assert.equal(f.writes(),1);assert.deepEqual(f.reads,[parentId,pageId]);
  for(const field of ['canonicalVersion','expectedCanonicalDigest','expectedDigest','expectedRawDigest','expectedLength','checkpointKey'] as const)assert.deepEqual(receipt[field],original[field]);
 }
 const future=await fixture();future.job.notionReceipt!.canonicalVersion=12 as any;
 assert.equal(notionLinkRecoveryOffer(future.db,scope,future.op),undefined);
 assert.equal(selectNotionLinkRecovery(future.db,scope,{text:'原页链接是 '+url,boundTaskId:'task'}).kind,'unavailable');
 await assert.rejects(future.check);assert.equal(future.reads.length,0);assert.equal(future.writes(),1);assert.equal(future.job.notionReceipt!.state,'uncertain');
});

test('an original-page link can reprove v9 escapes only with its exact original source and keeps all original receipt hashes',async()=>{
 const source='方法 {开始}，金额 $3000。\n\n正文 [甲]与 `code_7`。\n\n完整结尾。';
 const serialized='方法 \\{开始\\}，金额 \\$3000。\n\n正文 \\[甲\\]与 `code_7`。\n\n完整结尾。';
 for(const proof of ['trace','workflow','missing','foreign_trace','wrong_request','changed_source','changed_body','changed_code','foreign_workflow','removed_during_read','removed_before_adoption'] as const){
  const f=await fixture(source),receipt=f.job.notionReceipt!;
  receipt.canonicalVersion=9;receipt.expectedCanonicalDigest=canonicalNotionDigest(source,9);
  if(proof==='workflow'||proof==='foreign_workflow'){
   const binding={...scope,operationId:f.op.id},workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'完整稿',kind:'model',instruction:'撰写完整稿',inputs:[]}]},binding);
   const step=workflow.spec.steps[0],namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:${step.id}`,key=taskStepKey(namespace,tool,JSON.stringify({revision:workflow.revision,instruction:step.instruction,inputs:step.inputs}));
   workflow.steps[0]={id:step.id,state:'completed',checkpointKey:key};workflow.phase='completed';
   f.job.workflow=workflow;
   f.job.steps!.push({key,namespace,scopeId:proof==='foreign_workflow'?'foreign-operation':f.op.id,tool,label:'完整稿',effect:'model',state:'completed',updatedAt:'2026-11-03T01:00:00.000Z',output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:step.id},outcome:'completed',result:{outcome:'returned',content:source,summary:'完整稿'}}});
  }else if(proof!=='missing'){
   const query=JSON.stringify(proof==='changed_source'?{...f.args,content:source+'附加稿'}:f.args);
   f.db.contextTraces.push({...scope,workspaceId:proof==='foreign_trace'?'foreign-workspace':scope.workspaceId,id:'exact-write',conversationId:'task',requestId:proof==='wrong_request'?'foreign-request':f.op.requestId,executionSteps:[{tool:'save_notion_draft',query}]} as any);
  }
  f.mcp.readDocument=async(_ws,id)=>{
   f.reads.push(id);if(id===parentId)return f.parent();
   if(proof==='removed_during_read')f.db.contextTraces=[];
   const body=proof==='changed_body'?serialized.replace('3000','3001'):proof==='changed_code'?serialized.replace('code_7','code_8'):serialized;
   return {...f.page(),text:`<page><content>\n${body}\n</content></page>`};
  };
  if(proof==='removed_before_adoption'){
   const mutate=f.store.mutate.bind(f.store);
   f.store.mutate=async fn=>{f.db.contextTraces=[];return mutate(fn);};
  }
  const original=structuredClone(receipt);assert.ok(notionLinkRecoveryOffer(f.db,scope,f.op));
  if(proof==='trace'||proof==='workflow'){
   assert.equal((await f.check()).state,'verified');assert.equal(receipt.comparison!.kind,'matched');assert.equal(receipt.comparison!.comparatorVersion,11);
   assert.equal(receipt.pageId,pageId);assert.equal(receipt.linkRecovery!.selectionId,f.input.selectionId);
  }else{
   await assert.rejects(f.check,/正文|原稿证据/);assert.equal(receipt.state,'uncertain');assert.equal(receipt.pageId,undefined);assert.equal(f.job.steps![0].state,'started');
  }
  for(const field of ['canonicalVersion','expectedCanonicalDigest','expectedRawDigest','expectedDigest','expectedLength','checkpointKey'] as const)assert.deepEqual(receipt[field],original[field],proof+'/'+field);
  assert.equal(receipt.writeAcknowledgement,undefined);assert.equal(f.writes(),1);assert.deepEqual(f.reads,[parentId,pageId]);
 }
});

test('an old v10 unknown-page style receipt needs exact original source before a supplied link can use v11',async()=>{
 const source='**保留代码 `KEEP_紫色42`**\n\n**[格式说明](https://example.test/notion-format)**\n\n自然结尾。';
 const serialized='<b>保留代码 </b><b><code>KEEP_紫色42</code></b>\n\n[<b>格式说明</b>](https://example.test/notion-format)\n\n自然结尾。';
 assert.notEqual(canonicalNotionDigest(source,10),canonicalNotionDigest(serialized,10));
 for(const proof of ['exact','missing','foreign','changed_code','changed_link','missing_raw'] as const){
  const f=await fixture(source),receipt=f.job.notionReceipt!;receipt.canonicalVersion=10;receipt.expectedCanonicalDigest=canonicalNotionDigest(source,10);
  if(proof!=='missing')f.db.contextTraces.push({...scope,workspaceId:proof==='foreign'?'foreign':scope.workspaceId,conversationId:'task',requestId:f.op.requestId,executionSteps:[{tool:'save_notion_draft',query:JSON.stringify(f.args)}]} as any);
  if(proof==='missing_raw')delete receipt.expectedRawDigest;
  f.mcp.readDocument=async(_ws,id)=>{
   f.reads.push(id);if(id===parentId)return f.parent();
   const actual=proof==='changed_code'?serialized.replace('KEEP_紫色42','KEEP_紫色43'):proof==='changed_link'?serialized.replace('notion-format','another-page'):serialized;
   return {...f.page(),text:`<page><content>\n${actual}\n</content></page>`};
  };
  const original=structuredClone(receipt);
  if(proof==='exact'){
   assert.equal((await f.check()).state,'verified');assert.equal(receipt.comparison!.comparatorVersion,11);
  }else{await assert.rejects(f.check);assert.equal(receipt.state,'uncertain');assert.equal(receipt.pageId,undefined);}
  for(const field of ['canonicalVersion','expectedCanonicalDigest','expectedRawDigest','expectedDigest','expectedLength','checkpointKey'] as const)assert.deepEqual(receipt[field],original[field],proof+'/'+field);
  assert.equal(receipt.writeAcknowledgement,undefined);assert.equal(f.writes(),1);
 }
});

test('user supplied exact original page confirms body without create/update or altering original source/delivery facts',async()=>{
 const f=await fixture(),r=structuredClone(f.job.notionReceipt!),time=f.job.steps![0].updatedAt;
 assert.equal(r.pageId,undefined);assert.equal(r.expectedPageTitle,f.args.title);assert.equal(r.delivery,'unknown');
 assert.deepEqual(notionLinkRecoveryOffer(f.db,scope,f.op),{inputNeeded:'page_url',sourceJobId:'op',expectedUpdatedAt:f.op.updatedAt});
 const result=await f.check();assert.equal(result.state,'verified');assert.equal(result.url,url);assert.deepEqual(f.reads,[parentId,pageId]);assert.equal(f.writes(),1);
 const receipt=f.job.notionReceipt!;assert.equal(receipt.state,'verified');assert.equal(receipt.delivery,'unknown');
 for(const field of ['expectedDigest','expectedRawDigest','expectedCanonicalDigest','canonicalVersion','expectedLength','checkpointKey','expectedPageTitle'] as const)assert.deepEqual(receipt[field],r[field]);
 assert.equal(receipt.linkRecovery!.source,'user_supplied_page');assert.equal(receipt.linkRecovery!.selectionId,f.input.selectionId);assert.equal(receipt.comparison!.kind,'matched');
 assert.equal(f.job.steps![0].state,'completed');assert.equal(f.job.steps![0].updatedAt,time);assert.equal(f.job.notionTarget!.pageId,pageId);assert.equal(f.db.conversations[0].notionDocument!.pageId,pageId);
 const before=structuredClone(receipt),reports=f.job.reportRevision;await f.check();assert.deepEqual(f.job.notionReceipt,before);assert.equal(f.job.reportRevision,reports);assert.equal(f.reads.length,2,'same request returns one durable proof without more reads');
});

test('candidate requires original title, all complete source hashes and exact worker checkpoint, never a guessed conversation title',async()=>{
 for(const mode of ['title','raw','canonical','length','scope','tool','effect','state','duplicate','version'] as const){
  const f=await fixture(),r=f.job.notionReceipt!,step=f.job.steps![0];
  if(mode==='title')delete r.expectedPageTitle;if(mode==='raw')delete r.expectedRawDigest;if(mode==='canonical')delete r.expectedCanonicalDigest;if(mode==='length')r.expectedLength=0;if(mode==='scope')step.scopeId='different';if(mode==='tool')step.tool='oneHtml';if(mode==='effect')step.effect='read';if(mode==='state')step.state='failed';if(mode==='duplicate')f.job.steps!.push({...step});if(mode==='version')delete r.canonicalVersion;
  assert.equal(notionLinkRecoveryOffer(f.db,scope,f.op),undefined,mode);await assert.rejects(f.check);assert.equal(f.reads.length,0,mode);assert.equal(r.pageId,undefined);assert.equal(f.writes(),1);
 }
 const legacy=await fixture();delete legacy.job.notionReceipt!.expectedPageTitle;
 legacy.db.contextTraces.push({...scope,id:'trace',conversationId:'task',requestId:'request',executionSteps:[{tool:'save_notion_draft',query:JSON.stringify(legacy.args)}]} as any);
 assert.ok(notionLinkRecoveryOffer(legacy.db,scope,legacy.op));await legacy.check();
});

test('wrong title, altered body, incomplete content and wrong parent do not attach even a candidate id',async()=>{
 for(const mode of ['title','missing-title','body','truncated','parent','fake-child-code','fake-child-quote','fake-child-indent','fake-child-inline','parent-truncated'] as const){
  const f=await fixture();f.mcp.readDocument=async(_ws,id)=>{
   f.reads.push(id);if(id===parentId){
    if(mode==='parent')return {text:'<content>\n</content>'};
    if(mode==='parent-truncated')return {...f.parent(),truncated:true};
    const entry=`<page url="${url}">${f.args.title}</page>`;
    if(mode==='fake-child-code')return {text:`<content>\n\`\`\`\n${entry}\n\`\`\`\n</content>`};
    if(mode==='fake-child-quote')return {text:`<content>\n> ${entry}\n</content>`};
    if(mode==='fake-child-indent')return {text:`<content>\n    ${entry}\n</content>`};
    if(mode==='fake-child-inline')return {text:`<content>\n正文举例 ${entry}\n</content>`};
    return f.parent();
   }
   if(mode==='title')return {...f.page(),properties:{title:'另一篇文章'}};
   if(mode==='missing-title')return {text:f.page().text};
   if(mode==='truncated')return {...f.page(),truncated:true};
   if(mode==='body')return {...f.page(),text:f.page().text.replace('3200','3201')};
   return f.page();
  };
  await assert.rejects(f.check,/标题|正文|位置|列表/);assert.equal(f.job.notionReceipt!.pageId,undefined,mode);assert.equal(f.job.notionTarget!.pageId,undefined);assert.equal(f.db.conversations[0].notionDocument!.pageId,undefined);assert.equal(f.job.steps![0].state,'started');assert.equal(f.writes(),1);
 }
});

test('known page cannot be replaced and known async task is not bypassed by a user page',async()=>{
 for(const mode of ['page','async','not-sent','rejected'] as const){
  const f=await fixture();if(mode==='page')f.job.notionReceipt!.pageId=otherId;if(mode==='async')f.job.notionReceipt!.asyncTaskId='known-task';if(mode==='not-sent')f.job.notionReceipt!.delivery='not_sent';if(mode==='rejected')f.job.notionReceipt!.delivery='rejected';
  assert.equal(notionLinkRecoveryOffer(f.db,scope,f.op),undefined);await assert.rejects(f.check);assert.equal(f.reads.length,0);assert.equal(f.writes(),1);
 }
});

test('a formatted sibling title does not invalidate positive exact-child proof',async()=>{
 const f=await fixture(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(ws,id)=>id===parentId?{text:`<page><content>\n<page url="https://notion.so/${otherId}">其他 &amp; 无关标题</page>\n<page url="${url}">${f.args.title}</page>\n</content></page>`}:read(ws,id);
 await f.check();assert.equal(f.job.notionReceipt!.state,'verified');assert.equal(f.writes(),1);
});

test('other independent or foreign task pages and cross-owner recoveries are rejected without disclosing ownership',async()=>{
 for(const foreign of [false,true]){
  const f=await fixture();f.db.conversations.push({...(foreign?{workspaceId:'wb',userId:'b'}:scope),id:'another-task',notionDocument:{pageId}} as any);
  await assert.rejects(f.check,error=>{assert.match((error as Error).message,/不能作为本次/);assert.doesNotMatch((error as Error).message,/another-task|\bwb\b|\bb\b/);return true;});assert.equal(f.reads.length,0);assert.equal(f.job.notionReceipt!.pageId,undefined);
 }
 const f=await fixture();for(const other of [{workspaceId:'wa',userId:'b'},{workspaceId:'wb',userId:'b'}]){assert.equal(notionLinkRecoveryOffer(f.db,other,f.op),undefined);await assert.rejects(()=>f.docs.reconcile(other,'task',async()=>{},f.input),/不存在/);}assert.equal(f.reads.length,0);
});

test('selection races, stopped tasks, changed authorization and newer requirements preserve the unresolved original write',async()=>{
 for(const mode of ['stop','cancel','archive','grant','parent','digest','length','version','new-job','checkpoint'] as const){
  const f=await fixture(),read=f.mcp.readDocument.bind(f.mcp);f.mcp.readDocument=async(ws,id)=>{
   const result=await read(ws,id);if(id!==pageId)return result;
   if(mode==='stop')f.db.conversations[0].workPauseReason='user_stopped';if(mode==='cancel')f.job.state='cancelled';if(mode==='archive')f.db.conversations[0].archived=true;
   if(mode==='grant')f.db.knowledgeConnections[0].notionWriting!.grantId='new-grant';if(mode==='parent')f.db.knowledgeConnections[0].notionWriting!.parentId=otherId;
   if(mode==='digest')f.job.notionReceipt!.expectedRawDigest='f'.repeat(64);if(mode==='length')f.job.notionReceipt!.expectedLength!++;if(mode==='version')f.op.updatedAt='2026-11-03T02:00:00.000Z';
   if(mode==='new-job')f.db.chatOperations!.push({...f.op,id:'new-job',workRun:{...f.job,notionReceipt:undefined,state:'queued'}});if(mode==='checkpoint')f.job.steps![0].scopeId='changed';
   return result;
  };
  await assert.rejects(f.check);assert.equal(f.job.notionReceipt!.pageId,undefined,mode);assert.equal(f.job.notionTarget!.pageId,undefined);assert.equal(f.job.steps![0].state,'started');assert.equal(f.writes(),1);
 }
 const unavailable=await fixture();await assert.rejects(()=>unavailable.docs.reconcile(scope,'task',async()=>{throw Error('Key missing');},unavailable.input),/Key missing/);assert.equal(unavailable.reads.length,0);
});

test('malformed, stale and extra-field user selection never invokes a connector',async()=>{
 const f=await fixture();for(const input of [{...f.input,pageUrl:'https://evil.test/'+pageId},{...f.input,selectionId:''},{...f.input,expectedUpdatedAt:'old'},{...f.input,extra:'unreviewed'}])await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{},input));assert.equal(f.reads.length,0);assert.equal(f.writes(),1);
});

test('concurrent identical selections share one bounded readonly proof and reject a second page under the same selection',async()=>{
 const f=await fixture(),read=f.mcp.readDocument.bind(f.mcp);let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 f.mcp.readDocument=async(ws,id)=>{const result=await read(ws,id);if(id===pageId){enter();await gate;}return result;};
 const first=f.check();await entered;const second=f.check();
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{},{...f.input,pageUrl:`https://www.notion.so/${otherId}`}),/另一个页面/);
 release();const results=await Promise.all([first,second]);assert.deepEqual(results[0],results[1]);assert.deepEqual(f.reads,[parentId,pageId]);assert.equal(f.job.reportRevision,1);assert.equal(f.writes(),1);
});

test('natural recovery requires a current direct single link, with explicit task choice for ambiguity',async()=>{
 const f=await fixture();
 assert.equal(parseNotionLinkRecovery('原页链接是 '+url+'，请核对完整正文。').kind,'candidate');
 for(const text of ['参考链接 '+url,'不要核对原页链接是 '+url,'如果原页链接是 '+url+'，我们怎么设计核对入口？','> 原页链接是 '+url,'```\n原页链接是 '+url+'\n```','他说“原页链接是 '+url+'，请核对正文。”'])assert.equal(parseNotionLinkRecovery(text).kind,'none',text);
 assert.equal(parseNotionLinkRecovery('原页链接是“'+url+'”，只读核对。').kind,'candidate');
 assert.equal(parseNotionLinkRecovery(url).kind,'none');assert.equal(parseNotionLinkRecovery(url,{allowBareLink:true}).kind,'candidate');
 assert.equal(parseNotionLinkRecovery('原页链接是 '+url+' '+`https://www.notion.so/${otherId}`).kind,'ambiguous');
 const selected=selectNotionLinkRecovery(f.db,scope,{text:'原页链接是 '+url});assert.equal(selected.kind,'candidate');if(selected.kind==='candidate'){assert.equal(selected.taskId,'task');assert.equal(selected.sourceJobId,'op');}
 assert.equal(selectNotionLinkRecovery(f.db,scope,{text:url,boundTaskId:'task'}).kind,'candidate');
 f.db.conversations.push({...f.db.conversations[0],id:'second-task'});f.db.chatOperations!.push({...f.op,id:'second-op',conversationId:'second-task',workRun:{...structuredClone(f.job),steps:f.job.steps!.map(step=>({...step,scopeId:'second-op'}))}});
 assert.equal(selectNotionLinkRecovery(f.db,scope,{text:'原页链接是 '+url}).kind,'ambiguous');assert.equal(selectNotionLinkRecovery(f.db,scope,{text:url,boundTaskId:'task'}).kind,'candidate');assert.equal(selectNotionLinkRecovery(f.db,{workspaceId:'wb',userId:'b'},{text:'原页链接是 '+url}).kind,'none');
});

test('ordinary page reads and known-page tasks retain normal routing instead of being hijacked by recovery',async()=>{
 const f=await fixture();assert.equal(selectNotionLinkRecovery({...f.db,chatOperations:[]},scope,{text:'请只读核对这页 '+url}).kind,'none');
 f.job.notionReceipt!.pageId=pageId;assert.equal(selectNotionLinkRecovery(f.db,scope,{text:'请只读核对这页 '+url,boundTaskId:'task'}).kind,'none');
 delete f.job.notionReceipt!.pageId;delete f.job.notionReceipt!.expectedPageTitle;
 assert.equal(selectNotionLinkRecovery(f.db,scope,{text:'原页链接是 '+url,boundTaskId:'task'}).kind,'unavailable','only a relevant incomplete original proof explains recovery unavailability');
});
