import test from "node:test";
import express from "express";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCoordinatorRoutes } from "./coordinatorRoutes.js";
import assert from "node:assert/strict";
import {createHash} from 'node:crypto';
import type { Store } from "./db.js";
import type { Database, ModelConfig } from "./types.js";
import { CoordinatorService } from "./coordinatorService.js";
import {ChatImageGatewayError} from './responsesImageGateway.js';
import {OneKeyPresenceError} from './oneKeyPresence.js';
import { NotionDocuments } from './notionDocuments.js';
import { NotionWriteError, type NotionMcpService } from './knowledge/notionMcpService.js';
import { defaultTaskValues, updateTaskConfig } from "./aiTaskConfig.js";
import {runtimeContext} from './runtimeContext.js';
import {sourceBinding} from './publicSharing.js';
import {localExecutionCapabilityGuidance} from './localDocumentPolicy.js';
import JSZip from 'jszip';
import XLSX from 'xlsx';

test('a missing mandatory PPT is repaired before queueing; one office bundle saves and reads back all real formats',async()=>{
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-office-bundle-'));let route=0;
 const ids=['doc','sheet','slides'],names=['oneDocument','oneWorkbook','oneSlides'];
 await f.store.mutate(d=>{d.settings.officialFeatures=ids.map((id,i)=>{
  const values={name:`办公${id}`,author:'ONE',description:'办公成果',instructions:`OFFICE_BUNDLE_${id}`,limitations:'合成私有资料',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:names[i],description:'生成私有文件'}]};
  const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};
  return {id,revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:`release-${id}`,version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}};
 });});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no knowledge');}},{artifactDirectory:directory,modelCall:async(model,messages,tools,_request,options)=>{
  if(model.id==='router'){
   route++;
   if(route===3)return answer('三份材料已经安排。');
   if(route===2){assert.match(messages.at(-1)!.content!,/oneSlides/);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);}
   return {...answer(''),toolCalls:[{id:`plan-${route}`,type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'办公包',instruction:'Word方案、Excel预算、6页PPT，PPT必须交付，网页可选',executorId:'general',featureIds:route===1?ids.slice(0,2):ids,outputKind:'text',dependsOn:[]}]})}}]};
  }
  if(model.id==='special'){
   if(messages.at(-1)?.role==='tool')return answer('文件已保存。');
   assert.equal(options?.maxOutputTokens,10000);
   const index=ids.findIndex(id=>messages[0].content?.includes(`OFFICE_BUNDLE_${id}`));
   const data=index===0?{title:'读书会方案',style:'manual',sections:[{heading:'执行安排',paragraphs:['小林负责活动；场地待定。']}]}:index===1?{title:'预算',sheets:[{name:'预算',headers:['人数','净收益'],rows:[[4,null],[6,null],[10,null],['保本人数',null]],formulas:[{cell:'B2',formula:'A2*(50-15)-120'},{cell:'B3',formula:'A3*(50-15)-120'},{cell:'B4',formula:'A4*(50-15)-120'},{cell:'B5',formula:'ROUNDUP(120/(50-15),0)'}]}]}:{title:'合作介绍',theme:'paper',slides:Array.from({length:6},(_,i)=>({title:`第${i+1}页`,layout:'bullets',bullets:['活动场地待定']}))};
   return {...answer(''),toolCalls:[{id:`file-${index}`,type:'function',function:{name:names[index],arguments:JSON.stringify({operation:'create',dataJson:JSON.stringify(data)})}}]};
  }
  if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:ids.map((_,i)=>({id:`feature-${i}`,type:'function' as const,function:{name:`feature_${i}`,arguments:JSON.stringify({query:'生成本功能对应文件，PPT为6页'})}}))};
  return answer(JSON.stringify({outcome:'completed',content:'三份材料好了。',summary:'三份都好了'}));
 }});
 try{
  const reply=await service.dispatch(a,input('operation_office_bundle_01','请准备Word执行方案、一份6页PPT介绍，最好也能网页翻页，以及Excel预算表'),key);
  await service.resume(a,key);await waitFor(async()=>(await service.task(a,reply.taskId!)).jobs[0].state==='completed');
  const db=await f.store.read(),files=db.attachments.filter(file=>file.conversationId===reply.taskId);
  assert.deepEqual(files.map(f=>path.extname(f.originalName)).sort(),['.docx','.html','.pptx','.xlsx']);
  const bytes=(ext:string)=>readFileSync(files.find(f=>f.originalName.endsWith(ext))!.storagePath);
  const word=await JSZip.loadAsync(bytes('.docx'));assert.match(await word.file('word/document.xml')!.async('string'),/场地待定/);
  const ppt=await JSZip.loadAsync(bytes('.pptx'));assert.equal(Object.keys(ppt.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).length,6);
  const workbook=XLSX.read(bytes('.xlsx'),{type:'buffer',cellFormula:true});assert.deepEqual([2,3,4,5].map(i=>workbook.Sheets['预算'][`B${i}`].v),[20,90,230,4]);assert.match(workbook.Sheets['预算'].B5.f,/ROUNDUP/);
  const trace=db.contextTraces.find(t=>t.conversationId===reply.taskId)!.executionSteps!;
  for(const name of names)assert.ok(trace.some(t=>t.tool.endsWith(`.${name}`)));
  await assert.rejects(()=>service.task(b,reply.taskId!));assert.equal(db.powerAccounts[1].balanceMicros,100e6);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('automatic public search is real, scoped, carries request time and does not create a task for a tool step',async()=>{
  const f=fixture();let searches=0,calls=0;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({status:'no_match',chunks:[],failures:[]})},{webSearch:async(q,context)=>{searches++;assert.equal(q,'公开测试新闻');assert.equal(context.workspaceId,a.workspaceId);assert.equal(context.userId,a.userId);assert.ok(context.conversationId);assert.match(context.requestId,/^coord_/);assert.equal(typeof context.beforeReserve,'function');await context.verify();return [{title:'公开来源',url:'https://example.com/source',snippet:'已核对的公开素材'}];},modelCall:async(_m,messages,tools)=>{
    calls++;assert.match(JSON.stringify(messages),/任务日期参考/);assert.ok(tools.length===0||tools.some(t=>t.function.name==='web_search'));
    if(calls===1)return answer('这条回复尚未搜索。');
    if(calls===2)return {...answer(''),toolCalls:[{id:'public-search',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'公开测试新闻'})}}]};
    assert.equal(JSON.parse(messages.at(-1)!.content!).status,'used');return answer('查到了，参考[公开来源](https://example.com/source)。');
  }});
  await service.dispatch(a,{...input('operation_public_search_001','请联网查今天的新闻，只查公开资料'),webSearch:true},key,undefined,undefined,'America/Los_Angeles');
  const db=await f.store.read(),op=db.chatOperations!.find(o=>o.operationId==='operation_public_search_001')!;
  assert.equal(searches,1);assert.equal(calls,3);assert.equal(op.runtimeContext?.timeZone,'America/Los_Angeles');assert.equal(db.chatOperations?.filter(o=>o.workRun).length,0);
  await service.dispatch(a,{...input('operation_public_search_001','请联网查今天的新闻，只查公开资料'),webSearch:true},key,undefined,undefined,'Asia/Shanghai');
  assert.equal(searches,1,'restoring the same attempt does not search or charge again when device time zone changed');
});
test('yesterday meeting recall gets a fixed date and honest non-exhaustive time metadata, never another workspace city',async()=>{
  const f=fixture();await f.store.mutate(db=>{db.knowledgeConnections.push({id:'ka',workspaceId:'wa',provider:'getnote',status:'connected',clientId:'test'} as any);db.users[1].contextPreferences=[{...b,timeZone:'Asia/Shanghai',city:'FOREIGN_PRIVATE_CITY'}];});let query='';
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async(_ws,q,_k,ids)=>{query=q;assert.deepEqual(ids,['ka']);return {status:'used',chunks:[{title:'会议',content:'合成会议内容',createdAt:'2026-10-17 10:00:00'}],failures:[]};}},{modelCall:async(_m,messages)=>{
    assert.doesNotMatch(JSON.stringify(messages),/FOREIGN_PRIVATE_CITY/);
    if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[{id:'private-date',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'会议'})}}]};
    assert.equal(JSON.parse(messages.at(-1)!.content!).timeConstraint.strictFilter,false);return answer('查到了相关片段，还要按会议正文核对日期。');
  }});
  await service.dispatch(a,input('operation_meeting_date_01','昨天我的会议说了什么？'),key,undefined,undefined,'Asia/Shanghai');
  const db=await f.store.read(),op=db.chatOperations!.find(o=>o.operationId==='operation_meeting_date_01')!;assert.ok(query.includes(runtimeContext(db,a,op.createdAt,'Asia/Shanghai').yesterday));
});
test('a no-internet request cannot call public search even if the browser enables it',async()=>{
  const f=fixture();let calls=0;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({status:'no_match',chunks:[],failures:[]})},{webSearch:async()=>{throw Error('must not search');},modelCall:async(_m,messages,tools)=>{
    assert.equal(tools.some(t=>t.function.name==='web_search'),false);calls++;
    if(calls===1)return {...answer(''),toolCalls:[{id:'forged-search',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'forbidden'})}}]};
    assert.equal(JSON.parse(messages.at(-1)!.content!).status,'rejected');return answer('不联网，只根据你给的内容讨论。');
  }});
  await service.dispatch(a,{...input('operation_no_internet_01','只讨论，不联网'),webSearch:true},key);assert.equal(calls,2);
});
test('explicit knowledge opt-out removes private retrieval and rejects a forged coordinator call',async()=>{
 const f=fixture();let calls=0;
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'private',workspaceId:'wa',provider:'getnote',status:'connected',clientId:'test'} as any));
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{assert.fail('private knowledge was not requested');}},{modelCall:async(_m,messages,tools)=>{
  assert.ok(!tools.some(t=>t.function.name==='knowledge_search'));calls++;
  if(calls===1)return {...answer(''),toolCalls:[{id:'forged-private',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'forbidden'})}}]};
  assert.equal(JSON.parse(messages.at(-1)!.content!).status,'rejected');return answer('只用你提供的内容。');
 }});
 await service.dispatch(a,input('operation_no_knowledge_01','只讨论给出的主题，不查知识库。'),key);assert.equal(calls,2);
});
test('an unavailable public search has a plain next step, never a successful search claim',async()=>{
  const f=fixture();let calls=0;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({status:'no_match',chunks:[],failures:[]})},{webSearch:async()=>({status:'unavailable'}),modelCall:async()=>++calls===1?{...answer(''),toolCalls:[{id:'search',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'公开新闻'})}}]}:answer('没有查到真实结果。')});
  const result=await service.dispatch(a,{...input('operation_search_unavailable_01','请联网查今天的新闻，另外今天和昨天的具体日期、当前时区和已设置的城市是什么'),webSearch:true},key);
  assert.match(result.message.content,/公开搜索这次没查成/);assert.match(result.message.content,/继续查刚才的问题/);assert.doesNotMatch(result.message.content,/API_KEY|未开放、已下架/);
  const context=(await f.store.read()).chatOperations!.find(o=>o.operationId==='operation_search_unavailable_01')!.runtimeContext!;
  assert.ok(result.message.content.includes(context.today)&&result.message.content.includes(context.yesterday));
  assert.match(result.message.content,/Asia\/Shanghai/);assert.match(result.message.content,/还没有设置常驻城市/);
});
import { executorDefaults, updateExecutor } from "./executorProfiles.js";

test('missing or failed private retrieval preserves independently requested server date and own city facts',async()=>{
 for(const connected of [false,true]){
  const f=fixture();let reads=0,calls=0;
  await f.store.mutate(d=>{
   d.users.find(u=>u.id==='a')!.contextPreferences=[{...a,timeZone:'Asia/Shanghai',city:'杭州'}];
   d.users.find(u=>u.id==='b')!.contextPreferences=[{...b,timeZone:'America/New_York',city:'FOREIGN_CITY'}];
   if(connected)d.knowledgeConnections.push({id:'private-notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test'} as any);
  });
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{reads++;return {status:'failed',chunks:[],failures:[],coverage:[{connectionId:'private-notion',provider:'notion',status:'failed',attempts:1}]};}},{modelCall:async()=>++calls===1?{...answer(''),toolCalls:[{id:'lookup',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'ONE-QA36'})}}]}:answer('不能把这段未核对的回答当成果。')});
  const operation=connected?'operation_knowledge_failed_facts':'operation_knowledge_missing_facts';
  const result=await service.dispatch(a,input(operation,'直接回答：今天、昨天各是几月几日？我设置的常驻城市是什么？再只去 Notion 查找 ONE-QA36，不分派任务。'),key);
  const db=await f.store.read(),context=db.chatOperations!.find(o=>o.operationId===operation)!.runtimeContext!;
  assert.ok(result.message.content.includes(context.today)&&result.message.content.includes(context.yesterday));
  assert.match(result.message.content,/杭州/);assert.doesNotMatch(result.message.content,/FOREIGN_CITY|全部没有|资料不存在|未核对的回答当成果/);
  assert.match(result.message.content,connected?/还没查全/:/Notion还没有连好/);
  assert.equal(reads,connected?1:0);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);
 }
});
import { beginChatOperation,reconcileInterruptedChatOperations } from "./chatOperations.js";
import { MODEL_MAX_OUTPUT_TOKENS, ModelRequestError, type ModelToolMessage, type ModelToolDefinition, type ToolChatResult } from "./modelGateway.js";

test('main-chat display history is scoped and retains old task links, separate from task pagination',async()=>{
 const f=fixture();await f.store.mutate(d=>{
  const messages=Array.from({length:92},(_,i)=>({id:`history_${i}`,role:i%2?'assistant' as const:'user' as const,content:`history ${i}`,createdAt:String(i).padStart(5,'0')}));
  d.conversations.push({...a,id:'history_main',coordinatorMain:true,title:'main',modelId:'router',archived:false,messages,createdAt:'now',updatedAt:'now'});
  d.conversations.push({...a,id:'history_task',title:'old task',modelId:'router',archived:false,messages:[],createdAt:'now',updatedAt:'now'});
  d.chatOperations!.push({...a,id:'history_op',operationId:'history_operation_01',requestId:'r',payloadHash:'h',status:'completed',createdAt:'now',updatedAt:'now',assistantMessageId:'history_13',dispatchedTaskId:'history_task'});
 });
 const state=await f.service.state(a);assert.equal(state.conversation!.messages.length,40);assert.equal(state.history.total,92);
 const page=await f.service.history(a,state.history.before);assert.equal(page.messages.length,40);
 const first=await f.service.history(a,page.history.before);assert.equal(first.messages.length,12);assert.equal(first.history.hasMore,false);
 assert.equal(page.links.some(link=>link.messageId==='history_13'&&link.taskId==='history_task'),true);
 const foreign=await f.service.history(b);assert.equal(foreign.messages.length,0);assert.equal(foreign.links.length,0);await assert.rejects(()=>f.service.history(b,'history_13'));
});

for(const sponsored of [true,false])test(`welcome manual → image → shared visual functions is durable, scoped and billed by stage (gift=${sponsored})`,async()=>{
  const f=await imageFixture(async()=>({content:'',imageUrl:imageFixturePng})),operationId='welcome_manual_0123456789';let texts=0,images=0;
  const scene={id:'idea',title:'整理想法',situation:'开会前有一堆想法。',feature:'把想法整理成提纲。',advantage:'不用自己反复排版。',benefit:'拿到可讨论的提纲。',evidence:'查看实际提纲，核对缺口。',steps:['说出目标。','核对提纲。'],prompt:'帮我整理开会提纲。',capabilityIds:['chat']};
  const doc={version:1,title:'小明的 ONE 使用说明',intro:'先从今天要开的会开始。',scenes:[scene,{...scene,id:'result',title:'把成果拿来用',capabilityIds:['visual']}]};
  await f.store.mutate(d=>{
    const u=d.users.find(u=>u.id==='a')!;u.defaultWorkspaceId='wa';
    u.profile={workspaceId:'wa',displayName:'小明',onboarding:{knowledgeChoice:'skipped',completedAt:'now',journey:{id:'journey_manual_test',launchId:'manual_launch_012345',version:2,experience:4,stage:'complete',startedAt:'now',featureIds:[],events:[]},handbook:{operationId,funding:sponsored?'one':'customer',status:'pending',requestedAt:'now',updatedAt:'now',maxPower:.5},...(sponsored?{welcomeGiftOperationId:operationId}:{})},updatedAt:'now'};
    const v=d.settings.aiTasks!.image_generation!.published!;v.imagePowerPerCall=.012;v.costImagePowerPerCall=.02;delete v.enabled;
    updateTaskConfig(d.settings,d.models,'welcome_manual',{revision:0,action:'draft',values:{...defaultTaskValues('welcome_manual'),modelId:d.models[0].id,prompt:defaultTaskValues('welcome_manual').prompt+' ONE_MANUAL_CUSTOM_PROMPT'}},'a','now');
    updateTaskConfig(d.settings,d.models,'welcome_manual',{revision:1,action:'publish'},'a','now');
    if(sponsored)d.powerAccounts.find(p=>p.userId==='a')!.balanceMicros=0;
  });
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('must not read knowledge');}},{artifactDirectory:f.directory,modelCall:async(_m,messages,tools,_requestId,options)=>{texts++;assert.equal(options?.requiredTool,'oneManual');assert.match(messages[0].content!,/ONE_MANUAL_CUSTOM_PROMPT/);assert.equal(tools[0].function.name,'oneManual');assert.doesNotMatch(JSON.stringify(messages),/apiKey|storagePath/);return {...answer(''),toolCalls:[{id:'manual',type:'function',function:{name:'oneManual',arguments:JSON.stringify(doc)}}]};},imageCall:async(_m,messages)=>{images++;assert.match(JSON.stringify(messages),/开会前有一堆想法/);assert.match(JSON.stringify(messages),/小明的 ONE 使用说明/);return {content:'',imageUrl:imageFixturePng};}});
  const {startOnboardingHandbook,onboardingHandbookOffer}=await import('./onboardingHandbook.js');
  const deps={verifyKey:key,storageAvailable:true,enqueueImage:(scope:typeof a,request:import('./onboardingHandbook.js').OnboardingImageInput,verify:()=>Promise<void>)=>service.enqueueOnboardingImage(scope,request,verify)};
  try{
    const offer=onboardingHandbookOffer(await f.store.read(),true,a);assert.ok(offer.available&&offer.pricePower!>.012);
    const accepted=await startOnboardingHandbook(f.store,a,deps);assert.equal(accepted.handbook!.status,'queued');const taskId=accepted.handbook!.taskId!;
    await service.resume(a,key);await waitFor(async()=>(await service.task(a,taskId)).jobs[0].state==='completed');
    const d=await f.store.read(),run=d.chatOperations!.find(o=>o.conversationId===taskId&&o.workRun)!.workRun!;
    assert.equal(texts,1);assert.equal(images,1);assert.deepEqual(run.welcomeManual!.document,doc);assert.equal(run.welcomeManual!.model.apiKey,'');assert.ok(run.welcomeArtifacts?.flowId&&run.welcomeArtifacts.pageId);
    assert.equal(run.fixedWorkflow?.id,'onboarding_guide');assert.equal(run.fixedWorkflow?.version,1);
    assert.equal(d.attachments.filter(f=>f.conversationId===taskId).length,3);assert.equal(d.modelUsageRecords.length,2);
    assert.ok(d.modelUsageRecords.every(r=>sponsored?r.chargedMicros===0:r.chargedMicros!>0));assert.ok(d.attachments.find(f=>f.id===run.welcomeImageAttachmentId)!.welcomeGuide!.manual);
    assert.equal(d.attachments.find(f=>f.id===run.welcomeImageAttachmentId)!.welcomeGuide!.sponsored,sponsored);
    const page=d.attachments.find(f=>f.id===run.welcomeArtifacts!.pageId)!;assert.equal(page.welcomeImageId,run.welcomeImageAttachmentId);const pageHtml=readFileSync(page.storagePath,'utf8');assert.match(pageHtml,/id="whole-illustration" src="data:image\/png;base64,/);assert.equal(pageHtml.includes('这期，ONE 老板请了'),sponsored);
    const returned=await service.task(a,taskId);assert.doesNotMatch(JSON.stringify(returned),/welcomeManual|contentBudget|safetyRules|apiKey/);
    await startOnboardingHandbook(f.store,a,deps);await service.resume(a,key);assert.equal(texts,1);assert.equal(images,1);
    await assert.rejects(()=>service.task(b,taskId));
    // Simulate a lost final receipt after artifacts were saved. Explicit retry
    // must recover the same image/manual rather than buying them again.
    const source=d.chatOperations!.find(o=>o.conversationId===taskId&&o.workRun)!;
    await f.store.mutate(db=>{const op=db.chatOperations!.find(o=>o.id===source.id)!;op.status='failed';op.workRun!.state='failed';op.workRun!.resultOutcome='failed';op.workRun!.resultMessageId=undefined;op.workRun!.error='收尾回执中断';});
    await service.retryLatest(a,taskId,source.id,undefined,key);await service.resume(a,key);
    await waitFor(async()=>(await service.task(a,taskId)).jobs.at(-1)!.state==='completed');
    assert.equal(texts,1);assert.equal(images,1);assert.equal((await f.store.read()).modelUsageRecords.length,2);
    const resumed=(await f.store.read()).chatOperations!.filter(o=>o.conversationId===taskId&&o.workRun).at(-1)!;
    await f.store.mutate(db=>{db.attachments=db.attachments.filter(f=>f.id!==run.welcomeImageAttachmentId);const op=db.chatOperations!.find(o=>o.id===resumed.id)!;op.status='failed';op.workRun!.state='failed';op.workRun!.resultMessageId=undefined;});
    await service.retryLatest(a,taskId,resumed.id,undefined,key);await service.resume(a,key);
    await waitFor(async()=>(await service.task(a,taskId)).jobs.at(-1)!.state==='failed');
    assert.equal(images,1);assert.equal(texts,1);assert.equal((await f.store.read()).modelUsageRecords.length,2);assert.match((await service.task(a,taskId)).jobs.at(-1)!.error!,/不会自动重新画图/);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('on-demand capability discovery is scoped, fresh, read-only and does not stuff the full feature library into the initial prompt',async()=>{
 const f=fixture();
 await f.store.mutate(d=>{d.settings.officialFeatures=Array.from({length:80},(_,i)=>{
  const values={name:`专用能力${i}`,author:'ONE',description:'独立特定用途',instructions:'PRIVATE_FEATURE_INSTRUCTIONS',limitations:'只读',integration:'question_answer' as const,modelId:'special',discovery:{aliases:[i===79?'星轨排期':`代号Q${i}`]}};
  const version={version:1,values,evidence:'synthetic',approvedBy:'a',approvedAt:'now'};
  return {id:`discovery-${i}`,revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:`release-${i}`,version:1,userIds:[i===78?'b':'a'],publishedAt:'now',publishedBy:'a'}};
 });});
 let calls=0;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('metadata discovery must not query knowledge');}},{modelCall:async(_model,messages,tools)=>{
  calls++;
  assert.ok(tools.some(tool=>tool.function.name==='discover_capabilities')||calls===3);
  if(calls===1){assert.doesNotMatch(JSON.stringify(messages),/discovery-79|PRIVATE_FEATURE_INSTRUCTIONS|discovery-78/);return {...answer(''),toolCalls:[{id:'find',type:'function',function:{name:'discover_capabilities',arguments:JSON.stringify({query:'星轨排期'})}}]};}
  const returned=JSON.parse(messages.filter(m=>m.role==='tool').at(-1)!.content!);
  if(calls===2){assert.equal(returned.items[0].featureId,'discovery-79');assert.equal(returned.total,1);await f.store.mutate(d=>{d.settings.officialFeatures!.find(feature=>feature.id==='discovery-79')!.status='paused';});return {...answer(''),toolCalls:[{id:'fresh',type:'function',function:{name:'discover_capabilities',arguments:JSON.stringify({query:'星轨排期'})}}]};}
  assert.equal(returned.items.length,0);return answer('这项能力刚停用了，没有运行任何任务。');
 }});
 const result=await service.dispatch(a,input('operation_discovery_read_01','只回答，不要安排新任务；先帮我查找能力目录'),key);
 assert.match(result.message.content,/停用/);const db=await f.store.read();
 assert.equal(db.chatOperations!.filter(op=>op.workRun).length,0);assert.ok(db.modelUsageRecords.every(row=>row.activity==='coordinator'));
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FEATURE_INSTRUCTIONS|discovery-78/);
});
for(const delegateName of ['delegate_tasks','delegate_task'])test(`a discovered entitled feature can actually be delegated and billed once through ${delegateName}, not merely named in an answer`,async()=>{
 const f=fixture();let routeCalls=0,featureCalls=0;
 await f.store.mutate(d=>{const values={name:'观测排期',author:'ONE',description:'安排望远镜观测',instructions:'只处理合成观测排期',limitations:'不联网',integration:'question_answer' as const,modelId:'special',usageMultiplier:.6,discovery:{aliases:['星轨排期']}};const version={version:1,values,evidence:'synthetic',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'discover-run',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'release-observe',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}];});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('must not query');}},{modelCall:async(model,messages)=>{
  if(model.id==='router'){
   routeCalls++;
   if(routeCalls===1)return {...answer(''),toolCalls:[{id:'find',type:'function',function:{name:'discover_capabilities',arguments:JSON.stringify({query:'星轨排期'})}}]};
   if(routeCalls===2){assert.equal(JSON.parse(messages.at(-1)!.content!).items[0].featureId,'discover-run');const task={taskId:null,title:'合成排期',instruction:'只安排今晚20时观测，不联网',executorId:'general',featureIds:['discover-run']};return {...answer(''),toolCalls:[{id:'delegate',type:'function',function:{name:delegateName,arguments:JSON.stringify(delegateName==='delegate_task'?task:{tasks:[{...task,outputKind:'text',dependsOn:[]}]})}}]};}
   return answer('已安排，结果会留在任务区');
  }
  if(model.id==='special'){featureCalls++;return answer('今晚20时观测，合成排期已整理。');}
  if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[{id:'run-feature',type:'function',function:{name:'feature_0',arguments:JSON.stringify({query:'今晚20时观测'})}}]};
  return answer(JSON.stringify({outcome:'completed',content:'今晚20时观测。',summary:'排期已整理'}));
 }});
 const reply=await service.dispatch(a,input('operation_discover_run_01','先找适合的专门能力，再完成这一件合成任务'),key);assert.equal(reply.taskIds.length,1);
 await service.resume(a,key);await waitFor(async()=>(await service.task(a,reply.taskIds[0])).jobs[0].state==='completed');
 assert.equal(featureCalls,1);const db=await f.store.read();assert.equal(db.modelUsageRecords.filter(row=>row.featurePriceSnapshot?.id==='discover-run').length,1);
 await service.resume(a,key);assert.equal(featureCalls,1);await assert.rejects(()=>service.task(b,reply.taskIds[0]));
});
test('single-task function selection cannot bypass entitlement, pause or multiplier approval',async()=>{
 for(const mode of ['foreign','paused','approval'] as const){
  const f=fixture();
  await f.store.mutate(d=>{const values={name:'专门功能',author:'ONE',description:'合成验收',instructions:'不得执行',limitations:'合成资料',integration:'question_answer' as const,modelId:'special',usageMultiplier:mode==='approval'?3:.6};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'restricted',revision:1,draft:values,status:mode==='paused'?'paused':'approved',current:version,history:[version],release:{id:'restricted-release',version:1,userIds:[mode==='foreign'?'b':'a'],publishedAt:'now',publishedBy:'a'}}];});
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('未分派，先检查可用范围。'):{...answer(''),toolCalls:[{id:'denied',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'隔离检查',instruction:'只做合成检查',executorId:'general',featureIds:['restricted']})}}]});
  const dispatch=()=>f.service.dispatch(a,input(`operation_single_restrict_${mode}`,'新建合成检查'),key);
  if(mode==='approval')await assert.rejects(dispatch,/超过你的 2 倍门槛/);else await dispatch();
  assert.equal((await f.store.read()).chatOperations!.filter(op=>op.workRun).length,0,mode);
 }
});
test('one request runs two tasks concurrently and briefs their durable results while idle, once',async()=>{
 const f=fixture();
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('两项已安排'):{...answer(''),toolCalls:[{id:'batch',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:['逻辑分析','写作草稿'].map(title=>({taskId:null,title,instruction:`只做${title}`,executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]}))})}}]});
 let started=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);f.setWorker(async()=>{started++;await gate;return answer(JSON.stringify({outcome:'completed',content:'可核对的独立成果',summary:'成果已返回'}));});
 const reply=await f.service.dispatch(a,input('operation_batch_two_001','分析和独立草稿同时做'),key);
 assert.equal(reply.taskIds.length,2);await f.service.resume(a,key);await waitFor(async()=>started===2);release();
 await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===2);
 const completed=await f.service.state(a);assert.match(completed.conversation!.messages.map(m=>m.content).join('\n'),/逻辑分析.*已完成/);assert.match(completed.conversation!.messages.map(m=>m.content).join('\n'),/写作草稿.*已完成/);
 f.setRoute(messages=>{assert.ok(!messages.some(m=>m.content?.startsWith('刚返回、尚未向用户汇报')));return answer('两项任务完成了。');});
 await f.service.dispatch(a,input('operation_batch_follow_01','现在做了吗？'),key);
 const state=await f.service.state(a);assert.equal(state.notices.length,2);assert.ok(state.notices.every(n=>n.reported&&!n.read));
 await f.service.report(a,state.notices.map(n=>n.id),key);assert.equal((await f.service.state(a)).conversation!.messages.length,state.conversation!.messages.length);
 await f.service.acknowledge(a,state.notices.map(n=>n.id));assert.equal((await f.service.state(a)).notices.length,0);
});

test('results arriving during a busy answer merge into that reply, including reviewed and unfinished work, without another model call',async()=>{
  const f=fixture();let releaseFirst!:()=>void,releaseSecond!:()=>void;
  const firstGate=new Promise<void>(resolve=>releaseFirst=resolve),secondGate=new Promise<void>(resolve=>releaseSecond=resolve);
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已经安排，结果会留在侧栏'):{...answer(''),toolCalls:[{id:'feedback-tasks',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:['先完成的方案','稍后完成的核算'].map((title,i)=>({taskId:null,title,instruction:`只做FEEDBACK_${i}`,executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]}))})}}]});
  f.setWorker(async messages=>{
    if(messages.at(-1)?.content?.includes('FEEDBACK_1')){await secondGate;return answer(JSON.stringify({outcome:'needs_input',content:'还缺活动日期。请补充活动是哪一天，再继续整理。',summary:'还缺活动日期。请补充活动是哪一天。'}));}
    await firstGate;return answer(JSON.stringify({outcome:'completed',content:'实际成果',summary:'方案正文做好了。'}));
  });
  const initial=await f.service.dispatch(a,input('operation_quiet_feedback_01','两项同时做'),key);
  await f.service.resume(a,key);
  const before=(await f.service.state(a)).conversation!.messages.length;
  let releaseAnswer!:(r:ToolChatResult)=>void, modelStarted!:()=>void;
  const answerGate=new Promise<ToolChatResult>(resolve=>releaseAnswer=resolve),started=new Promise<void>(resolve=>modelStarted=resolve);
  const follow=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async(_model,messages)=>{
    assert.ok(!messages.some(m=>m.content?.startsWith('刚返回、尚未向用户汇报')),'neither worker has finished when the reply begins');
    assert.match(messages[0].content!,/熟悉搭档/);
    modelStarted();return answerGate;
  }});
  const pending=follow.dispatch(a,input('operation_quiet_follow_01','今天怎么样？只聊聊，不执行。'),key);
  await started;
  releaseFirst();await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===1);
  for(let i=0;i<3;i++)assert.equal((await f.service.state(a)).conversation!.messages.length,before+1,'while answering, task polling cannot insert a competing reply');
  const read=await f.service.acknowledgeAll(a,key);assert.equal(read.count,1);
  releaseSecond();await waitFor(async()=>(await f.store.read()).chatOperations!.some(o=>o.workRun?.resultOutcome==='needs_input'));
  releaseAnswer(answer('挺好的。'));
  const reply=await pending;
  assert.match(reply.message.content,/先完成的方案/);assert.match(reply.message.content,/稍后完成的核算/);assert.match(reply.message.content,/还缺活动日期|请补充活动是哪一天/);
  const db=await f.store.read(),first=db.chatOperations!.find(o=>o.conversationId===initial.taskIds[0]&&o.workRun)!,second=db.chatOperations!.find(o=>o.conversationId===initial.taskIds[1]&&o.workRun)!;
  assert.ok(first.workRun!.reportedToCoordinatorAt);assert.equal(first.workRun!.unread,false);
  assert.ok(second.workRun!.reportedToCoordinatorAt);assert.equal(second.workRun!.unread,true);
  const snapshot=await follow.state(a);
  assert.deepEqual(snapshot.recentReportedReceiptIds.sort(),[first.id,second.id].sort());
  assert.deepEqual(snapshot.notices.map(n=>n.id),[second.id]);
  f.setRoute(messages=>{assert.ok(!messages.some(m=>m.content?.startsWith('刚返回、尚未向用户汇报')));return answer('继续聊。');});
  const after=await f.service.dispatch(a,input('operation_quiet_after_001','再聊两句，不执行'),key);
  assert.doesNotMatch(after.message.content,/稍后完成的核算/);
  assert.equal((await f.store.read()).chatOperations!.find(o=>o.id===second.id)!.workRun!.reportMessageId,reply.message.id);
});

test('batch workers receive only their own handoff while exact source messages stay in durable history',async()=>{
 const f=fixture(),original='一口气安排：画一张蓝色机器人图片；核算 3 件×12.5 元加 2 件×8 元；写 80 字以内的热茶短文。只用公开测试素材，不查知识库，不联网。';
 const tasks=[
  {taskId:null,title:'本轮核算',instruction:'只核算 3 件×12.5 元加 2 件×8 元，返回分项和 53.5 元合计，不处理图片或短文。',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
  {taskId:null,title:'本轮短文',instruction:'只写 80 字以内的热茶短文，使用公开素材，不查知识库，不联网，不处理图片或核算。',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
 ];
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('两件独立文字任务已排队'):{...answer(''),toolCalls:[{id:'strict-scope-batch',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks})}}]});
 f.setWorker(async messages=>{
  const scopeMessage=messages.find(m=>m.role==='system'&&m.content?.startsWith('当前任务参考：'))!;
  assert.ok(scopeMessage);assert.match(messages[0].content!,/不重做或总结其他任务/);
  assert.match(messages[0].content!,/不因缺少其他任务的工具虚构缺项/);
  assert.match(messages[0].content!,/结果封套只写最外层/);
  const scope=JSON.parse(scopeMessage.content!.split('\n')[0].slice('当前任务参考：'.length));
  const task=tasks.find(t=>t.title===scope.title)!;assert.ok(task);
  assert.equal(scope.expectedOutput,'text');assert.equal(JSON.stringify(messages).split(task.instruction).length-1,1,'current handoff is not duplicated in system and user');
  assert.equal(messages.at(-1)!.content,`本轮交接：${task.instruction}`);
  assert.doesNotMatch(JSON.stringify(messages),/一口气安排|蓝色机器人/);
  assert.ok(!messages.some(message=>message.content?.includes(tasks.find(t=>t.title!==scope.title)!.instruction)));
  return answer(JSON.stringify({outcome:'completed',content:scope.title==='本轮短文'?'忙完一天，捧起热茶，暖意缓缓散开。':'37.5＋16＝53.5 元。',summary:'只返回当前任务的成果'}));
 });
 const reply=await f.service.dispatch(a,input('operation_child_scope_01',original),key);
 await f.service.resume(a,key);await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===2);
 const db=await f.store.read();assert.equal(reply.taskIds.length,2);
 for(const id of reply.taskIds){
  const task=db.conversations.find(c=>c.id===id)!;assert.equal(task.messages.find(m=>m.role==='user')!.content,original);
  const result=task.messages.find(m=>m.role==='assistant')!.content;assert.doesNotMatch(result,/图片|其他任务|\"outcome\"/);
  assert.equal(db.chatOperations!.find(o=>o.conversationId===id&&o.workRun)!.workRun!.resultOutcome,'completed');
 }
 // A follow-up may use the previous task's actual answer and ordinary
 // discussion, but must not reintroduce that round's multi-goal source text.
 const shortId=reply.taskIds.find(id=>db.conversations.find(c=>c.id===id)!.title==='本轮短文')!;
 await f.store.mutate(d=>{d.conversations.find(c=>c.id===shortId)!.messages.unshift({id:'ordinary-task-discussion',role:'user',content:'独立讨论：语气温暖，不要华丽辞藻。',createdAt:'fixture-before-work'});});
 f.setWorker(async messages=>{
  assert.doesNotMatch(JSON.stringify(messages),/一口气安排|蓝色机器人/);
  assert.ok(messages.some(message=>message.role==='user'&&message.content===`本轮交接：${tasks[1].instruction}`));
  assert.ok(messages.some(message=>message.content==='独立讨论：语气温暖，不要华丽辞藻。'));
  assert.ok(messages.some(message=>message.content==='忙完一天，捧起热茶，暖意缓缓散开。'));
  assert.equal(messages.at(-1)!.content,'本轮交接：只把热茶短文改得更口语，不处理其他事情。');
  return answer(JSON.stringify({outcome:'completed',content:'忙完了，喝口热茶，慢慢歇一歇。',summary:'仅修改热茶短文'}));
 });
 await f.service.direct(a,shortId,{operationId:'operation_child_scope_follow_01',text:'只把热茶短文改得更口语，不处理其他事情。'},key);
 await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,shortId)).jobs.at(-1)!.state==='completed');
 assert.equal((await f.service.task(a,shortId)).conversation.messages.find(m=>m.id===(db.chatOperations!.find(o=>o.conversationId===shortId&&o.workRun)!.workRun!.inputMessageId))!.content,original);
});

test('explicit retry sends the saved narrow handoff rather than the multi-goal original',async()=>{
 const f=fixture(),original='批次原话：创建蓝色机器人图，算订单金额，再写热茶短文。',instruction='只写 80 字以内的热茶短文，不处理其他任务。';
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('短文已单独排队'):{...answer(''),toolCalls:[{id:'narrow-retry',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'只写热茶短文',instruction,executorId:'general'})}}]});
 f.setWorker(async()=>{throw new Error('synthetic controlled provider failure');});
 const reply=await f.service.dispatch(a,input('operation_child_scope_retry_01',original),key);
 await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs[0].state==='failed');
 const source=(await f.service.task(a,reply.taskId!)).jobs[0];
 assert.equal(source.instruction,instruction);
 f.setWorker(async messages=>{
  assert.equal(messages.at(-1)!.content,`本轮交接：${instruction}`);
  assert.doesNotMatch(JSON.stringify(messages),/批次原话|蓝色机器人|订单金额/);
  return answer(JSON.stringify({outcome:'completed',content:'一杯热茶，替忙碌的一天收个温柔的尾。',summary:'本轮短文已返回'}));
 });
 await f.service.retryLatest(a,reply.taskId!,source.id,undefined,key);await f.service.resume(a,key);
 await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs.at(-1)!.state==='completed');
 const detail=await f.service.task(a,reply.taskId!);assert.equal(detail.jobs.length,2);
 assert.equal(detail.conversation.messages.filter(m=>m.role==='user'&&m.content===original).length,2);
 assert.equal((await f.store.read()).chatOperations!.filter(o=>o.conversationId===reply.taskId&&o.workRun).every(o=>o.workRun!.instruction===instruction),true);
});

test('legacy drawing routes to actual images; an unavailable image blocks the whole proposed batch',async()=>{
 const f=await imageFixture(async()=>({content:'图片',imageUrl:imageFixturePng}));let worker=0;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{artifactDirectory:f.directory,imageCall:async()=>({content:'图片',imageUrl:imageFixturePng}),modelCall:async(model,messages)=>{if(model.id!=='router'){worker++;return answer('没有绘图能力');}return messages.at(-1)?.role==='tool'?answer('绘图已安排'):{...answer(''),toolCalls:[{id:'old-draw',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'绘制奥特曼大战孙悟空',instruction:'生成奥特曼大战孙悟空图片',executorId:'general'})}}]};}});
 try{
  const reply=await service.dispatch(a,input('operation_real_draw_001','画奥特曼大战孙悟空'),key);await service.resume(a,key);await waitFor(async()=>(await f.store.read()).chatOperations!.some(o=>o.workRun?.state==='completed'));assert.equal(worker,0);assert.ok((await f.store.read()).conversations.find(c=>c.id===reply.taskIds[0])!.messages.some(m=>m.imageUrl));
  await f.store.mutate(d=>{d.settings.aiTasks!.image_generation!.published!.modelId='missing';});const before=(await f.store.read()).chatOperations!.filter(o=>o.workRun).length;
  const denied=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{artifactDirectory:f.directory,modelCall:async()=>({...answer(''),toolCalls:[{id:'bad-batch',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'表',instruction:'战力表',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},{taskId:null,title:'图',instruction:'图片',executorId:'image_generation',outputKind:'image',featureIds:[],dependsOn:[]}]})}}]})});
  const blocked=await denied.dispatch(a,input('operation_no_image_batch','图和表都做'),key);assert.match(blocked.message.content,/还没接上|没能开始|中断/);assert.equal(blocked.taskIds.length,0);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,before);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('worker independently invokes two priced features; third unused feature costs zero and repeated tool result is reused',async()=>{
  const f=fixture();
  await f.store.mutate(d=>{
    d.settings.officialFeatures=[1,1.2,.6].map((rate,i)=>{
      const values={name:`功能${i}`,author:'ONE',description:'分开处理明确部分',instructions:`feature-body-${i}`,limitations:'只读',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:rate};
      const version={version:1,values,evidence:'合成测试',approvedBy:'a',approvedAt:'now'};
      return {id:`priced-${i}`,revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:`release-${i}`,version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}};
    });
    d.models.forEach(m=>{m.pricing={version:1,label:'基础',publishedAt:'now',multiplier:.6,referenceInput:2,referenceOutput:4};});
  });
  let parentCalls=0;
  f.setWorker(async messages=>{
    if(messages[0].content?.includes('feature-body-'))return answer('独立功能成果');
    parentCalls++;
    if(parentCalls===1)return {...answer(''),toolCalls:[0,1].map(i=>({id:`feature-call-${i}`,type:'function' as const,function:{name:`feature_${i}`,arguments:JSON.stringify({query:`只处理第${i}部分`})}}))};
    if(parentCalls===2)return {...answer(''),toolCalls:[{id:'feature-reuse',type:'function',function:{name:'feature_0',arguments:JSON.stringify({query:'只处理第0部分'})}}]};
    return answer('汇总完成');
  });
  const result=await f.service.dispatch(a,{...input('operation_features_sum_01','分开完成任务'),featureIds:['priced-0','priced-1','priced-2'],confirmedExternal:true},key);
  await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,result.taskId!)).jobs[0].state==='completed');
  const db=await f.store.read(),featureRows=db.modelUsageRecords.filter(r=>r.featurePriceSnapshot);
  assert.deepEqual(featureRows.map(r=>r.chargedMicros),[60,72]);
  assert.deepEqual(featureRows.map(r=>r.featurePriceSnapshot!.id),['priced-0','priced-1']);
  assert.equal(db.powerAccounts[0].balanceMicros,100e6-db.modelUsageRecords.reduce((n,r)=>n+(r.chargedMicros??0),0));
  assert.equal(db.powerAccounts[1].balanceMicros,100e6);
  const detail=await f.service.task(a,result.taskId!);assert.equal(detail.jobs[0].charges.filter(c=>c.feature).length,2);
  await f.service.resume(a,key);assert.equal((await f.store.read()).modelUsageRecords.filter(r=>r.featurePriceSnapshot).length,2);
});

test('one task composes two priced features and each executes three distinct calculation calls',async()=>{
  const f=fixture();
  await f.store.mutate(d=>{d.settings.officialFeatures=['profit','promotion'].map((operation,i)=>{
    const values={name:`测算${i}`,author:'ONE',description:'根据合成数据测算',instructions:`batch-calculation-${operation}`,limitations:'只用用户数据',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:'oneFinance',description:'执行真实金额测算'}]};
    const version={version:1,values,evidence:'合成测试',approvedBy:'a',approvedAt:'now'};
    return{id:`batch-${i}`,revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:`batch-release-${i}`,version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}};
  });});
  const returned:Record<string,number[]>={};
  f.setWorker(async messages=>{
    const instructions=messages[0].content||'',operation=instructions.includes('batch-calculation-profit')?'profit':instructions.includes('batch-calculation-promotion')?'promotion':undefined;
    if(operation){
      if(messages.at(-1)?.role==='tool'){
        returned[operation]=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content!)[operation==='profit'?'operatingProfit':'campaignProfit']);
        return answer(JSON.stringify({outcome:'completed',content:`${operation}: ${returned[operation].join('/')}`,summary:'三组结果已返回'}));
      }
      return {...answer(''),toolCalls:(operation==='profit'?[4,6,10]:[0,2.5,10]).map((n,index)=>({id:`${operation}-${index}`,type:'function' as const,function:{name:'oneFinance',arguments:JSON.stringify({operation,dataJson:JSON.stringify(operation==='profit'?{revenue:n*50,variableCost:n*15,fixedCost:120,quantity:n}:{price:50,discount:n,variableCost:15,giftCost:0,channelRate:0,fixedCampaignCost:120,participants:6})})}}))};
    }
    if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[0,1].map(i=>({id:`batch-part-${i}`,type:'function' as const,function:{name:`feature_${i}`,arguments:JSON.stringify({query:'完成本功能的三组计算'})}}))};
    return answer(JSON.stringify({outcome:'completed',content:'利润20/90/230；优惠90/75/30。',summary:'两部分都好了'}));
  });
  const reply=await f.service.dispatch(a,{...input('operation_two_feature_batch','做利润和优惠测算'),featureIds:['batch-0','batch-1'],confirmedExternal:true},key);
  await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs[0].state==='completed');
  assert.deepEqual(returned,{profit:[20,90,230],promotion:[90,75,30]});
  const db=await f.store.read(),op=db.chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!;
  assert.equal(op.workRun!.steps!.filter(step=>step.tool==='oneFinance'&&step.state==='completed'&&step.effect==='read').length,6);
  assert.equal(op.workRun!.steps!.filter(step=>step.namespace==='worker'&&step.state==='completed').length,2);
  assert.equal(db.powerAccounts[1].balanceMicros,100e6);await assert.rejects(()=>f.service.task(b,reply.taskId!));
  assert.match((await f.service.task(a,reply.taskId!)).conversation.messages.at(-1)!.content,/20\/90\/230/);
});

test('legacy assistant restrictions remain enforced before accepting or charging a task supplement',async()=>{
 const f=fixture(),stamp=new Date().toISOString();
 await f.store.mutate(d=>{
  d.agents=[{id:'private-agent',workspaceId:a.workspaceId,ownerId:a.userId,published:false,allowFileUpload:false,allowImageInput:false,allowWebSearch:false,prompt:'个人分身指令'} as Database['agents'][number]];
  d.conversations.push({...a,id:'legacy-agent',agentId:'private-agent',title:'UI 个人分身',modelId:'worker',archived:false,messages:[],createdAt:stamp,updatedAt:stamp});
  d.attachments.push({...a,id:'own-file',kind:'text',mimeType:'text/plain',originalName:'说明.txt',storagePath:'/fixture-only',size:20,extractedText:'资料',status:'ready',createdAt:stamp});
 });
 await assert.rejects(()=>f.service.direct(a,'legacy-agent',{operationId:'operation_agent_file_1',text:'看看资料',attachmentIds:['own-file']},key),/未开放附件/);
 assert.equal(f.calls.length,0);assert.equal((await f.store.read()).chatOperations?.length,0);
 const result=await f.service.direct(a,'legacy-agent',{operationId:'operation_agent_text_1',text:'继续 UI'},key);
 await f.service.resume(a,key);
 await waitFor(async()=>(await f.service.task(a,result.taskId)).jobs[0].state==='completed');
 assert.match(JSON.stringify(f.calls),/个人分身指令/);
});

test('legacy continuation preserves original history and attached file handoff is scoped and survives restart views',async()=>{
 const f=fixture();const stamp=new Date().toISOString();
 await f.store.mutate(d=>{d.conversations.push({...a,id:'legacy',title:'旧 UI',modelId:'worker',messages:[{id:'legacy-user',role:'user',content:'之前的完整原话',createdAt:stamp},{id:'legacy-answer',role:'assistant',content:'之前的成果',createdAt:stamp}],archived:false,createdAt:stamp,updatedAt:stamp});d.attachments.push({...a,id:'own-file',kind:'text',mimeType:'text/plain',originalName:'说明.txt',storagePath:'/fixture-only',size:20,extractedText:'独立输入框和不打断注意力',status:'ready',createdAt:stamp},{...b,id:'foreign-file',kind:'text',mimeType:'text/plain',originalName:'秘密.txt',storagePath:'/foreign',size:20,extractedText:'不能读取',status:'ready',createdAt:stamp});});
 await assert.rejects(()=>f.service.dispatch(a,{...input('operation_foreign_f','UI'),attachmentIds:['foreign-file']},key));assert.equal(f.calls.length,0);
 const r=await f.service.dispatch(a,{...input('operation_attach_ok','UI 看看附件'),boundTaskId:'legacy',attachmentIds:['own-file']},key);
 assert.equal(r.taskId,'legacy');const queued=await f.store.read();assert.ok(queued.messages.some(m=>m.id==='legacy-user'));assert.ok(queued.attachments.find(a=>a.id==='own-file')!.sharedConversationIds?.includes('legacy'));
 assert.equal(f.calls.find(c=>c.modelId==='router')!.requiredTool,'delegate_task','new attachments require delegation without pretending to read them');
 assert.equal(f.calls.filter(c=>c.modelId==='router').at(-1)!.requiredTool,undefined,'acknowledgement must not dispatch again');
 await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,'legacy')).jobs[0].state==='completed');
 const call=f.calls.find(c=>c.modelId==='worker')!;assert.match(call.messages[0].content!,/独立任务/);assert.match(JSON.stringify(call.messages),/之前的完整原话|之前的成果/);assert.doesNotMatch(JSON.stringify(call.messages),/不能读取/);
});

test('on-disk restart restores executor configuration, task originals and unstarted queue',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_disk_0001','UI 原话'),key),db=await f.store.read();
 const p=updateExecutor(db,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'磁盘保存模板'}});
 updateExecutor(db,'a',p.id,{revision:1,action:'publish'});
 for(const user of db.users)user.defaultWorkspaceId=user.id==='a'?'wa':'wb';
 const directory=mkdtempSync(path.join(tmpdir(),'one-execution-restart-'));
 try{
  writeFileSync(path.join(directory,'db.json'),JSON.stringify(db));
  const script=`const {store}=await import('./server/db.ts');const d=await store.read();console.log(JSON.stringify({profile:d.settings.executorProfiles[0].published.name,task:d.conversations.find(c=>c.id===${JSON.stringify(r.taskId)}),job:d.chatOperations.find(o=>o.workRun).workRun.state}));`;
  for(let n=0;n<2;n++){
   const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,DB_PROVIDER:'json',ONE_DATA_DIR:directory,NODE_ENV:'test',PROVIDER_CREDENTIALS_KEY:'fixture-only-encryption-key-32-characters'},encoding:'utf8',timeout:15000});
   assert.equal(result.status,0,result.stderr);const restored=JSON.parse(result.stdout.trim());assert.equal(restored.profile,'磁盘保存模板');assert.equal(restored.job,'queued');assert.equal(restored.task.executorProfileId,'general');assert.equal(restored.task.messages[0].content,'UI 原话');
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('truncated task output is not a completed result; own trace preserves actual input',async()=>{
 const f=fixture();f.setWorker(async()=>({...answer('不完整成果'),finishReason:'length'}));
 const r=await f.service.dispatch(a,input('operation_truncate_1','UI'),key);await f.service.resume(a,key);
 await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[0].state==='failed');
 const task=await f.service.task(a,r.taskId!),partial=task.conversation.messages.filter(m=>m.role==='assistant');
 assert.equal(partial.length,1);assert.match(partial[0].content,/不完整成果/);assert.match(partial[0].content,/本轮未完成/);
 assert.equal(partial[0].finishReason,'length');assert.equal(task.jobs[0].resultMessageId,partial[0].id);
 assert.equal(task.conversation.workPaused,true);assert.match(task.jobs[0].error!,/上游输出达到本轮限额/);
 const db=await f.store.read(),trace=db.contextTraces.find(t=>t.conversationId===r.taskId)!;
 assert.equal(trace.workspaceId,a.workspaceId);assert.match(JSON.stringify(trace.sections),/本轮交接|用户原话/);
 assert.equal(db.contextTraces.filter(t=>t.workspaceId===b.workspaceId).length,0);
 assert.equal(db.chatOperations!.find(o=>o.conversationId===r.taskId&&o.workRun)!.workRun!.resultOutcome,'partial');
 const calls=f.calls.length;await f.service.resume(a,key);assert.equal(f.calls.length,calls,'partial output never auto-runs again');
});

const a = { workspaceId: "wa", userId: "a" },
  b = { workspaceId: "wb", userId: "b" };

test('stopping a pending reply is scoped, preserves original words and rejects late delegation',async()=>{
 const f=fixture();let release!:(r:ToolChatResult)=>void;
 const blocked=new Promise<ToolChatResult>(resolve=>{release=resolve;});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async()=>blocked});
 const operationId='operation_stop_reply_001';
 const running=service.dispatch(a,input(operationId,'想想活动方案'),key);
 const rejected=assert.rejects(running,/已停止/);
 await waitFor(async()=>service.currentProgress(a,operationId)?.phase==='正在等待模型回答');
 assert.equal(service.currentProgress(b,operationId),undefined);
 await assert.rejects(()=>service.cancel(b,operationId,key),/不存在/);
 await service.cancel(a,operationId,key);
 release({...answer(''),toolCalls:[{id:'late',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'不能分派',instruction:'不能执行',executorId:'general'})}}]});
 await rejected;
 const db=await f.store.read();assert.equal(db.chatOperations?.find(o=>o.operationId===operationId)?.status,'interrupted');
 assert.equal(db.chatOperations?.filter(o=>o.workRun).length,0);
 assert.equal(db.conversations.find(c=>c.coordinatorMain)!.messages.length,1);
 assert.equal(db.conversations[0].messages[0].content,'想想活动方案');
 assert.equal(service.currentProgress(a,operationId),undefined);
});
test('task stop cancels queued work and late worker output without touching another owner',async()=>{
 const f=fixture();const task=await f.service.dispatch(a,input('operation_cancel_work_001','UI'),key);
 await assert.rejects(()=>f.service.cancelTask(b,task.taskId!,key),/不存在/);
 let release!:(r:ToolChatResult)=>void;f.setWorker(async()=>new Promise(resolve=>{release=resolve;}));
 await f.service.resume(a,key);await waitFor(async()=>Boolean(release));
 await f.service.cancelTask(a,task.taskId!,key);release(answer('晚到的成果，不得写入'));
 await new Promise(resolve=>setTimeout(resolve,30));
 const detail=await f.service.task(a,task.taskId!);assert.equal(detail.jobs[0].state,'cancelled');
 assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,0);
 const queued=await f.service.dispatch(a,input('operation_cancel_queue_01','露营'),key);
 await f.service.cancelTask(a,queued.taskId!,key);await f.service.resume(a,key);
 assert.equal((await f.service.task(a,queued.taskId!)).jobs[0].state,'cancelled');
});
const answer = (content: string): ToolChatResult => ({
  content,
  finishReason: "stop",
  toolCalls: [],
  usage: {
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    source: "provider",
  },
});
function fixture() {
  const models = ["router", "worker", "special"].map(
    (id) =>
      ({
        id,
        name: id,
        enabled: true,
        kind: "chat",
        apiKey: "fixture-only",
        systemPrompt: "",
        isDefault: id === "worker",
        inputPowerPerMillion: 1,
        outputPowerPerMillion: 1,
        costInputPowerPerMillion: 1,
        costOutputPowerPerMillion: 1,
      }) as ModelConfig,
  );
  let db = {
    users: [
      { id: "a", enabled: true, role: "admin" },
      { id: "b", enabled: true, role: "user" },
    ],
    workspaces: [
      { id: "wa", status: "active" },
      { id: "wb", status: "active" },
    ],
    workspaceMembers: [
      { workspaceId: "wa", userId: "a" },
      { workspaceId: "wb", userId: "b" },
    ],
    models,
    settings: { safetyRules: "fixed-safety", rechargeCnyPerPower: 7 },
    conversations: [],
    messages: [],
    chatOperations: [],
    knowledgeConnections: [],
    auditLogs: [],
    contextTraces: [],
    modelUsageRecords: [],
    powerAccounts: [a, b].map((s) => ({
      ...s,
      id: s.userId,
      balanceMicros: 100e6,
      reservedMicros: 0,
    })),
    powerLedger: [],
    attachments: [],
  } as unknown as Database;
  updateTaskConfig(
    db.settings,
    models,
    "coordinator",
    {
      revision: 0,
      action: "draft",
      values: {
        ...defaultTaskValues("coordinator"),
        modelId: "router",
        enabled: true,
      },
    },
    "a",
    "now",
  );
  updateTaskConfig(
    db.settings,
    models,
    "coordinator",
    { revision: 1, action: "publish" },
    "a",
    "now",
  );
  updateTaskConfig(
    db.settings,
    models,
    "task_worker",
    {
      revision: 0,
      action: "draft",
      values: { ...defaultTaskValues("task_worker"), modelId: "worker" },
    },
    "a",
    "now",
  );
  updateTaskConfig(
    db.settings,
    models,
    "task_worker",
    { revision: 1, action: "publish" },
    "a",
    "now",
  );
  let chain = Promise.resolve();
  const store = {
    read: async () => structuredClone(db),
    mutate: <T>(fn: (db: Database) => T) => {
      const next = chain.then(() => {
        const draft = structuredClone(db),
          result = fn(draft);
        db = draft;
        return result;
      });
      chain = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  } as Store;
  const calls: { modelId: string; messages: ModelToolMessage[]; tools: ModelToolDefinition[]; requiredTool?: string }[] = [],
    recalls: { ws: string; ids?: readonly string[] }[] = [];
  let workerHook:
      ((messages: ModelToolMessage[]) => Promise<ToolChatResult>) | undefined,
    routeHook: ((messages: ModelToolMessage[]) => ToolChatResult) | undefined;
  const service = new CoordinatorService(
    store,
    {
      recallWithDiagnostics: async (ws, _q, _k, ids) => {
        recalls.push({ ws, ids });
        return { chunks: [], failures: [], status: "no_match" };
      },
    },
    {
      modelCall: async (model, messages, tools, _requestId, options) => {
        calls.push({ modelId: model.id, messages: structuredClone(messages), tools: structuredClone(tools), requiredTool: options?.requiredTool });
        if (model.id !== "router")
          return workerHook
            ? workerHook(messages)
            : answer("真实合成模型返回的成果");
        if (routeHook) return routeHook(messages);
        if (messages.at(-1)?.role === "tool")
          return answer("已接住，交给这件事处理。");
        const current =
          messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
        if (current === "你好") return answer("我在。");
        if (!tools.length) return answer("没有分派工具。");
        const catalog = JSON.parse(messages.find(m=>m.content?.startsWith('本轮授权参考：'))!.content!.slice('本轮授权参考：'.length));
        const task =
          catalog.boundTaskId ||
          catalog.tasks.find((t: any) =>
            current.includes("露营")
              ? t.title.includes("露营")
              : t.title.includes("UI"),
          )?.id ||
          null;
        return {
          ...answer(""),
          toolCalls: [
            {
              id: "dispatch",
              type: "function",
              function: {
                name: "delegate_task",
                arguments: JSON.stringify({
                  taskId: task,
                  title: current.includes("露营") ? "露营安排" : "UI 设计",
                  instruction: `本轮交接 ${current}`,
                  executorId:
                    catalog.tasks.find((t: any) => t.id === task)?.executorId ??
                    "general",
                }),
              },
            },
          ],
        };
      },
    },
  );
  return {
    store,
    service,
    calls,
    recalls,
    setWorker: (fn: typeof workerHook) => (workerHook = fn),
    setRoute: (fn: typeof routeHook) => (routeHook = fn),
  };
}
const key = async () => {};

/** Full service-path fixture: only provider/model transports are synthetic.
 * Admission, workflow persistence, Notion ownership/readback, billing and HTML
 * file generation are the same implementations used by the live routes. */
async function workflowServiceFixture(options:{delayed?:boolean;noMatch?:boolean;twoSaves?:boolean;adaptiveDefault?:boolean;legacyChain?:boolean}={}){
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-workflow-service-'));
 const parentId='1'.repeat(32),pageId='2'.repeat(32),clock={now:Date.now()+1000};
 const source='ONE-WORKFLOW-SOURCE-青色42：插入入口后先找资料，再写完整方案。';
 const firstBody='ONE-WORKFLOW-DRAFT-青色42\n资料核对后形成完整方案。\n自然结尾。';
 const secondBody='ONE-WORKFLOW-REVISION-橙色17\n沿用同一页修订完整方案。\n第二次自然结尾。';
 const counts={retrieval:0,create:0,update:0,read:0,draft:0,feature:0};
 const calls:{modelId:string;messages:ModelToolMessage[];tools:ModelToolDefinition[]}[]=[];
 let body='',readbackReady=!options.delayed,legacyRound=0;
 await f.store.mutate(d=>{
  d.knowledgeConnections.push({id:'wf-source',workspaceId:a.workspaceId,provider:'getnote',status:'connected',clientId:'fixture-only',createdAt:'now',updatedAt:'now'} as any);
  d.knowledgeConnections.push({id:'wf-notion',workspaceId:a.workspaceId,provider:'notion',status:'connected',clientId:'fixture-only',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'wf-grant',userId:a.userId,authorizedAt:'now',parentId}});
  const values={name:'交互网页',author:'ONE',description:'把完整方案制成交互网页',instructions:'WORKFLOW_SERVICE_HTML: 将前置完整方案做成网页，调用 oneHtml 交付真实文件。',limitations:'仅合成私有资料',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:'oneHtml',description:'保存交互网页'}]};
  const version={version:1,values,evidence:'fixture',approvedBy:'a',approvedAt:'now'};
  d.settings.officialFeatures=[{id:'oneHtml',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'wf-html-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}];
 });
 const steps:import('./taskWorkflow.js').WorkflowStep[]=[
  {id:'source',title:'查找实际资料',kind:'tool',tool:'knowledge_search',instruction:'查找 ONE-WORKFLOW-SOURCE 青色42 的入口方案资料',inputs:[]},
  {id:'draft',title:'写完整方案',kind:'model',executorId:'general',instruction:'依据已取得资料写出完整方案，保留青色42。',inputs:['source']},
  {id:'save',title:'保存并核对原文',kind:'notion',instruction:'把前置完整方案保存到已选Notion位置并回读。',inputs:['draft']},
  ...(options.twoSaves?[
   {id:'revise',title:'修订完整方案',kind:'model' as const,executorId:'general',instruction:'把青色42改成橙色17，交付修订后的完整正文。',inputs:['source','draft','save']},
   {id:'save_again',title:'更新同一页面',kind:'notion' as const,instruction:'更新原页面并回读，不新建另一篇。',inputs:['revise']},
  ]:[]),
  {id:'html',title:'制作真实交互网页',kind:'feature',featureId:'oneHtml',instruction:'把前置完整方案制成交互网页，保留正文中的标记和已保存入口。',inputs:options.twoSaves?['revise','save_again']:['draft','save']},
 ];
 const mcp={
  readDocument:async(ws:string,id:string)=>{assert.equal(ws,a.workspaceId);assert.ok([parentId,pageId].includes(id));if(id===parentId)return {text:'合成保存目录'};counts.read++;if(!readbackReady)throw Error('synthetic eventual readback');return {text:body};},
  callDocumentTool:async(ws:string,cid:string,grant:string,user:string,name:string,args:any,beforeSend?:()=>Promise<void>)=>{
   assert.deepEqual([ws,cid,grant,user],[a.workspaceId,'wf-notion','wf-grant',a.userId]);await beforeSend?.();
   if(name==='notion-create-pages'){counts.create++;assert.equal(args.parent.page_id,parentId);body=args.pages[0].content;return {pages:[{id:pageId}]};}
   assert.equal(name,'notion-update-page');assert.equal(args.page_id,pageId);counts.update++;
   for(const update of args.content_updates){assert.equal(update.old_str,body,'each revision replaces the latest verified full body');body=body.replace(update.old_str,update.new_str);}return {};
  },
 } as unknown as NotionMcpService;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async(ws,query,_top,ids,user)=>{
  counts.retrieval++;assert.equal(ws,a.workspaceId);assert.equal(user,a.userId);assert.deepEqual(ids,['wf-source']);assert.match(query,/青色42|ONE-WORKFLOW/);
  return {status:options.noMatch?'no_match':'used',chunks:options.noMatch?[]:[{id:'wf-source-body',provider:'getnote',title:'入口方案',content:source}],failures:[],coverage:[{connectionId:'wf-source',provider:'getnote',status:options.noMatch?'no_match':'used',attempts:1}]};
 }},{artifactDirectory:directory,contextMode:options.adaptiveDefault?'adaptive':'legacy',notionDocuments:new NotionDocuments(f.store,mcp,{now:()=>clock.now,delays:[5,10]}),reportCall:async()=>assert.fail('workflow does not buy an extra progress-summary model'),modelCall:async(model,messages,tools)=>{
  calls.push({modelId:model.id,messages:structuredClone(messages),tools:structuredClone(tools)});
  if(model.id==='router'){
   if(messages.at(-1)?.role==='tool'&&!messages.at(-1)?.content?.includes('"status":"loaded"'))return answer('开始处理。');
   if(!tools.some(tool=>tool.function.name==='delegate_task'))return {...answer(''),toolCalls:[{id:'load-dispatch',type:'function',function:{name:'load_tools',arguments:JSON.stringify({names:['delegate_task']})}}]};
   return {...answer(''),toolCalls:[{id:'workflow-plan',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'青色42完整方案',instruction:'从得到大脑查找 ONE-WORKFLOW-SOURCE 青色42 入口方案，依据实际资料写完整方案并保存到 Notion，随后做成交互网页。',executorId:'general',featureIds:['oneHtml'],...(options.adaptiveDefault||options.legacyChain?{}:{workflow:{version:1,steps}})})}}]};
  }
  if(model.id==='special'){
   counts.feature++;if(messages.at(-1)?.role==='tool')return answer('本功能要求的网页文件已经做好。');assert.equal(counts.feature,1,'the feature must not regenerate an existing HTML file');assert.deepEqual(tools.map(tool=>tool.function.name),['oneHtml']);
   const finalBody=options.twoSaves?secondBody:firstBody;assert.ok(JSON.stringify(messages).includes(finalBody.split('\n')[0]));assert.ok(JSON.stringify(messages).includes(pageId),'HTML receives the real saved page, not an invented link');
   const scene={id:'read',title:'找资料',situation:'需要完成方案',feature:'查询已连接资料',advantage:'资料与输出连贯',benefit:'得到可核对方案',evidence:source,steps:['查找入口方案','核对原文'],prompt:'青色42入口方案',capabilityIds:[]};
   return {...answer(''),toolCalls:[{id:'real-html',type:'function',function:{name:'oneHtml',arguments:JSON.stringify({version:1,title:finalBody.split('\n')[0],intro:'已保存完整方案的交互说明',scenes:[scene,{...scene,id:'deliver',title:'拿到完整成果',evidence:`Notion 原稿 https://www.notion.so/${pageId}`} ]})}}]};
  }
  if(options.legacyChain){
   legacyRound++;const invoke=(name:string,args:unknown)=>({...answer(''),toolCalls:[{id:`legacy-step-${legacyRound}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]});
   if(legacyRound===1)return invoke('knowledge_search',{query:'ONE-WORKFLOW-SOURCE 青色42入口方案'});
   assert.ok(JSON.stringify(messages).includes(source));
   if(legacyRound===2){counts.draft++;return invoke('save_notion_draft',{title:'青色42完整方案',content:firstBody,final:true});}
   if(legacyRound===3)return invoke('feature_0',{query:`把前置完整正文做成交互网页：\n${firstBody}\n已保存原稿：https://www.notion.so/${pageId}`});
   assert.equal(legacyRound,4);return answer(JSON.stringify({outcome:'completed',content:'完整方案和交互网页已做好。',summary:'完整方案和网页都已完成。'}));
  }
  counts.draft++;assert.deepEqual(tools,[]);assert.ok(JSON.stringify(messages).includes(source),'model receives the actual source body');
  if(counts.draft>1){assert.ok(options.twoSaves);assert.ok(JSON.stringify(messages).includes(firstBody.split('\n')[0]));}
  return answer(JSON.stringify({outcome:'completed',content:counts.draft===1?firstBody:secondBody,summary:'完整方案已整理。'}));
 }});
 return {...f,service,directory,parentId,pageId,source,firstBody,secondBody,counts,calls,clock,body:()=>body,allowReadback:()=>{readbackReady=true;clock.now+=20;},metrics:()=>({counts:{...counts},executionModelCalls:calls.filter(call=>call.modelId!=='router').length,models:calls.map(call=>({model:call.modelId,messagesBytes:Buffer.byteLength(JSON.stringify(call.messages),'utf8'),toolsBytes:Buffer.byteLength(JSON.stringify(call.tools),'utf8')}))}),cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

for(const delayed of [false,true])test(`workflow service retrieval to model to Notion to real HTML; delayed readback=${delayed}`,async t=>{
 const f=await workflowServiceFixture({delayed});
 try{
  const result=await f.service.dispatch(a,{...input(`operation_workflow_chain_${delayed}`,'请从得到大脑查找青色42入口方案，写成完整方案保存到Notion并做交互网页。'),sourceIds:['wf-source'],featureIds:['oneHtml'],confirmedExternal:true,outputDestination:'notion'},key);
  assert.ok(result.taskId,'one deliverable task is actually admitted');await f.service.resume(a,key);
  await waitFor(async()=>{const d=await f.store.read();return d.chatOperations!.some(o=>o.workRun&&o.conversationId===result.taskId&&(delayed?o.workRun.failureCode==='notion_verification_pending':o.workRun.state==='completed'));});
  const before=await f.store.read(),original=before.chatOperations!.find(o=>o.workRun&&o.conversationId===result.taskId)!;
  if(delayed){
   assert.equal(f.counts.draft,1);assert.equal(f.counts.feature,0);assert.equal(f.counts.create,1);assert.equal(original.status,'pending');assert.equal((await f.service.state(a)).notices.length,0);
   f.allowReadback();await f.service.reconcileNotionResults(a,key);await f.service.resume(a,key);
   await waitFor(async()=>(await f.service.task(a,result.taskId!)).jobs[0].state==='completed');
  }
  const db=await f.store.read(),ops=db.chatOperations!.filter(o=>o.workRun&&o.conversationId===result.taskId),op=ops[0],detail=await f.service.task(a,result.taskId!);
  assert.equal(ops.length,1);assert.equal(op.id,original.id);assert.equal(op.workRun!.notionReceipt!.state,'verified');assert.equal(f.counts.retrieval,1);assert.equal(f.counts.draft,1);assert.equal(f.counts.create,1);assert.equal(f.counts.update,0);assert.equal(f.counts.feature,2);assert.equal(f.body(),f.firstBody);
  assert.ok(op.workRun!.workflow!.steps.every(step=>step.state==='completed'));assert.equal(detail.jobs[0].state,'completed');
  const files=db.attachments.filter(file=>file.conversationId===result.taskId);assert.equal(files.length,1);assert.match(files[0].originalName,/\.html$/);const html=readFileSync(files[0].storagePath,'utf8');assert.match(html,/ONE-WORKFLOW-DRAFT-青色42/);assert.match(html,new RegExp(f.pageId));assert.match(html,/<script>/);assert.ok(detail.conversation.messages.at(-1)!.attachments?.some(file=>file.id===files[0].id));
  const calls=f.calls.length;await f.service.resume(a,key);await f.service.reconcileNotionResults(a,key);assert.equal(f.calls.length,calls);assert.equal(f.counts.create,1);assert.equal((await f.store.read()).attachments.length,1);
  await assert.rejects(()=>f.service.task(b,result.taskId!));assert.equal((await f.store.read()).powerAccounts[1].balanceMicros,100e6);t.diagnostic(JSON.stringify(f.metrics()));
 }finally{f.cleanup();}
});

test('workflow service no_match asks for material in main conversation without drafting, writing or inventing a webpage',async t=>{
 const f=await workflowServiceFixture({noMatch:true});
 try{
  const r=await f.service.dispatch(a,{...input('operation_workflow_no_match','从得到大脑找青色42入口方案，写入Notion并做网页。'),sourceIds:['wf-source'],featureIds:['oneHtml'],confirmedExternal:true,outputDestination:'notion'},key);assert.ok(r.taskId);await f.service.resume(a,key);
  await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[0].state==='failed');
  const detail=await f.service.task(a,r.taskId!),db=await f.store.read(),run=db.chatOperations!.find(o=>o.workRun&&o.conversationId===r.taskId)!.workRun!;
  assert.equal(run.resultOutcome,'needs_input');assert.equal(run.workflow!.steps[0].state,'needs_input');assert.equal(run.workflow!.steps[1].state,'waiting');assert.equal(f.counts.retrieval,1);assert.equal(f.counts.draft,0);assert.equal(f.counts.create,0);assert.equal(f.counts.feature,0);assert.equal(db.attachments.length,0);assert.match(detail.conversation.messages.at(-1)!.content,/没有找到|补充/);
  const state=await f.service.state(a);assert.match(state.conversation!.messages.at(-1)!.content,/没有找到|补充/);assert.doesNotMatch(state.conversation!.messages.at(-1)!.content,/已全部完成|已保存到 Notion/);assert.equal(state.transfers.some(task=>task.id===r.taskId),false);
  await assert.rejects(()=>f.service.task(b,r.taskId!));t.diagnostic(JSON.stringify(f.metrics()));
 }finally{f.cleanup();}
});

test('workflow service second Notion save updates the same page using the newest verified body',async t=>{
 const f=await workflowServiceFixture({twoSaves:true});
 try{
  const r=await f.service.dispatch(a,{...input('operation_workflow_second_save','从得到大脑查找青色42入口方案，写完整方案保存Notion，随后同页修订为橙色17，再做交互网页。'),sourceIds:['wf-source'],featureIds:['oneHtml'],confirmedExternal:true,outputDestination:'notion'},key);assert.ok(r.taskId);await f.service.resume(a,key);
  await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[0].state==='completed');
  const db=await f.store.read(),run=db.chatOperations!.find(o=>o.workRun&&o.conversationId===r.taskId)!.workRun!;
  assert.equal(f.counts.create,1);assert.equal(f.counts.update,1);assert.equal(f.counts.draft,2);assert.equal(f.body(),f.secondBody);assert.equal(run.notionReceipt!.pageId,f.pageId);assert.ok(run.workflow!.steps.every(step=>step.state==='completed'));const file=db.attachments.find(file=>file.conversationId===r.taskId)!;assert.match(readFileSync(file.storagePath,'utf8'),/ONE-WORKFLOW-REVISION-橙色17/);t.diagnostic(JSON.stringify(f.metrics()));
 }finally{f.cleanup();}
});

test('workflow service adaptive default plans real retrieval, drafting, Notion and HTML without an explicit workflow',async t=>{
 const f=await workflowServiceFixture({adaptiveDefault:true});
 try{
  const r=await f.service.dispatch(a,{...input('operation_workflow_default_plan','从得到大脑查找青色42入口方案，写完整方案保存到Notion并做交互网页。'),sourceIds:['wf-source'],featureIds:['oneHtml'],confirmedExternal:true,outputDestination:'notion'},key);assert.ok(r.taskId);await f.service.resume(a,key);
  await waitFor(async()=>['completed','failed'].includes((await f.service.task(a,r.taskId!)).jobs[0].state));
  const db=await f.store.read(),run=db.chatOperations!.find(o=>o.workRun&&o.conversationId===r.taskId)!.workRun!;
  assert.equal(run.state,'completed',JSON.stringify({run,metrics:f.metrics()}));assert.deepEqual(run.workflow!.spec.steps.map(step=>step.kind),['tool','model','notion','feature']);assert.ok(run.workflow!.steps.every(step=>step.state==='completed'));assert.deepEqual([f.counts.retrieval,f.counts.draft,f.counts.create,f.counts.feature],[1,1,1,2]);assert.equal(f.body(),f.firstBody);const file=db.attachments.find(file=>file.conversationId===r.taskId)!;assert.match(readFileSync(file.storagePath,'utf8'),/ONE-WORKFLOW-DRAFT-青色42/);t.diagnostic(JSON.stringify(f.metrics()));
 }finally{f.cleanup();}
});

test('workflow service dependent task receives the complete parent body beyond 6000 characters with exact provenance',async t=>{
 const f=fixture(),longBody='WORKFLOW-PARENT-HEAD\n'+Array.from({length:700},(_,i)=>`第${i}项：青色42完整合成资料。`).join('\n')+'\nWORKFLOW-PARENT-TAIL-不截断';
 assert.ok(longBody.length>6000);let parentCalls=0,childCalls=0;const calls:{modelId:string;messagesBytes:number;toolsBytes:number}[]=[];
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>assert.fail('only explicit parent deliverable is used')},{reportCall:async()=>assert.fail('workflow uses deterministic progress'),modelCall:async(model,messages,tools)=>{
  calls.push({modelId:model.id,messagesBytes:Buffer.byteLength(JSON.stringify(messages),'utf8'),toolsBytes:Buffer.byteLength(JSON.stringify(tools),'utf8')});
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('两件事按前后关系处理。'):{...answer(''),toolCalls:[{id:'two-workflows',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[
   {taskId:null,title:'完整长正文',instruction:'只用合成资料生成完整长正文，不读取知识库，不保存文档。',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[],workflow:{version:1,steps:[{id:'parent',title:'交付完整长正文',kind:'model',instruction:'生成带完整头尾标记的长正文。',inputs:[]}]}},
   {taskId:null,title:'核对前置完整正文',instruction:'接收前一件成果全文，核对首尾及正文完整性。只在对话交付，不查知识库。',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[0],workflow:{version:1,steps:[{id:'child',title:'核对全文',kind:'model',instruction:'核对前一件成果全文，不得截短后再核对。',inputs:[]}]}}
  ]})}}]};
  assert.deepEqual(tools,[]);const goal=JSON.parse(messages.find(message=>message.role==='user'&&message.content?.startsWith('{"goal"'))!.content!);
  if(goal.currentStep.id==='parent'){parentCalls++;return answer(JSON.stringify({outcome:'completed',content:longBody,summary:'完整长正文已交付。'}));}
  assert.equal(goal.currentStep.id,'child');childCalls++;const raw=messages.find(message=>message.content?.startsWith('以下仅为本步骤明确选择的参考资料'))!.content!,reference=JSON.parse(raw.slice(raw.indexOf('\n')+1));
  const dependency=reference.inputs.find((entry:any)=>entry.originOperationId);assert.ok(dependency);assert.ok(dependency.content.startsWith(longBody));assert.match(dependency.content,/WORKFLOW-PARENT-TAIL-不截断/);assert.equal(dependency.complete,true);assert.equal(dependency.truncated,undefined);
  const db=await f.store.read(),parent=db.chatOperations!.find(op=>op.id===dependency.originOperationId)!;assert.equal(parent.workspaceId,a.workspaceId);assert.equal(parent.userId,a.userId);assert.equal(parent.workRun!.state,'completed');return answer(JSON.stringify({outcome:'completed',content:'首尾与完整长正文均已核对。',summary:'已核对前置全文。'}));
 }});
 const r=await service.dispatch(a,input('operation_workflow_full_dependency','先生成合成资料长正文，再让第二件任务核对前一件完整正文。不要查知识库。'),key);assert.equal(r.taskIds.length,2);await service.resume(a,key);
 await waitFor(async()=>(await service.task(a,r.taskIds[0])).jobs[0].state==='completed');await service.resume(a,key);await waitFor(async()=>(await service.task(a,r.taskIds[1])).jobs[0].state==='completed');
 assert.equal(parentCalls,1);assert.equal(childCalls,1);assert.equal((await service.task(a,r.taskIds[0])).conversation.messages.at(-1)!.content,longBody);await assert.rejects(()=>service.task(b,r.taskIds[1]));assert.equal((await f.store.read()).powerAccounts[1].balanceMicros,100e6);t.diagnostic(JSON.stringify({bodyChars:longBody.length,parentCalls,childCalls,calls}));
});

test('workflow service compares a real legacy tool loop and staged service path on the same verified file deliverable',async t=>{
 const metrics=[];
 for(const legacyChain of [true,false]){
  const f=await workflowServiceFixture({legacyChain});
  try{
   const r=await f.service.dispatch(a,{...input(`operation_workflow_comparison_${legacyChain}`,'请从得到大脑查找青色42入口方案，写完整方案保存Notion并做交互网页。'),sourceIds:['wf-source'],featureIds:['oneHtml'],confirmedExternal:true,outputDestination:'notion'},key);assert.ok(r.taskId);await f.service.resume(a,key);
   await waitFor(async()=>['completed','failed'].includes((await f.service.task(a,r.taskId!)).jobs[0].state));const detail=await f.service.task(a,r.taskId!);assert.equal(detail.jobs[0].state,'completed',JSON.stringify(detail));
   const db=await f.store.read(),run=db.chatOperations!.find(o=>o.workRun&&o.conversationId===r.taskId)!.workRun!,files=db.attachments.filter(file=>file.conversationId===r.taskId);assert.equal(Boolean(run.workflow),!legacyChain);assert.equal(run.notionReceipt!.state,'verified');assert.equal(f.body(),f.firstBody);assert.equal(f.counts.retrieval,1);assert.equal(f.counts.create,1);assert.equal(f.counts.update,0);assert.equal(files.length,1);const html=readFileSync(files[0].storagePath,'utf8');assert.match(html,/ONE-WORKFLOW-DRAFT-青色42/);assert.match(html,new RegExp(f.pageId));
   const execution=f.calls.filter(call=>call.modelId!=='router');metrics.push({mode:legacyChain?'legacy_loop':'staged_workflow',executionCalls:execution.length,executionMessagesBytes:execution.reduce((n,call)=>n+Buffer.byteLength(JSON.stringify(call.messages),'utf8'),0),executionToolsBytes:execution.reduce((n,call)=>n+Buffer.byteLength(JSON.stringify(call.tools),'utf8'),0),...f.metrics()});
  }finally{f.cleanup();}
 }
 assert.equal(metrics[1].executionCalls,3);assert.ok(metrics[0].executionCalls>metrics[1].executionCalls);t.diagnostic(JSON.stringify({measurement:'actual service calls and serialized UTF8 bytes; not supplier token costs or cache-hit estimates',metrics}));
});

test('required source searches cannot be replaced by a model claim, including read-only chat',async()=>{
  const f=fixture();await f.store.mutate(d=>{d.knowledgeConnections.push({id:'notion-required',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now'});});
  const refusing=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('not actually called');}},{modelCall:async()=>answer('没有找到这份资料')});
  const notRead=await refusing.dispatch(a,input('operation_required_search_1','帮我去 Notion 查查方案，只回答，不执行任务'),key);
  assert.match(notRead.message.content,/还没查全/);assert.doesNotMatch(notRead.message.content,/没有找到这份资料/);
  let selected:readonly string[]|undefined;
  const reading=new CoordinatorService(f.store,{recallWithDiagnostics:async(_ws,_q,_k,ids)=>{selected=ids;return{chunks:[],failures:[],status:'no_match',coverage:[{connectionId:'notion-required',provider:'notion',status:'no_match',attempts:1}]};}},{modelCall:async(_m,messages)=>messages.at(-1)?.role==='tool'?answer('这次没有找到匹配的方案。'):{...answer(''),toolCalls:[{id:'search',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'方案'})}}]}});
  const result=await reading.dispatch(a,input('operation_required_search_2','帮我去 Notion 查查方案，只回答，不执行任务'),key);assert.deepEqual(selected,['notion-required']);assert.match(result.message.content,/这次没有找到匹配/);
});
test('a multi-feature deliverable preserves completed work, reports it through ONE, and retries only the missing feature',async()=>{
  const f=fixture();
  await f.store.mutate(d=>{d.settings.officialFeatures=['文案','网页'].map((name,i)=>{const values={name,author:'ONE',description:'处理当前成果',instructions:`checkpoint-feature-${i}`,limitations:'只用合成数据',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};return{id:`checkpoint-${i}`,revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:`checkpoint-release-${i}`,version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}};});});
  let first=0,second=0,parentRounds=0,reports=0;
  f.setRoute(messages=>{
    if(messages[0].content!.startsWith('你是用户一直在交流的 ONE')){reports++;return answer(JSON.stringify({message:'文案已经做好，网页这次没做成。可以继续补上，不用重写文案。'}));}
    return messages.at(-1)?.role==='tool'?answer('安排好了'):{...answer(''),toolCalls:[{id:'plan',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'一份完整说明',instruction:'先写文案，再做网页',executorId:'general',outputKind:'text',featureIds:['checkpoint-0','checkpoint-1'],dependsOn:[]}]})}}]};
  });
  f.setWorker(async messages=>{
    if(messages[0].content!.includes('checkpoint-feature-0')){first++;return answer('真实保留的文案'+ '合成段落'.repeat(800));}
    if(messages[0].content!.includes('checkpoint-feature-1')){second++;if(second===1)throw Error('private provider failure');return answer('真实网页内容');}
    parentRounds++;if(!messages.some(m=>m.role==='tool'))return {...answer(''),toolCalls:[0,1].map(i=>({id:`part-${i}`,type:'function' as const,function:{name:`feature_${i}`,arguments:JSON.stringify({query:`${parentRounds}：处理第${i}部分`})}}))};
    return answer(JSON.stringify({outcome:'completed',content:'真实保留的文案，以及真实网页内容',summary:'两部分做好了'}));
  });
  const reply=await f.service.dispatch(a,{...input('operation_checkpoints_01','整理说明和网页'),budget:.5},key);
  await f.service.resume(a,key);const id=reply.taskIds[0];
  await waitFor(async()=>(await f.service.task(a,id)).jobs.at(-1)!.state==='failed');
  const partial=await f.service.task(a,id),source=partial.jobs.at(-1)!;
  assert.equal(first,1);assert.equal(second,1);assert.equal(reports,1);assert.match(source.userReport!,/文案已经做好/);assert.match(partial.conversation.messages.at(-1)!.content,/真实保留的文案/);
  assert.ok(partial.conversation.messages.at(-1)!.content.length<1000);
  const retained=(await f.store.read()).chatOperations!.find(o=>o.conversationId===id&&o.workRun)!.workRun!.steps!.find(step=>step.namespace==='worker'&&step.tool==='feature_0')!.output as {content:string};
  assert.ok(retained.content.length>3000,'full content remains available for recovery, not repeated in the brief receipt');
  assert.doesNotMatch(JSON.stringify(partial),/private provider failure|"namespace"|"steps"/);
  assert.equal(partial.recovery.kind,'none','a new supplement can continue safe partial work without another start button');await assert.rejects(()=>f.service.retryLatest(b,id,source.id,undefined,key));
  const beforeBudgetRetry=(await f.store.read()).chatOperations!.length;
  for(const requested of [0,11,NaN,'1',null])await assert.rejects(()=>f.service.retryLatest(a,id,source.id,undefined,key,requested as number),/电力上限/);
  assert.equal((await f.store.read()).chatOperations!.length,beforeBudgetRetry);
  await f.service.retryLatest(a,id,source.id,undefined,key,1);
  await f.service.retryLatest(a,id,source.id,undefined,key,1);
  await assert.rejects(()=>f.service.retryLatest(a,id,source.id,undefined,key,2),/已经受理/);
  assert.equal((await f.service.task(a,id)).jobs.at(-1)!.budget,1);
  assert.equal(source.budget,.5);
  await f.service.resume(a,key);
  await waitFor(async()=>(await f.service.task(a,id)).jobs.at(-1)!.state==='completed');
  assert.equal(first,1);assert.equal(second,2);assert.equal(reports,1);
  const db=await f.store.read();assert.equal(db.modelUsageRecords.filter(r=>r.featurePriceSnapshot?.id==='checkpoint-0').length,1);assert.equal(db.powerAccounts[1].balanceMicros,100e6);
  const recovery=db.chatOperations!.filter(o=>o.conversationId===id&&o.workRun).at(-1)!;
  assert.equal(recovery.workRun!.parentOperationId,recovery.operationId);
  assert.ok(db.modelUsageRecords.filter(r=>r.requestId===recovery.requestId).every(r=>r.batchBudget?.parentOperationId===recovery.operationId&&r.batchBudget.budget===1));
});
test('failed prerequisites wait without killing their successors; explicit recovery unblocks only their own dependents',async()=>{
  const f=fixture();let parentCalls=0,childCalls=0,otherCalls=0;
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('安排好了'):{...answer(''),toolCalls:[{id:'chain',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[
    {taskId:null,title:'准备素材',instruction:'PARENT_ONLY',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
    {taskId:null,title:'整理成品',instruction:'CHILD_ONLY',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[0]},
    {taskId:null,title:'独立短文',instruction:'OTHER_ONLY',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
  ]})}}]});
  f.setWorker(async messages=>{const last=messages.at(-1)!.content!;if(last.includes('PARENT_ONLY')){parentCalls++;return answer(JSON.stringify({outcome:parentCalls===1?'failed':'completed',content:parentCalls===1?'素材暂时没找齐':'RECOVERED_REAL_SOURCE',summary:'本轮真实状态'}));}if(last.includes('CHILD_ONLY')){childCalls++;assert.match(JSON.stringify(messages),/RECOVERED_REAL_SOURCE/);}else otherCalls++;return answer(JSON.stringify({outcome:'completed',content:'真实成果',summary:'已做好'}));});
  const result=await f.service.dispatch(a,input('operation_dependency_fix_1','先准备素材，再整理成品，同时写短文'),key);await f.service.resume(a,key);
  await waitFor(async()=>{const d=await f.store.read();return d.chatOperations!.some(o=>o.conversationId===result.taskIds[2]&&o.workRun?.state==='completed');});
  await f.service.resume(a,key);
  const blocked=await f.service.task(a,result.taskIds[1]);assert.equal(childCalls,0);assert.equal(otherCalls,1);assert.equal(blocked.jobs[0].state,'queued');assert.equal(blocked.jobs[0].dependencyBlocked,true);assert.equal(blocked.recovery.kind,'none');
  const parent=await f.service.task(a,result.taskIds[0]);await f.service.retryLatest(a,result.taskIds[0],parent.jobs[0].id,undefined,key);await f.service.resume(a,key);
  await waitFor(async()=>(await f.service.task(a,result.taskIds[1])).jobs[0].state==='completed');assert.equal(parentCalls,2);assert.equal(childCalls,1);assert.equal(otherCalls,1);
});
for(const interruptedSummary of [false,true])test(`two visual features return owned artifact URLs and preserve them across summary failure=${interruptedSummary}`,async()=>{
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-artifact-links-'));
 const scene={id:'first',title:'开始一天',situation:'开始工作',feature:'喝水后列要事',advantage:'明确下一步',benefit:'开始专注',evidence:'打开核对',steps:['喝水','列要事'],prompt:'开始一天',capabilityIds:[]};
 const document={version:1,title:'合成指南',intro:'两个场景的晨间指南',scenes:[scene,{...scene,id:'second',title:'结束一轮'}]};
 await f.store.mutate(d=>{d.settings.officialFeatures=['oneFlowchart','oneHtml'].map((tool,i)=>{
  const values={name:`视觉功能${i}`,author:'ONE',description:'真实文件',instructions:`VISUAL_FEATURE_${i}`,limitations:'私有文件',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:tool,name:tool,description:'生成文件',kind:'local' as const}]};
  const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};
  return {id:`visual-${i}`,revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:`release-${i}`,version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}};
 });});
 let summaries=0;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('must not read');}},{artifactDirectory:directory,modelCall:async(model,messages,tools)=>{
  if(model.id==='router'){
   if(messages[0].content?.startsWith('你是用户一直在交流的 ONE'))return answer(JSON.stringify({message:'两份文件已保存，最后的说明还没整理好，可以继续。'}));
   const schema=tools.find(tool=>tool.function.name==='delegate_task')!.function.parameters as {required:string[]};assert.ok(schema.required.includes('featureIds'));
   return messages.at(-1)?.role==='tool'?answer('两份文件已安排在同一件任务'):{...answer(''),toolCalls:[{id:'single-two-features',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'合成双文件指南',instruction:'生成同一指南的流程图与网页',executorId:'general',featureIds:['visual-0','visual-1']})}}]};
  }
  if(model.id==='special'){
   if(messages.at(-1)?.role==='tool')return answer('文件已保存');
   const tool=messages[0].content!.includes('VISUAL_FEATURE_0')?'oneFlowchart':'oneHtml';
   return {...answer(''),toolCalls:[{id:tool,type:'function',function:{name:tool,arguments:JSON.stringify(document)}}]};
  }
  assert.ok(messages.some(message=>message.role==='system'&&message.content?.includes('创建任务、并行和归档由平台负责')),'the worker must not treat platform task creation or filing as a missing delivery');
  if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[0,1].map(i=>({id:`feature-${i}`,type:'function' as const,function:{name:`feature_${i}`,arguments:JSON.stringify({query:'生成合成指南'})}}))};
  const outputs=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content!));
  assert.equal(outputs.length,2);
  for(const output of outputs){assert.equal(output.artifacts.length,1);assert.match(output.artifacts[0].openUrl,/^\/api\/welcome-pages\/att_\w+\/view$/);assert.match(output.artifacts[0].downloadUrl,/^\/api\/attachments\/att_\w+\/content$/);}
  assert.notEqual(outputs[0].artifacts[0].openUrl,outputs[1].artifacts[0].openUrl);
  summaries++;if(interruptedSummary&&summaries===1)throw Error('private_summary_failure SECRET');return answer('两份文件都已保存');
 }});
 try{
  const result=await service.dispatch(a,input('operation_visual_links_01','两个功能合做一份指南，无需用户手动勾选'),key);
  await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskId!)).jobs[0].state===(interruptedSummary?'failed':'completed'));
  if(interruptedSummary){
   const partial=await service.task(a,result.taskId!);assert.equal(partial.conversation.messages.at(-1)!.attachments!.length,2);assert.equal(partial.jobs[0].failureCode,'task_execution_failed');assert.doesNotMatch(JSON.stringify(partial),/private_summary_failure|SECRET/);
   const before=(await f.store.read()).modelUsageRecords.filter(row=>row.featurePriceSnapshot).length;
   await service.retryLatest(a,result.taskId!,partial.jobs[0].id,undefined,key);await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='completed');
   assert.equal((await f.store.read()).modelUsageRecords.filter(row=>row.featurePriceSnapshot).length,before,'saved feature results must not be purchased again');
  }
  assert.equal(summaries,interruptedSummary?2:1);assert.equal((await f.store.read()).attachments.length,2);
  await assert.rejects(()=>service.task(b,result.taskId!));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
for(const interrupted of [false,true])test(`office feature preserves its HTML and PPTX receipts through coordinator recovery=${interrupted}`,async()=>{
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-office-checkpoint-'));let generations=0,summaries=0;
 await f.store.mutate(d=>{const values={name:'演示稿',author:'ONE',description:'真实HTML与PPTX文件',instructions:'OFFICE_SLIDES',limitations:'私有文件',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:'oneSlides',description:'生成两份演示文件'}]};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'office-slides',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'office-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}];});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no knowledge');}},{artifactDirectory:directory,modelCall:async(model,messages)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('已安排演示稿'):{...answer(''),toolCalls:[{id:'dispatch',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'制作演示稿',instruction:'生成可导出的演示稿',executorId:'general',featureIds:['office-slides']})}}]};
  if(model.id==='special'){if(messages.at(-1)?.role==='tool')return answer('两份文件已保存');generations++;return {...answer(''),toolCalls:[{id:'slides',type:'function',function:{name:'oneSlides',arguments:JSON.stringify({operation:'create',dataJson:JSON.stringify({title:'演示稿',theme:'paper',slides:[{title:'项目目标',layout:'cover'}]})})}}]};}
  if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[{id:'office-feature',type:'function',function:{name:'feature_0',arguments:JSON.stringify({query:'生成演示稿'})}}]};
  const output=JSON.parse(messages.filter(m=>m.role==='tool').at(-1)!.content!);assert.equal(output.artifacts.length,2);assert.ok(output.artifacts.some((a:any)=>/^\/api\/office-files\/att_\w+\/view$/.test(a.openUrl)));summaries++;if(interrupted&&summaries===1)throw Error('summary interrupted');return answer('演示稿可以打开和导出');
 }});
 try{const result=await service.dispatch(a,input('office_receipt_12345678','请做演示稿'),key);await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskId!)).jobs[0].state===(interrupted?'failed':'completed'));
  if(interrupted){const task=await service.task(a,result.taskId!);assert.equal(task.conversation.messages.at(-1)!.attachments!.length,2);await service.retryLatest(a,result.taskId!,task.jobs[0].id,undefined,key);await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='completed');}
  assert.equal(generations,1);assert.equal((await f.store.read()).attachments.length,2);await assert.rejects(()=>service.task(b,result.taskId!));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('structured HTML deliverable calls the reviewed renderer directly without another model or knowledge read',async()=>{
  const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-direct-contract-'));
  const scene={id:'first',title:'整理说明',situation:'需要一份说明',feature:'整理要点',advantage:'不用反复排版',benefit:'拿到清楚的网页',evidence:'打开网页核对',steps:['整理要点','打开查看'],prompt:'整理说明',capabilityIds:[]};
  const document={version:1,title:'合成测试说明',intro:'测试结构化资料直接交付',scenes:[scene,{...scene,id:'second'}]};
  await f.store.mutate(d=>{const values={name:'交互网页',author:'ONE',description:'生成说明网页',instructions:'生成网页',limitations:'私有文件',integration:'question_answer' as const,knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:'oneHtml',name:'网页',description:'生成网页',kind:'local' as const}]};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'direct-page',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'direct-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}] as any;});
  let modelCalls=0;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('must not read');}},{artifactDirectory:directory,modelCall:async(model,messages)=>{modelCalls++;assert.equal(model.id,'router');return messages.at(-1)?.role==='tool'?answer('网页正在整理'):{...answer(''),toolCalls:[{id:'direct',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'合成说明网页',instruction:'把结构化说明保存成网页',executorId:'direct',outputKind:'text',featureIds:['direct-page'],dependsOn:[],requiredTools:['oneHtml'],direct:{tool:'oneHtml',document}}]})}}]};}});
  try{const result=await service.dispatch(a,input('operation_direct_page_01','把说明保存成网页'),key);await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskIds[0])).jobs[0].state==='completed');assert.equal(modelCalls,2);const d=await f.store.read();assert.equal(d.modelUsageRecords.filter(r=>r.activity==='task_worker'||r.activity==='task_feature').length,0);assert.equal(d.attachments.length,1);assert.equal(d.attachments[0].mimeType,'text/html');await assert.rejects(()=>service.task(b,result.taskIds[0]));}finally{rmSync(directory,{recursive:true,force:true});}
});
test('a new Notion draft cannot be completed by a model claim without a verified save',async()=>{
  const f=fixture();
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}));
  let writes=0;
  const mcp={readDocument:async()=>({text:'保存目录'}),callDocumentTool:async()=>{writes++;throw Error('must not be called');}} as unknown as NotionMcpService;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no private recall');}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages)=>{
    if(model.id==='router'&&messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[{id:'route',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'测试草稿',instruction:'把合成短文保存到 Notion',executorId:'general'})}}]};
    return answer(JSON.stringify({outcome:'completed',content:'已经保存好了。',summary:'保存好了'}));
  }});
  const r=await service.dispatch(a,{...input('operation_notion_missing_save','新建一篇合成短文'),outputDestination:'notion'},key);
  await service.resume(a,key);await waitFor(async()=>['failed','completed'].includes((await service.task(a,r.taskId!)).jobs[0].state));
  const task=await service.task(a,r.taskId!);
  assert.equal(task.jobs[0].state,'failed');assert.notEqual((await f.store.read()).chatOperations!.find(o=>o.conversationId===r.taskId&&o.workRun)!.workRun!.resultOutcome,'completed');
  assert.equal(writes,0);assert.equal(task.jobs[0].notionReceipt,undefined);
  assert.doesNotMatch(task.conversation.messages.at(-1)!.content,/已保存到 Notion/);
  await assert.rejects(()=>service.task(b,r.taskId!));
});
test('a verified saved explanation is still needs-input when yesterday material is missing, and main chat reports that fact once', async () => {
  const f=fixture(), parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageId='cccccccccccccccccccccccccccccccc';
  let body='', writes=0, reportCalls=0;
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
  const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(_ws:string,_connection:string,_grant:string,_user:string,_name:string,args:any)=>{
    writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};
  }} as unknown as NotionMcpService;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({status:'no_match',chunks:[],failures:[]})},{
    notionDocuments:new NotionDocuments(f.store,mcp), reportCall:async()=>{reportCalls++;throw Error('report summary unavailable');},
    modelCall:async(model,messages)=>{
      if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('我先找昨天的素材，再整理成专栏。'):{...answer(''),toolCalls:[{id:'column',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'昨天的专栏',instruction:'整理合成专栏；没有昨天素材时如实说明，若保存说明也不能视作正文完成。不查知识库。',executorId:'general',featureIds:[]})}}]};
      if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[{id:'save-explanation',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'专栏（待素材）',content:'还没有找到能确认属于这一天的内容，正文还没有写成。请补充昨天几句原话。'})}}]};
      return answer(JSON.stringify({outcome:'needs_input',summary:'没有找到能确认属于这一天的内容，专栏正文还没写成。',content:'没有找到能确认属于这一天的内容，专栏正文还没写成。已经保存的是说明，不是文章。\n## 需要你给我的一步\n- 昨天说过的几句原话，直接发来就好。'}));
    },
  });
  const accepted=await service.dispatch(a,{...input('operation_column_missing_material','请整理合成专栏，结果保存到Notion；不查知识库。'),outputDestination:'notion'},key);
  await service.resume(a,key);await waitFor(async()=>(await service.task(a,accepted.taskId!)).jobs[0].state==='failed');
  const detail=await service.task(a,accepted.taskId!);assert.equal(detail.jobs[0].notionReceipt?.state,'verified');
  const snapshots=await Promise.all([service.state(a),service.state(a)]), db=await f.store.read(), job=db.chatOperations!.find(o=>o.workRun)!;
  assert.equal(job.workRun!.resultOutcome,'needs_input');assert.equal(writes,1);assert.ok(reportCalls<=1,'a failed existing summary call never triggers a report retry');
  const main=snapshots[0].conversation!, report=main.messages.find(m=>m.id===job.workRun!.reportMessageId)!;
  assert.match(report.content,/所需日期的素材.*正文还没写成/);assert.match(report.content,/几句原话或相关记录/);assert.match(report.content,new RegExp(pageId));
  assert.doesNotMatch(report.content,/已完成|工具|回执|错误码|summary unavailable/);
  assert.equal(main.messages.filter(m=>m.id===report.id).length,1);assert.ok(snapshots.every(s=>s.recentReportedReceiptIds.includes(job.id)));
  await service.state(a);assert.equal(writes,1,'refresh only reports existing evidence; it never rewrites Notion');
  await assert.rejects(()=>service.task(b,accepted.taskId!));assert.equal(db.powerAccounts[1].balanceMicros,100e6);
});
for(const recallStatus of ['no_match','failed'] as const)test(`dated retrieval ${recallStatus} never creates a placeholder Notion page, and later supplied sources produce the real article`,async()=>{
  const f=fixture(), parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='dddddddddddddddddddddddddddddddd';
  let materials=false,body='',writes=0,workerCalls=0;
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
  const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,_n:string,args:any)=>{writes++;body=args.pages[0].content;return{pages:[{id:pageId}]};}} as unknown as NotionMcpService;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async(_ws,_q,_k,sourceIds)=>{assert.deepEqual(sourceIds,['notion']);return{status:materials?'used':recallStatus,chunks:materials?[{title:'昨天的笔记',content:'2026-10-24 合成原话：AI让实现更容易，也让判断更重要。',dateEvidence:{basis:'event',date:'2026-10-24',status:'requires_content_verification'}}]:[],failures:[]};}}, {
    notionDocuments:new NotionDocuments(f.store,mcp),reportCall:async()=>{assert.fail('missing material should not buy another report model round');},modelCall:async(model,messages)=>{
      if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('我先查昨天的素材，再写专栏。'):{...answer(''),toolCalls:[{id:'dated-column',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'昨天的专栏',instruction:'从Notion检索2026-10-24的会议笔记，依据真实素材写专栏并保存到Notion。',executorId:'general',featureIds:[],knowledge:'notion',requiredTools:['knowledge_search'],outputKind:'text',dependsOn:[]}]})}}]};
      workerCalls++;
      if(messages.at(-1)?.role!=='tool')return {...answer(''),toolCalls:[{id:'dated-search',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'会议笔记'})}},...(!materials?[{id:'bad-placeholder',type:'function' as const,function:{name:'save_notion_draft',arguments:JSON.stringify({title:'待素材说明',content:'没找到素材，先留下说明。'})}}]:[])]};
      if(messages.at(-1)?.content?.includes('"state":"verified"'))return answer(JSON.stringify({outcome:'completed',content:'根据真实素材写成的专栏已保存。',summary:'专栏已保存。'}));
      assert.equal(materials,true,'no-match should return needs_input directly without forcing another generation');
      return {...answer(''),toolCalls:[{id:'real-article',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'合成专栏',content:'AI让实现更容易，也让判断更重要。以下依据2026-10-24的会议笔记展开。'})}}]};
    },
  });
  const accepted=await service.dispatch(a,{...input('operation_no_material_placeholder','请从Notion检索2026-10-24的会议笔记，写专栏并保存到Notion。'),outputDestination:'notion'},key);
  await service.resume(a,key);await waitFor(async()=>(await service.task(a,accepted.taskId!)).jobs[0].state==='failed');
  let detail=await service.task(a,accepted.taskId!),snapshot=await service.state(a);
  assert.equal(writes,0);assert.equal(workerCalls,1);assert.equal(detail.jobs[0].notionReceipt,undefined);
  assert.match(snapshot.conversation!.messages.at(-1)!.content,recallStatus==='failed'?/资料来源这次没查成.*2026-10-24/:/2026-10-24.*正文还没写成/);assert.match(snapshot.conversation!.messages.at(-1)!.content,/没有新建占位文档/);
  assert.doesNotMatch(snapshot.conversation!.messages.at(-1)!.content,/已保存到 Notion|已完成/);
  materials=true;
  await service.direct(a,accepted.taskId!,{operationId:'operation_material_supplied_followup',text:'请再从Notion检索2026-10-24的会议笔记，按原要求写专栏并保存到Notion。',outputDestination:'notion'},key);
  await service.resume(a,key,accepted.taskId!);await waitFor(async()=>(await service.task(a,accepted.taskId!)).jobs.at(-1)!.state==='completed');
  detail=await service.task(a,accepted.taskId!);snapshot=await service.state(a);
  assert.equal(writes,1);assert.equal(detail.jobs.at(-1)!.notionReceipt?.state,'verified');assert.match(body,/AI让实现更容易/);assert.doesNotMatch(body,/没找到素材/);
  assert.match(snapshot.conversation!.messages.at(-1)!.content,/专栏.*已完成/);assert.match(snapshot.conversation!.messages.at(-1)!.content,new RegExp(pageId));
  await assert.rejects(()=>service.task(b,accepted.taskId!));
});
test('a new explicit Notion task with default chat binds only its own scoped write and verifies the real page',async()=>{
 for(const batch of [false,true]){
  const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='cccccccccccccccccccccccccccccccc';let body='',writes=0;
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
  const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(ws:string,cid:string,grant:string,user:string,name:string,args:any)=>{
   assert.deepEqual([ws,cid,grant,user,name],['wa','notion','grant','a','notion-create-pages']);writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};
  }} as unknown as NotionMcpService;
  const write={taskId:null,title:'合成便笺',instruction:'只在当前已选的 Notion 草稿保存页面下面新建合成便笺，正文只有青色42，保存后回读。不查知识库。',executorId:'general',featureIds:[]};
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no knowledge');}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages,tools)=>{
   if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('任务已安排。'):{...answer(''),toolCalls:[{id:'route',type:'function',function:{name:batch?'delegate_tasks':'delegate_task',arguments:JSON.stringify(batch?{tasks:[{...write,outputKind:'text',dependsOn:[]},{...write,title:'独立短句',instruction:'只返回独立短句你好，不保存任何文档。',outputKind:'text',dependsOn:[]}]}:write)}}]};
   if(messages.at(-1)?.role==='tool')return answer(JSON.stringify({outcome:'completed',content:'合成便笺已保存并回读。',summary:'完成'}));
   if(messages.at(-1)?.content?.includes('独立短句')){assert.ok(!tools.some(t=>t.function.name==='save_notion_draft'));return answer(JSON.stringify({outcome:'completed',content:'你好',summary:'完成'}));}
   assert.ok(tools.some(t=>t.function.name==='save_notion_draft'),'default chat must not erase the user-named Notion destination');
   return {...answer(''),toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'合成便笺',content:'青色42'})}}]};
  }});
  const r=await service.dispatch(a,{...input(`operation_notion_auto_${batch?'batch':'single'}`,'只在当前已选的 Notion 草稿保存页面下面新建合成便笺，正文只有青色42，保存后回读。不查知识库。另写一句独立短句，只在对话中返回。'),outputDestination:'chat'},key);
  const jobs=(await f.store.read()).chatOperations!.filter(o=>o.workRun);assert.equal(jobs.length,batch?2:1);assert.equal(jobs[0].workRun!.notionTarget?.parentId,parentId);if(batch)assert.equal(jobs[1].workRun!.notionTarget,undefined);
  await service.resume(a,key);await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun).every(o=>o.workRun!.state==='completed'));
  assert.equal(writes,1);assert.equal(body,'青色42');assert.equal((await service.task(a,jobs[0].conversationId!)).jobs[0].notionReceipt?.state,'verified');
  await assert.rejects(()=>service.task(b,r.taskId!));assert.equal((await f.store.read()).powerAccounts[1].balanceMicros,100e6);
 }
});

test('model-only Notion requests, quoted examples and read-only originals never acquire a writing target',async()=>{
 for(const original of ['只在这里写一篇合成短文，不保存到 Notion。','把“在 Notion 新建便笺”这句话整理成说明。','在 Notion 查找合成便笺，不修改。','整理这段合成文字。']){
  const f=fixture();let writes=0;
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}));
  const mcp={callDocumentTool:async()=>{writes++;throw Error('no write permission from a model');}} as unknown as NotionMcpService;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({status:'no_match',chunks:[],failures:[]})},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages,tools)=>{
   if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('已安排。'):{...answer(''),toolCalls:[{id:'wrong-write',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'合成文字',instruction:'在 Notion 新建合成便笺。',executorId:'general',featureIds:[]})}}]};
   assert.ok(!tools.some(t=>t.function.name==='save_notion_draft'));return answer(JSON.stringify({outcome:'completed',content:'只返回合成文字。',summary:'完成'}));
  }});
  await service.dispatch(a,{...input('operation_no_notion_authority',original),outputDestination:'chat'},key);
  assert.ok((await f.store.read()).chatOperations!.filter(o=>o.workRun).every(o=>!o.workRun!.notionTarget));
  await service.resume(a,key);assert.equal(writes,0);
 }
});

test('text-selected Notion destination still requires the exact owner grant and preflights a whole batch',async()=>{
 for(const grant of ['foreign-workspace','other-user','read-only','no-parent','valid']){
  const f=fixture();let writes=0;
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:grant==='foreign-workspace'?'wb':'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',...(grant==='read-only'?{}:{notionWriting:{grantId:'grant',userId:grant==='other-user'?'b':'a',authorizedAt:'now',parentId:grant==='no-parent'?'':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}})}));
  const mcp={callDocumentTool:async()=>{writes++;throw Error('not run');}} as unknown as NotionMcpService;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(_model,messages)=>messages.at(-1)?.role==='tool'?answer('按实际回执说明。'):{...answer(''),toolCalls:[{id:'whole-plan',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'独立短句',instruction:'返回你好',executorId:'general',featureIds:[],outputKind:'text',dependsOn:[]},{taskId:null,title:'Notion便笺',instruction:'在Notion新建合成便笺',executorId:'general',featureIds:[],outputKind:'text',dependsOn:[]}]})}}]}});
  const dispatch=()=>service.dispatch(a,{...input('operation_notion_grant_check','写一句你好，另在Notion新建合成便笺。'),outputDestination:'chat'},key);
  if(grant==='valid')await dispatch();else await assert.rejects(dispatch,/授权 Notion|选择草稿保存页面/);
  const db=await f.store.read(),jobs=db.chatOperations!.filter(o=>o.workRun);assert.equal(jobs.length,grant==='valid'?2:0,grant);assert.equal(writes,0);assert.equal(db.powerAccounts[1].balanceMicros,100e6);
 }
});

test('Notion dispatcher and queued continuation create once, revise the same document, keep original words and scoped receipts',async()=>{
  const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
  let body='',actualReads=0,failReadSummary=false,release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);const mutations:string[]=[];
  const mcp={readDocument:async(ws:string)=>{assert.equal(ws,'wa');actualReads++;return {text:body||'保存目录'};},callDocumentTool:async(ws:string,cid:string,grant:string,user:string,name:string,args:any)=>{
    assert.deepEqual([ws,cid,grant,user],['wa','notion','grant','a']);mutations.push(name);
    if(name==='notion-create-pages'){await hold;body=args.pages[0].content;return {pages:[{id:pageId}]};}
    body=body.replace(args.content_updates[0].old_str,args.content_updates[0].new_str);return {id:pageId};
  }} as unknown as NotionMcpService;
  let freshReadRoutes=0,ignoreFreshRead=false;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages,tools,_req,options)=>{
    if(messages.at(-1)?.role==='tool'){
      const read=messages.at(-1)!.content!;
      if(model.id!=='router'&&JSON.parse(read).status==='read'){
        if(failReadSummary){failReadSummary=false;throw Error('read summary interrupted');}
        return answer(JSON.stringify({outcome:'completed',content:JSON.parse(read).content,summary:'只读核对完成'}));
      }
      if(JSON.parse(messages.at(-1)!.content!).code==='TOOL_INPUT_REPAIR')return {...answer(''),toolCalls:[{id:'corrected-save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({old_str:'第一段。',new_str:'修改后的第一段。'})}}]};
      return answer('已收到真实工具回执。');
    }
    if(model.id==='router'){
      const readonly=messages.at(-1)?.content?.includes('新的只读核对');
      if(readonly){freshReadRoutes++;assert.equal(options?.requiredTool,'delegate_task');assert.match(JSON.stringify(messages),new RegExp(pageId));}
      if(readonly&&ignoreFreshRead)return answer('读好了，正文和结尾都在。');
      const taskId=readonly?(await f.store.read()).conversations.find(c=>c.notionDocument?.pageId===pageId)!.id:null;
      return {...answer(''),toolCalls:[{id:'route',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId,title:'专栏草稿',instruction:readonly?'只读核对正文，不修改、不保存，不查知识库。':'请写专栏并保存到已授权的 Notion 目录',executorId:'general'})}}]};
    }
    if(messages.at(-1)?.content?.includes('只读核对')){
      assert.match(JSON.stringify(messages),new RegExp(pageId));
      assert.ok(!tools.some(t=>t.function.name==='save_notion_draft'),'explicit read-only continuation must not expose a write tool');
      assert.ok(tools.some(t=>t.function.name==='read_notion_document'));
      return {...answer(''),toolCalls:[{id:'read-current',type:'function',function:{name:'read_notion_document',arguments:'{}'}}]};
    }
    assert.ok(tools.some(t=>t.function.name==='save_notion_draft'));
    return {...answer(''),toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify(body?{old_str:'第一段。',new_str:'修改后的第一段.'}:{title:'专栏',content:'第一段。'})}}]};
  }});
  await assert.rejects(()=>service.dispatch(b,{...input('operation_notion_foreign','写篇文章'),outputDestination:'notion'},key));
  const result=await service.dispatch(a,{...input('operation_notion_first','讨论之后请写专栏'),outputDestination:'notion'},key);
  await service.resume(a,key);await waitFor(async()=>mutations.length===1);
  await service.direct(a,result.taskId!,{operationId:'operation_notion_second',text:'只把“第一段。”改为“修改后的第一段。”，其余不动。'},key);
  release();await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.every(j=>j.state==='completed'));
  assert.deepEqual(mutations,['notion-create-pages','notion-update-page']);assert.equal(body,'修改后的第一段。');
  const task=await service.task(a,result.taskId!);
  assert.equal(task.conversation.notionDocument?.pageId,pageId);assert.match(JSON.stringify(task.conversation.messages),/讨论之后请写专栏|修改后的第一段。|已保存到 Notion/);
  assert.ok(task.jobs.every(j=>j.notionReceipt?.state==='verified'));
  await service.direct(a,result.taskId!,{operationId:'operation_notion_readonly',text:'只读核对正文，不修改'},key);
  await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='completed');
  assert.deepEqual(mutations,['notion-create-pages','notion-update-page'],'ordinary follow-up on the saved draft must not force another write');
  const readback=(await service.task(a,result.taskId!)).conversation.messages.at(-1)!.content;
  assert.match(readback,new RegExp(`打开 Notion 原文.*${pageId}`));assert.doesNotMatch(readback,/尚未|已保存到 Notion|"outcome"/);
  const before=(await service.task(a,result.taskId!)).jobs.length;
  await assert.rejects(()=>service.dispatch(b,{...input('operation_notion_fresh_foreign','请实际回读本任务原文，不修改。'),boundTaskId:result.taskId,outputDestination:'chat'},key));
  const again=await service.dispatch(a,{...input('operation_notion_fresh_read','只在这件任务做一次新的只读核对：读取本任务已保存文章，不修改、不保存、不新建文档，不查知识库。'),boundTaskId:result.taskId,outputDestination:'chat'},key);
  assert.equal(again.taskId,result.taskId,JSON.stringify({again,freshReadRoutes}));assert.equal(freshReadRoutes,1);
  await service.resume(a,key);await waitFor(async()=>{const t=await service.task(a,result.taskId!);return t.jobs.length===before+1&&t.jobs.at(-1)!.state==='completed';});
  assert.deepEqual(mutations,['notion-create-pages','notion-update-page'],'fresh read must not repeat any old writes');
  const latestRead=(await f.store.read()).chatOperations!.filter(o=>o.conversationId===result.taskId&&o.workRun).at(-1)!.workRun!;
  assert.equal(latestRead.notionTarget?.pageId,pageId,'chat output must retain the same server-bound article as a read input');
  assert.deepEqual(latestRead.steps?.map(s=>[s.tool,s.effect,s.state]),[['read_notion_document','read','completed']]);
  const readCount=actualReads;
  await service.direct(a,result.taskId!,{operationId:'operation_read_summary_failure',text:'只读核对本任务原文，不修改、不保存。'},key);
  failReadSummary=true;await service.resume(a,key);
  await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='failed');
  const failedSummary=(await service.task(a,result.taskId!)).jobs.at(-1)!;
  assert.equal(actualReads,readCount+1);assert.equal((await service.task(a,result.taskId!)).recovery.kind,'none','safe summary recovery accepts a new request without a second confirmation');
  body+='\n新的结尾。';
  await service.retryLatest(a,result.taskId!,failedSummary.id,undefined,key);await service.resume(a,key);
  await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='completed');
  assert.equal(actualReads,readCount+2,'explicit read recovery must fetch again instead of reusing the old body');
  assert.match((await service.task(a,result.taskId!)).conversation.messages.at(-1)!.content,/新的结尾/);
  await service.direct(a,result.taskId!,{operationId:'operation_notion_read_key_failure',text:'只在这件任务做一次新的只读核对：读取本任务原文，不修改、不保存。'},key);
  let proofChecks=0;
  await service.resume(a,async()=>{if(++proofChecks>1)throw new OneKeyPresenceError('fixture disconnected');});
  await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='failed');
  const failedRead=(await service.task(a,result.taskId!)).jobs.at(-1)!;
  assert.equal(failedRead.failureCode,'task_key_required');
  assert.equal((await service.task(a,result.taskId!)).recovery.kind,'retry');
  await assert.rejects(()=>service.retryLatest(b,result.taskId!,failedRead.id,undefined,key));
  await service.retryLatest(a,result.taskId!,failedRead.id,undefined,key);
  await service.retryLatest(a,result.taskId!,failedRead.id,undefined,key);
  assert.equal((await service.task(a,result.taskId!)).jobs.length,before+5,'concurrent recovery must share one new attempt');
  await service.resume(a,key);
  await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.at(-1)!.state==='completed');
  assert.deepEqual(mutations,['notion-create-pages','notion-update-page'],'recovered read must not replay the old write');
  ignoreFreshRead=true;
  const ignored=await service.dispatch(a,{...input('operation_notion_fresh_ignored','只在这件任务做一次新的只读核对：读取本任务已保存文章，不修改、不保存。'),boundTaskId:result.taskId,outputDestination:'notion'},key);
  assert.equal(ignored.taskId,undefined);assert.match(ignored.message.content,/还没能重新读取/);assert.doesNotMatch(ignored.message.content,/读好了/);
  assert.equal((await service.task(a,result.taskId!)).jobs.length,before+5);assert.equal(mutations.length,2);
  await assert.rejects(()=>service.task(b,result.taskId!));
});
test('long Notion article arguments use a document allowance, save once and retain owner and budget checks',async()=>{
 for(const originalDeclines of [true,false]){
 const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
 const article=Array.from({length:200},(_,i)=>`第${i+1}段：这是长文合成资料，不涉及真实用户。`).join('\n\n');let body='',writes=0,workerCalls=0;
 const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(ws:string,_cid:string,_grant:string,user:string,_name:string,args:any)=>{
  assert.deepEqual([ws,user],['wa','a']);writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};
 }} as unknown as NotionMcpService;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no knowledge requested');}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages,tools,_request,options)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('已经安排。'):{...answer(''),toolCalls:[{id:'route',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'长文草稿',instruction:'请将合成长文章保存到 Notion 并回读。'+(originalDeclines?'':'只依据主题创作，不必联网或查知识库。'),executorId:'general',featureIds:[],outputKind:'text',dependsOn:[],knowledge:'all',requiredTools:['knowledge_search']}]})}}]};
  workerCalls++;assert.equal(options?.maxOutputTokens,12000);
  if(messages.at(-1)?.role==='tool')return answer('已保存并回读。');
  assert.ok(tools.some(t=>t.function.name==='save_notion_draft'));assert.ok(!tools.some(t=>t.function.name==='knowledge_search'));
  return {...answer(''),toolCalls:[{id:'save-long',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'长文草稿',content:article})}}]};
 }});
 const reply=await service.dispatch(a,{...input('operation_long_notion_article','请写一篇合成长文章并保存。'+(originalDeclines?'不必联网或查知识库。':'')),outputDestination:'notion'},key);
 await service.resume(a,key);await waitFor(async()=>['failed','completed'].includes((await service.task(a,reply.taskId!)).jobs[0].state));
 const task=await service.task(a,reply.taskId!);assert.equal(task.jobs[0].state,'completed');assert.equal(task.jobs[0].notionReceipt?.state,'verified');assert.equal(writes,1);assert.equal(body,article);assert.equal(workerCalls,2);
 const run=(await f.store.read()).chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!.workRun!;assert.deepEqual(run.contract?.requiredTools,[]);assert.deepEqual(run.sources,[]);
 await assert.rejects(()=>service.task(b,reply.taskId!));
 const usage=(await f.store.read()).modelUsageRecords.filter(u=>u.conversationId===reply.taskId);assert.ok(usage.every(u=>u.reservedMicros===0));
 }
});
test('a verified new document still completes when the remaining budget cannot reserve another acknowledgement',async()=>{
 const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';let body='',writes=0,workerCalls=0;
 const article='Synthetic paragraph for isolated document acceptance.\n'.repeat(300);
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
 const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,_n:string,args:any)=>{writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};}} as unknown as NotionMcpService;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{assert.fail('declined retrieval');}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages,tools)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('已经安排。'):{...answer(''),toolCalls:[{id:'plan',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'预算内文章',instruction:'写好合成文章并保存到 Notion，保存后回读。不必联网或查知识库。',executorId:'general'})}}]};
  workerCalls++;assert.equal(workerCalls,1,'no extra model call should be billed just to acknowledge a verified save');assert.ok(!tools.some(t=>t.function.name==='knowledge_search'));
  const hold=(await f.store.read()).modelUsageRecords.find(u=>u.modelId===model.id&&u.status==='pending')!.reservedMicros!;
  return {...answer(''),usage:{inputTokens:hold-1,outputTokens:1,totalTokens:hold,source:'provider'},toolCalls:[{id:'save-budget',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'预算内文章',content:article,final:true})}}]};
 }});
 const result=await service.dispatch(a,{...input('operation_notion_budget_finish','写好一篇文章并保存到 Notion'),budget:.03,outputDestination:'notion'},key);
 // Reproduce an older snapshot's stale mandatory search without modifying its
 // original record at execution time. Current restrictions must still win.
 await f.store.mutate(d=>{const w=d.chatOperations!.find(o=>o.conversationId===result.taskId&&o.workRun)!.workRun!;w.contract!.requiredTools=['knowledge_search'];w.contract!.knowledgeSourceIds=['notion'];});
 await service.resume(a,key);await waitFor(async()=>['completed','failed'].includes((await service.task(a,result.taskId!)).jobs[0].state));
 const task=await service.task(a,result.taskId!);assert.equal(task.jobs[0].state,'completed',JSON.stringify(task.jobs));assert.equal(task.jobs[0].notionReceipt?.state,'verified');assert.equal(writes,1);assert.equal(workerCalls,1);assert.equal(body,article);assert.match(task.conversation.messages.at(-1)!.content,new RegExp(pageId));
 const rows=(await f.store.read()).modelUsageRecords.filter(u=>u.conversationId===result.taskId);assert.equal(rows.length,1);assert.ok(rows[0].chargedMicros!<=30000);assert.equal(rows[0].reservedMicros,0);await assert.rejects(()=>service.task(b,result.taskId!));
});
test('a first-turn truncated Notion instruction has a safe same-task recovery without weakening unknown-write protection',async()=>{
 const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';let truncate=true,writes=0,body='';
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
 const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,_n:string,args:any)=>{writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};}} as unknown as NotionMcpService;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{assert.fail('no retrieval allowed');}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages)=>{
  if(messages.at(-1)?.role==='tool')return answer('已经保存并回读。');
  if(model.id==='router')return {...answer(''),toolCalls:[{id:'plan',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'长文截断恢复',instruction:'将合成文章保存到 Notion，不查知识库。',executorId:'general'})}}]};
  return {...answer(''),finishReason:truncate?'length':'tool_calls',toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:truncate?'溢出但未执行':JSON.stringify({title:'合成专栏',content:'这是完整的合成文章。'})}}]};
 }});
 const reply=await service.dispatch(a,{...input('operation_notion_truncated_01','在 Notion 新建合成文章，不查知识库。'),outputDestination:'notion'},key);
 await service.resume(a,key);await waitFor(async()=>(await service.task(a,reply.taskId!)).jobs[0].state==='failed');
 const failed=await service.task(a,reply.taskId!);assert.equal(failed.jobs[0].failureCode,'task_tool_instruction_incomplete');assert.equal(failed.recovery.kind,'retry');assert.equal(writes,0);
 const source=(await f.store.read()).chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!.workRun!;assert.deepEqual(source.steps,[]);assert.equal(source.notionReceipt,undefined);
 await assert.rejects(()=>service.retryLatest(b,reply.taskId!,failed.jobs[0].id,undefined,key));
 truncate=false;await service.retryLatest(a,reply.taskId!,failed.jobs[0].id,undefined,key);await service.resume(a,key);await waitFor(async()=>(await service.task(a,reply.taskId!)).jobs.at(-1)?.state==='completed');
 const recovered=await service.task(a,reply.taskId!);assert.equal(recovered.conversation.id,reply.taskId);assert.equal(recovered.conversation.notionDocument?.pageId,pageId);assert.equal(writes,1);assert.equal(body,'这是完整的合成文章。');assert.equal(recovered.jobs.at(-1)?.notionReceipt?.state,'verified');
});
test('a proven unsent Notion save can retry on the same task and destination without replaying unknown writes',async()=>{
 const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
 let fail=true,body='',writes=0;
 const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(_ws:string,_cid:string,_grant:string,_user:string,_name:string,args:any)=>{
  if(fail)throw new NotionWriteError('connect','not_sent','connection');
  writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};
 }} as unknown as NotionMcpService;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages)=>{
  if(messages.at(-1)?.role==='tool')return answer('已取得保存回执');
  if(model.id==='router')return {...answer(''),toolCalls:[{id:'route',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'连接恢复草稿',instruction:'将合成正文保存到 Notion',executorId:'general'})}}]};
  return {...answer(''),toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'合成标题',content:'合成正文'})}}]};
 }});
 const r=await service.dispatch(a,{...input('operation_unsent_notion','在 Notion 新建合成短文，正文：明天15时检查小苗。保存后回读，不读取知识库或参考文章。'),outputDestination:'notion'},key);
 assert.doesNotMatch(r.message.content,/还没查全/);
 await service.resume(a,key);await waitFor(async()=>(await service.task(a,r.taskId!)).jobs.at(-1)?.state==='failed');
 const detail=await service.task(a,r.taskId!);assert.equal(detail.recovery.kind,'retry');assert.equal(writes,0);
 await assert.rejects(()=>service.retryLatest(b,r.taskId!,detail.jobs[0].id,undefined,key));
 fail=false;await service.retryLatest(a,r.taskId!,detail.jobs[0].id,undefined,key);await service.resume(a,key);
 await waitFor(async()=>(await service.task(a,r.taskId!)).jobs.at(-1)?.state==='completed');
 const done=await service.task(a,r.taskId!);assert.equal(done.jobs.length,2);assert.equal(writes,1);assert.equal(done.jobs.at(-1)?.notionReceipt?.state,'verified');assert.equal(done.conversation.notionDocument?.pageId,pageId);
});
const imageFixturePng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=';
test('image feature uses its image model and own rate, without changing base image price or tenant scope',async()=>{
  const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-priced-image-'));
  await f.store.mutate(d=>{
    d.models.push({...d.models[0],id:'image-model',kind:'image',imagePowerPerCall:.1,costImagePowerPerCall:.02});
    const values={name:'图片功能',author:'ONE',description:'生成测试图片',instructions:'绘制圆圈',limitations:'仅合成测试',integration:'question_answer' as const,modelId:'image-model',knowledgeMode:'none' as const,usageMultiplier:.6,experience:{mode:'image'} as any};
    const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};
    d.settings.officialFeatures=[{id:'priced-image',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'image-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}];
  });
  let imageCalls=0,workerCalls=0;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{artifactDirectory:directory,imageCall:async model=>{imageCalls++;assert.equal(model.id,'image-model');assert.equal(model.imagePowerPerCall,.06);return {content:'图片成果',imageUrl:imageFixturePng};},modelCall:async()=>++workerCalls===1?{...answer(''),toolCalls:[{id:'feature-image',type:'function',function:{name:'feature_0',arguments:JSON.stringify({query:'生成圆圈'})}}]}:answer('图片已完成')});
  try{
    const result=await f.service.dispatch(a,{...input('operation_priced_image_1','UI 配图'),featureIds:['priced-image'],confirmedExternal:true},key);
    await service.resume(a,key);await waitFor(async()=>(await service.task(a,result.taskId!)).jobs[0].state==='completed');
    const db=await f.store.read(),row=db.modelUsageRecords.find(r=>r.featurePriceSnapshot)!;
    assert.equal(imageCalls,1);assert.equal(row.chargedMicros,60000);assert.equal(row.costMicros,20000);
    assert.equal(db.models.find(m=>m.id==='image-model')!.imagePowerPerCall,.1);
    assert.equal(db.attachments[0].workspaceId,'wa');assert.equal(db.attachments[0].userId,'a');assert.equal(db.powerAccounts[1].balanceMicros,100e6);
    await service.resume(a,key);assert.equal(imageCalls,1);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
async function imageFixture(imageCall:NonNullable<import('./featureRuns.js').FeatureRunDependencies['imageCall']>) {
  const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-image-queue-'));
  await f.store.mutate(d=>{
    d.models.push({...d.models[0],id:'image-model',kind:'image',protocol:'openai',imagePowerPerCall:0.1,costImagePowerPerCall:0.02});
    updateTaskConfig(d.settings,d.models,'image_generation',{revision:0,action:'draft',values:{...defaultTaskValues('image_generation'),modelId:'image-model'}},'a','now');
    updateTaskConfig(d.settings,d.models,'image_generation',{revision:1,action:'publish'},'a','now');
  });
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{artifactDirectory:directory,imageCall,modelCall:async(_model,messages)=>messages.at(-1)?.role==='tool'?answer('活动文案先给你；图片正在制作。'):{...answer(''),toolCalls:[{id:'draw',type:'function',function:{name:'generate_image',arguments:JSON.stringify({query:'蓝色圆圈，没有文字'})}}]}});
  return {...f,service,directory};
}
test('discovered builtin image card in legacy featureIds creates an actual private image once',async()=>{
 let images=0;const f=await imageFixture(async()=>({content:'',imageUrl:imageFixturePng}));
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no knowledge');}},{artifactDirectory:f.directory,imageCall:async()=>{images++;return{content:'',imageUrl:imageFixturePng};},modelCall:async(_model,messages)=>messages.at(-1)?.role==='tool'?answer('画图已经安排。'):{...answer(''),toolCalls:[{id:'discovered-image',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'合成图案',instruction:'画一个绿色圆圈',executorId:'general',outputKind:'image',featureIds:['builtin:image_generation'],dependsOn:[]}]})}}]}});
 try{const request=input('operation_card_image_001','画一个合成图案');const reply=await service.dispatch(a,request,key);assert.equal(reply.taskIds.length,1);await service.resume(a,key);await waitFor(async()=>(await service.task(a,reply.taskIds[0])).jobs[0].state==='completed');
  const detail=await service.task(a,reply.taskIds[0]);assert.match(detail.conversation.messages.at(-1)!.imageUrl!,/^\/api\/attachments\//);assert.equal((await f.store.read()).attachments.length,1);
  await service.dispatch(a,request,key);assert.equal(images,1);await assert.rejects(()=>service.task(b,reply.taskIds[0]));
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
for(const direct of [false,true])test(`image → webpage embeds the actual owned prerequisite bytes, not a placeholder (direct=${direct})`,async()=>{
 let images=0;const f=await imageFixture(async()=>({content:'',imageUrl:imageFixturePng}));
 const scene={id:'first',title:'休息一下',situation:'工作间隙想缓一缓',feature:'喝一杯水',advantage:'不用复杂准备',benefit:'重新找回节奏',evidence:'看真实配图',steps:['放下手头工作','喝水休息'],prompt:'休息一下',capabilityIds:[]};
 const document={version:1 as const,title:'合成休息指南',intro:'图和说明放在一起',scenes:[scene,{...scene,id:'second',title:'伸展一下'}]};
 await f.store.mutate(d=>{const values={name:'交互网页',author:'ONE',description:'整理网页',instructions:'调用 oneHtml 保存网页',limitations:'不读取外部资料',integration:'question_answer' as const,modelId:'special',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:'oneHtml',description:'生成网页'}]};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'image-page',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'page-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}];});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('no knowledge');}},{artifactDirectory:f.directory,imageCall:async()=>{images++;return{content:'',imageUrl:imageFixturePng};},modelCall:async(model,messages,_tools,_request,options)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('两件事已经接到。'):{...answer(''),toolCalls:[{id:'image-page',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'合成配图',instruction:'画一个圆圈',executorId:'general',outputKind:'image',featureIds:['builtin:image_generation'],dependsOn:[]},{taskId:null,title:'合成网页',instruction:'把真图放进网页，不使用占位图',executorId:direct?'direct':'general',outputKind:'text',capabilityIds:['feature:image-page'],featureIds:[],dependsOn:[0],requiredTools:['oneHtml'],...(direct?{direct:{tool:'oneHtml',document}}:{})}]})}}]};
  if(messages.at(-1)?.role==='tool'){if(model.id==='special')assert.equal(options?.maxOutputTokens,undefined,'saved HTML only needs a short acknowledgement');return answer(model.id==='special'?'网页已保存':JSON.stringify({outcome:'completed',content:'网页做好了。',summary:'包含真实配图'}));}
  if(model.id==='special')assert.equal(options?.maxOutputTokens,10000,'complete HTML arguments must not use the short-chat output ceiling');
  return {...answer(''),toolCalls:[{id:model.id==='special'?'html':'feature',type:'function',function:{name:model.id==='special'?'oneHtml':'feature_0',arguments:JSON.stringify(model.id==='special'?document:{query:'生成包含前置真图的网页'})}}]};
 }});
 try{
  const request={...input(`operation_image_page_${direct}`,'只用合成资料画图，再做网页'),budget:1};const reply=await service.dispatch(a,request,key);assert.equal(reply.taskIds.length,2);
  await service.resume(a,key);await waitFor(async()=>(await service.task(a,reply.taskIds[1])).jobs[0].state==='completed').catch(async()=>assert.fail(JSON.stringify((await service.task(a,reply.taskIds[1])).jobs)));
  const db=await f.store.read(),page=db.attachments.find(a=>a.mimeType==='text/html')!,image=db.attachments.find(a=>a.kind==='image')!;
  assert.ok(page&&image);assert.equal(images,1);assert.ok(readFileSync(page.storagePath,'utf8').includes(`src="${imageFixturePng}"`));assert.equal(page.welcomeGuide,undefined,'normal work is not an onboarding gift');
  const parent=db.chatOperations!.find(o=>o.workRun?.kind==='image')!;
  const {visualArtifactSaver}=await import('./featureArtifacts.js');
  const foreign=visualArtifactSaver(f.store,{...b,conversationId:'foreign'},f.directory,()=>{},undefined,undefined,[parent.operationId])!;
  await assert.rejects(()=>foreign(document,'html'),/前面的结果/);
  await service.dispatch(a,request,key);assert.equal(images,1);await assert.rejects(()=>service.task(b,reply.taskIds[1]));
  await f.store.mutate(d=>{d.attachments=d.attachments.filter(a=>a.id!==image.id);});
  const missing=visualArtifactSaver(f.store,{...a,conversationId:reply.taskIds[1]},f.directory,()=>{},undefined,undefined,[parent.operationId])!;
  await assert.rejects(()=>missing(document,'html'),/图片暂时找不到/);assert.equal(images,1,'missing image is not a reason to buy another one');
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('failed image shows a safe reason and explicit retry reuses its task with one new billed attempt',async()=>{
  let calls=0,fail=true;const f=await imageFixture(async()=>{calls++;if(fail)throw new ChatImageGatewayError('authorization',403);return {content:'图片好了',imageUrl:imageFixturePng};});
  try{
    const reply=await f.service.dispatch(a,input('operation_image_recover_01','画图'),key);await f.service.resume(a,key);
    await waitFor(async()=>(await f.service.task(a,reply.taskIds[0])).jobs.at(-1)?.state==='failed');
    const detail=await f.service.task(a,reply.taskIds[0]),source=detail.jobs.at(-1)!;
    assert.equal(source.failureCode,'image_authorization_403');assert.match(source.error!,/不用重新授权电脑/);assert.equal(calls,1);
    await assert.rejects(()=>f.service.retryLatest(b,reply.taskIds[0],source.id,undefined,key));assert.equal(calls,1);
    fail=false;
    await Promise.allSettled([f.service.retryLatest(a,reply.taskIds[0],source.id,undefined,key),f.service.retryLatest(a,reply.taskIds[0],source.id,undefined,key)]);
    await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,reply.taskIds[0])).jobs.at(-1)?.state==='completed');
    const done=await f.store.read();assert.equal(calls,2);assert.equal(done.chatOperations!.filter(o=>o.conversationId===reply.taskIds[0]&&o.workRun).length,2);
    assert.equal(done.attachments.length,1);assert.equal(done.modelUsageRecords.filter(r=>r.activity==='image_generation'&&r.status==='success').length,1);
    assert.equal(done.modelUsageRecords.filter(r=>r.activity==='image_generation'&&r.status==='failed').length,1);
    assert.equal(done.powerAccounts[1].balanceMicros,100e6);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('chat image task is independent, private, billed once and returns to the same chat exactly once',async()=>{
  let release!:()=>void,calls=0;
  const gate=new Promise<void>(r=>release=r);
  const f=await imageFixture(async()=>{calls++;await gate;return {content:'生成完成',imageUrl:imageFixturePng};});
  try {
    const request=input('operation_image_parallel_01','给活动写文案并画图');
    const reply=await f.service.dispatch(a,request,key);
    assert.match(reply.message.content,/文案先/);
    const db=await f.store.read(),job=db.chatOperations!.find(o=>o.workRun?.kind==='image')!;
    assert.ok(['queued','running'].includes(job.workRun!.state));
    await assert.rejects(()=>f.service.task(b,job.conversationId!),/不存在/);
    await f.service.resume(a,key);await waitFor(async()=>calls===1);
    assert.equal((await f.service.task(a,job.conversationId!)).jobs[0].state,'running');
    await f.service.dispatch(a,request,key);assert.equal(calls,1,'replayed submission does not duplicate the image');
    release();await waitFor(async()=>(await f.service.task(a,job.conversationId!)).jobs[0].state==='completed');
    const done=await f.store.read(),image=done.attachments[0];
    assert.equal(image.workspaceId,a.workspaceId);assert.equal(image.userId,a.userId);
    assert.equal(done.modelUsageRecords.filter(r=>r.activity==='image_generation').length,1);
    assert.equal(done.modelUsageRecords.find(r=>r.activity==='image_generation')!.chargedMicros,100000);
    await f.service.state(a);
    await f.service.report(b,[job.id],key);assert.equal((await f.store.read()).conversations.find(c=>c.coordinatorMain)!.messages.filter(m=>m.imageUrl).length,1,'idle completion already returned the owned image; another owner cannot duplicate it');
    await f.service.report(a,[job.id],key);await f.service.report(a,[job.id],key);
    const main=(await f.store.read()).conversations.find(c=>c.coordinatorMain)!;
    assert.equal(main.messages.filter(m=>m.imageUrl).length,1);
    assert.equal(main.messages.find(m=>m.imageUrl)!.imageUrl,`/api/attachments/${image.id}/content`);
  }finally{release?.();rmSync(f.directory,{recursive:true,force:true});}
});
test('cancelled or invalid image output never claims completion or charges an image quota',async()=>{
  for(const cancel of [true,false]) {
    let release!:()=>void,started=false;
    const gate=new Promise<void>(r=>release=r);
    const f=await imageFixture(async()=>{started=true;await gate;return {content:'生成完成',imageUrl:cancel?imageFixturePng:'data:image/png;base64,bm90LWltYWdl'};});
    try {
      await f.service.dispatch(a,input(`operation_image_failure_${cancel}`,'画图'),key);
      const job=(await f.store.read()).chatOperations!.find(o=>o.workRun?.kind==='image')!;
      await f.service.resume(a,key);await waitFor(async()=>started);
      if(cancel)await f.service.cancelTask(a,job.conversationId!,key);
      release();await waitFor(async()=>(await f.store.read()).modelUsageRecords.some(r=>r.activity==='image_generation'&&r.status==='failed'));
      const db=await f.store.read();assert.equal(db.attachments.length,0);
      assert.equal(db.modelUsageRecords.find(r=>r.activity==='image_generation')!.chargedMicros,0);
      assert.equal(db.chatOperations!.find(o=>o.id===job.id)!.workRun!.state,cancel?'cancelled':'failed');
      const main=await f.service.state(a);
      assert.match(main.conversation!.messages[1].content,/文案先/);
      assert.match(main.conversation!.messages.at(-1)!.content,cancel?/已停止/:/未完成|没做成/);
      assert.doesNotMatch(main.conversation!.messages.at(-1)!.content,/已完成|生成完成/);
    }finally{release?.();rmSync(f.directory,{recursive:true,force:true});}
  }
});
test('one dispatcher can queue a text worker and an image worker under the same original request',async()=>{
  const f=await imageFixture(async()=>({content:'完成',imageUrl:imageFixturePng}));
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{artifactDirectory:f.directory,imageCall:async()=>({content:'完成',imageUrl:imageFixturePng}),modelCall:async(model,messages)=>model.id!=='router'?answer('文字产物'):messages.at(-1)?.role==='tool'?answer('文字和图片都已入队'):{...answer(''),toolCalls:[{id:'write',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'活动文案',instruction:'活动文案，折扣8折',executorId:'general'})}},{id:'draw',type:'function',function:{name:'generate_image',arguments:JSON.stringify({query:'活动海报，折扣8折'})}}]}});
  try {
    await service.dispatch(a,{...input('operation_image_text_pair_01','活动文案和海报，8折'),budget:.2},key);
    const jobs=(await f.store.read()).chatOperations!.filter(o=>o.workRun);
    assert.equal(jobs.length,2);assert.equal(new Set(jobs.map(o=>o.workRun!.originMessageId)).size,1);
    await service.resume(a,key);await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===2).catch(async()=>assert.fail(JSON.stringify((await f.store.read()).chatOperations!.filter(o=>o.workRun).map(o=>({state:o.workRun!.state,error:o.workRun!.error})))));
    const db=await f.store.read();assert.ok(db.modelUsageRecords.some(r=>r.activity==='task_worker'));assert.ok(db.modelUsageRecords.some(r=>r.activity==='image_generation'));
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('unconfigured image price cannot create or bill an image task',async()=>{
  let calls=0;const f=await imageFixture(async()=>{calls++;return {content:'不该调用',imageUrl:imageFixturePng};});
  try {
    await f.store.mutate(d=>{d.models.find(m=>m.id==='image-model')!.imagePowerPerCall=0;});
    await assert.rejects(()=>f.service.dispatch(a,input('operation_image_unpriced_01','画图'),key));
    const db=await f.store.read();assert.equal(calls,0);assert.equal(db.chatOperations!.filter(o=>o.workRun?.kind==='image').length,0);assert.equal(db.modelUsageRecords.filter(r=>r.activity==='image_generation').length,0);
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});
test('coordinator knowledge tools retrieve only exact authorized sources and answer without delegated work',async()=>{
 const f=fixture();
 await f.store.mutate(d=>{
  d.settings.aiTasks!.coordinator!.published!.tools.push('knowledge_search');
  d.knowledgeConnections.push({id:'source-own',workspaceId:'wa',provider:'getnote',status:'connected',clientId:'own',encryptedApiKey:'PRIVATE'} as any,{id:'source-foreign',workspaceId:'wb',provider:'getnote',status:'connected',clientId:'foreign',encryptedApiKey:'FOREIGN'} as any);
 });
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已查授权资料，没有匹配内容。'):{...answer(''),toolCalls:[{id:'kb',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'资料里如何安排活动'})}}]});
 await f.service.dispatch(a,input('operation_knowledge_direct_01','查查我的资料库'),key);
 assert.deepEqual(f.recalls,[{ws:'wa',ids:['source-own']}]);
 const db=await f.store.read();assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);
 assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE|FOREIGN|source-foreign/);
});
test('natural local execution requires the enabled tool, saves complete handoff and never runs a cloud worker', async () => {
 const f=fixture();let count=0;
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已受理，等待文件夹授权。'):{...answer(''),toolCalls:[{id:'local',type:'function',function:{name:'execute_local_task',arguments:JSON.stringify({taskId:null,title:'创建文档',instruction:'创建说明.md，仅含原文：荷叶饼好吃，一个5块。禁止添加其他内容。',executorId:'general'})}}]});
 const r=await f.service.dispatch(a,input('operation_natural_123','帮我创建说明.md，内容是荷叶饼好吃，一个5块，开始执行'),key,undefined,async(cid,mid)=>{count++;const db=await f.store.read();const job=db.chatOperations!.find(o=>o.workRun?.inputMessageId===mid)!;assert.match(job.workRun!.instruction,/禁止添加其他内容/);assert.equal(db.messages.find(m=>m.id===mid)!.conversationId,cid);return{id:'local-natural',status:'selecting_target'};});
 assert.ok(r.taskId);assert.equal(count,1);await f.service.resume(a,key);assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
 const denied=fixture();await denied.store.mutate(d=>{d.settings.aiTasks!.coordinator!.published!.tools=['delegate_task'];});denied.setRoute(()=>({...answer(''),toolCalls:[{id:'blocked',type:'function',function:{name:'execute_local_task',arguments:'{}'}}]}));
 await assertRoutingBlocked(denied.service.dispatch(a,input('operation_natural_denied','开始执行'),key,undefined,async()=>{throw Error('must never invoke');}));assert.equal((await denied.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('local-capable dispatch receives static-delivery boundaries without adding them to cloud-only prompts', async () => {
  for (const localAvailable of [false, true]) {
    const f = fixture();
    await f.store.mutate(db => { db.settings.aiTasks!.coordinator!.published!.prompt = '自定义调度提示，只回答当前要求。'; });
    f.setRoute(() => answer('可以交付自包含 HTML；现在先讨论，不执行。'));
    await f.service.dispatch(a, input(`operation_static_boundary_${localAvailable ? 'local' : 'cloud'}`, '先讨论本地独立静态网页怎么做，不要执行'), key, undefined,
      localAvailable ? async () => { throw Error('discussion must not execute local work'); } : undefined);
    const prompt = f.calls[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.equal(prompt.includes(localExecutionCapabilityGuidance), localAvailable);
    if (localAvailable) {
      assert.equal(prompt.split(localExecutionCapabilityGuidance).length, 2);
      assert.match(prompt, /不能联网或监听本地端口/);
      assert.match(prompt, /不擅自把“必须启动开发服务器”添加为必需目标/);
      assert.match(prompt, /用户明确要求的后端服务、服务启动或浏览器验证仍是必需目标/);
    }
    assert.equal((await f.store.read()).chatOperations!.filter(operation => operation.workRun).length, 0);
  }
});
test('on-demand task reading is private and local completion reporting is persistent and idempotent',async()=>{
 const f=fixture(),stamp=new Date().toISOString();await f.store.mutate(d=>{d.conversations.push({...a,id:'owned',title:'旧UI',modelId:'worker',messages:[{id:'old',role:'user',content:'文件只能写一句荷叶饼',createdAt:stamp}],archived:false,createdAt:stamp,updatedAt:stamp},{...b,id:'foreign',title:'不能读取',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});});
 let step=0;f.setRoute(messages=>{if(step++===0)return{...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query:'owned'})}}]};assert.match(JSON.stringify(messages),/文件只能写一句荷叶饼/);return answer('目标确认，请继续。');});
 await f.service.dispatch(a,input('operation_read_12345','之前UI的要求是什么？'),key);
 await f.store.mutate(d=>{d.executionTasks=[{...a,id:'local-completed',conversationId:'owned',sourceMessageId:'old',provider:'codex',instruction:'创建文档',deviceId:'fixture-key',status:'completed',finalResponse:'本轮进程结束，产物需查看',createdAt:stamp,updatedAt:stamp}];});
 await f.service.report(b,['local-completed'],key);assert.equal((await f.store.read()).executionTasks[0].reportedToCoordinatorAt,undefined);
 await f.service.report(a,['local-completed'],key);await f.service.report(a,['local-completed'],key);const db=await f.store.read();assert.equal(db.conversations.find(c=>c.coordinatorMain&&c.userId==='a')!.messages.filter(m=>m.id==='report_local-completed').length,1);assert.ok(db.executionTasks[0].reportedToCoordinatorAt);
 await f.store.mutate(d=>{const task=d.executionTasks[0];task.reportRound=1;task.reportedToCoordinatorAt=undefined;task.finalResponse='第二轮的独立结果';});await f.service.report(a,['local-completed'],key);await f.service.report(a,['local-completed'],key);assert.equal((await f.store.read()).conversations.find(c=>c.coordinatorMain&&c.userId==='a')!.messages.filter(m=>m.id==='report_local-completed_1').length,1);
 const blocked=fixture();await blocked.store.mutate(d=>{d.conversations.push({...b,id:'foreign',title:'秘密',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});});blocked.setRoute(()=>({...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query:'foreign'})}}]}));const denied=await blocked.service.dispatch(a,input('operation_read_denied','读旧事情'),key);assert.equal(denied.taskId,undefined);assert.doesNotMatch(JSON.stringify(blocked.calls)+denied.message.content,/秘密/);const deniedDb=await blocked.store.read();assert.equal(deniedDb.conversations.find(c=>c.id==='foreign')!.messages.length,0);assert.equal(deniedDb.chatOperations!.filter(o=>o.workRun).length,0);
});
test('an execution click cannot be acknowledged as dispatched without a real local task', async () => {
 const f=fixture(); f.setRoute(()=>answer('已转达并开始执行。'));
 let runs=0;
 await assert.rejects(()=>f.service.dispatch(a,{...input('operation_false_local','修改网页标题'),localExecution:true},key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}),/本机执行尚未开始/);
 assert.equal(runs,0);
 assert.equal(f.calls.find(c=>c.modelId==='router')!.requiredTool,'execute_local_task','an explicit execution click requires local routing, even with no feature, attachment or bound task');
 const db=await f.store.read();
 assert.ok(db.messages.some(m=>m.role==='user'&&m.content==='修改网页标题'));
 assert.ok(!db.messages.some(m=>m.role==='assistant'&&m.content==='已转达并开始执行。'));
});

test('explicit local execution can ask one controlled clarification without creating or starting any task',async()=>{
 const f=fixture(),stamp=new Date().toISOString();let runs=0;
 await f.store.mutate(d=>d.conversations.push(...[
  {...a,id:'website-ui',title:'官网 UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp},
  {...a,id:'product-ui',title:'ONE UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp},
  {...b,id:'foreign-ui',title:'PRIVATE_OTHER_UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp},
 ]));
 f.setRoute(messages=>{
  assert.doesNotMatch(JSON.stringify(messages),/PRIVATE_OTHER_UI/);
  return messages.at(-1)?.role==='tool'?answer('已经开始修改了。'):{...answer(''),toolCalls:[{id:'clarify-ui',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({clarificationQuestion:'你说的是官网 UI，还是 ONE UI？'})}}]};
 });
 const request={...input('operation_local_clarify_01','把那个 UI 标题改一下，开工'),localExecution:true};
 const reply=await f.service.dispatch(a,request,key,undefined,async()=>{runs++;return{id:'must-not-start',status:'running'};});
 assert.equal(reply.message.content,'还没开始操作电脑。你说的是官网 UI，还是 ONE UI？');
 assert.deepEqual(reply.taskIds,[]);assert.equal(reply.taskId,undefined);assert.equal(runs,0);
 const routing=f.calls.filter(c=>c.modelId==='router');
 assert.equal(routing[0].requiredTool,'execute_local_task');
 assert.equal(routing.at(-1)!.requiredTool,undefined);assert.deepEqual(routing.at(-1)!.tools,[]);
 const schema=routing[0].tools.find(t=>t.function.name==='delegate_task')!.function.parameters as {properties:Record<string,unknown>;oneOf:unknown[]};
 assert.ok(schema.properties.clarificationQuestion);assert.equal(schema.oneOf.length,2);
 const db=await f.store.read();assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);assert.equal((db.executionTasks??[]).length,0);
 assert.equal(db.conversations.filter(c=>!c.coordinatorMain).length,3);
 assert.equal(db.messages.filter(m=>m.role==='user'&&m.content===request.text).length,1);
 assert.ok(db.modelUsageRecords.every(row=>row.modelId==='router'),'clarification only uses the coordinator, never a worker');
 const calls=f.calls.length;await f.service.dispatch(a,request,key,undefined,async()=>{runs++;return{id:'must-not-retry',status:'running'};});await f.service.resume(a,key);
 assert.equal(f.calls.length,calls);assert.equal(runs,0);
 await assert.rejects(()=>f.service.dispatch(b,{...request,operationId:'operation_clarify_foreign',boundTaskId:'website-ui'},key,undefined,async()=>{runs++;return{id:'foreign',status:'running'};}),/不存在|未授权/);
 assert.equal(runs,0);
});

test('clarification accepts only its own question field and blocks any later delegation in the same request',async()=>{
 const invalid=fixture();let runs=0;
 invalid.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已开始了。'):{...answer(''),toolCalls:[{id:'mixed-clarification',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({clarificationQuestion:'要改哪个？',taskId:null,title:'猜测任务',instruction:'未经确认的目标',executorId:'general'})}}]});
 await assert.rejects(()=>invalid.service.dispatch(a,{...input('operation_clarify_mixed_01','修改那个文件'),localExecution:true},key,undefined,async()=>{runs++;return{id:'bad',status:'running'};}),/本机执行尚未开始/);
 assert.equal(runs,0);assert.equal((await invalid.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
 const guarded=fixture();
 guarded.setRoute(()=>({...answer(''),toolCalls:[
  {id:'ask-first',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({clarificationQuestion:'你指的是哪个文件？'})}},
  {id:'try-after-question',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'不能开始',instruction:'不准猜测',executorId:'general',outputKind:'local_file',featureIds:[],dependsOn:[]}]})}},
 ]}));
 const reply=await guarded.service.dispatch(a,{...input('operation_clarify_guard_01','修改那个文件'),localExecution:true},key,undefined,async()=>{runs++;return{id:'bad',status:'running'};});
 assert.equal(reply.message.content,'还没开始操作电脑。你指的是哪个文件？');assert.equal(runs,0);
 assert.equal((await guarded.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});

test('cancelling an explicit local clarification rejects a late acknowledgement without starting or saving an answer',async()=>{
 const f=fixture();let release!:(r:ToolChatResult)=>void;let step=0,runs=0;
 const gate=new Promise<ToolChatResult>(resolve=>{release=resolve;});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async()=>step++===0?{...answer(''),toolCalls:[{id:'ask-before-cancel',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({clarificationQuestion:'你指的是哪个项目？'})}}]}:gate});
 const operationId='operation_clarify_cancel_01';
 const pending=service.dispatch(a,{...input(operationId,'改那个项目，开始'),localExecution:true},key,undefined,async()=>{runs++;return{id:'bad',status:'running'};});
 const rejected=assert.rejects(pending,/已停止/);
 await waitFor(async()=>step===2);await assert.rejects(()=>service.cancel(b,operationId,key),/不存在/);await service.cancel(a,operationId,key);
 release(answer('你指的是哪个项目？'));await rejected;
 const db=await f.store.read();assert.equal(runs,0);assert.equal((db.executionTasks??[]).length,0);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);
 assert.equal(db.chatOperations!.find(o=>o.operationId===operationId)!.status,'interrupted');assert.equal(db.messages.filter(m=>m.role==='assistant').length,0);
});

test('explicit local routing forces only an enabled local tool and cannot enable disabled tools',async()=>{
 const f=fixture();let runs=0;
 await f.store.mutate(d=>{d.settings.aiTasks!.coordinator!.published!.tools=['execute_local_task'];});
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('本机要求已交出。'):{...answer(''),toolCalls:[{id:'enabled-local-only',type:'function',function:{name:'execute_local_task',arguments:JSON.stringify({taskId:null,title:'独立本机测试',instruction:'只创建测试文件，不覆盖、不联网。',executorId:'general'})}}]});
 await f.service.dispatch(a,{...input('operation_local_only_tool_01','创建独立测试文件'),localExecution:true},key,undefined,async()=>{runs++;return{id:'enabled-local',status:'queued'};});
 assert.equal(runs,1);assert.equal(f.calls[0].requiredTool,'execute_local_task');assert.deepEqual(f.calls[0].tools.map(t=>t.function.name),['execute_local_task']);
 const disabled=fixture();await disabled.store.mutate(d=>{d.settings.aiTasks!.coordinator!.published!.tools=[];});disabled.setRoute(()=>answer('没有可用分派工具。'));
 await assert.rejects(()=>disabled.service.dispatch(a,{...input('operation_local_no_tool_01','创建独立测试文件'),localExecution:true},key,undefined,async()=>{runs++;return{id:'disabled',status:'queued'};}),/本机执行尚未开始/);
 assert.equal(runs,1);assert.equal(disabled.calls[0].requiredTool,undefined);assert.deepEqual(disabled.calls[0].tools,[]);
});

test('a pending local clarification rechecks Key and exact knowledge bindings through its save transaction',async()=>{
 for(const change of ['revoked','rebound','key','after-read'] as const){
  const f=fixture(),marker=`CLARIFICATION_REVOKED_CONTENT_${change}`;let release!:(r:ToolChatResult)=>void,step=0,runs=0,keyValid=true;
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'clarify-source',workspaceId:a.workspaceId,provider:'getnote',status:'connected',clientId:'fixture-account',encryptedApiKey:'fixture-encrypted',createdAt:'now',updatedAt:'now'}));
  const gate=new Promise<ToolChatResult>(resolve=>{release=resolve;});
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async()=>step++===0?{...answer(''),toolCalls:[{id:'ask-sensitive',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({clarificationQuestion:`${marker}：你指的是哪个项目？`})}}]}:gate});
  const operationId=`operation_clarify_revoke_${change.replace('-','_')}`;
  const pending=service.dispatch(a,{...input(operationId,'改那个项目，开工'),sourceIds:['clarify-source'],localExecution:true},async()=>{if(!keyValid)throw new Error('本机授权已失效');},undefined,async()=>{runs++;return{id:'bad',status:'running'};});
  const rejected=assert.rejects(pending,/知识授权已变化|未完成分派|本机授权/);
  await waitFor(async()=>step===2);
  if(change==='key')keyValid=false;
  else if(change==='after-read'){
   const read=f.store.read.bind(f.store);let armed=true;
   f.store.read=async()=>{const snapshot=await read();if(armed){armed=false;await f.store.mutate(d=>{d.knowledgeConnections[0].status='revoked';});}return snapshot;};
  }else await f.store.mutate(d=>{if(change==='rebound')d.knowledgeConnections[0].clientId='different-fixture-account';else d.knowledgeConnections[0].status='revoked';});
  release(answer('这句确认可以发出。'));await rejected;
  const db=await f.store.read();assert.equal(runs,0);assert.equal((db.executionTasks??[]).length,0);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);
  assert.equal(db.chatOperations!.find(o=>o.operationId===operationId)!.status,'failed','failed authorization must not leave a pending operation');
  assert.equal(db.messages.filter(m=>m.role==='assistant').length,0);assert.doesNotMatch(JSON.stringify([...db.messages,...db.contextTraces]),new RegExp(marker));
 }
});

test('explicit answer-only messages cannot delegate even when bound to an existing task', async () => {
 const f=fixture(), stamp=new Date().toISOString();
 await f.store.mutate(d=>d.conversations.push({...a,id:'owned-read',title:'UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp}));
 f.setRoute(()=>answer('只读回执回答，没有执行。'));
 let runs=0;
 const reply=await f.service.dispatch(a,{...input('operation_answer_only_01','只回答，不执行、不重跑。'),boundTaskId:'owned-read'},key,undefined,async()=>{runs++;return{id:'never',status:'queued'};});
 assert.equal(reply.taskId,undefined);
 assert.equal(runs,0);
 assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
 const tools=f.calls.filter(c=>c.modelId==='router').flatMap(c=>c.tools.map(t=>t.function.name));
 assert.ok(!tools.includes('delegate_task')&&!tools.includes('execute_local_task'));
 const denied=fixture(); denied.setRoute(()=>({...answer(''),toolCalls:[{id:'forbidden',type:'function',function:{name:'execute_local_task',arguments:JSON.stringify({taskId:null,title:'旧任务',instruction:'不能执行',executorId:'general'})}}]}));
 await assertRoutingBlocked(denied.service.dispatch(a,input('operation_answer_only_02','只回答，不执行。'),key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}));
 assert.equal(runs,0);
 assert.equal((await denied.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
 const foreign=fixture(); foreign.setRoute(()=>answer('不应读取'));
 await foreign.store.mutate(d=>d.conversations.push({...a,id:'owned-read',title:'UI',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp}));
 await assert.rejects(()=>foreign.service.dispatch(b,{...input('operation_answer_only_03','只回答，不执行。'),boundTaskId:'owned-read'},key));
 assert.equal(foreign.calls.length,0);
 await assert.rejects(()=>f.service.dispatch(a,{...input('operation_answer_only_04','不执行。'),localExecution:true},key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}),/本机尚未开始/);
 assert.equal(runs,0);
});
test('local notices acknowledge their own execution round without suppressing a requested brief', async () => {
 const f=fixture(); await f.service.dispatch(a,input('operation_notice_init','你好'),key);
 const stamp=new Date().toISOString();
 await f.store.mutate(d=>{
  d.conversations.push({...a,id:'notice-task',title:'本机测试',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});
  d.executionTasks=[{...a,id:'notice-execution',conversationId:'notice-task',sourceMessageId:'m',provider:'local_agent',instruction:'safe',deviceId:'fixture-key',status:'completed',reportRound:0,finalResponse:'已回读',createdAt:stamp,updatedAt:stamp}];
 });
 await assert.rejects(()=>f.service.acknowledge(b,['notice-execution']));
 await assert.rejects(()=>f.service.acknowledge(a,['notice-execution','missing']));
 assert.equal((await f.store.read()).executionTasks[0].noticeReadRound,undefined);
 await f.service.acknowledge(a,['notice-execution']); await f.service.acknowledge(a,['notice-execution']);
 const reviewed=await f.service.state(a);
 assert.equal(reviewed.notices.length,0,'the already-reviewed result is still briefed in main chat, then its note retracts');
 assert.match(reviewed.conversation!.messages.at(-1)!.content,/已回读/);
 assert.ok((await f.store.read()).executionTasks[0].reportedToCoordinatorAt);
 await f.service.report(a,['notice-execution'],key);
 assert.ok((await f.store.read()).executionTasks[0].reportedToCoordinatorAt);
 assert.equal((await f.service.state(a)).notices.length,0,'reviewed and reported result is fully acknowledged');
 await f.store.mutate(d=>{d.executionTasks[0].reportRound=1;d.executionTasks[0].reportedToCoordinatorAt=undefined;});
 assert.equal((await f.service.state(a)).notices.length,1);
});
test('saving a task alone is not proof that the local executor accepted it',async()=>{
 const f=fixture();let runs=0;
 const result=await f.service.dispatch(a,{...input('operation_local_rejected','UI 改标题'),localExecution:true},key,undefined,async()=>{runs++;throw new Error('连接执行器失败');});
 assert.match(result.conversation.messages.at(-1)?.content ?? '',/(尚|还)不能确认(?:已开始或完成|是否已经开始)/);
 assert.equal(runs,1);
 const db=await f.store.read();
 assert.ok(db.messages.some(m=>m.role==='user'&&m.content==='UI 改标题'));
 assert.equal((db.executionTasks ?? []).length,0);
 assert.equal(db.chatOperations?.find(o=>o.operationId==='operation_local_rejected')?.status,'completed');
});
test('a batch briefing is one message with all task links and replays never duplicate it', async () => {
 const f=fixture(); await f.service.dispatch(a,input('operation_batch_start','你好'),key);
 const stamp=new Date().toISOString();
 await f.store.mutate(d=>{
   d.executionTasks=['one','two'].map(id=>({...a,id,conversationId:id,sourceMessageId:id,provider:'local_agent',instruction:'safe',deviceId:'fixture-key',status:'completed',finalResponse:`${id} 已创建并回读：/QA/${id}.md`,createdAt:stamp,updatedAt:stamp}));
   for(const id of ['one','two']) d.conversations.push({...a,id,title:id,modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});
 });
 await f.service.report(a,['one','two'],key);await f.service.report(a,['two','one'],key);
 const state=await f.service.state(a), brief=state.conversation!.messages.filter(m=>m.id?.startsWith('report_'));
 assert.equal(brief.length,1);assert.match(brief[0].content,/one.*已创建/);assert.match(brief[0].content,/two.*已创建/);
 assert.deepEqual(state.links.filter(l=>l.messageId===brief[0].id).map(l=>l.taskId).sort(),['one','two']);
 assert.equal(state.notices.length,2);
 assert.ok(state.notices.every(n=>n.reported&&!n.read),'main-chat briefing does not imply user reviewed either task');
});
test('local dispatch preserves the handoff, bypasses cloud worker and replay never executes twice', async () => {
  const f = fixture(), executed: string[] = [];
  const run = async (cid: string, mid: string) => { const d=await f.store.read(); assert.equal(d.messages.find(m=>m.id===mid)?.content,'UI 标题改成荷叶饼，开工'); executed.push(cid); return {id:'ext-fixture',status:'queued'}; };
  const request={...input('operation_local_1234','UI 标题改成荷叶饼，开工'),localExecution:true};
  const result = await f.service.dispatch(a,request,key,undefined,run);
  assert.equal(f.calls.find(c=>c.modelId==='router')!.requiredTool,'execute_local_task');
  assert.equal(f.calls.filter(c=>c.modelId==='router').at(-1)!.requiredTool,undefined,'the acknowledgement must not start a second execution');
  await f.service.resume(a,key);
  assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
  assert.equal((await f.service.task(a,result.taskId!)).jobs[0].state,'prepared');
  await f.service.dispatch(a,request,key,undefined,run);
  assert.equal(executed.length,1);
  await assert.rejects(f.service.dispatch(b,{...request,operationId:'operation_local_other',boundTaskId:result.taskId},key,undefined,run),/不存在|未授权/);
});
test('completed result returns to the main dialogue once and cannot leak another user result',async()=>{
  const f=fixture(),r=await f.service.dispatch(a,input('operation_report_123','UI'),key);
  await f.service.resume(a,key); await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[0].state==='completed');
  const d=await f.store.read(),id=d.chatOperations!.find(o=>o.workRun)!.id;
  await f.service.report(b,[id],key); assert.equal((await f.store.read()).conversations.find(c=>c.userId==='b'&&c.coordinatorMain),undefined);
  await f.service.report(a,[id],key);await f.service.report(a,[id],key);
  const main=(await f.store.read()).conversations.find(c=>c.userId==='a'&&c.coordinatorMain)!;
  assert.equal(main.messages.filter(m=>m.id===`report_${id}`).length,1);
  assert.match(main.messages.find(m=>m.id===`report_${id}`)!.content,/真实合成模型返回的成果/);
  const reported=await f.service.state(a);
  assert.equal(reported.notices.length,1);
  assert.equal(reported.notices[0].reported,true);
  assert.equal(reported.notices[0].read,false);
});
test("failed core routing preserves only its owner's safe diagnostic receipt", async () => {
  const f = fixture();
  f.setRoute(() => { throw new Error("upstream api_key=SECRET"); });
  await assert.rejects(f.service.dispatch(a, input("operation_route_failure", "UI"), key));
  const db = await f.store.read(), operation = db.chatOperations?.find(o => o.operationId === "operation_route_failure")!;
  assert.equal(operation.status, "failed");
  const traces = db.contextTraces.filter(t => t.requestId === operation.requestId);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].workspaceId, a.workspaceId);
  assert.equal(traces[0].userId, a.userId);
  assert.match(traces[0].responsePreview, /未完成分派/);
  assert.doesNotMatch(JSON.stringify(traces), /api_key|SECRET/);
  assert.equal(db.contextTraces.filter(t => t.workspaceId === b.workspaceId).length, 0);
});
test('a bare promise is repaired in the same turn into a real durable receipt, and replay never dispatches twice',async()=>{
 const f=fixture();let turns=0;
 f.setRoute(messages=>{turns++;if(turns===1)return answer('我会制作一份简短说明，并保存结果。');if(turns===2){assert.match(messages.at(-1)!.content!,/还没有成功分派的回执/);return {...answer(''),toolCalls:[{id:'actually-start',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'合成说明',instruction:'只整理合成测试材料',executorId:'general',featureIds:[]})}}]};}return answer('已安排好了。');});
 const request=input('operation_promise_repair_01','没事儿，随便你编，开始做吧');
 const result=await f.service.dispatch(a,request,key);assert.equal(result.taskIds.length,1);assert.equal(turns,3);
 const replay=await f.service.dispatch(a,request,key);assert.deepEqual(replay.taskIds,result.taskIds);assert.equal(turns,3);
 assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun?.parentOperationId===request.operationId).length,1);
 await assert.rejects(()=>f.service.task(b,result.taskIds[0]));
});
test('single-task validation returns reviewed repair hints without queueing invalid or foreign tasks',async()=>{
 for(const bad of [{outputDestination:'notion'},{executorId:'unknown-private-executor'},{taskId:'foreign-private-task'},{featureIds:['duplicate','duplicate']},{instruction:''}]){
  const f=fixture();let turns=0;
  const valid={taskId:null,title:'合成便笺',instruction:'只整理合成材料',executorId:'general',featureIds:[]};
  f.setRoute(messages=>{turns++;
   if(turns===2){const feedback=JSON.parse(messages.at(-1)!.content!);assert.equal(feedback.code,'TOOL_INPUT_REPAIR');assert.doesNotMatch(JSON.stringify(feedback),/unknown-private-executor|foreign-private-task/);}
   if(turns<3)return {...answer(''),toolCalls:[{id:`repair-${turns}`,type:'function',function:{name:'delegate_task',arguments:JSON.stringify(turns===1?{...valid,...bad}:valid)}}]};
   return answer('已经安排好了。');
  });
  const request=input('operation_delegate_repair_01','新建一份合成便笺');
  const result=await f.service.dispatch(a,request,key);assert.equal(turns,3);assert.equal(result.taskIds.length,1);
  const db=await f.store.read();assert.equal(db.chatOperations!.filter(o=>o.workRun).length,1);
  assert.equal(db.contextTraces.find(t=>t.requestId===db.chatOperations!.find(o=>o.operationId===request.operationId)!.requestId)!.executionSteps![0].status,'rejected');
  assert.equal((await f.service.dispatch(a,request,key)).taskIds.length,1);assert.equal(turns,3);
  await assert.rejects(()=>f.service.task(b,result.taskIds[0]));
 }
});
test('friendly provider feedback is durable, but revocation immediately before save cannot leave pending or leak a reply',async()=>{
 for(const revoke of [false,true]){
  const f=fixture();let threw=false,armed=false,calls=0;
  f.setRoute(()=>{calls++;threw=true;throw new ModelRequestError(503,'暂时无法连接');});
  const read=f.store.read.bind(f.store);
  f.store.read=async()=>{const snapshot=await read();if(armed){armed=false;await f.store.mutate(d=>{d.users.find(u=>u.id===a.userId)!.enabled=false;});}return snapshot;};
  const verify=async()=>{if(revoke&&threw){armed=true;threw=false;}};
  const request=input(`operation_provider_feedback_${revoke}`,'只整理合成测试资料');
  if(revoke){await assert.rejects(()=>f.service.dispatch(a,request,verify),/账号或空间不可用/);const db=await read();assert.equal(db.chatOperations!.find(o=>o.operationId===request.operationId)!.status,'failed');assert.equal(db.messages.filter(m=>m.role==='assistant').length,0);}
  else{const reply=await f.service.dispatch(a,request,verify);assert.match(reply.message.content,/中断.*核对/);assert.equal(reply.taskIds.length,0);await f.service.dispatch(a,request,verify);}
  assert.equal(calls,1);
 }
});
test('a real clarification is not forced into execution; unavailable card is repaired or returned with a next step',async()=>{
 const question=fixture();question.setRoute(()=>answer('这张图想用什么风格？'));
 assert.equal((await question.service.dispatch(a,input('operation_question_0001','帮我做一张图'),key)).taskIds.length,0);
 const f=fixture();let turns=0;
 f.setRoute(messages=>{turns++;if(turns===1)return {...answer(''),toolCalls:[{id:'wrong',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'合成任务',instruction:'只用合成资料',executorId:'general',outputKind:'text',featureIds:['feature:unknown-private'],dependsOn:[]}]})}}]};assert.match(messages.at(-1)!.content!,/TOOL_INPUT_REPAIR/);return answer('好像工具还没就位，这次还没开始。可以稍后告诉我继续。');});
 const request=input('operation_unknown_card_01','做个合成成果');const result=await f.service.dispatch(a,request,key);
 assert.equal(result.taskIds.length,0);assert.match(result.message.content,/工具还没就位/);assert.equal(turns,2);
 const db=await f.store.read();assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);assert.equal(db.conversations.find(c=>c.coordinatorMain)!.messages.at(-1)!.content,result.message.content);
 assert.equal((await f.service.dispatch(a,request,key)).message.content,result.message.content);assert.equal(turns,2);
});
test('discovered feature namespace dispatches the actual authorized feature, never another tenant release',async()=>{
 const f=fixture();await f.store.mutate(d=>{const values={name:'合成说明',author:'ONE',description:'整理合成资料',instructions:'只整理合成资料',limitations:'不读取外部资料',integration:'question_answer' as const,knowledgeMode:'none' as const,modelId:'special',usageMultiplier:.6,tools:[]};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'namespace-test',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'namespace-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}];});
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已经接到任务。'):{...answer(''),toolCalls:[{id:'namespace',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[{taskId:null,title:'合成说明',instruction:'整理合成资料',executorId:'general',outputKind:'text',featureIds:['feature:namespace-test'],dependsOn:[]}]})}}]});
 const reply=await f.service.dispatch(a,input('operation_namespace_0001','整理合成资料'),key);assert.equal(reply.taskIds.length,1);
 const job=(await f.store.read()).chatOperations!.find(o=>o.workRun?.parentOperationId==='operation_namespace_0001')!.workRun!;assert.deepEqual(job.skills.map(f=>f.id),['namespace-test']);
 await assert.rejects(()=>f.service.task(b,reply.taskIds[0]));
});
test("omitted task budget has a usable bounded default; explicit smaller caps remain unchanged", async () => {
  const f = fixture();
  const first = await f.service.dispatch(a, { operationId: "operation_default_cap", text: "UI" }, key);
  const second = await f.service.direct(a, first.taskId!, { operationId: "operation_explicit_cap", text: "补充", budget: 0.02 }, key);
  const db = await f.store.read();
  assert.equal(db.chatOperations?.find(o => o.operationId === "operation_default_cap_work")?.workRun?.budget, 0.5);
  assert.equal(db.chatOperations?.find(o => o.operationId === "operation_explicit_cap")?.workRun?.budget, 0.02);
  assert.equal(second.taskId, first.taskId);
});
test('implicit routing is wallet-backed instead of a hidden .5 cap; explicit route caps still block without a model charge',async()=>{
 const f=fixture();await f.store.mutate(d=>{const m=d.models.find(m=>m.id==='router')!;m.inputPowerPerMillion=300;m.outputPowerPerMillion=300;});
 let calls=0;f.setRoute(()=>{calls++;return {...answer('用公开合成文字直接回答。'),usage:{inputTokens:1000,outputTokens:1000,totalTokens:2000,source:'provider'}};});
 const reply=await f.service.dispatch(a,{operationId:'route-wallet-backed-001',text:'请只回答一段合成文字，不执行任务'},key);
 assert.equal(reply.taskIds.length,0);assert.equal(calls,1);
 let db=await f.store.read();assert.equal(db.modelUsageRecords[0].chargedMicros,600000);assert.equal(db.powerLedger.length,1);assert.equal(db.powerAccounts[1].balanceMicros,100e6);
 const denied=await f.service.dispatch(a,{operationId:'route-explicit-cap-001',text:'只回答，不执行',routeBudget:.001},key);
 assert.match(denied.message.content,/不是账户没电/);assert.equal(denied.taskIds.length,0);assert.equal(calls,1);db=await f.store.read();assert.equal(db.modelUsageRecords.length,1);
});
async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}
/** A reviewed failure can now be a durable ONE reply instead of a thrown UI
 * error. Both paths must prove no dispatch, and a returned reply has a next step. */
async function assertRoutingBlocked(promise:ReturnType<CoordinatorService['dispatch']>,expected?:RegExp){
 await promise.then(result=>{assert.equal(result.taskIds.length,0);assert.equal(result.taskId,undefined);assert.match(result.message.content,/没能开始|未完成|还没|没就位|上限|预算/);assert.match(result.message.content,/继续|调整|稍后/);},error=>{if(expected)assert.match(String(error),expected);});
}
const input = (operationId: string, text: string) => ({
  operationId,
  text,
  budget: 0.1,
  routeBudget: 0.1,
});

test("HTTP routes require trusted Key/admin gates and isolate task and operation receipts", async () => {
  const f = fixture(),
    app = express();
  app.use(express.json());
  const auth: express.RequestHandler = (req, res, next) => {
    const id = req.headers["x-fixture-user"];
    if (
      !["a", "b"].includes(String(id)) ||
      req.headers["x-fixture-key"] !== "present"
    ) {
      res.status(428).json({ error: "Key required" });
      return;
    }
    req.user = { id: String(id), role: id === "a" ? "admin" : "user" } as any;
    req.workspaceId = id === "a" ? "wa" : "wb";
    next();
  };
  const admin: express.RequestHandler = (req, res, next) => {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "admin required" });
      return;
    }
    next();
  };
  installCoordinatorRoutes(app, [auth], [auth, admin], f.store, key, {
    recallWithDiagnostics: async () => ({
      chunks: [],
      failures: [],
      status: "no_match",
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as { port: number },
    base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    user = "a",
    method = "GET",
    body?: unknown,
    keyPresent = true,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-fixture-user": user,
        ...(keyPresent ? { "x-fixture-key": "present" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request("/api/coordinator", "a", "GET", undefined, false)).status,
      428,
    );
    assert.equal((await request("/api/admin/executors", "b")).status, 403);
    const created = await request("/api/admin/executors", "a", "POST", {
      revision: 0,
      action: "draft",
      values: { ...executorDefaults(), name: "接口测试执行器" },
    });
    assert.equal(created.status, 200);
    const profile = (await created.json()) as { id: string };
    assert.equal(
      (await request(`/api/admin/executors/${profile.id}`, "b")).status,
      403,
    );
    assert.equal(
      (
        await request(`/api/admin/executors/${profile.id}`, "a", "POST", {
          revision: 0,
          action: "publish",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`/api/admin/executors/${profile.id}`, "a", "POST", {
          revision: 1,
          action: "publish",
        })
      ).status,
      200,
    );
    const result = await f.service.dispatch(
      a,
      input("operation_http_0001", "UI"),
      key,
    );
    assert.equal(
      (await request(`/api/coordinator/tasks/${result.taskId}`, "b")).status,
      404,
    );
    assert.equal(
      (await request("/api/coordinator/messages/operation_http_0001", "b"))
        .status,
      404,
    );
    const receipt = await request(
      "/api/coordinator/messages/operation_http_0001",
    );
    assert.equal(receipt.status, 200);
    for(const endpoint of [`/api/coordinator/messages/operation_http_0001/stop`,`/api/coordinator/tasks/${result.taskId}/stop`]){
      assert.equal((await request(endpoint,'a','POST',{},false)).status,428);
      assert.equal((await request(endpoint,'b','POST',{})).status,404);
      assert.equal((await request(endpoint,'a','POST',{})).status,200);
    }
    const json = JSON.stringify(await receipt.json());
    assert.doesNotMatch(json, /fixture-only|modelPrompt|credentials/);
    assert.equal(
      (
        await request("/api/coordinator/resume", "a", "POST", {
          continueTaskId: result.taskId,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/api/coordinator/messages", "a", "POST", {
          ...input("operation_attach_01", "UI"),
          attachmentIds: ["file"],
        })
      ).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("real model-backed routing preserves one main conversation, separates original words, and replay does not call or charge twice", async () => {
  const f = fixture();
  const first = await f.service.dispatch(
      a,
      input("operation_first_001", "UI 保留输入框"),
      key,
    ),
    second = await f.service.dispatch(
      a,
      input("operation_second_02", "露营要带帐篷"),
      key,
    );
  assert.equal(first.conversation.id, second.conversation.id);
  assert.notEqual(first.taskId, second.taskId);
  const ui = await f.service.task(a, first.taskId!),
    camp = await f.service.task(a, second.taskId!);
  assert.equal(ui.conversation.messages[0].content, "UI 保留输入框");
  assert.equal(camp.conversation.messages[0].content, "露营要带帐篷");
  const calls = f.calls.length,
    ledger = (await f.store.read()).powerLedger.length;
  const replay = await f.service.dispatch(
    a,
    input("operation_first_001", "UI 保留输入框"),
    key,
  );
  assert.equal(replay.taskId, first.taskId);
  assert.equal(f.calls.length, calls);
  assert.equal((await f.store.read()).powerLedger.length, ledger);
  await assert.rejects(() =>
    f.service.dispatch(a, input("operation_first_001", "更改内容"), key),
  );
  const chat = await f.service.dispatch(
    a,
    input("operation_hello_001", "你好"),
    key,
  );
  assert.equal(chat.taskId, undefined);
  assert.equal(f.calls.at(-1)!.requiredTool, undefined, "ordinary conversation retains automatic routing");
  assert.equal((await f.service.state(a)).total, 2);
});
test("same-task supplements wait; another task proceeds; running snapshot excludes the new supplement", async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let count = 0;
  f.setWorker(async (messages) => {
    if (++count === 1) await blocked;
    return answer("本轮成果");
  });
  const first = await f.service.dispatch(
    a,
    input("operation_queue_001", "UI 第一轮"),
    key,
  );
  await f.service.resume(a, key);
  await waitFor(async () => f.calls.some((c) => c.modelId === "worker"));
  await f.service.dispatch(
    a,
    {
      ...input("operation_queue_002", "再补充一个边界"),
      boundTaskId: first.taskId,
    },
    key,
  );
  const camp = await f.service.dispatch(
    a,
    input("operation_queue_003", "露营第二件事"),
    key,
  );
  await f.service.resume(a, key);
  await waitFor(async () =>
    (await f.service.task(a, camp.taskId!)).jobs.some(
      (j) => j.state === "completed",
    ),
  );
  const interim = await f.service.task(a, first.taskId!);
  assert.equal(interim.jobs[0].state, "running");
  assert.equal(interim.jobs[1].state, "queued");
  assert.doesNotMatch(
    JSON.stringify(f.calls.find((c) => c.modelId === "worker")!.messages),
    /再补充一个边界|露营第二件事/,
  );
  release();
  await waitFor(async () =>
    (await f.service.task(a, first.taskId!)).jobs.every(
      (j) => j.state === "completed",
    ),
  );
  const db = await f.store.read();
  assert.equal(
    db.conversations
      .filter((c) => c.coordinatorMain)[0]
      .messages.filter((m) => m.content === "本轮成果").length,
    0,
  );
  assert.equal((await f.service.state(a)).notices.length, 2,'a task bubble represents its latest attempt, not each earlier supplement');
});
test("direct task continuation never changes the main conversation, and scoped reads/notifications cannot cross users", async () => {
  const f = fixture(),
    r = await f.service.dispatch(
      a,
      input("operation_direct_001", "UI 第一句"),
      key,
    );
  const main = (await f.service.state(a)).conversation!;
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_direct_002", "直接补充"),
    key,
  );
  assert.deepEqual((await f.service.state(a)).conversation, main);
  await assert.rejects(() => f.service.task(b, r.taskId!));
  await assert.rejects(() =>
    f.service.direct(b, r.taskId!, input("operation_direct_003", "越权"), key),
  );
  await f.service.resume(a, key);
  await waitFor(async () =>
    (await f.service.task(a, r.taskId!)).jobs.every(
      (j) => j.state === "completed",
    ),
  );
  const notices = (await f.service.state(a)).notices;
  await assert.rejects(() => f.service.acknowledge(b, [notices[0].id]));
  await f.service.acknowledge(
    a,
    notices.map((n) => n.id),
  );
  await f.service.acknowledge(
    a,
    notices.map((n) => n.id),
  );
  const reviewed=await f.service.state(a);
  assert.equal(reviewed.notices.length, 0,'idle task updates have been briefed; viewing details clears only the review badge');
  await f.service.report(a,notices.map(n=>n.id),key);
  assert.equal((await f.service.state(a)).notices.length,0);
  assert.equal((await f.service.state(b)).total, 0);
});
test("executor profiles use different models and immutable versions; stopping the profile stops further calls", async () => {
  const f = fixture();
  const p = await f.store.mutate((d) =>
    updateExecutor(d, "a", undefined, {
      revision: 0,
      action: "draft",
      values: {
        ...executorDefaults(),
        name: "专业设计",
        description: "设计任务",
        modelId: "special",
        prompt: "SPECIAL_VERSION_ONE",
      },
    }),
  );
  await f.store.mutate((d) =>
    updateExecutor(d, "a", p.id, { revision: 1, action: "publish" }),
  );
  f.setRoute((messages) =>
    messages.at(-1)?.role === "tool"
      ? answer("已分派")
      : {
          ...answer(""),
          toolCalls: [
            {
              id: "d",
              type: "function",
              function: {
                name: "delegate_task",
                arguments: JSON.stringify({
                  taskId: null,
                  title: "设计",
                  instruction: "完成设计",
                  executorId: p.id,
                }),
              },
            },
          ],
        },
  );
  const r = await f.service.dispatch(
    a,
    input("operation_profile_001", "做 UI"),
    key,
  );
  await f.store.mutate((d) => {
    updateExecutor(d, "a", p.id, {
      revision: 2,
      action: "draft",
      values: {
        ...executorDefaults(),
        name: "专业设计",
        description: "设计任务",
        modelId: "worker",
        prompt: "SPECIAL_VERSION_TWO",
      },
    });
    updateExecutor(d, "a", p.id, { revision: 3, action: "publish" });
  });
  await f.service.resume(a, key);
  await waitFor(
    async () =>
      (await f.service.task(a, r.taskId!)).jobs[0].state === "completed",
  );
  const worker = f.calls.find((c) => c.modelId === "special")!;
  assert.match(worker.messages[0].content!, /SPECIAL_VERSION_ONE/);
  assert.doesNotMatch(worker.messages[0].content!, /SPECIAL_VERSION_TWO/);
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_profile_002", "补充"),
    key,
  );
  await f.store.mutate((d) =>
    updateExecutor(d, "a", p.id, { revision: 4, action: "pause" }),
  );
  const count = f.calls.length;
  await f.service.resume(a, key);
  await waitFor(
    async () => (await f.service.task(a, r.taskId!)).jobs[1].state === "failed",
  );
  assert.equal(f.calls.length, count);
});
test("Key loss, insufficient budget and malformed/foreign routing never trigger a worker call", async () => {
  const f = fixture();
  await assert.rejects(() =>
    f.service.dispatch(a, input("operation_denied_001", "UI"), async () => {
      throw Error("Key absent");
    }),
  );
  assert.equal(f.calls.length, 0);
  await assertRoutingBlocked(
    f.service.dispatch(
      a,
      { ...input("operation_budget_001", "UI"), routeBudget: 0.001 },
      key,
    ),
  );
  assert.equal(f.calls.length, 0);
  f.setRoute(() => ({
    ...answer(""),
    toolCalls: [
      {
        id: "d",
        type: "function",
        function: {
          name: "delegate_task",
          arguments: JSON.stringify({
            taskId: "foreign",
            title: "偷读",
            instruction: "test",
            executorId: "general",
          }),
        },
      },
    ],
  }));
  await assert.rejects(() =>
    f.service.dispatch(
      a,
      { ...input("operation_foreign_01", "UI"), boundTaskId: "foreign" },
      key,
    ),
  );
  const before = (await f.store.read()).conversations.length;
  await assertRoutingBlocked(f.service.dispatch(a, input("operation_invalid_1", "UI"), key));
  assert.equal((await f.store.read()).conversations.length, before);
  assert.equal(f.calls.filter((c) => c.modelId === "worker").length, 0);
});
test("failed tasks pause their supplements; restart marks only in-flight work interrupted and never replays it", async () => {
  const f = fixture();
  f.setWorker(async () => {
    throw Error("upstream unavailable");
  });
  const r = await f.service.dispatch(
    a,
    input("operation_fail_0001", "UI"),
    key,
  );
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_fail_0002", "补充保留"),
    key,
  );
  await f.service.resume(a, key);
  await waitFor(
    async () => (await f.service.task(a, r.taskId!)).jobs[0].state === "failed",
  );
  assert.equal((await f.service.task(a, r.taskId!)).jobs[1].state, "queued");
  assert.equal((await f.service.state(a)).tasks.find(t=>t.id===r.taskId)!.paused,true);
  await f.service.resume(a, key);
  assert.equal((await f.service.task(a, r.taskId!)).jobs[1].state, "queued");
  f.setWorker(undefined);
  await f.service.resume(a, key, r.taskId);
  await waitFor(
    async () =>
      (await f.service.task(a, r.taskId!)).jobs[1].state === "completed",
  );
  await f.service.direct(
    a,
    r.taskId!,
    input("operation_fail_0003", "新补充"),
    key,
  );
  await f.store.mutate((d) => {
    const ops = d.chatOperations!.filter((o) => o.workRun);
    ops[0].status = "pending";
    ops[0].workRun!.state = "running";
    reconcileInterruptedChatOperations(d);
    assert.equal(ops[0].workRun!.state, "interrupted");
    assert.equal(ops.at(-1)!.workRun!.state, "queued");
  });
  const calls = f.calls.length;
  await f.service.resume(a, key);
  assert.equal(f.calls.length, calls);
});

test('task deletion is scoped, preserves originals, cancels queue and restore never replays work',async()=>{
  const f=fixture(),r=await f.service.dispatch(a,input('operation_delete_001','UI 删除回归'),key);
  const before=(await f.service.task(a,r.taskId!)).conversation.messages;
  await assert.rejects(()=>f.service.removeTask(b,r.taskId!,key),/不存在/);
  await assert.rejects(()=>f.service.restoreTask(b,r.taskId!,key),/不存在/);
  await f.service.removeTask(a,r.taskId!,key);
  assert.ok(!(await f.service.state(a)).tasks.some(t=>t.id===r.taskId));
  assert.deepEqual((await f.store.read()).conversations.find(c=>c.id===r.taskId)!.messages,before);
  await f.service.resume(a,key);assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
  await f.service.restoreTask(a,r.taskId!,key);
  await f.service.resume(a,key,r.taskId);
  assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
  assert.equal((await f.service.task(a,r.taskId!)).jobs[0].state,'cancelled');
  await assert.rejects(()=>f.service.resume(a,key,r.taskId,true),/没有尚未开始的待办/);
});

test('restoring a genuinely completed task restores its terminal state without replay, but unresolved work stays paused',async()=>{
 for(const mode of ['completed','failed','uncertain','queued','local']){
  const f=fixture(),r=await f.service.dispatch(a,input(`operation_restore_${mode}`,'UI 恢复状态回归'),key);
  await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.conversationId===r.taskId&&o.workRun)!;op.workRun!.state=mode==='failed'?'failed':'completed';op.workRun!.resultOutcome=mode==='failed'?'partial':'completed';
   if(mode==='uncertain')op.workRun!.notionReceipt={state:'uncertain',delivery:'unknown'};
   if(mode==='queued')d.chatOperations!.push({...structuredClone(op),id:'other-queued',workRun:{...structuredClone(op.workRun!),state:'queued'}});
   if(mode==='local')d.executionTasks=[{...a,id:'local-uncertain',conversationId:r.taskId,status:'failed',result:{error:'execution_unconfirmed'}} as any];
  });
  await f.service.removeTask(a,r.taskId!,key);await f.service.restoreTask(a,r.taskId!,key);
  const detail=await f.service.task(a,r.taskId!);assert.equal(detail.conversation.workPaused,mode!=='completed',mode);
  assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
 }
});

test('explicit latest-only resume retains older inputs without executing or billing them',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_latest_001','UI 第一条'),key);
 await f.service.direct(a,r.taskId!,{operationId:'operation_latest_002',text:'最新修改要求'},key);
 await f.store.mutate(d=>{d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;});
 await assert.rejects(()=>f.service.resume(b,key,r.taskId,true),/不存在/);
 await f.service.resume(a,key,r.taskId,true);
 await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[1].state==='completed');
 const detail=await f.service.task(a,r.taskId!);
 assert.equal(detail.jobs[0].state,'cancelled');assert.equal(detail.jobs[0].charges.length,0);
 assert.ok(detail.conversation.messages.some(m=>m.content==='UI 第一条'));
 assert.equal(f.calls.filter(c=>c.modelId==='worker').length,1);
});
test('explicit retry preserves original, uses current configuration and deduplicates repeated clicks',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_retry_001','UI 原始要求'),key);
 const source=(await f.service.task(a,r.taskId!)).jobs[0];
 await f.store.mutate(d=>{const o=d.chatOperations!.find(o=>o.id===source.id)!;o.status='failed';o.workRun!.state='failed';d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;
 updateTaskConfig(d.settings,d.models,'task_worker',{revision:2,action:'draft',values:{...defaultTaskValues('task_worker'),modelId:'special'}},'a','now');
 updateTaskConfig(d.settings,d.models,'task_worker',{revision:3,action:'publish'},'a','now');});
 await assert.rejects(()=>f.service.retryLatest(b,r.taskId!,source.id,undefined,key),/不存在/);
 await f.service.retryLatest(a,r.taskId!,source.id,undefined,key);
 await f.service.retryLatest(a,r.taskId!,source.id,undefined,key);
 const before=await f.service.task(a,r.taskId!);
 assert.equal(before.jobs.length,2);assert.equal(before.jobs[0].state,'failed');assert.equal(before.jobs[1].modelId,'special');assert.equal(before.conversation.workPaused,false);
 assert.equal(before.conversation.messages.filter(m=>m.content==='UI 原始要求').length,2);
 await f.service.resume(a,key);
 await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[1].state==='completed');
 assert.equal(f.calls.filter(c=>c.modelId==='special').length,1);
});
test('task lookup accepts unique exact title, rejects unknown IDs without failing routing or leaking other workspaces',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_lookup_001','UI 原话'),key);
 await f.store.mutate(d=>{
   d.messages.push({...a,id:'execution_receipt_owned',conversationId:r.taskId!,role:'assistant',content:'实测产物：已保存结果.html',createdAt:new Date().toISOString()});
   d.messages.push({...b,id:'execution_receipt_foreign',conversationId:r.taskId!,role:'assistant',content:'跨空间秘密',createdAt:new Date().toISOString()});
 });
 let query='UI 设计';
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已核对'):({...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query})}}]}));
 await f.service.dispatch(a,input('operation_lookup_002','请查看任务'),key);
 const result=f.calls.at(-1)!.messages.at(-1)!.content!;assert.match(result, new RegExp(r.taskId!));
 assert.match(result,/实测产物：已保存结果.html/);assert.doesNotMatch(result,/跨空间秘密/);
 assert.ok(JSON.parse(result).handoffs.length,'resolved title also loads the correct handoff');
 query='cnv_guessed_not_real';
 await f.service.dispatch(a,input('operation_lookup_003','请查看任务'),key);
 assert.match(f.calls.at(-1)!.messages.at(-1)!.content!,/not_found/);
 await f.service.dispatch(a,{...input('operation_lookup_004','请查看任务'),boundTaskId:r.taskId!},key);
 assert.match(f.calls.at(-1)!.messages.at(-1)!.content!,new RegExp(r.taskId!));
 assert.match(f.calls.at(-1)!.messages.at(-1)!.content!,/实测产物：已保存结果.html/);
 assert.ok(f.calls.at(-1)!.messages.some(m=>m.content?.includes('当前输入框明确绑定的任务与最近成果')));
});
test('latest-only recovery releases a full paused queue without running superseded inputs',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_fullqueue_001','UI 首次要求'),key);
 for(let i=1;i<10;i++)await f.service.direct(a,r.taskId!,{operationId:`operation_fullqueue_${100+i}`,text:`UI 最新补充 ${i}`},key);
 await f.store.mutate(d=>{d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;});
 const before=await f.service.task(a,r.taskId!);
 await f.service.retryLatest(a,r.taskId!,before.jobs.at(-1)!.id,undefined,key);
 const detail=await f.service.task(a,r.taskId!);
 assert.equal(detail.jobs.filter(j=>j.state==='queued').length,1);
 assert.equal(detail.jobs.filter(j=>j.state==='cancelled').length,10);
 assert.equal(detail.conversation.messages.filter(m=>m.role==='user').length,11);
 await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs.at(-1)?.state==='completed');
 assert.equal(f.calls.filter(c=>c.modelId==='worker').length,1);
});
test('a new supplement arriving during retry validation remains queued and is not cancelled',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_retry_race1','UI 原要求'),key);
 const source=(await f.service.task(a,r.taskId!)).jobs[0];
 await f.store.mutate(d=>{d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;});
 let checks=0;
 const changingKey=async()=>{if(++checks===2)await f.service.direct(a,r.taskId!,{operationId:'operation_retry_race2',text:'刚到的新要求'},key);};
 await assert.rejects(()=>f.service.retryLatest(a,r.taskId!,source.id,undefined,changingKey),/新的要求/);
 const detail=await f.service.task(a,r.taskId!);
 assert.equal(detail.jobs.length,2);assert.ok(detail.jobs.every(j=>j.state==='queued'));assert.equal(detail.conversation.workPaused,true);
 assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
});
test('stop during recovery validation takes precedence over the earlier retry click',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_retry_stop1','UI 原要求'),key);
 const source=(await f.service.task(a,r.taskId!)).jobs[0];let checks=0;
 const changingKey=async()=>{if(++checks===2)await f.service.cancelTask(a,r.taskId!,key);};
 await assert.rejects(()=>f.service.retryLatest(a,r.taskId!,source.id,undefined,changingKey),/状态已变化/);
 const detail=await f.service.task(a,r.taskId!);
 assert.equal(detail.jobs.length,1);assert.equal(detail.jobs[0].state,'cancelled');assert.equal(detail.conversation.workPaused,true);
 await f.service.resume(a,key);assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
});
test('a failed retry admission with no work or usage can be explicitly retried once',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_retry_admit1','UI 原要求'),key);
 const source=(await f.service.task(a,r.taskId!)).jobs[0];
 await f.store.mutate(d=>{
   const original=d.chatOperations!.find(o=>o.id===source.id)!;
   original.status='failed';original.workRun!.state='failed';d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;
   d.chatOperations!.push({...structuredClone(original),id:'failed_admission',operationId:`retry_${createHash('sha256').update(source.id).digest('hex')}`,requestId:'no_model_admission',workRun:undefined,conversationId:undefined});
 });
 await f.service.retryLatest(a,r.taskId!,source.id,undefined,key);
 await f.service.retryLatest(a,r.taskId!,source.id,undefined,key);
 const detail=await f.service.task(a,r.taskId!);
 assert.equal(detail.jobs.length,2);assert.equal(detail.jobs[1].state,'queued');
 await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,r.taskId!)).jobs[1].state==='completed');
 assert.equal(f.calls.filter(c=>c.modelId==='worker').length,1);
});
test('a lost acknowledgement after saving a paused task supplement explains the required recovery',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_paused_ack1','UI 原要求'),key);
 await f.store.mutate(d=>{d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;});
 f.setRoute(messages=>{
   if(messages.at(-1)?.role==='tool')throw new Error('model acknowledgement timeout');
   return {...answer(''),toolCalls:[{id:'supplement',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:r.taskId,title:'UI 设计',instruction:'UI 追加要求',executorId:'general'})}}]};
 });
 await f.service.dispatch(a,{...input('operation_paused_ack2','UI 追加要求'),boundTaskId:r.taskId},key);
 const db=await f.store.read();const main=db.conversations.find(c=>c.coordinatorMain&&c.userId===a.userId)!;
 assert.match(main.messages.at(-1)!.content,/任务仍暂停|还暂停着/);assert.doesNotMatch(main.messages.at(-1)!.content,/结果会回到/);
 await f.service.resume(a,key);assert.equal(f.calls.filter(c=>c.modelId==='worker').length,0);
});
test('uncertain Notion saves block replay while verified saves allow explicit latest queued continuation',async()=>{
 const f=fixture(),r=await f.service.dispatch(a,input('operation_notion_recover1','UI 保存要求'),key);
 await f.service.direct(a,r.taskId!,{operationId:'operation_notion_recover2',text:'最新修改'},key);
 await f.store.mutate(d=>{
   const jobs=d.chatOperations!.filter(o=>o.workRun);
   jobs[0].status='failed';jobs[0].workRun!.state='failed';jobs[0].workRun!.notionReceipt={state:'uncertain'};
   jobs[1].workRun!.notionTarget={connectionId:'notion',parentPageId:'parent',title:'test',referenceIds:[]} as any;
   d.conversations.find(c=>c.id===r.taskId)!.workPaused=true;
 });
 let detail=await f.service.task(a,r.taskId!);const latest=detail.jobs.at(-1)!;
 assert.equal(detail.recovery.kind,'review_notion');
 await assert.rejects(()=>f.service.retryLatest(a,r.taskId!,latest.id,undefined,key),/Notion 保存结果还没确认.*只读核对.*不会重写/);
 await f.store.mutate(d=>{d.chatOperations!.find(o=>o.workRun?.notionReceipt)!.workRun!.notionReceipt!.state='verified';});
 detail=await f.service.task(a,r.taskId!);assert.equal(detail.recovery.kind,'resume');
 await f.service.retryLatest(a,r.taskId!,latest.id,undefined,key);
 detail=await f.service.task(a,r.taskId!);assert.equal(detail.jobs.length,2);assert.equal(detail.conversation.workPaused,false);assert.equal(detail.jobs.at(-1)!.state,'queued');
});
test("knowledge revocation is checked before worker billing; public credentials and private prompt snapshots stay off task receipts", async () => {
  const f = fixture();
  await f.store.mutate((d) =>
    d.knowledgeConnections.push({
      id: "source",
      workspaceId: "wa",
      provider: "getnote",
      status: "connected",
      clientId: "c",
      encryptedApiKey: "PRIVATE_CREDENTIAL",
    } as any),
  );
  const r = await f.service.dispatch(
    a,
    input("operation_source_01", "UI 查资料"),
    key,
  );
  await f.store.mutate((d) => {
    d.knowledgeConnections[0].status = "revoked";
  });
  const calls = f.calls.length;
  await f.service.resume(a, key);
  await waitFor(
    async () => (await f.service.task(a, r.taskId!)).jobs[0].state === "failed",
  );
  assert.equal(f.calls.length, calls);
  assert.doesNotMatch(
    JSON.stringify(await f.service.task(a, r.taskId!)),
    /PRIVATE_CREDENTIAL|本轮交接|modelPrompt|encryptedApiKey/,
  );
});

test('parallel workers sharing one dispatch budget reserve atomically and cannot each spend the full batch cap', async () => {
  const f=fixture(), cap=MODEL_MAX_OUTPUT_TOKENS*1.5/1e6;
  await f.store.mutate(d=>{for(const model of d.models){model.inputPowerPerMillion=0;model.outputPowerPerMillion=1;}});
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('任务已保存'):({...answer(''),toolCalls:[{id:'dispatch-budget',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'独立预算任务',instruction:'返回一份独立结果',executorId:'general'})}}]}));
  const first=await f.service.dispatch(a,{...input('operation_shared_cap_1','第一份独立分析'),budget:cap},key);
  const second=await f.service.dispatch(a,{...input('operation_shared_cap_2','第二份独立分析'),budget:cap},key);
  await f.store.mutate(d=>{for(const op of d.chatOperations??[])if(op.workRun)op.workRun.parentOperationId='fixture_shared_batch';});
  let release!:(value:ToolChatResult)=>void;
  const blocked=new Promise<ToolChatResult>(resolve=>{release=resolve;});
  f.setWorker(async()=>blocked);
  try {
    await f.service.resume(a,key);
    await waitFor(async()=>(await f.service.task(a,second.taskId!)).jobs[0].state==='failed');
    assert.equal(f.calls.filter(c=>c.modelId==='worker').length,1,'only one provider call fits while its reservation is held');
    const db=await f.store.read(), workerRows=db.modelUsageRecords.filter(u=>u.activity==='task_worker');
    assert.equal(workerRows.length,1);assert.equal(workerRows[0].status,'pending');
    assert.ok(workerRows.reduce((total,row)=>total+(row.reservedMicros??0)+(row.chargedMicros??0),0)<=Math.floor(cap*1e6));
    assert.equal((await f.service.task(a,first.taskId!)).jobs[0].state,'running');
  } finally { release(answer('已核对的合成测试结果')); }
  await waitFor(async()=>(await f.service.task(a,first.taskId!)).jobs[0].state==='completed');
  assert.equal((await f.service.task(a,second.taskId!)).jobs[0].state,'failed','failed admission does not automatically rerun after another worker releases its hold');
  assert.equal((await f.store.read()).powerAccounts[1].balanceMicros,100e6);
});

test('dependent image dispatch receives its completed text prerequisite and returns owned actual image bytes', async () => {
  let imageInput='',imageCalls=0;
  const f=await imageFixture(async (_model,messages)=>{imageCalls++;imageInput=JSON.stringify(messages);return{content:'图片完成',imageUrl:imageFixturePng};});
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},
    {artifactDirectory:f.directory,imageCall:async(_model,messages)=>{imageCalls++;imageInput=JSON.stringify(messages);return{content:'图片完成',imageUrl:imageFixturePng};},modelCall:async(model,messages)=>{
      if(model.id!=='router')return answer(JSON.stringify({outcome:'completed',content:'实际分析结论：ONE_DEPENDENCY_SOURCE，主题是红色帐篷与蓝色湖面',summary:'已完成主题分析'}));
      if(messages.at(-1)?.role==='tool')return answer('分析和配图已分别安排，图片会参考真实分析。');
      return{...answer(''),toolCalls:[{id:'plan-dependency',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:[
        {taskId:null,title:'分析露营主题',instruction:'先分析活动主题',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
        {taskId:null,title:'绘制露营海报',instruction:'按照前置分析结果生成图片',executorId:'image_generation',outputKind:'image',featureIds:[],dependsOn:[0]},
      ]})}}]};
    }});
  try {
    const result=await service.dispatch(a,{...input('operation_image_dependent','分析活动主题，再按分析结果画海报'),budget:.3},key);
    assert.equal(result.taskIds.length,2);
    await service.resume(a,key);
    await waitFor(async()=>imageCalls===1);
    assert.match(imageInput,/ONE_DEPENDENCY_SOURCE/);assert.match(imageInput,/红色帐篷与蓝色湖面/);
    await waitFor(async()=>(await service.task(a,result.taskIds[1])).jobs[0].state==='completed');
    const db=await f.store.read(),imageTask=await service.task(a,result.taskIds[1]),resultMessage=imageTask.conversation.messages.at(-1)!;
    assert.match(resultMessage.imageUrl!,/^\/api\/attachments\//);
    const imageFile=db.attachments.find(file=>file.id===resultMessage.attachments?.[0]?.id)!;
    assert.equal(imageFile.workspaceId,a.workspaceId);assert.equal(imageFile.userId,a.userId);
    await assert.rejects(()=>service.task(b,result.taskIds[1]));
    assert.equal(imageCalls,1);
  } finally { rmSync(f.directory,{recursive:true,force:true}); }
});

test('stopping one prepared task never cancels a sibling local execution sharing the same dispatcher parent', async () => {
  const f=fixture(),stamp=new Date().toISOString(),parent='operation_stop_shared_parent';
  await f.service.dispatch(a,input('operation_stop_setup','你好'),key);
  await f.store.mutate(d=>{
    for(const id of ['first-local-task','second-local-task'])d.conversations.push({...a,id,title:id,modelId:'worker',executorProfileId:'general',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});
    for(const [index,conversationId] of ['first-local-task','second-local-task'].entries())d.chatOperations!.push({...a,id:`prepared-${index}`,operationId:`operation_local_child_${index}`,requestId:`work_local_${index}`,payloadHash:'',status:'completed',conversationId,createdAt:stamp,updatedAt:stamp,
      workRun:{state:'prepared',parentOperationId:parent,budget:.1,values:executorDefaults(),executorId:'general',executorVersion:0,modelId:'worker',modelPrompt:'',instruction:'保存本机任务',inputMessageId:`input_${index}`,webSearch:false,sources:[],skills:[],credentials:[]}});
    d.chatOperations!.push({...a,id:'legacy-local-parent',operationId:`local_${parent}`,requestId:'local_execution',payloadHash:'',status:'pending',conversationId:'first-local-task',createdAt:stamp,updatedAt:stamp});
    d.executionTasks=[];
  });
  const app=express(),cancellations:string[]=[];
  app.use(express.json());
  const auth:express.RequestHandler=(req,_res,next)=>{const user=String(req.headers['x-fixture-user']||'a');req.user={id:user,role:'user'} as any;req.workspaceId=user==='a'?'wa':'wb';next();};
  installCoordinatorRoutes(app,[auth],[auth],f.store,key,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{cancelLocal:async(_req,id)=>{cancellations.push(id);}});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const foreign=await fetch(`${base}/api/coordinator/tasks/second-local-task/stop`,{method:'POST',headers:{'x-fixture-user':'b'}});
    assert.equal(foreign.status,404);assert.deepEqual(cancellations,[]);
    const response=await fetch(`${base}/api/coordinator/tasks/second-local-task/stop`,{method:'POST'});
    assert.equal(response.status,200);assert.deepEqual(cancellations,['local_operation_local_child_1']);
    const db=await f.store.read();assert.equal(db.chatOperations!.find(o=>o.id==='prepared-0')!.workRun!.state,'prepared');
    assert.equal(db.chatOperations!.find(o=>o.id==='prepared-1')!.workRun!.state,'cancelled');
    assert.equal(db.chatOperations!.find(o=>o.id==='legacy-local-parent')!.status,'pending');
  } finally { server.close(); }
});

test('a GPT chat credential powers a real image task while fixed picture pricing stays frozen and text model prices stay unchanged', async () => {
  let release!:()=>void,imageCalls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const f=await imageFixture(async model=>{
    imageCalls++;assert.equal(model.id,'image-model');assert.equal(model.kind,'image');
    assert.equal(model.imagePowerPerCall,.1);assert.equal(model.costImagePowerPerCall,.02);
    assert.equal(model.inputPowerPerMillion,0);assert.equal(model.outputPowerPerMillion,0);
    assert.equal(model.model,'gpt-image-2');
    await gate;return {content:'生成完成',imageUrl:imageFixturePng};
  });
  let originalTextPrices:unknown;
  await f.store.mutate(d=>{
    const model=d.models.find(model=>model.id==='image-model')!;
    model.kind='chat';model.protocol='openai';model.model='gpt-chat-fixture';
    originalTextPrices=[model.inputPowerPerMillion,model.outputPowerPerMillion,model.costInputPowerPerMillion,model.costOutputPowerPerMillion];
    const record=d.settings.aiTasks!.image_generation!;
    updateTaskConfig(d.settings,d.models,'image_generation',{revision:record.revision,action:'draft',values:{...record.draft,imageRoute:'responses',imageServiceModel:'gpt-image-2',imagePowerPerCall:.1,costImagePowerPerCall:.02}},'a','before');
    updateTaskConfig(d.settings,d.models,'image_generation',{revision:d.settings.aiTasks!.image_generation!.revision,action:'publish'},'a','before');
  });
  try {
    const reply=await f.service.dispatch(a,{...input('operation_chat_credential_image','画一张实际测试图片'),budget:.3},key);
    const queued=await f.store.read(),job=queued.chatOperations!.find(o=>o.workRun?.kind==='image')!;
    assert.equal(reply.taskId,job.conversationId);assert.equal(job.workRun!.values.imageRoute,'responses');
    await waitFor(async()=>imageCalls===1);
    await f.store.mutate(d=>{
      const record=d.settings.aiTasks!.image_generation!;
      updateTaskConfig(d.settings,d.models,'image_generation',{revision:record.revision,action:'draft',values:{...record.draft,imagePowerPerCall:.2,costImagePowerPerCall:.04}},'a','during');
      updateTaskConfig(d.settings,d.models,'image_generation',{revision:d.settings.aiTasks!.image_generation!.revision,action:'publish'},'a','during');
    });
    release();await waitFor(async()=>(await f.service.task(a,job.conversationId!)).jobs[0].state==='completed');
    await f.service.report(a,[job.id],key);await f.service.report(a,[job.id],key);
    const db=await f.store.read(),row=db.modelUsageRecords.find(r=>r.activity==='image_generation')!;
    assert.equal(row.chargedMicros,100000);assert.equal(row.costMicros,20000);
    assert.equal(row.imagePowerPerCallSnapshot,.1);assert.equal(row.costImagePowerPerCallSnapshot,.02);
    assert.equal(db.settings.aiTasks!.image_generation!.published!.imagePowerPerCall,.2);
    const original=db.models.find(model=>model.id==='image-model')!;
    assert.equal(original.kind,'chat');assert.equal(original.model,'gpt-chat-fixture');
    assert.deepEqual([original.inputPowerPerMillion,original.outputPowerPerMillion,original.costInputPowerPerMillion,original.costOutputPowerPerMillion],originalTextPrices);
    const file=db.attachments[0],main=db.conversations.find(c=>c.coordinatorMain&&c.userId===a.userId)!;
    assert.equal(main.messages.filter(m=>m.imageUrl===`/api/attachments/${file.id}/content`).length,1);
    assert.ok(file.sharedConversationIds?.includes(main.id));assert.equal(file.workspaceId,a.workspaceId);
    const notice=(await f.service.state(a)).notices.find(n=>n.id===job.id)!;
    assert.equal(notice.reported,true);assert.equal(notice.read,false);
    assert.equal(imageCalls,1);
  } finally { release?.();rmSync(f.directory,{recursive:true,force:true}); }
});

test('truncated tool instructions preserve only returned text as partial and never execute the tool or claim completion', async()=>{
  const f=fixture();await f.store.mutate(d=>d.knowledgeConnections.push({id:'source-partial',workspaceId:a.workspaceId,provider:'getnote',status:'connected',clientId:'fixture',encryptedApiKey:'fixture-encrypted',createdAt:'now',updatedAt:'now'}));
  f.setWorker(async()=>({...answer('已经返回的真实短文片段'),finishReason:'length',toolCalls:[{id:'incomplete-read',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'不能执行的截断指令'})}}]}));
  const reply=await f.service.dispatch(a,input('operation_partial_tool_1','UI 写一段短文'),key);
  await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs[0].state==='failed');
  const detail=await f.service.task(a,reply.taskId!),db=await f.store.read(),job=db.chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!;
  assert.equal(f.recalls.length,0);assert.ok(f.calls.find(c=>c.modelId==='worker')!.tools.some(t=>t.function.name==='knowledge_search'));
  assert.equal(job.workRun!.resultOutcome,'partial');assert.match(job.workRun!.error!,/截断的工具指令没有执行/);
  assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,1);
  assert.match(detail.conversation.messages.at(-1)!.content,/已经返回的真实短文片段/);
  assert.equal(detail.conversation.messages.at(-1)!.finishReason,'length');
  assert.equal(db.modelUsageRecords.find(u=>u.requestId===job.requestId)!.finishReason,'length');
  await assert.rejects(()=>f.service.task(b,reply.taskId!));
  await f.service.report(a,[job.id],key);await f.service.report(a,[job.id],key);
  const main=(await f.service.state(a)).conversation!;
  assert.equal(main.messages.filter(m=>m.id===`report_${job.id}`).length,1);
  assert.match(main.messages.at(-1)!.content,/部分结果|部分文字/);assert.doesNotMatch(main.messages.at(-1)!.content,/已完成/);
});

test('filtered responses and length responses without text do not create fabricated partial messages', async()=>{
  for(const filtered of [true,false]){
    const f=fixture(),marker='FILTERED_PROVIDER_TEXT_MUST_NOT_SURFACE';
    f.setWorker(async()=>({...answer(filtered?marker:''),finishReason:filtered?'filtered':'length',toolCalls:[{id:'incomplete',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'不能执行'})}}]}));
    const reply=await f.service.dispatch(a,input(`operation_partial_empty_${filtered?'filtered':'length'}`,'UI 不完整输出'),key);
    await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs[0].state==='failed');
    const detail=await f.service.task(a,reply.taskId!),db=await f.store.read();
    assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,0);
    assert.equal(detail.jobs[0].resultMessageId,undefined);assert.equal(db.chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!.workRun!.resultOutcome,undefined);
    assert.match(detail.jobs[0].error!,filtered?/过滤内容没有保存或展示/:/未返回可保留的正文/);
    assert.doesNotMatch(JSON.stringify([...db.messages,...db.contextTraces]),new RegExp(marker));
  }
});

test('cancelled task rejects late truncated text without changing terminal state or preserving it as a partial result',async()=>{
  const f=fixture();let release!:(result:ToolChatResult)=>void;
  f.setWorker(async()=>new Promise(resolve=>{release=resolve;}));
  const reply=await f.service.dispatch(a,input('operation_partial_late_cancel','UI 写一个短文'),key);
  await f.service.resume(a,key);await waitFor(async()=>Boolean(release));
  await f.service.cancelTask(a,reply.taskId!,key);
  release({...answer('CANCELLED_LATE_PARTIAL_NOT_SAVED'),finishReason:'length'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const detail=await f.service.task(a,reply.taskId!),db=await f.store.read();
  assert.equal(detail.jobs[0].state,'cancelled');assert.equal(detail.jobs[0].resultMessageId,undefined);
  assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,0);
  assert.doesNotMatch(JSON.stringify([...db.messages,...db.contextTraces]),/CANCELLED_LATE_PARTIAL_NOT_SAVED/);
  assert.equal(db.chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!.workRun!.resultOutcome,undefined);
});

test('revoked knowledge access suppresses in-flight partial text, including revocation after the fresh authorization read',async()=>{
  for(const revokeAfterRead of [false,true]){
    const f=fixture(),marker=`REVOKED_PARTIAL_NOT_SAVED_${revokeAfterRead}`;
    await f.store.mutate(d=>d.knowledgeConnections.push({id:'partial-source',workspaceId:a.workspaceId,provider:'getnote',status:'connected',clientId:'fixture',encryptedApiKey:'fixture-encrypted',createdAt:'now',updatedAt:'now'}));
    let release!:(result:ToolChatResult)=>void;
    f.setWorker(async()=>new Promise(resolve=>{release=resolve;}));
    const reply=await f.service.dispatch(a,input(`operation_partial_revoke_${revokeAfterRead?'transaction':'call'}`,'UI 写一段短文'),key);
    await f.service.resume(a,key);await waitFor(async()=>Boolean(release));
    if(revokeAfterRead){
      const originalRead=f.store.read.bind(f.store);let armed=true;
      f.store.read=async()=>{
        const snapshot=await originalRead();
        if(armed){armed=false;await f.store.mutate(d=>{d.knowledgeConnections[0].status='revoked';});}
        return snapshot;
      };
    }else await f.store.mutate(d=>{d.knowledgeConnections[0].status='revoked';});
    release({...answer(marker),finishReason:'length'});
    await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs[0].state==='failed');
    const detail=await f.service.task(a,reply.taskId!),db=await f.store.read(),job=db.chatOperations!.find(o=>o.conversationId===reply.taskId&&o.workRun)!;
    assert.equal(detail.conversation.workPaused,true);assert.match(detail.jobs[0].error!,/知识授权已变化/);
    assert.equal(detail.jobs[0].resultMessageId,undefined);assert.equal(job.workRun!.resultOutcome,undefined);
    assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,0);
    assert.doesNotMatch(JSON.stringify([...db.messages,...db.contextTraces]),new RegExp(marker));
    assert.equal(db.modelUsageRecords.find(u=>u.requestId===job.requestId)!.status,'success','paid provider result remains in the usage ledger even when its text is no longer authorized');
  }
});

test('a lost Key proof suppresses late length text while keeping a failed authorization receipt and actual billed usage',async()=>{
  const f=fixture(),marker='KEY_REVOKED_PARTIAL_NOT_SAVED';let connected=true,release!:(result:ToolChatResult)=>void;
  const liveKey=async()=>{if(!connected)throw new Error('Key transport disconnected');};
  f.setWorker(async()=>new Promise(resolve=>{release=resolve;}));
  const reply=await f.service.dispatch(a,input('operation_partial_key_revoke','UI 写一个短文'),liveKey);
  await f.service.resume(a,liveKey);await waitFor(async()=>Boolean(release));
  connected=false;release({...answer(marker),finishReason:'length'});
  await waitFor(async()=>(await f.service.task(a,reply.taskId!)).jobs[0].state==='failed');
  const detail=await f.service.task(a,reply.taskId!),db=await f.store.read();
  assert.equal(detail.conversation.workPaused,true);assert.match(detail.jobs[0].error!,/授权或连接已变化/);
  assert.equal(detail.jobs[0].resultMessageId,undefined);assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,0);
  assert.doesNotMatch(JSON.stringify([...db.messages,...db.contextTraces]),new RegExp(marker));
  assert.ok(db.modelUsageRecords.some(row=>row.activity==='task_worker'&&row.finishReason==='length'&&row.status==='success'));
});

test('single local_special routes only through its configured logic handoff and retains owner and bound-task validation',async()=>{
  const f=fixture();
  const profile=await f.store.mutate(d=>updateExecutor(d,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'本机逻辑交接',modelId:'worker',routingRole:'logic'}}));
  await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:1,action:'publish'}));
  let localCalls=0;const executeLocal=async(cid:string,mid:string)=>{
    localCalls++;const db=await f.store.read(),job=db.chatOperations!.find(o=>o.conversationId===cid&&o.workRun)!;
    assert.equal(job.workRun!.executorId,profile.id);assert.equal(job.workRun!.state,'prepared');assert.equal(job.workRun!.inputMessageId,mid);
    return {id:'actual-local-execution',status:'queued'};
  };
  const localCall=(taskId:string|null=null,name='execute_local_task')=>({...answer(''),toolCalls:[{id:'local-alias',type:'function' as const,function:{name,arguments:JSON.stringify({taskId,title:'本机文档',instruction:'只在已授权文件夹创建 hello.md，并回读，不覆盖旧文件',executorId:'local_special'})}}]});
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已经安排，目录还需要本机确认'):localCall());
  const accepted=await f.service.dispatch(a,input('operation_single_local_alias','在本机创建文档'),key,undefined,executeLocal);
  assert.equal(localCalls,1);assert.ok(accepted.taskId);
  const offered=f.calls.find(call=>call.modelId==='router')!.tools.find(t=>t.function.name==='execute_local_task')!;
  assert.ok((offered.function.parameters as any).properties.executorId.enum.includes('local_special'));
  assert.ok((offered.function.parameters as any).properties.executorId.enum.includes(profile.id));
  f.setRoute(()=>localCall('someone-elses-task'));
  await assertRoutingBlocked(f.service.dispatch(a,input('operation_local_foreign_01','在别人任务里写文件'),key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  f.setRoute(()=>localCall());
  await assertRoutingBlocked(f.service.dispatch(a,{...input('operation_local_bound_001','修改当前文档'),boundTaskId:accepted.taskId},key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  f.setRoute(()=>localCall(null,'delegate_task'));
  await assertRoutingBlocked(f.service.dispatch(a,input('operation_local_cloud_001','不能用普通分派拿到本机权限'),key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  assert.equal(localCalls,1);
  await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:2,action:'pause'}));
  f.setRoute(()=>localCall());
  await assertRoutingBlocked(f.service.dispatch(a,input('operation_local_disabled_01','逻辑能力停用后不可静默降级'),key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  assert.equal(localCalls,1);
});

test('explicit local button accepts local_special through both routing tools without relaxing task ownership',async()=>{
  for(const name of ['delegate_task','execute_local_task'])for(const withCard of [false,true]){
    const f=fixture();
    await f.store.mutate(d=>{d.models.find(m=>m.id==='worker')!.protocol='openai';});
    const profile=await f.store.mutate(d=>updateExecutor(d,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'本机交接',modelId:'worker',routingRole:'logic'}}));
    await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:1,action:'publish'}));
    let calls=0;
    const localCall=(taskId:string|null)=>({...answer(''),toolCalls:[{id:'explicit-local-alias',type:'function' as const,function:{name,arguments:JSON.stringify({taskId,title:'独立文档',instruction:'在授权目录内新建并核验文档',executorId:withCard?profile.id:'local_special',...(withCard?{capabilityIds:['builtin:codex_execution']}: {})})}}]});
    f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已经交给本机'):localCall(null));
    const run=async(cid:string)=>{calls++;const saved=await f.store.read();const job=saved.chatOperations!.find(o=>o.conversationId===cid&&o.workRun)!.workRun!;assert.equal(job.executorId,profile.id);assert.equal(job.state,'prepared');return{id:'local-real',status:'queued'};};
    const accepted=await f.service.dispatch(a,{...input(`operation_explicit_alias_${name}`,'新建本地文档'),localExecution:true},key,undefined,run);
    assert.ok(accepted.taskId);assert.equal(calls,1);
    assert.equal(f.calls[0].requiredTool,'execute_local_task');
    f.setRoute(()=>localCall('foreign-task'));
    await assertRoutingBlocked(f.service.dispatch(a,{...input(`operation_explicit_foreign_${name}`,'写入文件'),localExecution:true},key,undefined,run),/未开始|尚未开始|未完成分派|参数无效/);
    assert.equal(calls,1);
  }
});

test('read-all HTTP endpoint requires a live Key and only acknowledges the authenticated owner current results',async t=>{
  const f=fixture(),stamp=new Date().toISOString();
  await f.store.mutate(d=>{
    for(const scope of [a,b]){
      const cid=`result-${scope.userId}`;
      d.conversations.push({...scope,id:cid,title:'已完成任务',modelId:'worker',archived:false,messages:[],createdAt:stamp,updatedAt:stamp});
      (d.executionTasks??=[]).push({...scope,id:`local-${scope.userId}`,conversationId:cid,sourceMessageId:'input',provider:'codex',status:'completed',finalResponse:'已回读实际结果',instruction:'保留任务历史',deviceId:'fixture-key',createdAt:stamp,updatedAt:stamp});
    }
    d.executionTasks.push({...d.executionTasks[0],id:'running',status:'running'});
  });
  const app=express();app.use(express.json());let verifications=0;
  const auth:express.RequestHandler=(req,res,next)=>{
    if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}
    req.workspaceId=req.headers['x-user']==='b'?'wb':'wa';req.user={id:req.headers['x-user']==='b'?'b':'a',role:'user'} as any;next();
  };
  installCoordinatorRoutes(app,[auth],[auth],f.store,async()=>{verifications++;}, {recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/coordinator/notices/read-all`;
  assert.equal((await fetch(url,{method:'POST'})).status,428);
  const response=await fetch(url,{method:'POST',headers:{'x-key':'present','Content-Type':'application/json'},body:JSON.stringify({workspaceId:'wb',userId:'b',ids:['local-b']})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,ids:['local-a'],count:1});assert.equal(verifications,1);
  const db=await f.store.read();assert.equal(db.executionTasks[0].noticeReadRound,0);assert.equal(db.executionTasks[1].noticeReadRound,undefined);
  assert.equal(db.executionTasks.find(task=>task.id==='running')!.status,'running');
  assert.ok(db.executionTasks.every(task=>!task.reportedToCoordinatorAt));assert.equal(db.messages.length,0);
});

for(const variant of ['guide','comic','gift'])test(`server-only onboarding ${variant} requires the claimed profile marker and uses a private normal image job once`,async()=>{
  const comic=variant!=='guide',sponsored=variant==='gift';
  let calls=0;const f=await imageFixture(async()=>{calls++;return {content:'真实欢迎图片',imageUrl:imageFixturePng};});
  const operationId='welcome_0123456789abcdef';
  await f.store.mutate(d=>{
    const user=d.users.find(u=>u.id==='a')!;user.defaultWorkspaceId='wa';
    user.profile={workspaceId:'wa',displayName:'小明',onboarding:{nameSetAt:'now',knowledgeChoice:'skipped',completedAt:'now',handbook:{operationId,status:'preparing',requestedAt:'now',updatedAt:'now',pricePower:.012,maxPower:.012}},updatedAt:'now'};
    if(comic)user.profile.onboarding.journey={id:'journey_0123456789',launchId:'launch_0123456789',version:2,stage:'complete',startedAt:'now',completedAt:'now',nameChoice:'provided',knowledgeChoice:'skipped',localChoice:'skipped',featureIds:[],events:[]};
    if(sponsored){user.profile.onboarding.welcomeGiftOperationId=operationId;user.profile.onboarding.handbook!.funding='one';d.powerAccounts.find(p=>p.userId==='a')!.balanceMicros=0;}
    d.settings.aiTasks!.image_generation!.published!.imagePowerPerCall=.012;
    d.settings.aiTasks!.image_generation!.published!.costImagePowerPerCall=.02;
    delete d.settings.aiTasks!.image_generation!.published!.enabled;
  });
  const {handbookInstruction,handbookTitle,startOnboardingHandbook}=await import('./onboardingHandbook.js');
  const db=await f.store.read(),configuration=db.settings.aiTasks!.image_generation!.published!;
  const welcome={operationId,title:handbookTitle(db.users.find(u=>u.id==='a')!.profile!),instruction:handbookInstruction(db,a),budget:.012,imageVersion:configuration.version,sponsored};
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw new Error('欢迎图片不得读取知识库');}},
    {artifactDirectory:f.directory,imageCall:async()=>{calls++;return {content:'真实欢迎图片',imageUrl:imageFixturePng};},modelCall:async()=>{throw new Error('欢迎图片不得调用文字模型');}});
  await f.store.mutate(d=>{d.conversations.push({...a,id:'busy-main',coordinatorMain:true,title:'与 ONE 对话',modelId:d.models[0].id,archived:false,messages:[],createdAt:'now',updatedAt:'now'});});
  await beginChatOperation(f.store,{...a,operationId:'ordinary_chat_busy_012345',conversationId:'busy-main',requestId:'ordinary-chat',payload:{text:'另一条正在回答的问题'}});
  try{
    await assert.rejects(()=>service.enqueueOnboardingImage(b,welcome,key));
    await assert.rejects(()=>service.enqueueOnboardingImage(a,{...welcome,sponsored:!sponsored},key),/资格/);
    await assert.rejects(()=>service.enqueueOnboardingImage(a,{...welcome,instruction:'浏览器任意写入任务'},key),/内容已变化/);
    await assert.rejects(()=>service.enqueueOnboardingImage(a,{...welcome,imageVersion:configuration.version+1},key),/配置或额度已变化/);
    await assert.rejects(()=>service.enqueueOnboardingImage(a,welcome,async()=>{throw new Error('Key已断开');}),/Key已断开/);
    await f.store.mutate(d=>{d.users[0].profile!.onboarding.handbook!.status='pending';});
    const deps={verifyKey:key,storageAvailable:true,enqueueImage:(scope:typeof a,request:import('./onboardingHandbook.js').OnboardingImageInput,verify:()=>Promise<void>)=>service.enqueueOnboardingImage(scope,request,verify)};
    const accepted=await startOnboardingHandbook(f.store,a,deps),taskId=accepted.handbook!.taskId!;
    assert.equal(accepted.handbook!.status,'queued');assert.ok(taskId);
    let saved=await f.store.read();const child=saved.chatOperations!.find(o=>o.operationId===`${operationId}_image`)!;
    assert.equal(child.conversationId,taskId);assert.equal(child.workRun!.state,'queued');assert.equal(calls,0);
    assert.equal(saved.conversations.find(c=>c.coordinatorMain)!.messages.length,1);assert.equal(saved.conversations.find(c=>c.coordinatorMain)!.messages[0].role,'assistant');
    assert.match(saved.conversations.find(c=>c.coordinatorMain)!.messages[0].content,comic?/查看任务/:/查看小指南/);
    assert.equal(saved.conversations.find(c=>c.id===taskId)!.messages[0].content,'根据你刚才的设置，整理你的 ONE 使用说明。');
    assert.equal(saved.chatOperations!.find(o=>o.conversationId===taskId&&o.workRun)!.workRun!.instruction,welcome.instruction,'only server execution retains the real prompt');
    assert.doesNotMatch(JSON.stringify(await service.task(a,taskId)),/生成并交付一张|固定故事|JSON 仅为|米白背景/);
    await service.resume(a,key);await waitFor(async()=>(await service.task(a,taskId)).jobs[0].state==='completed');
    saved=await f.store.read();assert.equal(calls,1);const usage=saved.modelUsageRecords.filter(r=>r.imagePowerPerCallSnapshot!==undefined);assert.equal(usage.length,1);
    assert.equal(usage[0].chargedMicros,sponsored?0:12000);assert.equal(usage[0].costMicros,20000);
    if(sponsored){assert.equal(usage[0].sponsorship!.operationId,operationId);assert.equal(saved.powerAccounts.find(p=>p.userId==='a')!.balanceMicros,0);assert.equal(saved.powerLedger.length,0);}
    assert.equal(saved.attachments[0].workspaceId,'wa');
    const delivered=(await service.task(a,taskId)).conversation.messages.at(-1)!;
    if(comic){assert.equal(delivered.imageUrl,undefined);assert.equal(delivered.attachments![0].welcomeGuide,true);assert.equal(saved.attachments[0].welcomeGuide!.nickname,'小明');assert.match(delivered.content,/使用说明/);}else assert.match(delivered.imageUrl!,/^\/api\/attachments\//);
    assert.ok((await service.state(a)).notices.some(n=>n.taskId===taskId&&!n.read&&!n.reported));
    assert.equal(saved.conversations.find(c=>c.coordinatorMain)!.messages.length,1,'completion stays in the sidebar');
    assert.equal((await startOnboardingHandbook(f.store,a,deps)).handbook!.taskId,taskId);assert.equal(calls,1,'a welcome-flow replay cannot create another image');
    assert.equal((await f.store.read()).chatOperations!.find(o=>o.operationId==='ordinary_chat_busy_012345')!.status,'pending','independent welcome work never interrupts or locks the existing chat turn');
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('natural local batch dispatch obeys its tool switch before creating any child; only this explicit button request is an exception',async()=>{
  const f=fixture();
  const profile=await f.store.mutate(d=>updateExecutor(d,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'本机逻辑处理',modelId:'worker',routingRole:'logic'}}));
  await f.store.mutate(d=>{
    updateExecutor(d,'a',profile.id,{revision:1,action:'publish'});
    d.models.find(model=>model.id==='worker')!.protocol='openai';
    d.settings.aiTasks!.coordinator!.published!.tools=d.settings.aiTasks!.coordinator!.published!.tools.filter(name=>name!=='execute_local_task');
  });
  let localCalls=0,expectedLocalCatalog=false;
  const tasks=[{taskId:null,title:'可并行文字分析',instruction:'只整理文字',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
    {taskId:null,title:'本机文件',instruction:'只在已授权目录创建 hello.md，不覆盖',executorId:'local_special',outputKind:'local_file',featureIds:[],dependsOn:[]}];
  const route=(plan=tasks)=>f.setRoute(messages=>{
    if(messages.at(-1)?.role==='tool')return answer('两项已安排，进展在侧栏');
    const catalog=JSON.parse(messages.find(m=>m.content?.includes('能力目录：'))!.content!.split('能力目录：')[1]);
    assert.equal(catalog.some((card:any)=>card.executorId==='local_special'),expectedLocalCatalog);
    return {...answer(''),toolCalls:[{id:'local-batch',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:plan})}}]};
  });
  route();
  const local=async(cid:string)=>{localCalls++;assert.equal((await f.service.task(a,cid)).jobs[0].state,'prepared');return {id:`accepted-local-${localCalls}`,status:'queued'};};
  await assert.rejects(()=>f.service.dispatch(a,input('operation_natural_local_off','安排文字和本机文件'),key,undefined,local),/未开启本机操作/);
  assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0,'whole-plan authorization precedes the first text child');
  assert.equal(localCalls,0);
  expectedLocalCatalog=true;
  const accepted=await f.service.dispatch(a,{...input('operation_explicit_local_on','我明确点本机执行'),localExecution:true},key,undefined,local);
  assert.equal(accepted.taskIds.length,2);assert.equal(localCalls,1);
  const before=(await f.store.read()).chatOperations!.filter(o=>o.workRun).length;
  expectedLocalCatalog=false;
  await assert.rejects(()=>f.service.dispatch(a,input('operation_natural_still_off','下一句自然请求不能继承之前按钮权限'),key,undefined,local),/未开启本机操作/);
  assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,before);assert.equal(localCalls,1);
  await f.store.mutate(d=>{const stamp=new Date().toISOString();d.conversations.push({...b,id:'foreign-local-task',title:'别人本机文件',modelId:'worker',executorProfileId:profile.id,archived:false,messages:[],createdAt:stamp,updatedAt:stamp});});
  route([tasks[0],{...tasks[1],taskId:'foreign-local-task'}] as any);expectedLocalCatalog=true;
  await assert.rejects(()=>f.service.dispatch(a,{...input('operation_explicit_foreign','明确按钮也不能越权'),localExecution:true},key,undefined,local),/不属于当前账号/);
  assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,before,'foreign second child cannot leave behind an accepted first child');
  assert.equal(localCalls,1);
  await f.store.mutate(d=>{d.settings.aiTasks!.coordinator!.published!.tools.push('execute_local_task');});
  expectedLocalCatalog=false;route();
  await assert.rejects(()=>f.service.dispatch(a,input('operation_batch_no_connection','没有设备回调不能本机处理'),key),/本机执行未连接/);
  assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,before);
});

test('batch saves all independent tasks before a failed local start and still completes its cloud sibling',async()=>{
  const f=fixture();
  const profile=await f.store.mutate(d=>updateExecutor(d,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'逻辑处理',modelId:'worker',routingRole:'logic'}}));
  await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:1,action:'publish'}));
  const tasks=[{taskId:null,title:'本机先保存',instruction:'LOCAL_ONLY 创建 local.html',executorId:'local_special',outputKind:'local_file',featureIds:[],dependsOn:[]},
    {taskId:null,title:'云端不能丢',instruction:'CLOUD_ONLY 只写一句茶的短文',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
    {taskId:null,title:'第二件本机',instruction:'SECOND_LOCAL 创建 second.html',executorId:'local_special',outputKind:'local_file',featureIds:[],dependsOn:[]}];
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('本机还没确认开始，云端照常处理。'):{...answer(''),toolCalls:[{id:'batch-local-first',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks})}}]});
  f.setWorker(async messages=>{assert.match(messages.at(-1)!.content!,/CLOUD_ONLY/);assert.doesNotMatch(JSON.stringify(messages),/LOCAL_ONLY|SECOND_LOCAL/);return answer('茶暖了，歇一歇。');});
  let calls=0;
  const accepted=await f.service.dispatch(a,input('operation_local_start_failure','两件本机文件和独立短文'),key,undefined,async()=>{
    calls++;
    assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,3,'every child is durable before local startup');
    throw new Error('fixture-only device startup failure');
  });
  assert.equal(accepted.taskIds.length,3);assert.equal(calls,1,'ambiguous first local failure must not start another local write');
  await waitFor(async()=>(await f.service.task(a,accepted.taskIds[1])).jobs[0].state==='completed');
  assert.equal((await f.service.task(a,accepted.taskIds[0])).jobs[0].state,'prepared');
  assert.equal((await f.service.task(a,accepted.taskIds[2])).jobs[0].state,'prepared');
  assert.match((await f.service.task(a,accepted.taskIds[1])).conversation.messages.at(-1)!.content,/茶暖了/);
  await assert.rejects(()=>f.service.task(b,accepted.taskIds[0]));
  await assert.rejects(()=>f.service.task(b,accepted.taskIds[1]));
  assert.doesNotMatch(JSON.stringify(await f.service.state(a)),/fixture-only device startup failure/);
});

test('a natural local task does not turn the following ordinary text delegate into another local execution',async()=>{
  const f=fixture();
  const profile=await f.store.mutate(d=>updateExecutor(d,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'逻辑交接',modelId:'worker',routingRole:'logic'}}));
  await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:1,action:'publish'}));
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('文档和短文分别安排好了'):{...answer(''),toolCalls:[
    {id:'first-local',type:'function',function:{name:'execute_local_task',arguments:JSON.stringify({taskId:null,title:'本机说明文档',instruction:'仅在已授权目录创建 LOCAL_ONLY.md，不覆盖',executorId:'local_special'})}},
    {id:'second-cloud',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'独立短文',instruction:'CLOUD_ONLY：只返回一句热茶短文，不操作本机',executorId:'general'})}},
  ]});
  let localCalls=0;const accepted=await f.service.dispatch(a,input('operation_local_then_cloud','先创建本机文档，另外返回一段短文'),key,undefined,async(cid)=>{
    localCalls++;assert.match((await f.service.task(a,cid)).jobs[0].instruction!,/LOCAL_ONLY/);return {id:'single-local-task',status:'queued'};
  });
  assert.equal(accepted.taskIds.length,2);assert.equal(localCalls,1);
  const db=await f.store.read(),local=db.chatOperations!.find(o=>o.conversationId===accepted.taskIds[0]&&o.workRun)!,cloud=db.chatOperations!.find(o=>o.conversationId===accepted.taskIds[1]&&o.workRun)!;
  assert.equal(local.workRun!.state,'prepared');assert.equal(cloud.workRun!.state,'queued');
  f.setWorker(async messages=>{assert.match(messages.at(-1)!.content!,/CLOUD_ONLY/);assert.doesNotMatch(JSON.stringify(messages),/LOCAL_ONLY/);return answer('热茶在手，忙碌渐远。');});
  await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,accepted.taskIds[1])).jobs[0].state==='completed');
  assert.equal(localCalls,1);assert.match((await f.service.task(a,accepted.taskIds[1])).conversation.messages.at(-1)!.content,/热茶在手/);
  assert.equal((await f.service.task(a,accepted.taskIds[0])).jobs[0].state,'prepared');
});

test('next answer reports the captured old local round after the same execution has already begun a new round',async()=>{
  const f=fixture(),stamp=new Date().toISOString();
  const {saveExecutionReceipt}=await import('./executionService.js');
  await f.store.mutate(d=>{
    d.conversations.push({...a,id:'main-before-local-round',coordinatorMain:true,taskResultReportSince:stamp,title:'与 ONE 对话',modelId:'worker',archived:false,messages:[],createdAt:stamp,updatedAt:stamp});
    d.conversations.push({...a,id:'same-local-conversation',title:'连续本机文档',modelId:'worker',archived:false,messages:[],createdAt:stamp,updatedAt:stamp});
    (d.executionTasks??=[]).push({...a,id:'same-local-execution',conversationId:'same-local-conversation',sourceMessageId:'original',provider:'codex',status:'completed',reportRound:0,finalResponse:'OLD_ROUND_RESULT：创建 /QA/hello.md，回读 hello',instruction:'创建文档',deviceId:'fixture-key',targetName:'/QA',createdAt:stamp,updatedAt:stamp,completedAt:stamp});
    saveExecutionReceipt(d,d.executionTasks[0]);
  });
  let release!:(result:ToolChatResult)=>void,started!:()=>void;const gate=new Promise<ToolChatResult>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve);
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async(_model,messages)=>{
    assert.match(messages.find(m=>m.content?.startsWith('刚返回、尚未向用户汇报'))!.content!,/OLD_ROUND_RESULT/);started();return gate;
  }});
  const response=service.dispatch(a,input('operation_report_old_round','上一轮做了什么？只回答，不执行。'),key);
  await ready;
  await f.store.mutate(d=>{const task=d.executionTasks[0];task.reportRound=1;task.status='running';task.finalResponse=undefined;task.completedAt=undefined;task.updatedAt=new Date().toISOString();});
  release(answer('上一轮已经返回了文件内容和回读结果。'));
  const reply=await response;assert.match(reply.message.content,/上一轮的「连续本机文档」.*已返回结果/);assert.match(reply.message.content,/task=same-local-conversation/);assert.doesNotMatch(reply.message.content,/执行器|回执|验证证据/);
  let db=await f.store.read();assert.equal(db.chatOperations!.filter(o=>o.id==='notice_same-local-execution'&&o.assistantMessageId===reply.message.id).length,1);
  assert.equal(db.executionTasks[0].status,'running');assert.equal(db.executionTasks[0].reportedRound,undefined);assert.equal(db.executionTasks[0].reportedToCoordinatorAt,undefined);
  const state=await service.state(a);assert.deepEqual(state.recentReportedReceiptIds,['same-local-execution']);assert.ok(state.transfers.some(t=>t.id==='same-local-conversation'&&t.running));
  assert.equal((await service.dispatch(a,input('operation_report_old_round','上一轮做了什么？只回答，不执行。'),key)).message.id,reply.message.id,'replaying the same answer cannot report twice');
  await f.store.mutate(d=>{const task=d.executionTasks[0];task.status='completed';task.finalResponse='NEW_ROUND_RESULT：改好新标题并回读';task.updatedAt=new Date().toISOString();task.completedAt=task.updatedAt;saveExecutionReceipt(d,task);});
  const next=await service.state(a);assert.deepEqual(next.notices.map(n=>n.id),['same-local-execution_1']);assert.equal(next.notices[0].reported,true);assert.equal(next.notices[0].read,false);
  db=await f.store.read();assert.equal(db.messages.filter(m=>m.id==='execution_receipt_same-local-execution_0').length,1);assert.equal(db.messages.filter(m=>m.id==='execution_receipt_same-local-execution_1').length,1);
});

test('new material and explicit continue automatically resume the same needs-input task through main chat and task send',async()=>{
 for(const entry of ['main','task']){
  const f=fixture();let executions=0;
  f.setWorker(async messages=>{
   executions++;const context=JSON.stringify(messages);
   if(executions===1)return answer(JSON.stringify({outcome:'needs_input',content:'还缺启动器的素材，请补充后再写。',summary:'还缺素材'}));
   assert.match(context,/UI 原目标：写一篇启动器说明/);assert.match(context,/素材补充：小小启动器/);
   return answer(JSON.stringify({outcome:executions===2?'partial':'completed',content:executions===2?'素材已写入正文，排版还没完成。':'启动器说明与排版均已完成。',summary:executions===2?'排版还没完成':'说明已完成'}));
  });
  const original=await f.service.dispatch(a,input(`operation_auto_${entry}_1`,'UI 原目标：写一篇启动器说明'),key);
  await f.service.resume(a,key);await waitFor(async()=>(await f.service.task(a,original.taskId!)).jobs[0].state==='failed');
  const awaiting=await f.service.task(a,original.taskId!);
  assert.equal(awaiting.recovery.kind,'none','safe material waiting does not offer a second manual start');
  assert.match(awaiting.recovery.message,/直接发给我.*不用另外点开始/);
  const supplement={...input(`operation_auto_${entry}_2`,'素材补充：小小启动器，按这个写'),boundTaskId:original.taskId};
  if(entry==='main')await f.service.dispatch(a,supplement,key);else await f.service.direct(a,original.taskId!,supplement,key);
  assert.equal((await f.service.task(a,original.taskId!)).conversation.workPaused,false,'new material does not need a second start button');
  await Promise.all([f.service.resume(a,key),f.service.resume(a,key)]);
  await waitFor(async()=>(await f.service.task(a,original.taskId!)).jobs.at(-1)!.state==='failed');
  await f.service.direct(a,original.taskId!,input(`operation_auto_${entry}_3`,'继续干'),key);
  await Promise.all([f.service.resume(a,key),f.service.resume(a,key)]);
  await waitFor(async()=>(await f.service.task(a,original.taskId!)).jobs.at(-1)!.state==='completed');
  await f.service.direct(a,original.taskId!,input(`operation_auto_${entry}_3`,'继续干'),key);await f.service.resume(a,key);
  assert.equal(executions,3,'each accepted instruction executes once, without replaying an old failed round');
  await assert.rejects(()=>f.service.direct(b,original.taskId!,input('operation_auto_foreign_1','继续干'),key));
 }
});

test('supplements arriving during a run merge into one latest sequential continuation after a normal partial result',async()=>{
 const f=fixture();let executions=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 f.setWorker(async messages=>{
  if(++executions===1){await gate;return answer(JSON.stringify({outcome:'partial',content:'已完成开头，等待补充后接着写。',summary:'还要接着写'}));}
  assert.match(JSON.stringify(messages),/UI 原稿目标/);assert.match(JSON.stringify(messages),/补充甲：不要使用真实姓名/);assert.match(JSON.stringify(messages),/补充乙：结尾加一个例子/);
  return answer(JSON.stringify({outcome:'completed',content:'完整说明已写好。',summary:'已完成'}));
 });
 const first=await f.service.dispatch(a,input('operation_auto_busy_1','UI 原稿目标'),key);await f.service.resume(a,key);
 await waitFor(async()=>executions===1);
 await f.service.direct(a,first.taskId!,input('operation_auto_busy_2','补充甲：不要使用真实姓名'),key);
 await f.service.direct(a,first.taskId!,input('operation_auto_busy_3','补充乙：结尾加一个例子'),key);
 let detail=await f.service.task(a,first.taskId!);assert.deepEqual(detail.jobs.map(j=>j.state),['running','cancelled','queued']);
 await f.service.resume(a,key);assert.equal(executions,1,'a supplement never interrupts the running round');
 release();await waitFor(async()=>(await f.service.task(a,first.taskId!)).jobs.at(-1)!.state==='completed');
 detail=await f.service.task(a,first.taskId!);assert.equal(executions,2);assert.equal(detail.jobs[1].state,'cancelled');assert.equal(detail.conversation.workPaused,false);
});

test('a status question or a new supplement cannot release an explicit user stop or a local safety hold',async()=>{
 for(const hold of ['question','stop','local']){
  const f=fixture();let executions=0;
  f.setWorker(async()=>{executions++;return answer(JSON.stringify({outcome:'needs_input',content:'请补充素材。',summary:'缺素材'}));});
  const first=await f.service.dispatch(a,input(`operation_auto_hold_${hold}_1`,'UI 原稿目标'),key);await f.service.resume(a,key);
  await waitFor(async()=>(await f.service.task(a,first.taskId!)).jobs[0].state==='failed');
  if(hold==='stop')await f.service.cancelTask(a,first.taskId!,key);
  if(hold==='local')await f.store.mutate(d=>(d.executionTasks??=[]).push({...a,id:'protected-local',conversationId:first.taskId!,status:'failed',executionSafetyHold:'command_unconfirmed'} as any));
  await f.service.direct(a,first.taskId!,input(`operation_auto_hold_${hold}_2`,hold==='question'?'现在怎么了？':'补充素材，请继续写'),key);
  await f.service.resume(a,key);assert.equal(executions,1,hold);assert.equal((await f.service.task(a,first.taskId!)).conversation.workPaused,true,hold);
 }
});

test('a real partial step-limit with an old verified Notion save resumes on named new material, reads the new source first and updates the same page once',async()=>{
 const f=fixture(),parentId='a'.repeat(32),pageId='b'.repeat(32);let body='旧的待素材说明',writes=0,recalls=0,workerCalls=0,selected:readonly string[]|undefined;
 const original=await f.service.dispatch(a,input('operation_step_material_1','UI 原目标：写一篇小小启动器专栏'),key);
 await f.store.mutate(d=>{
  d.knowledgeConnections.push({id:'notion-material',workspaceId:a.workspaceId,provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:a.userId,authorizedAt:'now',parentId}},{id:'getnote-material',workspaceId:a.workspaceId,provider:'getnote',status:'connected',clientId:'test'} as any);
  const task=d.conversations.find(c=>c.id===original.taskId)!,op=d.chatOperations!.find(o=>o.conversationId===task.id&&o.workRun)!,run=op.workRun!;
  task.workPaused=true;task.workPauseReason='failed';task.notionDocument={connectionId:'notion-material',grantId:'grant',parentId,pageId};
  op.status='failed';run.state='failed';run.resultOutcome='partial';run.failureCode='task_step_limit';run.notionTarget={...task.notionDocument,referenceIds:[]};run.notionReceipt={state:'verified',pageId,digest:'c'.repeat(64),expectedDigest:'c'.repeat(64)};
  run.contract={version:1,requiredFeatureIds:[],requiredTools:['knowledge_search','save_notion_draft'],knowledgeSourceIds:['notion-material'],execution:'model'};
  run.sources=[{id:'notion-material',binding:sourceBinding(d.knowledgeConnections[0])}];
  run.steps=[{key:'old-save',namespace:'worker',tool:'save_notion_draft',label:'旧说明',effect:'external_write',state:'completed',output:{state:'verified',pageId},updatedAt:'2026-10-25T01:00:00Z'}];
 });
 const mcp={readDocument:async()=>({text:body}),callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,name:string,args:any)=>{
  assert.equal(name,'notion-update-page');assert.equal(args.page_id??args.pageId,pageId);writes++;for(const update of args.content_updates)body=body.replace(update.old_str,update.new_str);return {};
 }} as unknown as NotionMcpService;
 const finalBody='小小启动器把复杂操作收在一个入口：插上后先定位手边材料，再把关键决定写成可交付的说明。';
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async(_ws,_query,_top,ids)=>{recalls++;selected=ids;return {status:'used',chunks:[{title:'小小启动器',content:'把复杂操作收在一个入口，插上就能找资料并完成工作。'}],failures:[]};}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('按新补充的素材接着写。'):{...answer(''),toolCalls:[{id:'continue',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:original.taskId,title:'小小启动器专栏',instruction:'按新补充材料继续完成这篇专栏',executorId:'general'})}}]};
  workerCalls++;
  if(workerCalls===2)return {...answer(''),toolCalls:[{id:'source-first',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'小小启动器'})}}]};
  if(workerCalls===1){assert.equal(writes,0);return {...answer(''),toolCalls:[{id:'premature-save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({old_str:'旧的待素材说明',new_str:finalBody,final:true})}}]};}
  assert.equal(workerCalls,3,'final verified write must not buy another model round or repeat save');assert.equal(recalls,1);
  return {...answer(''),toolCalls:[{id:'final-save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({old_str:'旧的待素材说明',new_str:finalBody,final:true})}}]};
 }});
 const reply=await service.dispatch(a,{...input('operation_step_material_2','得到大脑有小小启动器内容，按这个写。不要新建重复页面，继续改原文'),boundTaskId:original.taskId,outputDestination:'chat'},key);
 assert.equal(reply.taskId,original.taskId);assert.equal((await service.task(a,original.taskId!)).conversation.workPaused,false);
 await Promise.all([service.resume(a,key),service.resume(a,key)]);await waitFor(async()=>['failed','completed'].includes((await service.task(a,original.taskId!)).jobs.at(-1)!.state));
 const detail=await service.task(a,original.taskId!);assert.equal(detail.jobs.at(-1)!.state,'completed',JSON.stringify({job:detail.jobs.at(-1),writes,recalls,workerCalls,selected,body,trace:(await f.store.read()).contextTraces.at(-1)?.executionSteps}));assert.deepEqual(selected,['getnote-material']);assert.equal(writes,1);assert.equal(body,finalBody);assert.equal(detail.jobs.length,2);assert.equal(detail.jobs[0].state,'failed');assert.equal(detail.jobs.at(-1)!.notionReceipt?.state,'verified');assert.equal(workerCalls,3);
 assert.match((await service.state(a)).conversation!.messages.at(-1)!.content,new RegExp(pageId));
});

test('plain continue retains the unfinished feature contract and still checks the current release before admitting work',async()=>{
 const f=fixture();await f.store.mutate(d=>{
  const values={name:'合成网页',author:'ONE',description:'合成能力',instructions:'仅测试',limitations:'不联网',integration:'question_answer' as const,knowledgeMode:'none' as const,tools:[{id:'oneHtml',description:'网页'}]};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};
  d.settings.officialFeatures=[{id:'continuation-page',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'continuation-release',version:1,userIds:['a'],publishedAt:'now',publishedBy:'a'}}] as any;
 });
 const first=await f.service.dispatch(a,input('operation_contract_continue_1','UI 原目标'),key);
 await f.store.mutate(d=>{const task=d.conversations.find(c=>c.id===first.taskId)!,run=d.chatOperations!.find(o=>o.conversationId===task.id&&o.workRun)!.workRun!,feature=d.settings.officialFeatures![0];
  task.workPaused=true;task.workPauseReason='partial';run.state='failed';run.resultOutcome='partial';run.steps=[];run.instruction='整理昨天的活动安排';run.runtimeContext=runtimeContext(d,a,'2026-10-24T01:00:00Z');run.skills=[{id:feature.id,releaseId:feature.release!.id,version:1,values:feature.current!.values}];run.contract={version:1,requiredFeatureIds:[feature.id],requiredTools:['oneHtml'],execution:'model'};
 });
 await f.service.direct(a,first.taskId!,input('operation_contract_continue_2','继续干'),key);
 let detail=await f.service.task(a,first.taskId!);assert.equal(detail.conversation.workPaused,false);
 const run=(await f.store.read()).chatOperations!.filter(o=>o.conversationId===first.taskId&&o.workRun).at(-1)!.workRun!;
 assert.deepEqual(run.contract!.requiredFeatureIds,['continuation-page']);assert.deepEqual(run.contract!.requiredTools,['oneHtml']);assert.equal(run.skills[0].releaseId,'continuation-release');
 assert.equal(run.runtimeContext!.today,'2026-10-24');assert.match(run.instruction,/整理昨天的活动安排/,'plain continue keeps the original pending goal and its relative-date origin');
 await f.store.mutate(d=>{d.settings.officialFeatures![0].status='draft';d.settings.officialFeatures![0].release=undefined;});
 await assert.rejects(()=>f.service.direct(a,first.taskId!,input('operation_contract_continue_3','继续干'),key),/功能未开放|已下架|版本已变更/);
 detail=await f.service.task(a,first.taskId!);assert.equal(detail.jobs.length,2,'a revoked feature cannot silently execute on old permissions');
});

test('generic missing material in a Notion task returns needs-input once without forcing a placeholder, then supplied text resumes and saves',async()=>{
 const f=fixture(),parentId='a'.repeat(32),pageId='d'.repeat(32);let calls=0,writes=0,body='';
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion-missing',workspaceId:a.workspaceId,provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:a.userId,authorizedAt:'now',parentId}}));
 const mcp={readDocument:async()=>({text:body||'保存目录'}),callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,name:string,args:any)=>{assert.equal(name,'notion-create-pages');writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};}} as unknown as NotionMcpService;
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{assert.fail('user supplied all material and declined retrieval');}},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('我来处理。'):{...answer(''),toolCalls:[{id:'delegate',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'启动器说明',instruction:'缺少素材先询问；拿到资料后写说明并保存到Notion。不查知识库。',executorId:'general'})}}]};
  calls++;
  if(calls===1)return answer(JSON.stringify({outcome:'needs_input',content:'还缺启动器的素材。请直接补充一两句素材，我接着写。',summary:'还缺启动器的素材，请补充一两句。'}));
  assert.equal(calls,2,'missing input must not buy four empty attempts, and final write needs no extra acknowledgement');
  assert.match(JSON.stringify(messages),/小小启动器让用户插上就能开始工作/);
  return {...answer(''),toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'启动器说明',content:'小小启动器让用户插上就能开始工作，把资料、工具和交付连接起来。',final:true})}}]};
 }});
 const accepted=await service.dispatch(a,{...input('operation_generic_material_1','请写启动器说明并保存到Notion，缺素材先问我，不查知识库。'),outputDestination:'notion'},key);await service.resume(a,key);
 await waitFor(async()=>(await service.task(a,accepted.taskId!)).jobs[0].state==='failed');
 let detail=await service.task(a,accepted.taskId!);assert.equal((await f.store.read()).chatOperations!.find(op=>op.conversationId===accepted.taskId&&op.workRun)!.workRun!.resultOutcome,'needs_input');assert.equal(calls,1);assert.equal(writes,0);
 assert.match(detail.conversation.messages.at(-1)!.content,/请直接补充一两句素材/);
 const missingInputReport=await service.state(a);
 assert.match(missingInputReport.conversation!.messages.at(-1)!.content,/启动器的素材/);
 assert.doesNotMatch(missingInputReport.conversation!.messages.at(-1)!.content,/剩下的内容还没做好|确认启动/);
 await service.direct(a,accepted.taskId!,{...input('operation_generic_material_2','素材：小小启动器让用户插上就能开始工作，把资料、工具和交付连接起来。按这个写。'),outputDestination:'chat'},key);
 assert.equal((await service.task(a,accepted.taskId!)).conversation.workPaused,false);
 await service.resume(a,key);await waitFor(async()=>(await service.task(a,accepted.taskId!)).jobs.at(-1)!.state==='completed');
 detail=await service.task(a,accepted.taskId!);assert.equal(writes,1);assert.equal(calls,2);assert.equal(detail.jobs.at(-1)!.notionReceipt!.state,'verified');
});

async function pendingNotionVerificationFixture(options:{final?:boolean;required?:string[]}={}){
 const f=fixture(),pageId='e'.repeat(32),parentId='a'.repeat(32),body='最终合成方案\n自然结尾。',digest=createHash('sha256').update(body).digest('hex'),clock={now:Date.now()};
 const accepted=await f.service.dispatch(a,input('operation_delayed_receipt_seed','UI 合成任务'),key);
 clock.now=Date.now()+1000;
 let operationId='';
 await f.store.mutate(d=>{
  d.knowledgeConnections.push({id:'delayed-notion',workspaceId:a.workspaceId,provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'delayed-grant',userId:a.userId,authorizedAt:'now',parentId}});
  const op=d.chatOperations!.find(o=>o.workRun&&o.conversationId===accepted.taskId)!,task=d.conversations.find(c=>c.id===accepted.taskId)!;operationId=op.id;
  op.status='pending';op.workRun!.state='failed';op.workRun!.failureCode='notion_verification_pending';op.workRun!.unread=false;
  op.workRun!.contract={version:1,execution:'model',requiredFeatureIds:[],requiredTools:['save_notion_draft',...(options.required??[])]};
  op.workRun!.notionTarget={connectionId:'delayed-notion',grantId:'delayed-grant',parentId,referenceIds:[]};
  op.workRun!.notionReceipt={state:'uncertain',pageId,url:`https://www.notion.so/${pageId}`,expectedDigest:digest,checkpointKey:'exact-delayed-save',final:options.final!==false,verification:{state:'scheduled',version:1,attempt:0,nextCheckAt:new Date(clock.now).toISOString(),deadlineAt:new Date(clock.now+60000).toISOString()}};
  op.workRun!.steps=[{key:'exact-delayed-save',namespace:'worker',scopeId:op.id,tool:'save_notion_draft',label:'保存到 Notion',state:'started',effect:'external_write',updatedAt:op.createdAt}];
  task.workPaused=true;task.workPauseReason='failed';
 });
 return {...f,taskId:accepted.taskId!,operationId,pageId,body,clock};
}
function verificationService(f:Awaited<ReturnType<typeof pendingNotionVerificationFixture>>,read:()=>Promise<unknown>,worker?:()=>Promise<ToolChatResult>){
 return new CoordinatorService(f.store,{recallWithDiagnostics:async()=>assert.fail('verification never retrieves other knowledge')},{notionDocuments:new NotionDocuments(f.store,{readDocument:async(ws:string,id:string)=>{assert.equal(ws,a.workspaceId);assert.equal(id,f.pageId);return read();},callDocumentTool:async()=>assert.fail('verification never creates or updates')} as unknown as NotionMcpService,{now:()=>f.clock.now,delays:[1,2]}),modelCall:async()=>worker?worker():assert.fail('verification never buys another model call'),reportCall:async()=>assert.fail('verification never buys a progress report')});
}

test('connected-Key Notion verification is active until exact readback, then briefs once without model calls or billing',async()=>{
 const f=await pendingNotionVerificationFixture();let reads=0,proofs=0;
 const service=verificationService(f,async()=>{reads++;return {text:f.body};}),before=await f.store.read();
 const pending=await service.state(a),transfer=pending.transfers.find(t=>t.id===f.taskId)!;
 assert.equal(transfer.state,'reconciling');assert.equal(transfer.running,false);assert.equal(transfer.reconciling,true);assert.equal(pending.notices.length,0);
 assert.equal(reads,0,'viewing session state without a fresh Key callback cannot read Notion');
 await service.state(a,1,async()=>{proofs++;throw Error('Key is offline');});await new Promise(resolve=>setTimeout(resolve,15));assert.equal(reads,0);
 await service.reconcileNotionResults(b,key);assert.equal(reads,0,'another exact owner has no candidate');
 await Promise.all([service.reconcileNotionResults(a,async()=>{proofs++;}),service.reconcileNotionResults(a,async()=>{proofs++;})]);
 const db=await f.store.read(),op=db.chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(reads,1);assert.ok(proofs>=3);assert.equal(op.status,'completed');assert.equal(op.workRun!.state,'completed');assert.equal(op.workRun!.resultOutcome,'completed');
 assert.equal(op.workRun!.steps![0].state,'completed');assert.equal(op.workRun!.notionReceipt!.verification,undefined);
 assert.equal(db.powerLedger.length,before.powerLedger.length);assert.equal(db.modelUsageRecords.length,before.modelUsageRecords.length);
 const done=await service.state(a),report=done.conversation!.messages.find(m=>m.id===op.workRun!.reportMessageId)!;
 assert.match(report.content,new RegExp(f.pageId));assert.match(report.content,/保存|核对/);assert.equal(done.transfers.some(t=>t.id===f.taskId),false);
 await service.reconcileNotionResults(a,key);await service.state(a);assert.equal(reads,1);assert.equal((await service.task(a,f.taskId)).conversation.messages.filter(m=>m.role==='assistant').length,1);
 assert.equal((await service.state(b)).conversation,null);
});

test('a saved proof waiting for deterministic finalization stays visibly active without a failed main briefing',async()=>{
 const f=await pendingNotionVerificationFixture();
 await f.store.mutate(d=>{const run=d.chatOperations!.find(o=>o.id===f.operationId)!.workRun!;run.notionReceipt!.state='verified';run.notionReceipt!.digest=run.notionReceipt!.expectedDigest;run.notionReceipt!.verification=undefined;run.steps![0].state='completed';run.steps![0].output={...run.notionReceipt};});
 const service=verificationService(f,async()=>assert.fail('a complete stored readback does not need another read'));
 const state=await service.state(a),transfer=state.transfers.find(t=>t.id===f.taskId)!;
 assert.equal(transfer.state,'reconciling');assert.equal(transfer.running,false);assert.match(transfer.phase!,/保存已经核对，正在整理结果/);assert.equal(state.notices.length,0);
 const detail=await service.task(a,f.taskId);assert.equal(detail.jobs[0].verificationPending,true);assert.equal(detail.recovery.kind,'reconciling');
 await service.reconcileNotionResults(a,key);assert.equal((await service.task(a,f.taskId)).jobs[0].state,'completed');
});

test('a real worker write with delayed readback exits to a durable verification phase before any paid progress report',async()=>{
 const f=fixture(),parentId='a'.repeat(32),pageId='f'.repeat(32),clock={now:Date.now()+1000};let writes=0,reads=0,workerCalls=0,body='';
 await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion-real-delayed',workspaceId:a.workspaceId,provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:a.userId,authorizedAt:'now',parentId}}));
 const documents=new NotionDocuments(f.store,{readDocument:async()=>{reads++;if(reads===1)throw Error('eventual-read-timeout');return {text:body};},callDocumentTool:async(_w:string,_c:string,_g:string,_u:string,name:string,args:any,beforeSend?:()=>Promise<void>)=>{assert.equal(name,'notion-create-pages');await beforeSend?.();writes++;body=args.pages[0].content;return {pages:[{id:pageId}]};}} as unknown as NotionMcpService,{now:()=>clock.now,delays:[5,10]});
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>assert.fail('not requested')},{notionDocuments:documents,reportCall:async()=>assert.fail('pending verification must not purchase a report'),modelCall:async(model,messages)=>{
  if(model.id==='router')return messages.at(-1)?.role==='tool'?answer('我来处理。'):{...answer(''),toolCalls:[{id:'delegate',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'延后核对方案',instruction:'用合成内容写完整项目方案并保存Notion，不查知识库',executorId:'general'})}}]};
  workerCalls++;assert.equal(workerCalls,1,'a saved write is never regenerated');return {...answer(''),toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify({title:'项目方案',content:'完整合成项目方案。\n自然结尾。',final:true})}}]};
 }});
 const accepted=await service.dispatch(a,{...input('operation_real_delayed_write','请用合成内容写完整项目方案并保存Notion，不查知识库'),outputDestination:'notion'},key);
 await service.resume(a,key);await waitFor(async()=>(await f.store.read()).chatOperations!.some(o=>o.conversationId===accepted.taskId&&o.workRun?.failureCode==='notion_verification_pending'));
 const pending=await f.store.read(),op=pending.chatOperations!.find(o=>o.conversationId===accepted.taskId&&o.workRun)!;
 assert.equal(op.status,'pending');assert.equal(writes,1);assert.equal(reads,1);assert.equal(workerCalls,1);
 assert.equal((await service.state(a)).notices.length,0);assert.equal((await service.task(a,accepted.taskId!)).conversation.messages.filter(m=>m.role==='assistant').length,0);
 assert.ok(pending.contextTraces.some(t=>t.requestId===op.requestId&&t.executionSteps?.some(step=>step.tool==='save_notion_draft')),'the original exact write trace remains available for support without generating another report');
 clock.now+=20;await service.reconcileNotionResults(a,key);
 const done=await f.store.read();assert.equal(done.chatOperations!.find(o=>o.id===op.id)!.workRun!.resultOutcome,'completed');assert.equal(done.powerLedger.length,pending.powerLedger.length);assert.equal(done.modelUsageRecords.length,pending.modelUsageRecords.length);assert.equal(writes,1);assert.equal(reads,2);assert.equal(workerCalls,1);
});

for(const kind of ['intermediate','required-source'] as const)test(`delayed ${kind} saving confirms the page but never invents whole-task completion`,async()=>{
 const f=await pendingNotionVerificationFixture(kind==='intermediate'?{final:false}:{required:['knowledge_search']});
 const service=verificationService(f,async()=>({text:f.body}));await service.reconcileNotionResults(a,key);
 const detail=await service.task(a,f.taskId),op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(detail.jobs[0].notionReceipt!.state,'verified');assert.equal(op.workRun!.resultOutcome,'partial');assert.equal(op.workRun!.state,'failed');assert.equal(detail.conversation.workPaused,true);
 const report=(await service.state(a)).conversation!.messages.at(-1)!.content;
 assert.match(report,/其余步骤还没有全部完成/);assert.doesNotMatch(report,/任务已完成|全部完成了/);assert.match(report,new RegExp(f.pageId));
});

test('bounded mismatching readback remains active between checks and ends once with a real original-page next step',async()=>{
 const f=await pendingNotionVerificationFixture();let reads=0;
 const service=verificationService(f,async()=>{reads++;return {text:'另一份未匹配的正文'};});
 await service.reconcileNotionResults(a,key);assert.equal((await service.state(a)).transfers[0].state,'reconciling');assert.equal((await service.state(a)).notices.length,0);
 f.clock.now+=10;await service.reconcileNotionResults(a,key);
 const op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(reads,2);assert.equal(op.workRun!.notionReceipt!.verification!.state,'exhausted');assert.equal(op.workRun!.failureCode,'notion_verification_exhausted');
 const main=(await service.state(a)).conversation!,report=main.messages.find(m=>m.id===op.workRun!.reportMessageId)!;
 assert.match(report.content,/未完整核对/);assert.match(report.content,/打开|核对|确认/);assert.match(report.content,new RegExp(f.pageId));assert.doesNotMatch(report.content,/已完成|已保存到 Notion · 已回读核对/);
 await service.reconcileNotionResults(a,key);await service.state(a);assert.equal(reads,2);assert.equal((await service.task(a,f.taskId)).conversation.messages.filter(m=>m.role==='assistant').length,1);
});

test('stopping during delayed Notion readback preserves user stop and cannot finalize from a late response',async()=>{
 const f=await pendingNotionVerificationFixture();let release!:(value:unknown)=>void;
 const service=verificationService(f,async()=>new Promise(resolve=>{release=resolve;}));
 const checking=service.reconcileNotionResults(a,key);await waitFor(async()=>Boolean(release));
 await assert.rejects(()=>service.cancelTask(b,f.taskId,key),/不存在/);await service.cancelTask(a,f.taskId,key);
 release({text:f.body});await checking;
 const detail=await service.task(a,f.taskId);assert.equal(detail.jobs[0].state,'cancelled');assert.equal(detail.conversation.workPauseReason,'user_stopped');assert.equal(detail.conversation.workPaused,true);assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,0);
});

test('a verified delayed save waits for a busy main reply and is delivered once when that reply is no longer pending',async()=>{
 const f=await pendingNotionVerificationFixture();
 await f.store.mutate(d=>d.chatOperations!.push({...a,id:'busy-while-notion-checks',operationId:'busy_notion_check_operation',requestId:'coord_busy_notion_check',payloadHash:'fixed',status:'pending',createdAt:new Date(f.clock.now).toISOString(),updatedAt:new Date(f.clock.now).toISOString()}));
 const service=verificationService(f,async()=>({text:f.body})),before=(await service.state(a)).conversation!.messages.length;
 await service.reconcileNotionResults(a,key);
 let op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(op.workRun!.resultOutcome,'completed');assert.equal(op.workRun!.reportedToCoordinatorAt,undefined);assert.equal((await service.state(a)).conversation!.messages.length,before);
 await f.store.mutate(d=>{d.chatOperations!.find(o=>o.id==='busy-while-notion-checks')!.status='completed';});
 await Promise.all([service.state(a),service.state(a)]);op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;
 assert.ok(op.workRun!.reportedToCoordinatorAt);assert.equal((await service.state(a)).conversation!.messages.length,before+1);
});

for(const localHold of [false,true])test(`verification releases only its own pause for an admitted newer requirement (local hold=${localHold})`,async()=>{
 const f=await pendingNotionVerificationFixture();let workerCalls=0;
 // This supplement was admitted while the first worker was still running,
 // before that worker transferred its unresolved write to verification.
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.workRun!.state='running';const task=d.conversations.find(c=>c.id===f.taskId)!;task.workPaused=false;task.workPauseReason=undefined;});
 await f.service.direct(a,f.taskId,input('operation_delayed_new_html','只在对话里提供新的 HTML 代码，不保存到Notion，不查知识库。'),key);
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.workRun!.state='failed';const task=d.conversations.find(c=>c.id===f.taskId)!;task.workPaused=true;task.workPauseReason='failed';if(localHold)(d.executionTasks??=[]).push({...a,id:'unrelated-local-hold',conversationId:f.taskId,status:'failed',executionSafetyHold:true,createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'} as unknown as NonNullable<Database['executionTasks']>[number]);});
 const service=verificationService(f,async()=>({text:f.body}),async()=>{workerCalls++;return answer('<main>新的合成 HTML 方案</main>');});
 await service.reconcileNotionResults(a,key);
 let detail=await service.task(a,f.taskId);assert.equal(detail.jobs[0].state,'completed');assert.equal(detail.jobs[1].state,'queued');assert.equal(workerCalls,0,'the read-only checker itself never starts a model');assert.equal(detail.conversation.workPaused,localHold);
 await service.resume(a,key);
 if(localHold){assert.equal(workerCalls,0);assert.equal((await service.task(a,f.taskId)).jobs[1].state,'queued');}
 else{await waitFor(async()=>(await service.task(a,f.taskId)).jobs[1].state==='completed');detail=await service.task(a,f.taskId);assert.equal(workerCalls,1);assert.match(detail.conversation.messages.at(-1)!.content,/新的合成 HTML 方案/);assert.equal(detail.jobs[0].state,'completed');}
});

test('an explicit legacy receipt check finalizes only its selected verified final draft and leaves a newer queued requirement intact',async()=>{
 const f=await pendingNotionVerificationFixture();
 await f.store.mutate(d=>{
  const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.status='failed';op.workRun!.failureCode='task_execution_failed';op.workRun!.notionReceipt!.verification=undefined;
  const newer=structuredClone(op);newer.id='newer-html-op';newer.operationId='newer_html_operation_0001';newer.createdAt=new Date(Date.parse(op.createdAt)+1000).toISOString();newer.status='pending';newer.workRun!.state='queued';newer.workRun!.failureCode=undefined;newer.workRun!.notionReceipt=undefined;newer.workRun!.notionTarget=undefined;newer.workRun!.steps=[];newer.workRun!.contract={version:1,execution:'direct',requiredFeatureIds:[],requiredTools:['oneHtml']};d.chatOperations!.push(newer);
 });
 const service=verificationService(f,async()=>({text:f.body}));
 await service.reconcileNotionResults(a,key);assert.equal((await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!.status,'failed','legacy history is never automatically enrolled');
 await service.verifyNotionResult(a,f.taskId,key);
 const db=await f.store.read(),old=db.chatOperations!.find(o=>o.id===f.operationId)!,newer=db.chatOperations!.find(o=>o.id==='newer-html-op')!,detail=await service.task(a,f.taskId);
 assert.equal(old.workRun!.state,'completed');assert.equal(old.status,'completed');assert.equal(newer.workRun!.state,'queued');assert.equal(newer.status,'pending');assert.equal(detail.conversation.workPaused,true);
 await service.verifyNotionResult(a,f.taskId,key);assert.equal((await service.task(a,f.taskId)).conversation.messages.filter(m=>m.role==='assistant').length,1);
});

test('an explicit legacy check that first schedules a mismatch survives restart and later finalizes only that exact selected operation',async()=>{
 const f=await pendingNotionVerificationFixture();let reads=0;
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.status='failed';op.workRun!.failureCode='task_execution_failed';op.workRun!.notionReceipt!.verification=undefined;const other=structuredClone(op),task=structuredClone(d.conversations.find(c=>c.id===f.taskId)!);other.id='unselected-old-operation';other.operationId='unselected_old_operation_001';other.conversationId=task.id='unselected-old-task';task.messages=[];other.workRun!.notionReceipt!.pageId='b'.repeat(32);d.chatOperations!.push(other);d.conversations.push(task);});
 let service=verificationService(f,async()=>({text:++reads===1?'暂未同步的正文':f.body}));
 await assert.rejects(()=>service.verifyNotionResult(a,f.taskId,key),/稍后会继续只读核对/);
 let db=await f.store.read(),op=db.chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(op.status,'failed');assert.equal(op.workRun!.failureCode,'task_execution_failed');assert.equal(op.workRun!.notionVerificationSelection!.operationId,f.operationId);assert.equal(op.workRun!.notionVerificationSelection!.expectedDigest,op.workRun!.notionReceipt!.expectedDigest);
 assert.equal((await service.state(a)).transfers.find(t=>t.id===f.taskId)!.state,'reconciling');assert.equal((await service.task(a,f.taskId)).recovery.kind,'reconciling');
 await service.reconcileNotionResults(b,key);await assert.rejects(()=>service.verifyNotionResult(b,f.taskId,key),/不存在/);assert.equal(reads,1,'manual enrollment never grants another workspace a read');
 await f.store.mutate(d=>reconcileInterruptedChatOperations(d));
 service=verificationService(f,async()=>{reads++;return {text:f.body};});f.clock.now+=10;
 await service.reconcileNotionResults(a,key);db=await f.store.read();op=db.chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(reads,2);assert.equal(op.status,'completed');assert.equal(op.workRun!.resultOutcome,'completed');assert.equal(op.workRun!.notionVerificationSelection,undefined);
 assert.equal(db.chatOperations!.find(o=>o.id==='unselected-old-operation')!.status,'failed');assert.equal(db.chatOperations!.find(o=>o.id==='unselected-old-operation')!.workRun!.notionReceipt!.verification,undefined,'no unselected history is enrolled or read');
 const reported=op.workRun!.reportMessageId;assert.ok(reported);assert.match((await service.state(a)).conversation!.messages.find(m=>m.id===reported)!.content,new RegExp(f.pageId));
 await service.reconcileNotionResults(a,key);assert.equal(reads,2);assert.equal((await service.task(a,f.taskId)).conversation.messages.filter(m=>m.role==='assistant').length,1);
});

test('a delayed manual proof survives the readback/finalization restart gap without leaking a failed main result',async()=>{
 const f=await pendingNotionVerificationFixture();
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.status='failed';op.workRun!.failureCode='task_execution_failed';op.workRun!.notionReceipt!.verification=undefined;});
 const service=verificationService(f,async()=>({text:'暂未同步'}));await assert.rejects(()=>service.verifyNotionResult(a,f.taskId,key),/稍后会继续只读核对/);f.clock.now+=10;
 const reader=new NotionDocuments(f.store,{readDocument:async()=>({text:f.body}),callDocumentTool:async()=>assert.fail('readback is not a write')} as unknown as NotionMcpService,{now:()=>f.clock.now,delays:[1,2]});
 await reader.reconcileDue(a,key);await f.store.mutate(d=>reconcileInterruptedChatOperations(d));
 const state=await service.state(a),detail=await service.task(a,f.taskId);assert.equal(detail.jobs[0].notionReceipt!.state,'verified');assert.equal(detail.jobs[0].verificationPending,true);assert.equal(detail.recovery.kind,'reconciling');assert.match(state.transfers.find(t=>t.id===f.taskId)!.phase!,/保存已经核对/);assert.equal(state.notices.length,0);
 await service.reconcileNotionResults(a,key);assert.equal((await service.task(a,f.taskId)).jobs[0].state,'completed');
});

test('a manually selected legacy intermediate draft clears its readback selection but never promotes the unfinished task',async()=>{
 const f=await pendingNotionVerificationFixture({final:false});
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.status='failed';op.workRun!.failureCode='task_execution_failed';op.workRun!.notionReceipt!.verification=undefined;});
 const service=verificationService(f,async()=>({text:f.body}));await service.verifyNotionResult(a,f.taskId,key);
 const op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!,detail=await service.task(a,f.taskId);
 assert.equal(op.workRun!.notionReceipt!.state,'verified');assert.equal(op.workRun!.notionVerificationSelection,undefined);assert.equal(op.workRun!.state,'failed');assert.notEqual(op.workRun!.resultOutcome,'completed');assert.equal(detail.conversation.workPaused,true);assert.equal(detail.jobs[0].verificationPending,false);assert.match((await service.state(a)).conversation!.messages.at(-1)!.content,/只确认了保存状态|其余没做完/);
});

test('an explicitly selected legacy check that exhausts gives one new main next-step report despite an old reported failure',async()=>{
 const f=await pendingNotionVerificationFixture();let reads=0;
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!;op.status='failed';op.workRun!.failureCode='task_execution_failed';op.workRun!.notionReceipt!.verification=undefined;op.workRun!.reportedToCoordinatorAt='2020-01-01T00:00:00Z';op.workRun!.reportMessageId='old-failure-report';});
 const service=verificationService(f,async()=>{reads++;return {text:'仍然不一致的正文'};});
 await assert.rejects(()=>service.verifyNotionResult(a,f.taskId,key),/稍后会继续只读核对/);f.clock.now+=10;
 await service.reconcileNotionResults(a,key);
 let op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(reads,2);assert.equal(op.workRun!.notionReceipt!.verification!.state,'exhausted');assert.equal(op.workRun!.notionVerificationSelection,undefined);assert.equal(op.workRun!.resultOutcome,'partial');assert.equal(op.workRun!.reportRevision,1);assert.notEqual(op.workRun!.reportMessageId,'old-failure-report');
 const report=(await service.state(a)).conversation!.messages.find(m=>m.id===op.workRun!.reportMessageId)!;assert.match(report.content,/未完整核对/);assert.match(report.content,new RegExp(f.pageId));
 await service.reconcileNotionResults(a,key);await service.state(a);op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;assert.equal(op.workRun!.reportRevision,1);assert.equal(reads,2);
});

test('automatic exhaustion can be explicitly rechecked, schedule once and later complete the exact final save without replaying work',async()=>{
 const f=await pendingNotionVerificationFixture();let reads=0,matched=false;
 const service=verificationService(f,async()=>{reads++;return {text:matched?f.body:'暂时仍未同步的正文'};});
 await service.reconcileNotionResults(a,key);f.clock.now+=10;await service.reconcileNotionResults(a,key);
 let op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;
 assert.equal(op.status,'completed');assert.equal(op.workRun!.state,'failed');assert.equal(op.workRun!.failureCode,'notion_verification_exhausted');
 const oldMessage=op.workRun!.resultMessageId;
 await assert.rejects(()=>service.verifyNotionResult(a,f.taskId,key),/稍后会继续只读核对/);
 op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;assert.ok(op.workRun!.notionVerificationSelection);assert.equal(op.status,'completed');assert.equal((await service.task(a,f.taskId)).recovery.kind,'reconciling');
 matched=true;f.clock.now+=10;await service.reconcileNotionResults(a,key);
 op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!;assert.equal(op.status,'completed');assert.equal(op.workRun!.state,'completed');assert.equal(op.workRun!.resultOutcome,'completed');assert.equal(op.workRun!.notionVerificationSelection,undefined);
 const detail=await service.task(a,f.taskId);assert.ok(detail.conversation.messages.some(m=>m.id===oldMessage),'the old partial history is retained');assert.equal(detail.conversation.messages.filter(m=>m.role==='assistant').length,2);
 const count=(await service.state(a)).conversation!.messages.length;await service.reconcileNotionResults(a,key);assert.equal((await service.state(a)).conversation!.messages.length,count);assert.equal(reads,4);
});

test('an old verified receipt is not fresh proof when an explicit recheck finds the page externally edited',async()=>{
 const f=await pendingNotionVerificationFixture();let reads=0;
 await f.store.mutate(d=>{const op=d.chatOperations!.find(o=>o.id===f.operationId)!,run=op.workRun!,r=run.notionReceipt!;op.status='failed';run.failureCode='task_execution_failed';r.state='verified';r.digest=r.expectedDigest;r.verification=undefined;run.steps![0].state='completed';run.steps![0].output={state:'verified',pageId:r.pageId,digest:r.digest,expectedDigest:r.expectedDigest,final:true};});
 const service=verificationService(f,async()=>{reads++;return {text:'用户已经在Notion改过的新正文'};});
 await assert.rejects(()=>service.verifyNotionResult(a,f.taskId,key),/自动核对已停下/);
 await service.reconcileNotionResults(a,key);
 const op=(await f.store.read()).chatOperations!.find(o=>o.id===f.operationId)!,detail=await service.task(a,f.taskId);
 assert.equal(op.workRun!.notionReceipt!.state,'verified','historical save evidence is not erased');assert.equal(op.workRun!.notionReceipt!.verification!.state,'exhausted');assert.equal(op.workRun!.state,'failed');assert.equal(op.workRun!.resultOutcome,'partial');assert.equal(op.workRun!.notionVerificationSelection,undefined);assert.equal(reads,1);
 assert.match(detail.conversation.messages.at(-1)!.content,/未能完整核对|没能完整核对/);assert.doesNotMatch(detail.conversation.messages.at(-1)!.content,/已保存到 Notion · 已回读核对|任务已完成/);assert.match(detail.conversation.messages.at(-1)!.content,/打开 Notion 原文/);
});
