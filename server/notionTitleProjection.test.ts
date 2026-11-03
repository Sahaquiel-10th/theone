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
import {createWorkflowRun} from './taskWorkflow.js';

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
 assert.equal(receipt.expectedRawDigest,notionHash(source));assert.equal(receipt.expectedCanonicalDigest,canonicalNotionDigest(source,9));
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

const italicSource='# 原文标题\n\n青色42\n\n*保留原来的主题和完整结尾。*';
async function oldV4ItalicFixture(expected=italicSource){
 const f=fixture();f.mcp.readDocument=async()=>{throw Error('temporary');};
 const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate({...args,content:expected})));f.stopped();
 const receipt=f.job.notionReceipt!;receipt.canonicalVersion=4;receipt.expectedCanonicalDigest=canonicalNotionDigest(expected,4);
 f.setBody(f.actual().body.replace('*保留原来的主题和完整结尾。*','<i>保留原来的主题和完整结尾。</i>'));
 f.mcp.readDocument=async()=>f.fetchResult();return f;
}

test('new v9 write verifies plain italic readback immediately without a second write or source change',async()=>{
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(...params)=>{f.setBody(f.actual().body.replace('*保留原来的主题和完整结尾。*','<i>保留原来的主题和完整结尾。</i>'));return read(...params);};
 const tool=f.tool(),result=await tool.run(tool.validate({...args,content:italicSource})) as any;
 assert.equal(result.state,'verified');assert.equal(f.calls.length,1);assert.equal(f.job.notionReceipt!.canonicalVersion,9);assert.equal(f.job.notionReceipt!.expectedRawDigest,notionHash(italicSource));
});

test('new v9 writes compare rich formatting beside exact code and retain visible escaped literal stars',async()=>{
 const source='# 组合专栏\n\n**重点**与 `ONE`。\n\n> 引用原话\n\n|项目|费用|\n|:----|-----:|\n|场地|-100|\n\n\\*\\*字面星号\\*\\*';
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(...params)=>{f.setBody(f.actual().body.replace('**重点**','<b>重点</b>').replace('> 引用原话','<quote>\n引用原话\n</quote>').replace('|:----|-----:|','| --- | --- |'));return read(...params);};
 const tool=f.tool(),result=await tool.run(tool.validate({...args,content:source})) as any;
 assert.equal(result.state,'verified');assert.equal(f.calls.length,1);assert.equal(f.job.notionReceipt!.canonicalVersion,9);assert.equal(f.job.notionReceipt!.expectedRawDigest,notionHash(source));assert.equal(f.job.notionReceipt!.comparison?.kind,'matched');assert.equal(f.job.notionReceipt!.comparison?.comparatorVersion,9);assert.ok(f.actual().body.includes('\\*\\*字面星号\\*\\*'));
});

test('new v9 save verifies an exact plain HTML inline code readback without rewriting or changing its original source',async()=>{
 const original='# 合成验收\n\n**保留重点**与 `ONE-QA`。\n\n|项目|费用|\n|---|---:|\n|测试|100|';
 for(const changed of [false,true]){
  const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);
  f.mcp.readDocument=async(...params)=>{f.setBody(f.actual().body.replace('**保留重点**','<b>保留重点</b>').replace('`ONE-QA`',changed?'<code>ONE-QB</code>':'<code>ONE-QA</code>'));return read(...params);};
  const tool=f.tool(),save=()=>tool.run(tool.validate({...args,content:original}));
  if(changed)await assert.rejects(save,/保存未确认/);else assert.equal((await save() as any).state,'verified');
  const receipt=f.job.notionReceipt!;
  assert.equal(receipt.canonicalVersion,9);assert.equal(receipt.expectedRawDigest,notionHash(original));assert.equal(receipt.expectedCanonicalDigest,canonicalNotionDigest(original,9));assert.equal(receipt.comparison?.kind,changed?'body_mismatch':'matched');assert.equal(f.calls.length,1);
 }
});

test('new v9 save verifies exact UTF-8 URL serialization and keeps the authored visible punctuation',async()=>{
 const original='# 合成URL专栏\n\n**重点**与 `ONE-QA`。\n\n参考：https://example.test/reference）',url='https://example.test/reference）';
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(...params)=>{f.setBody(f.actual().body.replace('**重点**','<b>重点</b>').replace('`ONE-QA`','<code>ONE-QA</code>').replace(url,`[${url}](https://example.test/reference%EF%BC%89)`));return read(...params);};
 const tool=f.tool(),saved=await tool.run(tool.validate({...args,content:original})) as any,receipt=f.job.notionReceipt!;
 assert.equal(saved.state,'verified');assert.equal(receipt.canonicalVersion,9);assert.equal(receipt.expectedRawDigest,notionHash(original));assert.equal(receipt.comparison?.comparatorVersion,9);assert.equal(receipt.comparison?.kind,'matched');assert.ok(f.actual().body.includes('reference）]'));assert.equal(f.calls.length,1);
});

test('new identifier-code writes verify their complete projected source immediately with one v9 write',async()=>{
 const original='# 合成标识符专栏\n\n**重点**与 `one_qa_probe`。\n\n|项目|步骤|\n|---|---:|\n|验证|1|',f=fixture(),read=f.mcp.readDocument.bind(f.mcp);
 f.mcp.readDocument=async(...params)=>{f.setBody(f.actual().body.replace('**重点**','<b>重点</b>').replace('`one_qa_probe`','<code>one_qa_probe</code>').replace('|---|---:|','| --- | --- |'));return read(...params);};
 const tool=f.tool(),saved=await tool.run(tool.validate({...args,content:original})) as any,receipt=f.job.notionReceipt!;
 assert.equal(saved.state,'verified');assert.equal(receipt.canonicalVersion,9);assert.equal(receipt.expectedRawDigest,notionHash(original));assert.equal(receipt.expectedDigest,notionHash(legacyNotionNormalized(original)));assert.equal(receipt.comparison?.comparatorVersion,9);assert.equal(receipt.comparison?.kind,'matched');assert.equal(f.calls.length,1);
});

test('explicit v9 reproof of an immutable v8 receipt requires exact original hashes and same-operation evidence',async()=>{
 const original='# 合成旧稿\n\n**重点**与 `one_qa_probe`。\n\n|项目|步骤|\n|---|---:|\n|验证|1|',value={...args,content:original},raw=JSON.stringify(value);
 for(const evidence of ['trace','workflow'] as const)for(const mutation of ['none','wrong-raw','missing-raw','wrong-normalized','wrong-old-canonical','missing-old-canonical','wrong-length','missing-length','missing-worker','foreign-owner','wrong-marker','changed-source','changed-code','changed-body','missing-title','revoked','stopped'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(value)));f.stopped();
  const receipt=f.job.notionReceipt!;receipt.canonicalVersion=8;receipt.expectedCanonicalDigest=canonicalNotionDigest(original,8);
  f.job.steps=mutation==='missing-worker'?[]:[{key:receipt.checkpointKey!,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'now'}];
  if(evidence==='trace')f.db.contextTraces.push({...scope,workspaceId:mutation==='foreign-owner'?'wb':'wa',conversationId:'task',requestId:mutation==='wrong-marker'?'foreign-request':'synthetic',executionSteps:[{tool:'save_notion_draft',query:mutation==='changed-source'?JSON.stringify({...value,content:original+'额外文字'}):raw}]} as any);
  else{
   const workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'完整成稿',kind:'model',instruction:'写完整原文',inputs:[]},{id:'save',title:'保存原文',kind:'notion',instruction:'原样保存',inputs:['draft']}]},{...scope,operationId:'op'});
   workflow.steps[0]={id:'draft',state:'completed',checkpointKey:'complete-v8-source'};f.job.workflow=workflow;
   if(mutation==='foreign-owner')workflow.binding.workspaceId='wb';
   f.job.steps.push({key:'complete-v8-source',scopeId:'op',namespace:`workflow:${workflow.id}`,tool:`workflow:${workflow.id}:draft`,effect:'model',state:'completed',label:'成稿',updatedAt:'now',output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:mutation==='wrong-marker'?'other':'draft'},outcome:'completed',result:{outcome:'completed',content:mutation==='changed-source'?original+'额外文字':original,summary:'成稿'}}});
  }
  if(mutation==='wrong-raw')receipt.expectedRawDigest='0'.repeat(64);if(mutation==='missing-raw')delete receipt.expectedRawDigest;if(mutation==='wrong-normalized')receipt.expectedDigest='0'.repeat(64);if(mutation==='wrong-old-canonical')receipt.expectedCanonicalDigest='0'.repeat(64);if(mutation==='missing-old-canonical')delete receipt.expectedCanonicalDigest;if(mutation==='wrong-length')receipt.expectedLength=original.length+1;if(mutation==='missing-length')delete receipt.expectedLength;
  f.setBody(f.actual().body.replace('**重点**','<b>重点</b>').replace('`one_qa_probe`','<code>one_qa_probe</code>').replace('|---|---:|','| --- | --- |'));
  if(mutation==='changed-code')f.setBody(f.actual().body.replace('one_qa_probe','one_qa_other'));if(mutation==='changed-body')f.setBody(f.actual().body.replace('|验证|1|','|验证|2|'));
  f.mcp.readDocument=async()=>mutation==='missing-title'?{text:f.actual().body}:f.fetchResult();const prior=structuredClone(receipt);
  if(mutation==='revoked')f.db.knowledgeConnections[0].status='revoked';if(mutation==='stopped')f.db.conversations[0].workPauseReason='user_stopped';
  if(mutation==='none'){
   f.advance();assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(receipt.comparison?.comparatorVersion,8);assert.equal(receipt.state,'uncertain','automatic polling keeps old v8 proof semantics');
   assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified');assert.equal(receipt.comparison?.comparatorVersion,9);assert.equal(receipt.comparison?.kind,'matched');
  }else if(mutation==='stopped'){
   assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified','an explicit readonly check may inspect the old page');assert.equal(f.job.notionVerificationSelection,undefined);assert.equal(f.job.state,'failed');assert.equal(f.db.conversations[0].workPauseReason,'user_stopped');
  }else{await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}),`${evidence}:${mutation}`);assert.equal(receipt.state,'uncertain',`${evidence}:${mutation}`);}
  for(const key of ['canonicalVersion','expectedRawDigest','expectedDigest','expectedCanonicalDigest','expectedLength','checkpointKey'] as const)assert.equal(receipt[key],prior[key],`${evidence}:${mutation}:${key}`);assert.equal(f.calls.length,1,'readonly proof never issues another write');
 }
});

test('manual v9 reproof of a v7 URL receipt requires the exact owned manuscript and preserves all original hashes',async()=>{
 const original='# 合成原题\n\n正文与 `ONE-QA`。\n\n参考：https://example.test/reference）',value={...args,content:original};
 for(const mutation of ['none','wrong-raw','wrong-old-canonical','missing-worker','foreign-model','changed-source','changed-target','changed-label','double-encoding','changed-code','missing-title'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(value)));f.stopped();
  const receipt=f.job.notionReceipt!;receipt.canonicalVersion=7;receipt.expectedCanonicalDigest=canonicalNotionDigest(original,7);
  const workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'完整成稿',kind:'model',instruction:'写完整原文',inputs:[]},{id:'save',title:'保存原文',kind:'notion',instruction:'原样保存',inputs:['draft']}]},{...scope,operationId:'op'});
  workflow.steps[0]={id:'draft',state:'completed',checkpointKey:'complete-v7-source'};f.job.workflow=workflow;
  f.job.steps=[...(mutation==='missing-worker'?[]:[{key:receipt.checkpointKey!,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write' as const,state:'started' as const,label:'保存',updatedAt:'now'}]),
   {key:'complete-v7-source',scopeId:mutation==='foreign-model'?'foreign':'op',namespace:`workflow:${workflow.id}`,tool:`workflow:${workflow.id}:draft`,effect:'model',state:'completed',label:'成稿',updatedAt:'now',output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:'draft'},outcome:'completed',result:{outcome:'completed',content:mutation==='changed-source'?original+'另一段':original,summary:'成稿'}}}];
  if(mutation==='wrong-raw')receipt.expectedRawDigest='0'.repeat(64);if(mutation==='wrong-old-canonical')receipt.expectedCanonicalDigest='0'.repeat(64);
  f.setBody(f.actual().body.replace('`ONE-QA`','<code>ONE-QA</code>').replace('https://example.test/reference）','[https://example.test/reference）](https://example.test/reference%EF%BC%89)'));
  if(mutation==='changed-target')f.setBody(f.actual().body.replace('%EF%BC%89)','different%EF%BC%89)'));
  if(mutation==='changed-label')f.setBody(f.actual().body.replace('reference）]','reference]'));
  if(mutation==='double-encoding')f.setBody(f.actual().body.replace('%EF%BC%89','%25EF%25BC%2589'));
  if(mutation==='changed-code')f.setBody(f.actual().body.replace('<code>ONE-QA</code>','<code>ONE-QB</code>'));
  f.mcp.readDocument=async()=>mutation==='missing-title'?{text:f.actual().body}:f.fetchResult();const prior=structuredClone(receipt);
  if(mutation==='none'){
   f.advance();assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(receipt.comparison?.comparatorVersion,7);assert.equal(receipt.state,'uncertain');
   assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified');assert.equal(receipt.comparison?.comparatorVersion,9);assert.equal(receipt.comparison?.kind,'matched');
  }else{await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(receipt.state,'uncertain');}
  for(const key of ['canonicalVersion','expectedRawDigest','expectedDigest','expectedCanonicalDigest','expectedLength'] as const)assert.equal(receipt[key],prior[key]);assert.equal(f.calls.length,1);
 }
});

for(const [mutation,kind] of [['missing-title','title_missing'],['changed-title','title_changed'],['changed-body','body_mismatch'],['incomplete','incomplete'],['read-failed','read_failed']] as const)test(`readback persists safe ${kind} metadata without title or body text`,async()=>{
 const f=fixture(),read=f.mcp.readDocument.bind(f.mcp),secret='PRIVATE_COMPARISON_BODY';
 f.mcp.readDocument=async(...params)=>{
  if(mutation==='missing-title')return {text:f.actual().body};
  if(mutation==='changed-title')f.setTitle('PRIVATE_COMPARISON_TITLE');
  if(mutation==='changed-body')f.setBody(secret);
  if(mutation==='incomplete')return {text:secret,truncated:true};
  if(mutation==='read-failed')throw Error(secret);
  return read(...params);
 };
 const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(args)));
 const receipt=f.job.notionReceipt!,comparison=receipt.comparison!;
 assert.equal(receipt.expectedRawDigest,notionHash(source));assert.equal(receipt.expectedLength,source.length);assert.equal(comparison.kind,kind);assert.equal(comparison.version,1);assert.equal(comparison.comparatorVersion,9);assert.equal(typeof comparison.checkedAt,'string');assert.equal(f.calls.length,1);
 assert.doesNotMatch(JSON.stringify(comparison),/PRIVATE_COMPARISON|青色42|ONE-QA-LATE/);
 if(['title_missing','title_changed','body_mismatch'].includes(kind)){assert.equal(comparison.actualBodyDigest,notionHash(f.actual().body));assert.equal(comparison.actualBodyLength,f.actual().body.length);}
 if(kind==='title_missing')assert.equal(comparison.actualTitleDigest,undefined);
 if(kind==='title_changed')assert.equal(comparison.actualTitleDigest,notionHash('PRIVATE_COMPARISON_TITLE'));
});

test('manual v9 reproof requires the exact old write source and never changes v5 or v6 digest meaning or repeats a save',async()=>{
 const original='# 原题\n\n**保留重点**与 `ONE`。\n\n\\*\\*可见字面星号\\*\\*',value={...args,content:original},raw=JSON.stringify(value);
 for(const version of [5,6] as const)for(const mutation of ['none','wrong-raw','wrong-old-canonical','wrong-checkpoint','foreign-trace','changed-code','lost-visible-stars'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(value)));f.stopped();
  const receipt=f.job.notionReceipt!,key=taskStepKey('worker','save_notion_draft',raw);receipt.canonicalVersion=version;receipt.expectedCanonicalDigest=canonicalNotionDigest(original,version);
  f.job.steps=[{key:mutation==='wrong-checkpoint'?'other':key,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'2026-10-29T02:00:00Z'}];
  f.db.contextTraces.push({...scope,workspaceId:mutation==='foreign-trace'?'wb':scope.workspaceId,conversationId:'task',requestId:'synthetic',executionSteps:[{tool:'save_notion_draft',query:raw}]} as any);
  if(mutation==='wrong-raw')receipt.expectedRawDigest='0'.repeat(64);
  if(mutation==='wrong-old-canonical')receipt.expectedCanonicalDigest='0'.repeat(64);
  f.setBody(f.actual().body.replace('**保留重点**','<b>保留重点</b>').replace('`ONE`','<code>ONE</code>'));
  if(mutation==='changed-code')f.setBody(f.actual().body.replace('<code>ONE</code>','<code>TWO</code>'));
  if(mutation==='lost-visible-stars')f.setBody(f.actual().body.replace('\\*\\*可见字面星号\\*\\*','<b>可见字面星号</b>'));
  f.mcp.readDocument=async()=>f.fetchResult();const prior=structuredClone(receipt);
  if(mutation==='none'){
   if(version===6){f.advance();assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(receipt.comparison?.comparatorVersion,6);assert.equal(receipt.state,'uncertain','automatic old-v6 read cannot silently adopt v7');}
   assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified');assert.equal(receipt.comparison?.comparatorVersion,9);assert.equal(receipt.comparison?.kind,'matched');
  }
  else{await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(receipt.state,'uncertain');}
  assert.equal(receipt.canonicalVersion,prior.canonicalVersion);assert.equal(receipt.expectedCanonicalDigest,prior.expectedCanonicalDigest);assert.equal(receipt.expectedRawDigest,prior.expectedRawDigest);assert.equal(receipt.expectedDigest,prior.expectedDigest);assert.equal(f.calls.length,1);
 }
});

test('manual v9 reproof can use the exact same-operation completed v6 workflow manuscript but never foreign or altered evidence',async()=>{
 const original='# 原题\n\n**保留重点**与 `ONE`。',value={...args,content:original};
 for(const mutation of ['none','workflow-owner','checkpoint-owner','marker-step','changed-source'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(value)));f.stopped();
  const receipt=f.job.notionReceipt!;receipt.canonicalVersion=6;receipt.expectedCanonicalDigest=canonicalNotionDigest(original,6);
  const workflow=createWorkflowRun({version:1,steps:[{id:'draft',title:'完整成稿',kind:'model',instruction:'完成整篇',inputs:[]},{id:'save',title:'保存整稿',kind:'notion',instruction:'原样保存',inputs:['draft']}]},{...scope,operationId:'op'});
  workflow.steps[0]={id:'draft',state:'completed',checkpointKey:'complete-manuscript'};f.job.workflow=workflow;
  f.job.steps=[{key:receipt.checkpointKey!,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'now'},
   {key:'complete-manuscript',scopeId:mutation==='checkpoint-owner'?'foreign':'op',namespace:`workflow:${workflow.id}`,tool:`workflow:${workflow.id}:draft`,effect:'model',state:'completed',label:'成稿',updatedAt:'now',output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:mutation==='marker-step'?'other':'draft'},outcome:'completed',result:{outcome:'completed',content:mutation==='changed-source'?original+'额外文字':original,summary:'成稿'}}}];
  if(mutation==='workflow-owner')workflow.binding.userId='b';
  f.setBody(f.actual().body.replace('**保留重点**','<b>保留重点</b>').replace('`ONE`','<code>ONE</code>'));f.mcp.readDocument=async()=>f.fetchResult();
  if(mutation==='none'){assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified');assert.equal(receipt.comparison?.comparatorVersion,9);}
  else{await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(receipt.state,'uncertain');}
  assert.equal(receipt.canonicalVersion,6);assert.equal(receipt.expectedRawDigest,notionHash(original));assert.equal(receipt.expectedCanonicalDigest,canonicalNotionDigest(original,6));assert.equal(f.calls.length,1);
 }
});

test('an exact old source does not reinterpret a literal italic tag from the v4 comparison protocol',async()=>{
 const original='# 原题\n\n<i>原先按字面保留的标签</i>',value={...args,content:original},raw=JSON.stringify(value),f=fixture();
 f.mcp.readDocument=async()=>{throw Error('initial unavailable');};const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(value)));f.stopped();
 const receipt=f.job.notionReceipt!;receipt.canonicalVersion=4;receipt.expectedCanonicalDigest=canonicalNotionDigest(original,4);f.job.steps=[{key:receipt.checkpointKey!,scopeId:'op',namespace:'worker',tool:'save_notion_draft',effect:'external_write',state:'started',label:'保存',updatedAt:'now'}];
 f.db.contextTraces.push({...scope,conversationId:'task',requestId:'synthetic',executionSteps:[{tool:'save_notion_draft',query:raw}]} as any);f.setBody('*原先按字面保留的标签*');f.mcp.readDocument=async()=>f.fetchResult();
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(receipt.canonicalVersion,4);assert.equal(receipt.expectedCanonicalDigest,canonicalNotionDigest(original,4));assert.equal(receipt.state,'uncertain');assert.equal(f.calls.length,1);
});

test('delayed reads retain the same safe comparison kinds and never change the original expected source',async()=>{
 for(const kind of ['title_missing','title_changed','body_mismatch','incomplete','read_failed'] as const){
  const f=fixture();f.mcp.readDocument=async()=>{throw Error('initial unavailable');};const tool=f.tool();await assert.rejects(()=>tool.run(tool.validate(args)));f.stopped();
  const expected=structuredClone(f.job.notionReceipt!);
  f.mcp.readDocument=async()=>{
   if(kind==='title_missing')return {text:f.actual().body};if(kind==='title_changed')f.setTitle('PRIVATE_CHANGED_TITLE');if(kind==='body_mismatch')f.setBody('PRIVATE_CHANGED_BODY');
   if(kind==='incomplete')return {text:'PRIVATE_PARTIAL_BODY',truncated:true};if(kind==='read_failed')throw Error('PRIVATE_TRANSPORT_ERROR');return f.fetchResult();
  };
  f.advance();assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');const receipt=f.job.notionReceipt!;
  assert.equal(receipt.comparison?.kind,kind);assert.equal(receipt.expectedRawDigest,expected.expectedRawDigest);assert.equal(receipt.expectedDigest,expected.expectedDigest);assert.equal(receipt.expectedCanonicalDigest,expected.expectedCanonicalDigest);assert.equal(receipt.expectedLength,expected.expectedLength);assert.doesNotMatch(JSON.stringify(receipt.comparison),/PRIVATE_|青色42/);assert.equal(f.calls.length,1);
 }
});

test('manual v4 italic recheck upgrades only after whole-document equality, without rewriting or changing source proof',async()=>{
 const f=await oldV4ItalicFixture(),before=structuredClone(f.job.notionReceipt!);
 const result=await f.docs.reconcile(scope,'task',async()=>{}),receipt=f.job.notionReceipt!;
 assert.equal(result.state,'verified');assert.equal(receipt.canonicalVersion,5);assert.equal(f.calls.length,1);
 assert.equal(receipt.expectedCanonicalDigest,before.expectedCanonicalDigest);assert.equal(receipt.expectedRawDigest,before.expectedRawDigest);assert.equal(receipt.expectedDigest,before.expectedDigest);assert.equal(receipt.checkpointKey,before.checkpointKey);
 assert.equal(receipt.expectedCanonicalDigest,canonicalNotionDigest(notionProjectedSource(f.actual().body,f.actual().title,receipt.titleProjection)!,5));
});

test('automatic old-v4 polling does not silently adopt v5, but an explicit read-only recheck may prove it',async()=>{
 const f=await oldV4ItalicFixture();f.advance();
 assert.equal((await f.docs.reconcileDue(scope,async()=>{}))[0].state,'scheduled');assert.equal(f.job.notionReceipt!.canonicalVersion,4);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.calls.length,1);
 assert.equal((await f.docs.reconcile(scope,'task',async()=>{})).state,'verified');assert.equal(f.job.notionReceipt!.canonicalVersion,5);assert.equal(f.calls.length,1);
});

for(const mutation of ['changed-word','missing-body','changed-title','missing-title','literal-old-tag','authorization-changed'] as const)test(`manual old-v4 italic comparison rejects ${mutation}, without a permissive upgrade`,async()=>{
 const expected=mutation==='literal-old-tag'?italicSource.replace('*保留原来的主题和完整结尾。*','<i>保留原来的主题和完整结尾。</i>'):italicSource;
 const f=await oldV4ItalicFixture(expected);
 if(mutation==='changed-word')f.setBody(f.actual().body.replace('原来的','别人的'));
 if(mutation==='missing-body')f.setBody('<i>保留原来的主题和完整结尾。</i>');
 if(mutation==='changed-title')f.setTitle('另一个标题');
 if(mutation==='missing-title')f.mcp.readDocument=async()=>({text:f.actual().body});
 if(mutation==='literal-old-tag')f.setBody('青色42\n\n*保留原来的主题和完整结尾。*');
 if(mutation==='authorization-changed')f.mcp.readDocument=async()=>{f.db.knowledgeConnections[0].notionWriting!.grantId='revoked';return f.fetchResult();};
 await assert.rejects(()=>f.docs.reconcile(scope,'task',async()=>{}));assert.equal(f.job.notionReceipt!.canonicalVersion,4);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.calls.length,1);
});
