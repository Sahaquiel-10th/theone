import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from './types.js';
import type { Store } from './db.js';
import type { WorkRun } from './coordinatorTypes.js';
import { NotionDocuments, notionPageId, notionBody, writingTarget } from './notionDocuments.js';
import type { NotionMcpService } from './knowledge/notionMcpService.js';
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
  assert.throws(()=>notionBody({text:'正文',truncated:true}));
  assert.throws(()=>notionBody({text:'正文',unknown_block_count:1}));
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
  await assert.rejects(()=>tool.structured!.run(args),/已经提交/);assert.equal(f.calls.length,1);
  const second=f.job('op2',pageId),current=(await f.docs.context(s,second)).currentDocument;
  const update=f.docs.tool(s,'op2','task',second,async()=>{},current);
  await update.structured!.run(update.structured!.validate({old_str:'这一句',new_str:'新的这一句'}));
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].name,'notion-update-page');assert.equal(f.calls[1].args.page_id,pageId);
  assert.equal(f.getBody(),'正文只写新的这一句。');
  assert.equal(f.calls.filter(c=>c.name==='notion-create-pages').length,1);
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
