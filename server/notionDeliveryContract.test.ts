import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import type {Store} from './db.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {NotionMcpService} from './knowledge/notionMcpService.js';
import {NotionDocuments} from './notionDocuments.js';
import {notionDeliveryConfirmed} from './notionCompletion.js';

const scope={workspaceId:'delivery-wa',userId:'delivery-a'},parentId='a'.repeat(32),pageId='b'.repeat(32);
function fixture(){
 let now=Date.parse('2026-11-10T01:00:00Z'),writes=0,reads=0,polls=0;
 const content='# 合成原稿\n\n金额3000元。\n\n保留完整结尾。';
 const db={users:[{id:scope.userId,enabled:true}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[scope],knowledgeConnections:[{id:'notion',workspaceId:scope.workspaceId,provider:'notion',status:'connected',notionWriting:{grantId:'grant',userId:scope.userId,parentId}}],conversations:[{...scope,id:'task',archived:false,messages:[],notionDocument:{connectionId:'notion',grantId:'grant',parentId}}],chatOperations:[]} as unknown as Database;
 const store={read:async()=>structuredClone(db),mutate:async<T>(fn:(db:Database)=>T)=>fn(db)} as Store;
 const job={state:'running',notionTarget:{connectionId:'notion',grantId:'grant',parentId,referenceIds:[]},steps:[]} as unknown as WorkRun;
 db.chatOperations!.push({...scope,id:'operation',operationId:'original',conversationId:'task',createdAt:new Date(now).toISOString(),status:'pending',workRun:job} as any);
 const mcp={readDocument:async()=>{reads++;return {text:content,properties:{title:'合成原稿'}};},callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,name:string,_args:unknown,before?:()=>Promise<void>)=>{
  if(name==='notion-create-pages'){await before?.();writes++;const snapshot=job.steps!.find(cp=>cp.key===job.notionReceipt!.checkpointKey)!;assert.equal((snapshot.output as any).content,content,'the whole source is durable before sending');return {pages:[{id:pageId}]};}
  assert.equal(name,'notion-get-async-task');polls++;return {status:'queued'};
 }} as unknown as NotionMcpService;
 const docs=new NotionDocuments(store,mcp,{now:()=>now,delays:[1,2,3],deadlineMs:1000});
 return {db,store,job,mcp,docs,content,advance:(ms:number)=>now+=ms,writes:()=>writes,reads:()=>reads,polls:()=>polls};
}

test('an async handle that stays queued cannot complete delivery or replay its write',async()=>{
 const f=fixture(),call=f.mcp.callDocumentTool.bind(f.mcp);let initial=true;
 f.mcp.callDocumentTool=async(...args)=>{
  if(args[4]==='notion-create-pages'){await call(...args);return {object:'async_task',id:'async_original',status:'queued'};}
  if(initial){initial=false;throw Error('first poll unavailable');}
  return call(...args);
 };
 const tool=f.docs.tool(scope,'operation','task',f.job,async()=>{}).structured!;
 await assert.rejects(()=>tool.run(tool.validate({title:'合成原稿',content:f.content,final:true})));
 f.job.state='failed';f.db.chatOperations![0].status='failed';
 assert.equal(f.job.notionReceipt!.asyncTaskId,'async_original');assert.equal(notionDeliveryConfirmed(f.job.notionReceipt,'operation'),false);
 for(const delay of [1,2,3]){f.advance(delay);await f.docs.reconcileDue(scope,async()=>{});assert.equal(notionDeliveryConfirmed(f.job.notionReceipt,'operation'),false);}
 assert.equal(f.job.notionReceipt!.verification!.state,'exhausted');assert.equal(f.job.steps![0].state,'started');assert.equal(f.writes(),1);assert.equal(f.reads(),0);assert.equal(f.polls(),3);
 await f.docs.reconcileDue(scope,async()=>{});assert.equal(f.polls(),3,'terminal polling stays bounded');
});

test('an ACK-before-wrapper crash retains the full source and recovers through fresh authorized state only',async()=>{
 const f=fixture();let confirmations=0;
 const tool=f.docs.tool(scope,'operation','task',f.job,async()=>{confirmations++;if(f.job.notionReceipt?.writeAcknowledgement)throw Error('Key disconnected after ACK');}).structured!;
 await assert.rejects(()=>tool.run(tool.validate({title:'合成原稿',content:f.content,final:true})));
 assert.equal(notionDeliveryConfirmed(f.job.notionReceipt,'operation'),true);assert.equal(f.job.steps![0].state,'started');assert.equal((f.job.steps![0].output as any).content,f.content);
 f.job.state='failed';f.db.chatOperations![0].status='failed';
 await assert.rejects(()=>f.docs.acknowledgeDeliveries(scope,async()=>{throw Error('Key offline');}));assert.equal(f.job.steps![0].state,'started');
 await f.docs.acknowledgeDeliveries(scope,async()=>{});assert.equal(f.job.steps![0].state,'completed');assert.equal((f.job.steps![0].output as any).content,f.content);assert.equal(f.writes(),1);
 f.mcp.readDocument=async()=>({text:f.content+'\n\n额外说明。',properties:{title:'合成原稿'}});f.advance(1);await f.docs.reconcileDue(scope,async()=>{});
 assert.equal(f.job.notionReceipt!.integrity!.state,'covered');assert.equal(f.job.notionReceipt!.state,'delivered');assert.equal(f.writes(),1);assert.equal((f.job.steps![0].output as any).content,f.content);
});

test('async polling with page-shaped payloads but no succeeded status cannot manufacture an ACK',async t=>{
 const f=fixture(),call=f.mcp.callDocumentTool.bind(f.mcp);let polls=0;
 f.mcp.callDocumentTool=async(...args)=>{
  if(args[4]==='notion-create-pages'){await call(...args);return {object:'async_task',id:'async_missing_status',status:'accepted'};}
  assert.equal(args[4],'notion-get-async-task');polls++;return {pages:[{id:pageId}]};
 };
 const tool=f.docs.tool(scope,'operation','task',f.job,async()=>{}).structured!;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  const attempt=assert.rejects(()=>tool.run(tool.validate({title:'合成原稿',content:f.content,final:true})));
  for(let tick=0;tick<12;tick++){await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(1500);}
  await attempt;
 }finally{t.mock.timers.reset();}
 assert.equal(polls,10);assert.equal(f.writes(),1);assert.equal(f.reads(),0);assert.equal(f.job.notionReceipt!.state,'uncertain');assert.equal(f.job.notionReceipt!.writeAcknowledgement,undefined);assert.equal(notionDeliveryConfirmed(f.job.notionReceipt,'operation'),false);assert.equal(f.job.notionReceipt!.pageId,undefined);assert.equal(f.job.steps![0].state,'started');
});

for(const scenario of ['changed_body','complete','decorated_title','decorated_changed_body','negated_title','wrong_title','unknown_title'] as const)test(`same-page source H1 uses only its safely matching actual title property during background ${scenario} checking`,async()=>{
 const f=fixture(),title=scenario==='negated_title'?'批准计划':'用户买的从来不是钻头，而是墙上那个洞';
 const blocks=Array.from({length:38},(_,index)=>`第${index+2}块合成段落，唯一编号${index+2}。`),source=`# ${title}\n\n${blocks.join('\n\n')}`;
 let actual='旧正文',writes=0;f.job.notionTarget!.pageId=pageId;
 const actualTitle=scenario==='wrong_title'?'另一个不相符的标题':scenario==='negated_title'?'不'+title:scenario.startsWith('decorated_')?`2026-11-10 · ${title}（草稿）`:title;
 f.mcp.readDocument=async()=>({text:actual,...(scenario!=='unknown_title'?{properties:{title:actualTitle}}:{})});
 f.mcp.callDocumentTool=async(_w,_c,_g,_u,name,args:any,before)=>{assert.equal(name,'notion-update-page');await before?.();writes++;assert.equal((f.job.steps![0].output as any).content,source);actual=args.content_updates[0].new_str;return {id:pageId};};
 const tool=f.docs.tool(scope,'operation','task',f.job,async()=>{},actual).structured!;
 assert.equal((await tool.run(tool.validate({old_str:actual,new_str:source,final:true})) as any).state,'delivered');
 f.job.state='completed';f.db.chatOperations![0].status='completed';
 const {canonicalNotionDigest}=await import('./notionCanonical.js');
 const receipt=f.job.notionReceipt!;receipt.canonicalVersion=9;receipt.expectedCanonicalDigest=canonicalNotionDigest(source,9);
 const before=structuredClone(receipt);assert.equal(receipt.titleProjection,undefined,'same-page updates do not invent a historical projection');
 actual=blocks.map((block,index)=>['changed_body','decorated_changed_body'].includes(scenario)&&[0,37].includes(index)?block.replace('合成段落','用户改过的段落'):block).join('\n\n');
 f.advance(1);await f.docs.reconcileDue(scope,async()=>{});
 const integrity=receipt.integrity!;
 assert.equal(integrity.sourceBlockCount,39);assert.equal(writes,1);assert.equal(receipt.state,'delivered');
 if(scenario==='changed_body'||scenario==='decorated_changed_body'){assert.equal(integrity.state,'missing');assert.deepEqual(integrity.missingBlockIndexes,[2,39]);assert.equal(integrity.missingBlockCount,2);assert.equal(integrity.title,'matched');}
 if(scenario==='complete'||scenario==='decorated_title'){assert.equal(integrity.state,'covered');assert.equal(integrity.matchedBlockCount,39);assert.deepEqual(integrity.missingBlockIndexes,[]);}
 if(scenario==='wrong_title'||scenario==='negated_title'){assert.equal(integrity.state,'missing');assert.deepEqual(integrity.missingBlockIndexes,[1]);assert.equal(integrity.title,'different');}
 if(scenario==='unknown_title'){assert.equal(integrity.state,'inconclusive');assert.deepEqual(integrity.missingBlockIndexes,[]);assert.equal(integrity.reason,'title_unavailable');assert.equal(integrity.title,'unavailable');}
 for(const key of ['expectedDigest','expectedRawDigest','expectedCanonicalDigest','canonicalVersion','expectedLength','checkpointKey','titleProjection','writeAcknowledgement','final'] as const)assert.deepEqual(receipt[key],before[key],key+' remains immutable');
});
