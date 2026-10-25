import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from './types.js';
import type { Store } from './db.js';
import type { WorkRun } from './coordinatorTypes.js';
import { NotionDocuments, notionPageId, notionBody, writingTarget } from './notionDocuments.js';
import { NotionWriteError, type NotionMcpService } from './knowledge/notionMcpService.js';
import {appendTaskResultReport,pendingConversationTaskResults,pendingTaskResults} from './taskResultInbox.js';
import {runTaskOrchestrator} from './taskOrchestrator.js';
import {notionRetryCheckpointPlan,verifiedNotionCompletion} from './notionCompletion.js';
import type {TaskStep,TaskStepStore} from './taskSteps.js';
const s = { workspaceId: 'wa', userId: 'a' };
const parentId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
function fixture() {
  const db = { users: [{id:'a',enabled:true},{id:'b',enabled:true}], workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],
    knowledgeConnections:[{ id:'notion-a',workspaceId:'wa',provider:'notion',status:'connected',notionWriting:{grantId:'grant-a',userId:'a',parentId,authorizedAt:'now'} }],conversations:[{...s,id:'task',notionDocument:{connectionId:'notion-a',grantId:'grant-a',parentId}}],chatOperations:[] } as unknown as Database;
  const store = {read:async()=>structuredClone(db),mutate:async(fn:any)=>fn(db)} as Store;
  let body = '原来的文章';
  const calls: {name:string;args:any}[]=[];
  const mcp = { readDocument:async(ws:string,id:string)=>{assert.equal(ws,'wa'); return {text:`<page url="https://www.notion.so/${id}"><content>${body}</content></page>`};},
    callDocumentTool:async(ws:string,cid:string,grant:string,uid:string,name:string,args:any)=>{
      assert.deepEqual([ws,cid,grant,uid],['wa','notion-a','grant-a','a']); calls.push({name,args});
      if(name==='notion-create-pages'){body=args.pages[0].content;return {pages:[{id:pageId}]};}
      if(name==='notion-update-page'){body=body.replace(args.content_updates[0].old_str,args.content_updates[0].new_str);return {id:pageId};}
      throw new Error('unexpected tool');
    } } as unknown as NotionMcpService;
  const docs = new NotionDocuments(store,mcp);
  function job(id='op',existing?:string) {
    const job = {state:'running',notionTarget:{...writingTarget(db,s),pageId:existing}} as WorkRun;
    db.chatOperations!.push({...s,id,conversationId:'task',workRun:job} as any);
    return job;
  }
  return {db,store,docs,mcp,calls,job,setBody:(v:string)=>body=v,getBody:()=>body};
}
function checkpointStore(steps:TaskStep[]=[]):TaskStepStore{return {namespace:'worker',steps,save:async step=>{const i=steps.findIndex(s=>s.key===step.key);if(i<0)steps.push(step);else steps[i]=step;}};}
test('same attempt identical Notion save arguments run once; a new revision really updates the same page',async()=>{
 const f=fixture(),first=f.job('first'),store=checkpointStore();let turn=0;
 const args={title:'合成文章',content:'等待补料的旧正文'};
 const write=(id:string,value:unknown)=>({id,type:'function' as const,function:{name:'save_notion_draft',arguments:JSON.stringify(value)}});
 const initial=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,checkpoints:store,requiredTools:['save_notion_draft'],beforeStep:async()=>{},tools:[f.docs.tool(s,'first','task',first,async()=>{})],call:async()=>++turn<3?{content:'',toolCalls:[write(`first-${turn}`,args)]}:{content:'已保存',toolCalls:[]}});
 assert.equal(f.calls.length,1);assert.equal(initial.trace[1].status,'reused');assert.equal(store.steps[0].scopeId,'first');
 first.steps=store.steps;
 const second=f.job('second',pageId),oldOnly=checkpointStore(structuredClone(store.steps));
 const absent=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:1,checkpoints:oldOnly,requiredTools:['save_notion_draft'],beforeStep:async()=>{},tools:[f.docs.tool(s,'second','task',second,async()=>{},f.getBody())],call:async()=>({content:'旧文章已保存',toolCalls:[]})});
 assert.deepEqual(absent.requiredMissing,['save_notion_draft'],'prior attempts never fulfil this revision');
 const plan=notionRetryCheckpointPlan(first,{newWrite:true,scopeId:'second'});
 second.steps=plan.steps;turn=0;
 await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,checkpoints:checkpointStore(second.steps),requiredTools:['save_notion_draft'],beforeStep:async()=>{},tools:[f.docs.tool(s,'second','task',second,async()=>{},f.getBody())],call:async()=>++turn===1?{content:'',toolCalls:[write('second',{old_str:'等待补料的旧正文',new_str:'按新补料写好的完整文章'})]}:{content:'已修订',toolCalls:[]}});
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].name,'notion-update-page');assert.equal(f.calls[1].args.page_id,pageId);assert.equal(f.getBody(),'按新补料写好的完整文章');assert.equal(second.notionReceipt!.state,'verified');
});
test('different Notion arguments sequentially revise the same page; only verified final manuscript finishes the task',async()=>{
 const f=fixture(),job=f.job(),store=checkpointStore();let turn=0;
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:4,checkpoints:store,requiredTools:['save_notion_draft'],beforeStep:async()=>{},tools:[f.docs.tool(s,'op','task',job,async()=>{})],completeAfterTools:()=>verifiedNotionCompletion(job.notionReceipt,store.steps,['save_notion_draft'],{scopeId:'op'}),call:async()=>{
  turn++;assert.ok(turn<=3,'final readback should not buy another model round');
  const args=turn<3?{title:'文章',content:'中间稿，尚未写完整'}:{old_str:'中间稿，尚未写完整',new_str:'按全部要求写好的完整终稿。\n结尾已经补齐。',final:true};
  return {content:'',toolCalls:[{id:`edit-${turn}`,type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify(args)}}]};
 }});
 assert.equal(turn,3);assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(c=>c.name),['notion-create-pages','notion-update-page']);assert.equal(f.calls[1].args.page_id,pageId);
 assert.equal(result.trace[1].status,'reused');assert.equal(result.trace[2].status,'returned');assert.equal(store.steps.length,2);
 assert.equal(f.getBody(),'按全部要求写好的完整终稿。\n结尾已经补齐。');assert.equal(job.notionReceipt!.final,true);assert.match(result.content,/文章已保存/);
 assert.ok(!verifiedNotionCompletion({...job.notionReceipt!,final:false},store.steps,['save_notion_draft'],{scopeId:'op'}),'nonfinal saved draft cannot terminate the complete article');
});
test('sequential revisions use the actual canonical readback when Notion serializes line breaks',async()=>{
 const f=fixture(),job=f.job();
 f.mcp.callDocumentTool=async(_ws,_cid,_grant,_uid,name,args:any)=>{
  f.calls.push({name,args});
  f.setBody((name==='notion-create-pages'?args.pages[0].content:f.getBody().replace(args.content_updates[0].old_str,args.content_updates[0].new_str)).replace(/\n/g,'<br />'));
  return {id:pageId};
 };
 const tool=f.docs.tool(s,'op','task',job,async()=>{}).structured!;
 const first=await tool.run(tool.validate({title:'合成文章',content:'第一行\n第二行'})) as any;
 assert.equal(first.currentDocument,'第一行<br />第二行');
 await tool.run(tool.validate({old_str:first.currentDocument,new_str:'完整的最终正文',final:true}));
 assert.equal(f.getBody(),'完整的最终正文');assert.equal(f.calls.length,2);assert.equal(job.notionReceipt!.final,true);
});
test('a second sequential save that loses its response cannot be followed by a third write or reuse the first final proof',async()=>{
 const f=fixture(),job=f.job(),store=checkpointStore(),tool=f.docs.tool(s,'op','task',job,async()=>{});let turn=0;
 const invoke=f.mcp.callDocumentTool.bind(f.mcp);
 f.mcp.callDocumentTool=async(...args:Parameters<NotionMcpService['callDocumentTool']>)=>{const result=await invoke(...args);if(args[4]==='notion-update-page')throw Error('lost second response');return result;};
 const next=()=>({content:'',toolCalls:[{id:`save-${++turn}`,type:'function' as const,function:{name:'save_notion_draft',arguments:JSON.stringify(turn===1?{title:'合成文章',content:'第一稿',final:true}:{old_str:'第一稿',new_str:'第二稿',final:true})}}]});
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:3,checkpoints:store,beforeStep:async()=>{},tools:[tool],call:async()=>next()}),/保存未确认/);
 assert.equal(f.calls.length,2);assert.equal(job.notionReceipt!.state,'uncertain');
 assert.equal(verifiedNotionCompletion(job.notionReceipt,store.steps,[],{scopeId:'op'}),undefined);
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,checkpoints:store,beforeStep:async()=>{},tools:[tool],call:async()=>({content:'',toolCalls:[{id:'third',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({old_str:'第一稿',new_str:'第三稿',final:true})}}]})}),/不会重复写入/);
 assert.equal(f.calls.length,2);assert.equal(f.getBody(),'第二稿');
});
test('a previous unknown Notion write blocks a new attempt even with different arguments and scope',async()=>{
 const f=fixture(),job=f.job('new',pageId),store=checkpointStore([{key:'unknown',namespace:'worker',scopeId:'old',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'started',updatedAt:'now'}]);
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,checkpoints:store,beforeStep:async()=>{},tools:[f.docs.tool(s,'new','task',job,async()=>{},f.getBody())],call:async()=>({content:'',toolCalls:[{id:'edit',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({old_str:'原来的文章',new_str:'新文章'})}}]})}),/不会重复写入/);
 assert.equal(f.calls.length,0);assert.equal(f.getBody(),'原来的文章');
});
test('document handler also rejects unresolved prior writes without inherited checkpoints, but never consults a foreign workspace',async()=>{
 for(const mode of ['receipt','started','foreign'] as const){
  const f=fixture(),old=f.job('old',pageId),next=f.job('new',pageId);
  if(mode==='started')old.steps=[{key:'s',namespace:'worker',tool:'save_notion_draft',label:'保存',effect:'external_write',state:'started',updatedAt:'now'}];
  else old.notionReceipt={state:'uncertain',delivery:'unknown',pageId};
  if(mode==='foreign'){f.db.chatOperations![0].workspaceId='wb';f.db.chatOperations![0].userId='b';}
  const tool=f.docs.tool(s,'new','task',next,async()=>{},f.getBody()).structured!;
  const pending=()=>tool.run(tool.validate({old_str:'原来的文章',new_str:'本轮新文章'}));
  if(mode==='foreign'){await pending();assert.equal(f.calls.length,1);}
  else{await assert.rejects(pending,/先核对原页面/);assert.equal(f.calls.length,0);}
 }
});
test('Notion destination validates links and exact workspace/user grant; legacy read-only stays read-only',async()=>{
  assert.equal(notionPageId(`https://www.notion.so/Title-${parentId}?v=ignored`),parentId);
  for(const input of ['https://evil.example/'+parentId,'self','notion://docs/spec','https://notion.so.evil.example/'+parentId]) assert.throws(()=>notionPageId(input));
  const f=fixture();
  assert.throws(()=>writingTarget(f.db,{workspaceId:'wa',userId:'b'}));
  assert.throws(()=>writingTarget(f.db,{workspaceId:'wb',userId:'b'}));
  delete f.db.knowledgeConnections[0].notionWriting;
  assert.equal((await f.docs.settings(s)).writeAuthorized,false); assert.throws(()=>writingTarget(f.db,s),/重新授权/);
  assert.equal(f.calls.length,0);
});
test('Notion readback extracts body, refuses truncated/unsupported pages',()=>{
  assert.equal(notionBody({content:[{type:'text',text:JSON.stringify({text:'<page><properties>not body</properties><content>正文</content></page>'})}]}),'正文');
  assert.equal(notionBody({text:'<page><content>\n    literal code<br />\n</content></page>'}),'    literal code<br />');
  assert.throws(()=>notionBody({text:'<page><content>\n    \n</content></page>'}),/正文无法完整读取/);
  assert.throws(()=>notionBody({text:'正文',truncated:true}));
  assert.throws(()=>notionBody({text:'正文',unknown_block_count:1}));
});

test('requested same-title check reads only the selected parent and reuses an exact existing result without writing',async()=>{
 const f=fixture(),job=f.job(),reads:string[]=[];
 f.mcp.readDocument=async(ws,id)=>{assert.equal(ws,s.workspaceId);reads.push(id);return {text:id===parentId?`<page><content><page url="https://app.notion.com/p/${pageId}">合成便笺</page></content></page>`:'<page><content>青色42。</content></page>'};};
 const tool=f.docs.tool(s,'op','task',job,async()=>{},undefined,'同名先核对，不重复新建');
 const r=await tool.structured!.run(tool.structured!.validate({title:'合成便笺',content:'青色42。'})) as any;
 assert.equal(r.state,'verified');assert.equal(r.reused,true);assert.equal(r.pageId,pageId);assert.equal(r.duplicateCheck,'matched_existing');
 assert.deepEqual(reads,[parentId,pageId]);assert.equal(f.calls.length,0);assert.equal(job.notionReceipt?.state,'verified');
 await assert.rejects(()=>f.docs.tool({workspaceId:'wb',userId:'b'},'op','task',job,async()=>{},undefined,'不重复新建').structured!.run({title:'合成便笺',content:'青色42。'}));assert.equal(reads.length,2);
});
test('same-title reuse cannot bypass v2 literal-code whitespace comparison through the legacy normalizer',async()=>{
 const f=fixture(),job=f.job();
 f.mcp.readDocument=async(_ws,id)=>({text:id===parentId?`<page><content><page url="https://www.notion.so/${pageId}">代码</page></content></page>`:'<page><content>```\nx\n```</content></page>'});
 await assert.rejects(()=>f.docs.tool(s,'op','task',job,async()=>{},undefined,'同名先核对').structured!.run({title:'代码',content:'```\nx \n\n```'}),/内容不同/);assert.equal(f.calls.length,0);assert.notEqual(job.notionReceipt!.state,'verified');
});
test('same-title precondition fails closed for conflicts, ambiguous names, incomplete directory or revoked grant',async()=>{
 for(const mode of ['conflict','ambiguous','truncated','unknown','unwrapped','revoked','formatted']){
  const f=fixture(),job=f.job();
  f.mcp.readDocument=async(_ws,id)=>{
   if(mode==='revoked')f.db.knowledgeConnections[0].notionWriting!.grantId='changed';
   if(id!==parentId)return {text:'<page><content>其他正文</content></page>'};
   const child=`<page url="https://www.notion.so/${pageId}">${mode==='formatted'?'无法&amp;确认':'合成便笺'}</page>`;
   return {text:mode==='unwrapped'?'目录未完整读到':`<page><content>${child}${mode==='ambiguous'?child:''}</content></page>`,truncated:mode==='truncated',unknown_block_count:mode==='unknown'?1:0};
  };
  const tool=f.docs.tool(s,'op','task',job,async()=>{},undefined,'同名先核对，不重复新建');
  await assert.rejects(()=>tool.structured!.run(tool.structured!.validate({title:'合成便笺',content:'青色42。'})));
  assert.equal(f.calls.length,0,mode);assert.notEqual(job.notionReceipt?.delivery,'unknown',mode);
 }
});
test('concurrent same-title requests cannot both pass the preflight and a stopped check cannot bind an existing page',async()=>{
 const f=fixture(),one=f.job('one'),two=f.job('two');let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(ws,id)=>{if(id!==parentId)return read(ws,id);entered();await gate;return {text:'<page><content></content></page>'};};
 const tool=(id:string,job:WorkRun)=>f.docs.tool(s,id,'task',job,async()=>{},undefined,'同名先核对，不重复新建').structured!;
 const pending=tool('one',one).run({title:'并行便笺',content:'青色42。'});await started;
 await assert.rejects(()=>tool('two',two).run({title:'并行便笺',content:'青色42。'}),/正在核对/);assert.equal(two.notionReceipt?.delivery,'not_sent');
 release();await pending;assert.equal(f.calls.length,1);
 const g=fixture(),stopped=g.job();g.mcp.readDocument=async(_ws,id)=>{if(id===parentId)return {text:`<page><content><page url="https://www.notion.so/${pageId}">便笺</page></content></page>`};g.db.chatOperations![0].workRun!.state='cancelled';return {text:'<page><content>青色42。</content></page>'};};
 await assert.rejects(()=>g.docs.tool(s,'op','task',stopped,async()=>{},undefined,'同名先核对').structured!.run({title:'便笺',content:'青色42。'}),/已经停下/);
 assert.equal(g.calls.length,0);assert.equal(g.db.conversations[0].notionDocument!.pageId,undefined);
});
test('complete empty selected directory permits exactly one create and reports its preflight',async()=>{
 const f=fixture(),job=f.job(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(ws,id)=>id===parentId?{text:'<page><content>\n</content></page>'}:read(ws,id);
 const tool=f.docs.tool(s,'op','task',job,async()=>{},undefined,'若已有同名便笺，先核对，不重复新建');
 const r=await tool.structured!.run(tool.structured!.validate({title:'新的便笺',content:'青色42。'})) as any;
 assert.equal(r.duplicateCheck,'no_same_title_in_parent');assert.equal(f.calls.length,1);assert.equal(r.state,'verified');
 await assert.rejects(()=>tool.structured!.run({title:'新的便笺',content:'青色42。'}));assert.equal(f.calls.length,1);
});

test('plain Notion line-break serialization verifies once without rewriting; literal code and changed text do not',async()=>{
 for(const [expected,actual,valid] of [
  ['第一行\n第二行','第一行<br />第二行',true],
  ['第一行\n第二行','第一行<br>第二行',true],
  ['第一行\n第二行','第一行<br />改掉的第二行',false],
  ['`第一行\n第二行`','`第一行<br />第二行`',false],
  ['```html\n第一行\n第二行\n```','```html\n第一行<br />第二行\n```',false],
  ['    第一行\n    第二行','    第一行<br />    第二行',false],
 ] as const){
  const f=fixture(),job=f.job();
  f.mcp.readDocument=async()=>({text:`<page><content>${actual}</content></page>`});
  const tool=f.docs.tool(s,'op','task',job,async()=>{}),args=tool.structured!.validate({title:'测试',content:expected});
  if(valid){const result=await tool.structured!.run(args) as any;assert.equal(result.state,'verified');}
  else{await assert.rejects(()=>tool.structured!.run(args),/保存未确认/);assert.equal(job.notionReceipt!.state,'uncertain');}
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.pages[0].content,expected,'never rewrite user text to make a check pass');
 }
});

test('an old uncertain plain-text receipt can be reconciled read-only after serialized breaks',async()=>{
 const f=fixture(),job=f.job(),actual='ONE-QA37<br />验收状态：等待整理。';
 // Simulate a transient readback failure after the create already succeeded.
 f.mcp.readDocument=async()=>{throw Error('temporarily offline');};
 const tool=f.docs.tool(s,'op','task',job,async()=>{});
 await assert.rejects(()=>tool.structured!.run(tool.structured!.validate({title:'QA37',content:'ONE-QA37\n验收状态：等待整理。'})));
 job.state='failed';f.db.chatOperations![0].workRun!.state='failed';
 f.mcp.readDocument=async()=>({text:`<page><content>${actual}</content></page>`});
 const result=await f.docs.reconcile(s,'task',async()=>{});
 assert.equal(result.state,'verified');assert.equal(f.calls.length,1);assert.equal(f.db.chatOperations![0].workRun!.state,'failed','save verification must not erase the failed task history');
 await assert.rejects(()=>f.docs.reconcile({workspaceId:'wb',userId:'b'},'task',async()=>{}));assert.equal(f.calls.length,1);
});
test('explicit read-only continuation reads only its own page and rejects even a direct write-tool invocation',async()=>{
 const f=fixture(),job=f.job('readonly',pageId),request='只读核对本任务的原文，不修改、不保存。',reads:string[]=[];
 job.notionTarget!.referenceIds=['cccccccccccccccccccccccccccccccc'];
 const read=f.mcp.readDocument.bind(f.mcp);f.mcp.readDocument=async(ws,id)=>{reads.push(id);return read(ws,id);};
 const context=await f.docs.context(s,job,request);assert.equal(context.readOnly,true);assert.deepEqual(reads,[]);assert.deepEqual(context.references,[]);
 const reader=f.docs.readTool(s,job,async()=>{});
 assert.throws(()=>reader.structured!.validate({pageId:parentId}),/不接受其他页面/);
 const result=await reader.structured!.run(reader.structured!.validate({})) as any;
 assert.equal(result.content,'原来的文章');assert.equal(result.pageId,pageId);assert.equal(result.complete,true);assert.match(result.url,new RegExp(pageId));assert.deepEqual(reads,[pageId]);
 await assert.rejects(()=>f.docs.readTool({workspaceId:'wb',userId:'b'},job,async()=>{}).structured!.run({}));assert.deepEqual(reads,[pageId]);
 const readCount=reads.length;
 await assert.rejects(()=>f.docs.readTool(s,job,async()=>{throw Error('Key not present');}).structured!.run({}));assert.equal(reads.length,readCount);
 const tool=f.docs.tool(s,'readonly','task',job,async()=>{},context.currentDocument,request);
 assert.throws(()=>tool.structured!.validate({old_str:'原来的文章',new_str:'不该写入'}),/只读/);
 await assert.rejects(()=>tool.structured!.run({old_str:'原来的文章',new_str:'不该写入'}),/只读/);
 assert.equal(f.calls.length,0);assert.equal(f.getBody(),'原来的文章');
 await assert.rejects(()=>f.docs.context({workspaceId:'wb',userId:'b'},job,request));assert.deepEqual(reads,[pageId]);
});
test('read-only result is withheld when its grant changes during the actual read',async()=>{
 const f=fixture(),job=f.job('readonly-revoke',pageId);
 f.mcp.readDocument=async()=>{f.db.knowledgeConnections[0].notionWriting!.grantId='revoked';return {text:'private body'};};
 await assert.rejects(()=>f.docs.readTool(s,job,async()=>{}).structured!.run({}),/授权或保存位置已改变/);
 assert.equal(f.calls.length,0);
});
test('Notion destination config normalizes links before scoped reads and never changes settings on malformed links',async()=>{
  const f=fixture(),read=f.mcp.readDocument.bind(f.mcp),reads:string[]=[];
  f.mcp.readDocument=async(ws,id)=>{reads.push(id);return read(ws,id);};
  const configured=await f.docs.configure(s,{parent:`notion://www.notion.so/草稿-${parentId}/?source=copy_link`,references:[`https://app.notion.com/${pageId}/`,`https://notion.so/${pageId}`]});
  assert.equal(configured.parentId,parentId);assert.deepEqual(configured.referenceIds,[pageId]);assert.deepEqual(reads,[parentId,pageId]);assert.equal(f.calls.length,0,'configuration does not write a Notion document');
  const before=structuredClone(f.db.knowledgeConnections);
  await assert.rejects(()=>f.docs.configure(s,{parent:`https://notion.so/${pageId}`,references:['wrong reference']}),/第 1 篇参考文章/);
  await assert.rejects(()=>f.docs.configure(s,{parent:'https://notion.so/home',references:[]}),/复制链接/);
  assert.deepEqual(f.db.knowledgeConnections,before);assert.equal(reads.length,2);
  await assert.rejects(()=>f.docs.configure({workspaceId:'wb',userId:'b'},{parent:`https://notion.so/${parentId}`,references:[]}));assert.equal(reads.length,2);
  await assert.rejects(()=>f.docs.configure({workspaceId:'wa',userId:'b'},{parent:`https://notion.so/${parentId}`,references:[]}));assert.equal(reads.length,2);
});
test('recognized Notion links distinguish inaccessible pages, databases and revoked grants without exposing provider errors',async()=>{
  const f=fixture(),before=structuredClone(f.db.knowledgeConnections);
  f.mcp.readDocument=async()=>{throw Error('provider token=private-secret');};
  await assert.rejects(()=>f.docs.configure(s,{parent:`https://app.notion.com/${pageId}`,references:[]}),error=>{assert.match((error as Error).message,/链接识别到了/);assert.match((error as Error).message,/账号和工作区/);assert.doesNotMatch((error as Error).message,/private-secret/);return true;});
  assert.deepEqual(f.db.knowledgeConnections,before);
  f.mcp.readDocument=async()=>({type:'database'});
  await assert.rejects(()=>f.docs.configure(s,{parent:`https://notion.so/${pageId}`,references:[]}),/这是数据库/);assert.deepEqual(f.db.knowledgeConnections,before);
  f.mcp.readDocument=async()=>{f.db.knowledgeConnections[0].notionWriting!.grantId='revoked-during-read';return{text:'<page></page>'};};
  await assert.rejects(()=>f.docs.configure(s,{parent:`https://notion.so/${pageId}`,references:[]}),/授权已改变/);assert.equal(f.db.knowledgeConnections[0].notionWriting!.parentId,parentId);
});
test('Notion create is scoped to the selected parent, verified and deduplicated; next round edits the same page',async()=>{
  const f=fixture(),job=f.job(),tool=f.docs.tool(s,'op','task',job,async()=>{});
  const args=tool.structured!.validate({title:'测试文章',content:'正文只写这一句。'});
  const result=await tool.structured!.run(args) as any;
  assert.equal(result.state,'verified');assert.equal(result.pageId,pageId);
  assert.equal(f.db.conversations[0].notionDocument!.pageId,pageId);
  assert.equal(f.db.chatOperations![0].workRun!.notionReceipt!.state,'verified');
  assert.deepEqual(f.calls[0].args.parent,{page_id:parentId});
  await assert.rejects(()=>tool.structured!.run(args),/最新已回读正文/);assert.equal(f.calls.length,1);
  const second=f.job('op2',pageId),context=await f.docs.context(s,second),current=context.currentDocument;
  assert.equal(context.location,`https://www.notion.so/${pageId}`);assert.equal(context.parentLocation,`https://www.notion.so/${parentId}`);
  const update=f.docs.tool(s,'op2','task',second,async()=>{},current);
  await update.structured!.run(update.structured!.validate({old_str:'这一句',new_str:'新的这一句'}));
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].name,'notion-update-page');assert.equal(f.calls[1].args.page_id,pageId);
  assert.equal(f.getBody(),'正文只写新的这一句。');
  assert.equal(f.calls.filter(c=>c.name==='notion-create-pages').length,1);
});
test('Notion exact quoted replacements reject extra punctuation or unrelated edits before any write',async()=>{
  const f=fixture(),job=f.job('precise',pageId),current='今天整理了一份合成便笺。\n明天15时检查小苗。\n核对标记：SYNTHETIC。';
  f.setBody(current);
  const tool=f.docs.tool(s,'precise','task',job,async()=>{},current,'只把第二行“明天15时检查小苗。”改为“明天16时检查小苗。”，其余不动。');
  for(const new_str of ['明天16时检查小苗.','明天16时检查小苗。\n额外文字'])
    assert.throws(()=>tool.structured!.validate({old_str:'明天15时检查小苗。',new_str}),/逐字/);
  assert.equal(f.calls.length,0);assert.equal(job.notionReceipt,undefined);
  const args=tool.structured!.validate({old_str:'15时',new_str:'16时'});
  await tool.structured!.run(args);
  assert.equal(f.getBody(),current.replace('15时','16时'));assert.equal(f.calls.length,1);
  const general=fixture(),generalJob=general.job('general',pageId);
  assert.doesNotThrow(()=>general.docs.tool(s,'general','task',generalJob,async()=>{},'原来的文章','请整体润色文章。').structured!.validate({old_str:'原来的文章',new_str:'润色后的文章。'}));
  const ambiguous=f.docs.tool(s,'precise','task',job,async()=>{},current+'\n明天15时检查小苗。','把“明天15时检查小苗。”改为“明天16时检查小苗。”');
  assert.throws(()=>ambiguous.structured!.validate({old_str:'15时检查小苗。\n核对',new_str:'16时检查小苗。\n核对'}),/不唯一/);
});
test('Notion concurrent user edit, revoked grant, foreign operation and unsafe structure cannot write',async()=>{
  const f=fixture(),job=f.job('op',pageId),tool=f.docs.tool(s,'op','task',job,async()=>{},'原来的文章');
  const args=tool.structured!.validate({old_str:'原来的文章',new_str:'新的文章'});
  f.setBody('用户手工修改后的文章');await assert.rejects(()=>tool.structured!.run(args),/已被修改/);assert.equal(f.calls.length,0);
  f.setBody('原来的文章');f.db.knowledgeConnections[0].notionWriting!.grantId='changed';await assert.rejects(()=>tool.structured!.run(args),/已改变/);assert.equal(f.calls.length,0);
  const g=fixture(),newJob=g.job();const unsafe=g.docs.tool(s,'op','task',newJob,async()=>{});
  assert.throws(()=>unsafe.structured!.validate({title:'移动',content:`<page url="https://notion.so/${pageId}">其他页面</page>`}));
  g.db.chatOperations![0].workspaceId='wb';await assert.rejects(()=>unsafe.structured!.run({title:'测试',content:'正常内容'}));assert.equal(g.calls.length,0);
});
test('Notion timeout never replays, retains uncertain receipt and created-page location when readback fails',async()=>{
  const f=fixture(),job=f.job();
  f.mcp.readDocument=async()=>{throw new Error('token=must-not-leak')};
  const tool=f.docs.tool(s,'op','task',job,async()=>{});
  await assert.rejects(()=>tool.structured!.run({title:'测试',content:'实际已创建'}),/未确认/);
  const receipt=f.db.chatOperations![0].workRun!.notionReceipt!;
  assert.equal(receipt.state,'uncertain');assert.equal(receipt.pageId,pageId);assert.doesNotMatch(JSON.stringify(receipt),/must-not-leak/);
  assert.equal(receipt.failureCode,'readback_failed');
  await assert.rejects(()=>tool.structured!.run({title:'测试',content:'实际已创建'}),/已经提交/);assert.equal(f.calls.length,1);
});
test('Notion official flat async task handles are polled once, never treated as page IDs or repeated writes',async()=>{
  const f=fixture(),job=f.job(),call=f.mcp.callDocumentTool.bind(f.mcp);let writes=0,polls=0;
  f.mcp.callDocumentTool=async(...args)=>{
    if(args[4]==='notion-create-pages'){
      writes++;await call(...args);
      return {content:[{type:'text',text:JSON.stringify({object:'async_task',id:'task_synthetic',status:'queued',poll_after_seconds:1})}]};
    }
    assert.equal(args[4],'notion-get-async-task');assert.deepEqual(args[5],{task_id:'task_synthetic'});polls++;
    return {structuredContent:{status:'succeeded',result:{pages:[{id:pageId}]}}};
  };
  const tool=f.docs.tool(s,'op','task',job,async()=>{});
  const result=await tool.structured!.run({title:'异步合成草稿',content:'正文完整保留'}) as any;
  assert.equal(result.state,'verified');assert.equal(result.pageId,pageId);assert.equal(writes,1);assert.equal(polls,1);
  assert.equal(job.notionReceipt!.asyncTaskId,'task_synthetic');assert.equal(job.notionReceipt!.failureCode,undefined);
});
test('Notion write and response failures retain only bounded stage codes, not upstream secrets',async()=>{
  for(const malformed of [false,true]){
    const f=fixture(),job=f.job();
    f.mcp.callDocumentTool=async()=>{if(malformed)return {unexpected:'provider-secret'};throw Error('provider-secret');};
    const tool=f.docs.tool(s,'op','task',job,async()=>{});
    await assert.rejects(()=>tool.structured!.run({title:'合成草稿',content:'合成正文'}),/保存未确认/);
    assert.equal(job.notionReceipt!.failureCode,malformed?'response_unrecognized':'write_unconfirmed');
    assert.doesNotMatch(JSON.stringify(job.notionReceipt),/provider-secret/);
  }
});
test('Notion save retains safe failure provenance and distinguishes unsent writes from unknown effects',async()=>{
  for(const delivery of ['not_sent','rejected','unknown'] as const){
    const f=fixture(),job=f.job();
    f.mcp.callDocumentTool=async()=>{throw new NotionWriteError(delivery==='not_sent'?'connect':'send',delivery,delivery==='not_sent'?'connection':'validation',delivery==='rejected'?'validation_error':undefined);};
    await assert.rejects(()=>f.docs.tool(s,'op','task',job,async()=>{}).structured!.run({title:'合成标题',content:'合成正文'}));
    assert.equal(job.notionReceipt!.delivery,delivery);assert.equal(job.notionReceipt!.diagnostic!.phase,delivery==='not_sent'?'connect':'send');
    assert.equal(f.calls.length,0);assert.equal(job.notionReceipt!.state,'uncertain');
  }
});
test('Notion cancelled task retains a receipt but does not report success or write again',async()=>{
  const f=fixture(),job=f.job();let n=0;
  const tool=f.docs.tool(s,'op','task',job,async()=>{n++;if(n===3){f.db.chatOperations![0].workRun!.state='cancelled';throw new Error('cancelled');}});
  await assert.rejects(()=>tool.structured!.run({title:'测试',content:'已保存的内容'}));
  assert.equal(f.db.chatOperations![0].workRun!.state,'cancelled');assert.equal(f.db.chatOperations![0].workRun!.notionReceipt!.state,'uncertain');assert.equal(f.calls.length,1);
});
test('Notion uncertain save can be reconciled by readback only without restarting cancelled work',async()=>{
  const f=fixture(),job=f.job();let reads=0;
  const read=f.mcp.readDocument.bind(f.mcp);
  f.mcp.readDocument=async(...args)=>{reads++;if(reads===1)throw new Error('lost readback');return read(...args);};
  const tool=f.docs.tool(s,'op','task',job,async()=>{});
  await assert.rejects(()=>tool.structured!.run({title:'测试',content:'已存在的原文'}));
  f.db.chatOperations![0].workRun!.state='cancelled';
  await assert.rejects(()=>f.docs.reconcile({workspaceId:'wb',userId:'b'},'task',async()=>{}));
  const result=await f.docs.reconcile(s,'task',async()=>{});
  assert.equal(result.state,'verified');assert.equal(f.calls.length,1);
  assert.equal(f.db.chatOperations![0].workRun!.state,'cancelled');
  assert.equal(f.db.chatOperations![0].workRun!.notionReceipt!.state,'verified');
});
test('a newly verified reconciliation returns once after an earlier failure briefing without replaying legacy notices or the write',async()=>{
  const f=fixture(),job=f.job();let reads=0;
  const read=f.mcp.readDocument.bind(f.mcp);f.mcp.readDocument=async(...args)=>{if(++reads===1)throw Error('lost readback');return read(...args);};
  await assert.rejects(()=>f.docs.tool(s,'op','task',job,async()=>{}).structured!.run({title:'测试',content:'真实内容'}));
  job.state='failed';job.error='保存结果尚未确认';job.unread=true;job.resultOutcome='partial';
  job.notionReceipt!.verification=undefined; // Historical failure was already reported before automatic verification existed.
  const stamp='2026-10-24T01:00:00Z';
  f.db.messages=[];f.db.executionTasks=[];f.db.attachments=[];
  Object.assign(f.db.conversations[0],{title:'原任务',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});
  f.db.conversations.push({...s,id:'main',title:'ONE',modelId:'model',coordinatorMain:true,taskResultReportSince:stamp,archived:false,messages:[],createdAt:stamp,updatedAt:stamp});
  Object.assign(f.db.chatOperations![0],{operationId:'original-operation',requestId:'work_original',status:'failed',createdAt:stamp,updatedAt:stamp});
  const old=appendTaskResultReport(f.db,s);assert.equal(old.results[0].id,'op');assert.ok(job.reportedToCoordinatorAt);
  await f.docs.reconcile(s,'task',async()=>{});
  assert.equal(job.reportRevision,1);assert.equal(job.state,'failed');assert.equal(job.resultOutcome,'partial');assert.equal(f.calls.length,1);
  assert.equal(job.notionVerificationSelection!.operationId,'op');
  assert.equal(pendingConversationTaskResults(f.db,s).length,0,'the coordinator must first settle this exact manual selection');
  job.notionVerificationSelection=undefined; // Coordinator consumes a verified nonfinal selection as save-confirmation only.
  assert.deepEqual(pendingConversationTaskResults(f.db,s).map(r=>r.id),['op_r1']);
  const fresh=appendTaskResultReport(f.db,s);assert.equal(fresh.results.length,1);assert.match(fresh.results[0].brief!,/刚核对过.*Notion/);
  assert.match(f.db.conversations.find(c=>c.id==='main')!.messages.at(-1)!.content,/打开 Notion/);
  assert.doesNotMatch(f.db.conversations.find(c=>c.id==='main')!.messages.at(-1)!.content,/已完成/);
  await f.docs.reconcile(s,'task',async()=>{});assert.equal(job.reportRevision,1);assert.equal(pendingTaskResults(f.db,s).length,0);
  assert.equal(appendTaskResultReport(f.db,s).results.length,0);assert.equal(f.calls.length,1);
  assert.equal(f.db.chatOperations!.filter(o=>o.requestId==='result_notice').length,2);
  await assert.rejects(()=>f.docs.reconcile({workspaceId:'wb',userId:'b'},'task',async()=>{}));
});
test('readback selects the unresolved round after a shuffled restart, never the older verified create',async()=>{
  const f=fixture(),first=f.job('create');
  await f.docs.tool(s,'create','task',first,async()=>{}).structured!.run({title:'测试',content:'旧正文14时'});
  f.db.chatOperations![0].createdAt='2026-10-20T00:22:00Z';first.state='completed';
  const second=f.job('update',pageId);
  f.db.chatOperations![1].createdAt='2026-10-20T00:27:00Z';
  f.mcp.callDocumentTool=async()=>{throw new Error('connection lost before confirmation');};
  await assert.rejects(()=>f.docs.tool(s,'update','task',second,async()=>{},'旧正文14时').structured!.run({old_str:'14时',new_str:'15时'}));
  second.state='failed';f.db.conversations[0].workPaused=true;
  f.db.chatOperations!.reverse();
  await assert.rejects(()=>f.docs.reconcile(s,'task',async()=>{}),/与本轮拟保存内容不同/);
  assert.equal(first.notionReceipt!.state,'verified');assert.equal(second.notionReceipt!.state,'uncertain');
  f.setBody('旧正文15时');
  await assert.rejects(()=>f.docs.reconcile({workspaceId:'wb',userId:'b'},'task',async()=>{}));
  const result=await f.docs.reconcile(s,'task',async()=>{});
  assert.equal(result.state,'verified');assert.equal(second.notionReceipt!.state,'verified');
  assert.equal(second.state,'failed');assert.equal(f.db.conversations[0].workPaused,true);
  assert.equal(f.calls.length,1,'readback never repeats the write');
});
test('Notion readback keeps a paused task paused and its queued supplements ineligible to resume',async()=>{
  const f=fixture(),job=f.job();
  const read=f.mcp.readDocument.bind(f.mcp);
  f.mcp.readDocument=async()=>{throw new Error('readback disconnected');};
  const tool=f.docs.tool(s,'op','task',job,async()=>{});
  await assert.rejects(()=>tool.structured!.run({title:'测试',content:'已经保存的文章'}),/未确认/);
  job.state='failed';
  f.db.conversations[0].workPaused=true;
  const supplement=f.job('queued-supplement',pageId);
  supplement.state='queued';
  f.db.chatOperations![1].status='pending';
  const queuedBefore=structuredClone(f.db.chatOperations![1]);
  f.mcp.readDocument=read;

  await assert.rejects(()=>f.docs.reconcile({workspaceId:'wb',userId:'b'},'task',async()=>{}));
  assert.equal(f.db.chatOperations![0].workRun!.notionReceipt!.state,'uncertain');
  const result=await f.docs.reconcile(s,'task',async()=>{});

  assert.equal(result.state,'verified');
  assert.equal(f.calls.length,1,'verification must not issue another write');
  assert.equal(job.state,'failed','verified save does not mean the whole task completed');
  assert.equal(f.db.conversations[0].workPaused,true,'readback must not make the client auto-resume supplements');
  assert.deepEqual(f.db.chatOperations![1],queuedBefore);
});
