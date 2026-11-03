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
const scope={workspaceId:'wa',userId:'a'},parentId='a'.repeat(32),pageId='b'.repeat(32),otherId='c'.repeat(32);
const url=`https://www.notion.so/${pageId}`;
async function fixture(){
 let now=Date.parse('2026-11-03T01:00:00.000Z'),writes=0;
 const args={title:'合成未知回执',content:'完整正文\n\n**原样** `紫色_42`\n\n|甲|乙|\n|---|---|\n|金额|3200|\n\n自然结尾。',final:true},reads:string[]=[];
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
