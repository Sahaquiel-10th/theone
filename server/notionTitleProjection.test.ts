import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import type {Store} from './db.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {NotionMcpService} from './knowledge/notionMcpService.js';
import {NotionDocuments,notionFetchedTitle} from './notionDocuments.js';
import {notionHash,legacyNotionNormalized,canonicalNotionDigest} from './notionCanonical.js';
import {projectNotionLeadingTitle,notionProjectedSource} from './notionTitleProjection.js';
import {taskStepKey} from './taskSteps.js';

const scope={workspaceId:'wa',userId:'a'},parentId='a'.repeat(32),pageId='b'.repeat(32);
const source='# ONE-QA-LATE-1029-A\n青色42\n先写好原文，再单独补存。';
const args={title:'保存 QA 原文到 Notion',content:source,final:true};
function fixture(){
 let now=Date.parse('2026-10-29T02:00:00Z'),title='',body='';
 const db={users:[{id:'a',enabled:true},{id:'b',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[scope,{workspaceId:'wb',userId:'b'}],knowledgeConnections:[{id:'notion',workspaceId:'wa',provider:'notion',status:'connected',notionWriting:{grantId:'grant',userId:'a',parentId}}],conversations:[{...scope,id:'task',archived:false,notionDocument:{connectionId:'notion',grantId:'grant',parentId}}],chatOperations:[],contextTraces:[]} as unknown as Database;
 const store={read:async()=>structuredClone(db),mutate:async<T>(fn:(db:Database)=>T)=>fn(db)} as Store;
 const job={state:'running',notionTarget:{connectionId:'notion',grantId:'grant',parentId,referenceIds:[]},steps:[]} as unknown as WorkRun;
 db.chatOperations!.push({...scope,id:'op',conversationId:'task',requestId:'synthetic',createdAt:new Date(now).toISOString(),status:'pending',workRun:job} as any);
 const calls:{name:string;args:any}[]=[];
 const fetchResult=()=>({text:`<page><properties>\n${JSON.stringify({title})}\n</properties><content>\n${body}\n</content></page>`});
 const mcp={readDocument:async(ws:string,id:string)=>{assert.equal(ws,scope.workspaceId);assert.equal(id,pageId);return fetchResult();},callDocumentTool:async(ws:string,c:string,g:string,u:string,name:string,value:any,before?:()=>Promise<void>)=>{
  assert.deepEqual([ws,c,g,u],[scope.workspaceId,'notion','grant',scope.userId]);await before?.();calls.push({name,args:structuredClone(value)});
  if(name==='notion-create-pages'){title=value.pages[0].properties.title;body=value.pages[0].content;}
  else if(name==='notion-update-page')body=body.replace(value.content_updates[0].old_str,value.content_updates[0].new_str);
  else assert.fail(name);
  return {pages:[{id:pageId}]};
 }} as unknown as NotionMcpService;
 const docs=new NotionDocuments(store,mcp,{now:()=>now,delays:[10,20],deadlineMs:1000});
 const tool=(projectLeadingTitle=true)=>docs.tool(scope,'op','task',job,async()=>{},undefined,'',{projectLeadingTitle}).structured!;
 const stopped=()=>{job.state='failed';db.chatOperations![0].status='failed';};
 return {db,job,mcp,docs,calls,tool,fetchResult,stopped,advance:()=>now+=10,actual:()=>({title,body}),setBody:(value:string)=>body=value,setTitle:(value:string)=>title=value};
}

test('authored plain H1 has an explicit lossless title/body boundary, never a loose normalizer',()=>{
 const projected=projectNotionLeadingTitle(source)!;
 assert.deepEqual(projected,{version:1,title:'ONE-QA-LATE-1029-A',prefix:'# ONE-QA-LATE-1029-A\n',content:'青色42\n先写好原文，再单独补存。'});
 assert.equal(notionProjectedSource(projected.content,projected.title,projected),source);
 assert.equal(notionProjectedSource(projected.content,'别的标题',projected),undefined);
 assert.equal(notionProjectedSource(projected.content,undefined,projected),undefined);
 for(const value of ['普通第一行\n正文','# **标题**\n正文','# [标题](https://example.test)\n正文','# <b>标题</b>\n正文','# 标题 ###\n正文','\n# 标题\n正文','# 标题\n\n','```\n# 标题\n正文\n```'])assert.equal(projectNotionLeadingTitle(value),undefined,value);
 const blank='# 中文标题\n\n正文\n\n结束。';assert.equal(notionProjectedSource(projectNotionLeadingTitle(blank)!.content,'中文标题',projectNotionLeadingTitle(blank)),blank);
});

test('fetch title evidence is exact and conflicting, malformed or missing properties cannot pass',()=>{
 const wrap=(metadata:string,body='正文')=>`<page>${metadata}<content>${body}</content></page>`;
 assert.equal(notionFetchedTitle({text:wrap('<properties>\n{"title":"青色"}\n</properties>')}),'青色');
 assert.equal(notionFetchedTitle({properties:{title:'青色'},title:'青色',text:'正文'}),'青色');
 for(const value of [{text:wrap('<properties>{"title":"青色"}</properties>'),title:'别的'}, {text:wrap('<properties>标题</properties>')}, {text:wrap('<properties>{"title":"青色"}</properties><properties>{"title":"青色"}</properties>')}, {text:'# 青色\n正文'}, {text:'<properties>{"title":"正文伪造"}</properties>'}, {text:wrap('','<properties>{"title":"正文伪造"}</properties>')}])assert.equal(notionFetchedTitle(value),undefined);
 assert.equal(notionFetchedTitle({text:wrap('<properties>{"title":"真实标题"}</properties>','<properties>{"title":"正文伪造"}</properties>')}),'真实标题');
 assert.equal(notionFetchedTitle({title:'真实标题',text:wrap('','<properties>{"title":"正文伪造"}</properties>')}),'真实标题');
});

test('workflow create saves authored H1 in page title, verifies original full-source digest and returns raw editable body',async()=>{
 const f=fixture(),tool=f.tool(),result=await tool.run(tool.validate(args)) as any;
 assert.equal(result.state,'verified');assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].args.pages,[{properties:{title:'ONE-QA-LATE-1029-A'},content:'青色42\n先写好原文，再单独补存。'}]);
 const receipt=f.job.notionReceipt!;
 assert.equal(receipt.expectedDigest,notionHash(legacyNotionNormalized(source)));
 assert.equal(receipt.expectedRawDigest,notionHash(source));assert.equal(receipt.expectedCanonicalDigest,canonicalNotionDigest(source));
 assert.equal(receipt.checkpointKey,taskStepKey('worker','save_notion_draft',JSON.stringify(args)));
 assert.equal(result.currentDocument,f.actual().body);assert.equal(receipt.digest,notionHash(f.actual().body));
 assert.deepEqual(receipt.titleProjection,{version:1,title:'ONE-QA-LATE-1029-A',prefix:'# ONE-QA-LATE-1029-A\n'});
 assert.ok(!Object.keys(tool.schema.properties as object).includes('titleProjection'),'internal projection is not model input');
 await tool.run(tool.validate({old_str:result.currentDocument,new_str:'青色43\n修订后的结尾。',final:true}));
 assert.equal(f.calls[1].name,'notion-update-page');assert.equal(f.calls[1].args.content_updates[0].old_str,'青色42\n先写好原文，再单独补存。');
 assert.equal(f.actual().title,'ONE-QA-LATE-1029-A');assert.equal(f.job.notionReceipt!.titleProjection,undefined,'a new body-only update never inherits stale source-title projection');
});

test('plain sources and direct tool calls retain their supplied title and body with no hidden projection',async()=>{
 for(const [value,enabled] of [[{title:'显式页面标题',content:'# 不同的章节标题\n正文。'},false],[{title:'普通标题',content:'第一行\n第二行。'},true],[{title:'格式标题',content:'# **正文标题**\n正文。'},true]] as const){
  const f=fixture(),tool=f.tool(enabled);await tool.run(tool.validate(value));
  assert.equal(f.calls[0].args.pages[0].properties.title,value.title);assert.equal(f.calls[0].args.pages[0].content,value.content);assert.equal(f.job.notionReceipt!.titleProjection,undefined);
 }
});

test('later context and read-only tool expose actual page title separately from raw editable body',async()=>{
 const f=fixture(),tool=f.tool();await tool.run(tool.validate(args));
 const context=await f.docs.context(scope,f.job);
 assert.equal(context.pageTitle,'ONE-QA-LATE-1029-A');assert.equal(context.currentDocument,'青色42\n先写好原文，再单独补存。');
 const read=f.docs.readTool(scope,f.job,async()=>{}).structured!,result=await read.run(read.validate({})) as any;
 assert.equal(result.title,'ONE-QA-LATE-1029-A');assert.equal(result.content,context.currentDocument);assert.ok(!result.content.startsWith('# '));assert.equal(f.calls.length,1);
 await assert.rejects(()=>f.docs.readTool({workspaceId:'wb',userId:'b'},f.job,async()=>{}).structured!.run({}));assert.equal(f.calls.length,1);
});

for(const mutation of ['missing-title','changed-title','conflicting-title','changed-body','deleted-first-body-line'] as const)test(`projected save refuses ${mutation} instead of declaring incomplete content saved`,async()=>{
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(...params)=>{
  if(mutation==='changed-title')f.setTitle('别的标题');
  if(mutation==='changed-body')f.setBody('青色43\n先写好原文，再单独补存。');
  if(mutation==='deleted-first-body-line')f.setBody('先写好原文，再单独补存。');
  if(mutation==='missing-title')return {text:f.actual().body};
  const fetched=await read(...params) as {text:string};return mutation==='conflicting-title'?{...fetched,title:'矛盾标题'}:fetched;
 };
 const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(args)),/保存未确认/);
 assert.equal(f.calls.length,1);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.notionReceipt!.failureCode,'readback_mismatch');
});

test('delayed readback checks persisted title projection once, without rewriting or crossing workspace',async()=>{
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);let unavailable=true;
 f.mcp.readDocument=async(...params)=>{if(unavailable){unavailable=false;throw Error('temporary');}return read(...params);};
 const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(args)));f.stopped();
 const receipt=f.job.notionReceipt!;
 f.job.steps!.push({key:receipt.checkpointKey!,namespace:'worker',scopeId:'op',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-29T02:00:00Z'});
 await assert.rejects(()=>f.docs.reconcile({workspaceId:'wb',userId:'b'},'task',async()=>{}));assert.equal(f.calls.length,1);
 // MySQL JSON property order is not semantically relevant.
 receipt.titleProjection={prefix:receipt.titleProjection!.prefix,title:receipt.titleProjection!.title,version:1};
 f.advance();assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'verified');
 assert.equal(f.calls.length,1);assert.equal(receipt.expectedDigest,notionHash(legacyNotionNormalized(source)));assert.equal(receipt.state,'verified');assert.equal(f.job.steps![0].state,'completed');
});

test('delayed title mismatch stays uncertain and legacy receipts never gain a title projection',async()=>{
 for(const legacy of [false,true]){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};
  const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(args)));f.stopped();
  if(legacy)delete f.job.notionReceipt!.titleProjection;
  f.mcp.readDocument=async()=>({text:`<page><properties>{"title":"${legacy?'ONE-QA-LATE-1029-A':'标题被改了'}"}</properties><content>${f.actual().body}</content></page>`});
  f.advance();assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.calls.length,1);
  assert.equal(Boolean(f.job.notionReceipt!.titleProjection),!legacy);
 }
});
