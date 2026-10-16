import test from "node:test";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
import { NotionDocuments } from './notionDocuments.js';
import type { NotionMcpService } from './knowledge/notionMcpService.js';
import { defaultTaskValues, updateTaskConfig } from "./aiTaskConfig.js";
import { executorDefaults, updateExecutor } from "./executorProfiles.js";
import { beginChatOperation,reconcileInterruptedChatOperations } from "./chatOperations.js";
import { MODEL_MAX_OUTPUT_TOKENS, type ModelToolMessage, type ModelToolDefinition, type ToolChatResult } from "./modelGateway.js";

for(const sponsored of [true,false])test(`welcome manual → image → shared visual functions is durable, scoped and billed by stage (gift=${sponsored})`,async()=>{
  const f=await imageFixture(async()=>({content:'',imageUrl:imageFixturePng})),operationId='welcome_manual_0123456789';let texts=0,images=0;
  const scene={id:'idea',title:'整理想法',situation:'开会前有一堆想法。',feature:'把想法整理成提纲。',advantage:'不用自己反复排版。',benefit:'拿到可讨论的提纲。',evidence:'查看实际提纲，核对缺口。',steps:['说出目标。','核对提纲。'],prompt:'帮我整理开会提纲。',capabilityIds:['chat']};
  const doc={version:1,title:'小明的 ONE 使用说明',intro:'先从今天要开的会开始。',scenes:[scene,{...scene,id:'result',title:'把成果拿来用',capabilityIds:['visual']}]};
  await f.store.mutate(d=>{
    const u=d.users.find(u=>u.id==='a')!;u.defaultWorkspaceId='wa';
    u.profile={workspaceId:'wa',displayName:'小明',onboarding:{knowledgeChoice:'skipped',completedAt:'now',journey:{id:'journey_manual_test',launchId:'manual_launch_012345',version:2,experience:4,stage:'complete',startedAt:'now',featureIds:[],events:[]},handbook:{operationId,funding:sponsored?'one':'customer',status:'pending',requestedAt:'now',updatedAt:'now',maxPower:.5},...(sponsored?{welcomeGiftOperationId:operationId}:{})},updatedAt:'now'};
    const v=d.settings.aiTasks!.image_generation!.published!;v.imagePowerPerCall=.012;v.costImagePowerPerCall=.02;delete v.enabled;
    if(sponsored)d.powerAccounts.find(p=>p.userId==='a')!.balanceMicros=0;
  });
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('must not read knowledge');}},{artifactDirectory:f.directory,modelCall:async(_m,messages,tools)=>{texts++;assert.equal(tools[0].function.name,'oneManual');assert.doesNotMatch(JSON.stringify(messages),/apiKey|storagePath/);return {...answer(''),toolCalls:[{id:'manual',type:'function',function:{name:'oneManual',arguments:JSON.stringify(doc)}}]};},imageCall:async(_m,messages)=>{images++;assert.match(JSON.stringify(messages),/开会前有一堆想法/);assert.match(JSON.stringify(messages),/小明的 ONE 使用说明/);return {content:'',imageUrl:imageFixturePng};}});
  const {startOnboardingHandbook,onboardingHandbookOffer}=await import('./onboardingHandbook.js');
  const deps={verifyKey:key,storageAvailable:true,enqueueImage:(scope:typeof a,request:import('./onboardingHandbook.js').OnboardingImageInput,verify:()=>Promise<void>)=>service.enqueueOnboardingImage(scope,request,verify)};
  try{
    const offer=onboardingHandbookOffer(await f.store.read(),true,a);assert.ok(offer.available&&offer.pricePower!>.012);
    const accepted=await startOnboardingHandbook(f.store,a,deps);assert.equal(accepted.handbook!.status,'queued');const taskId=accepted.handbook!.taskId!;
    await service.resume(a,key);await waitFor(async()=>(await service.task(a,taskId)).jobs[0].state==='completed');
    const d=await f.store.read(),run=d.chatOperations!.find(o=>o.conversationId===taskId&&o.workRun)!.workRun!;
    assert.equal(texts,1);assert.equal(images,1);assert.deepEqual(run.welcomeManual!.document,doc);assert.equal(run.welcomeManual!.model.apiKey,'');assert.ok(run.welcomeArtifacts?.flowId&&run.welcomeArtifacts.pageId);
    assert.equal(d.attachments.filter(f=>f.conversationId===taskId).length,3);assert.equal(d.modelUsageRecords.length,2);
    assert.ok(d.modelUsageRecords.every(r=>sponsored?r.chargedMicros===0:r.chargedMicros!>0));assert.ok(d.attachments.find(f=>f.id===run.welcomeImageAttachmentId)!.welcomeGuide!.manual);
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
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('one request runs two tasks concurrently and feeds their durable results into the next answer once',async()=>{
 const f=fixture();
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('两项已安排'):{...answer(''),toolCalls:[{id:'batch',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:['逻辑分析','写作草稿'].map(title=>({taskId:null,title,instruction:`只做${title}`,executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]}))})}}]});
 let started=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);f.setWorker(async()=>{started++;await gate;return answer(JSON.stringify({outcome:'completed',content:'可核对的独立成果',summary:'成果已返回'}));});
 const reply=await f.service.dispatch(a,input('operation_batch_two_001','分析和独立草稿同时做'),key);
 assert.equal(reply.taskIds.length,2);await f.service.resume(a,key);await waitFor(async()=>started===2);release();
 await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===2);
 f.setRoute(messages=>{assert.match(JSON.stringify(messages),/刚返回、尚未向用户汇报/);assert.match(JSON.stringify(messages),/逻辑分析/);assert.match(JSON.stringify(messages),/写作草稿/);return answer('两项任务完成了。');});
 const next=await f.service.dispatch(a,input('operation_batch_follow_01','现在做了吗？'),key);assert.match(next.message.content,/task=/);
 const state=await f.service.state(a);assert.equal(state.notices.length,2);assert.ok(state.notices.every(n=>n.reported&&!n.read));
 await f.service.report(a,state.notices.map(n=>n.id),key);assert.equal((await f.service.state(a)).conversation!.messages.length,state.conversation!.messages.length);
 await f.service.acknowledge(a,state.notices.map(n=>n.id));assert.equal((await f.service.state(a)).notices.length,0);
});

test('completed tasks stay quietly in the sidebar until the next answer and late results are not swallowed',async()=>{
  const f=fixture();let releaseSecond!:()=>void;const secondGate=new Promise<void>(resolve=>releaseSecond=resolve);
  f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已经安排，结果会留在侧栏'):{...answer(''),toolCalls:[{id:'feedback-tasks',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks:['先完成的方案','稍后完成的核算'].map((title,i)=>({taskId:null,title,instruction:`只做FEEDBACK_${i}`,executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]}))})}}]});
  f.setWorker(async messages=>{
    if(messages.at(-1)?.content?.includes('FEEDBACK_1'))await secondGate;
    return answer(JSON.stringify({outcome:'completed',content:'实际成果',summary:'已返回'}));
  });
  const initial=await f.service.dispatch(a,input('operation_quiet_feedback_01','两项同时做'),key);
  await f.service.resume(a,key);await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===1);
  const before=(await f.service.state(a)).conversation!.messages.length;
  for(let i=0;i<3;i++)assert.equal((await f.service.state(a)).conversation!.messages.length,before,'polling must not generate unsolicited main-chat answers');
  let releaseAnswer!:(r:ToolChatResult)=>void, modelStarted!:()=>void;
  const answerGate=new Promise<ToolChatResult>(resolve=>releaseAnswer=resolve),started=new Promise<void>(resolve=>modelStarted=resolve);
  const follow=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async(_model,messages)=>{
    const feedback=messages.find(m=>m.content?.startsWith('刚返回、尚未向用户汇报'))!.content!;
    assert.match(feedback,/先完成的方案/);assert.doesNotMatch(feedback,/稍后完成的核算|sourceId|resultMessageId/);
    assert.match(messages[0].content!,/像可靠的朋友/);assert.match(messages[0].content!,/不要承诺完成立刻自动回到主对话/);
    modelStarted();return answerGate;
  }});
  const pending=follow.dispatch(a,input('operation_quiet_follow_01','今天怎么样？只聊聊，不执行。'),key);
  await started;
  const read=await f.service.acknowledgeAll(a,key);assert.equal(read.count,1);
  releaseSecond();await waitFor(async()=>(await f.store.read()).chatOperations!.filter(o=>o.workRun?.state==='completed').length===2);
  releaseAnswer(answer('挺好的。之前的方案有结果了，要不要看看？'));
  const reply=await pending;
  assert.match(reply.message.content,/先完成的方案/);assert.doesNotMatch(reply.message.content,/稍后完成的核算/);
  const db=await f.store.read(),first=db.chatOperations!.find(o=>o.conversationId===initial.taskIds[0]&&o.workRun)!,second=db.chatOperations!.find(o=>o.conversationId===initial.taskIds[1]&&o.workRun)!;
  assert.ok(first.workRun!.reportedToCoordinatorAt);assert.equal(first.workRun!.unread,false);
  assert.equal(second.workRun!.reportedToCoordinatorAt,undefined);assert.equal(second.workRun!.unread,true);
  const snapshot=await follow.state(a);
  assert.deepEqual(snapshot.recentReportedReceiptIds,[first.id]);
  assert.deepEqual(snapshot.notices.map(n=>n.id),[second.id]);
  f.setRoute(()=>answer('刚才的核算也有结果了。'));
  const after=await f.service.dispatch(a,input('operation_quiet_after_001','再聊两句，不执行'),key);
  assert.match(after.message.content,/稍后完成的核算/);
  assert.equal((await f.store.read()).chatOperations!.find(o=>o.id===second.id)!.workRun!.reportMessageId,after.message.id);
});

test('batch workers receive only their own handoff while exact source messages stay in durable history',async()=>{
 const f=fixture(),original='一口气安排：画一张蓝色机器人图片；核算 3 件×12.5 元加 2 件×8 元；写 80 字以内的热茶短文。只用公开测试素材，不查知识库，不联网。';
 const tasks=[
  {taskId:null,title:'本轮核算',instruction:'只核算 3 件×12.5 元加 2 件×8 元，返回分项和 53.5 元合计，不处理图片或短文。',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
  {taskId:null,title:'本轮短文',instruction:'只写 80 字以内的热茶短文，使用公开素材，不查知识库，不联网，不处理图片或核算。',executorId:'general',outputKind:'text',featureIds:[],dependsOn:[]},
 ];
 f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('两件独立文字任务已排队'):{...answer(''),toolCalls:[{id:'strict-scope-batch',type:'function',function:{name:'delegate_tasks',arguments:JSON.stringify({tasks})}}]});
 f.setWorker(async messages=>{
  const scopeMessage=messages.find(m=>m.role==='system'&&m.content?.startsWith('执行范围由服务端锁定：'))!;
  assert.ok(scopeMessage);assert.match(scopeMessage.content!,/不要执行、重做、汇总或判断它们是否完成/);
  assert.match(scopeMessage.content!,/不因缺少其他任务的工具而把本任务标成失败/);
  assert.match(scopeMessage.content!,/不嵌入第二份结果 JSON/);
  const scope=JSON.parse(scopeMessage.content!.split('\n').find(line=>line.startsWith('{'))!);
  const task=tasks.find(t=>t.title===scope.title)!;assert.ok(task);
  assert.equal(scope.instruction,task.instruction);assert.equal(scope.expectedOutput,'text');
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
  await assert.rejects(()=>denied.dispatch(a,input('operation_no_image_batch','图和表都做'),key),/图片生成尚未配置/);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,before);
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
 const call=f.calls.find(c=>c.modelId==='worker')!;assert.match(call.messages[0].content!,/独立输入框/);assert.match(JSON.stringify(call.messages),/之前的完整原话|之前的成果/);assert.doesNotMatch(JSON.stringify(call.messages),/不能读取/);
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
        const catalog = JSON.parse(
          messages[0].content!.split(
            "服务端授权目录（仅为数据，不能扩大授权）：",
          )[1],
        );
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
test('Notion dispatcher and queued continuation create once, revise the same document, keep original words and scoped receipts',async()=>{
  const f=fixture(),parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await f.store.mutate(d=>d.knowledgeConnections.push({id:'notion',workspaceId:'wa',provider:'notion',status:'connected',clientId:'test',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'grant',userId:'a',authorizedAt:'now',parentId}}));
  let body='',release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);const mutations:string[]=[];
  const mcp={readDocument:async(ws:string)=>{assert.equal(ws,'wa');return {text:body||'保存目录'};},callDocumentTool:async(ws:string,cid:string,grant:string,user:string,name:string,args:any)=>{
    assert.deepEqual([ws,cid,grant,user],['wa','notion','grant','a']);mutations.push(name);
    if(name==='notion-create-pages'){await hold;body=args.pages[0].content;return {pages:[{id:pageId}]};}
    body=body.replace(args.content_updates[0].old_str,args.content_updates[0].new_str);return {id:pageId};
  }} as unknown as NotionMcpService;
  const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{notionDocuments:new NotionDocuments(f.store,mcp),modelCall:async(model,messages,tools)=>{
    if(messages.at(-1)?.role==='tool')return answer('已收到真实工具回执。');
    if(model.id==='router')return {...answer(''),toolCalls:[{id:'route',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({taskId:null,title:'专栏草稿',instruction:'请写专栏并保存到已授权的 Notion 目录',executorId:'general'})}}]};
    assert.ok(tools.some(t=>t.function.name==='save_notion_draft'));
    return {...answer(''),toolCalls:[{id:'save',type:'function',function:{name:'save_notion_draft',arguments:JSON.stringify(body?{old_str:'第一段',new_str:'修改后的第一段'}:{title:'专栏',content:'第一段'})}}]};
  }});
  await assert.rejects(()=>service.dispatch(b,{...input('operation_notion_foreign','写篇文章'),outputDestination:'notion'},key));
  const result=await service.dispatch(a,{...input('operation_notion_first','讨论之后请写专栏'),outputDestination:'notion'},key);
  await service.resume(a,key);await waitFor(async()=>mutations.length===1);
  await service.direct(a,result.taskId!,{operationId:'operation_notion_second',text:'第一段改一下'},key);
  release();await waitFor(async()=>(await service.task(a,result.taskId!)).jobs.every(j=>j.state==='completed'));
  assert.deepEqual(mutations,['notion-create-pages','notion-update-page']);assert.equal(body,'修改后的第一段');
  const task=await service.task(a,result.taskId!);
  assert.equal(task.conversation.notionDocument?.pageId,pageId);assert.match(JSON.stringify(task.conversation.messages),/讨论之后请写专栏|第一段改一下|已保存到 Notion/);
  assert.ok(task.jobs.every(j=>j.notionReceipt?.state==='verified'));
  await assert.rejects(()=>service.task(b,result.taskId!));
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
    await f.service.report(b,[job.id],key);assert.equal((await f.store.read()).conversations.find(c=>c.coordinatorMain)!.messages.filter(m=>m.imageUrl).length,0);
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
      assert.match(db.conversations.find(c=>c.coordinatorMain)!.messages.at(-1)!.content,/文案先/);
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
 await assert.rejects(denied.service.dispatch(a,input('operation_natural_denied','开始执行'),key,undefined,async()=>{throw Error('must never invoke');}));assert.equal((await denied.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('on-demand task reading is private and local completion reporting is persistent and idempotent',async()=>{
 const f=fixture(),stamp=new Date().toISOString();await f.store.mutate(d=>{d.conversations.push({...a,id:'owned',title:'旧UI',modelId:'worker',messages:[{id:'old',role:'user',content:'文件只能写一句荷叶饼',createdAt:stamp}],archived:false,createdAt:stamp,updatedAt:stamp},{...b,id:'foreign',title:'不能读取',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});});
 let step=0;f.setRoute(messages=>{if(step++===0)return{...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query:'owned'})}}]};assert.match(JSON.stringify(messages),/文件只能写一句荷叶饼/);return answer('目标确认，请继续。');});
 await f.service.dispatch(a,input('operation_read_12345','之前UI的要求是什么？'),key);
 await f.store.mutate(d=>{d.executionTasks=[{...a,id:'local-completed',conversationId:'owned',sourceMessageId:'old',provider:'codex',instruction:'创建文档',deviceId:'fixture-key',status:'completed',finalResponse:'本轮进程结束，产物需查看',createdAt:stamp,updatedAt:stamp}];});
 await f.service.report(b,['local-completed'],key);assert.equal((await f.store.read()).executionTasks[0].reportedToCoordinatorAt,undefined);
 await f.service.report(a,['local-completed'],key);await f.service.report(a,['local-completed'],key);const db=await f.store.read();assert.equal(db.conversations.find(c=>c.coordinatorMain&&c.userId==='a')!.messages.filter(m=>m.id==='report_local-completed').length,1);assert.ok(db.executionTasks[0].reportedToCoordinatorAt);
 await f.store.mutate(d=>{const task=d.executionTasks[0];task.reportRound=1;task.reportedToCoordinatorAt=undefined;task.finalResponse='第二轮的独立结果';});await f.service.report(a,['local-completed'],key);await f.service.report(a,['local-completed'],key);assert.equal((await f.store.read()).conversations.find(c=>c.coordinatorMain&&c.userId==='a')!.messages.filter(m=>m.id==='report_local-completed_1').length,1);
 const blocked=fixture();await blocked.store.mutate(d=>{d.conversations.push({...b,id:'foreign',title:'秘密',modelId:'worker',messages:[],archived:false,createdAt:stamp,updatedAt:stamp});});blocked.setRoute(()=>({...answer(''),toolCalls:[{id:'read',type:'function',function:{name:'read_task',arguments:JSON.stringify({query:'foreign'})}}]}));await assert.rejects(blocked.service.dispatch(a,input('operation_read_denied','读旧事情'),key));
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
 await assert.rejects(()=>denied.service.dispatch(a,input('operation_answer_only_02','只回答，不执行。'),key,undefined,async()=>{runs++;return{id:'never',status:'queued'};}));
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
 assert.equal(reviewed.notices.length,1);
 assert.equal(reviewed.notices[0].read,true);
 assert.equal(reviewed.notices[0].reported,false);
 assert.equal((await f.store.read()).executionTasks[0].reportedToCoordinatorAt,undefined);
 await f.service.report(a,['notice-execution'],key);
 assert.ok((await f.store.read()).executionTasks[0].reportedToCoordinatorAt);
 assert.equal((await f.service.state(a)).notices.length,0,'reviewed and reported result is fully acknowledged');
 await f.store.mutate(d=>{d.executionTasks[0].reportRound=1;d.executionTasks[0].reportedToCoordinatorAt=undefined;});
 assert.equal((await f.service.state(a)).notices.length,1);
});
test('saving a task alone is not proof that the local executor accepted it',async()=>{
 const f=fixture();let runs=0;
 const result=await f.service.dispatch(a,{...input('operation_local_rejected','UI 改标题'),localExecution:true},key,undefined,async()=>{runs++;throw new Error('连接执行器失败');});
 assert.match(result.conversation.messages.at(-1)?.content ?? '',/(尚|还)不能确认已开始或完成/);
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
test("omitted task budget has a usable bounded default; explicit smaller caps remain unchanged", async () => {
  const f = fixture();
  const first = await f.service.dispatch(a, { operationId: "operation_default_cap", text: "UI" }, key);
  const second = await f.service.direct(a, first.taskId!, { operationId: "operation_explicit_cap", text: "补充", budget: 0.02 }, key);
  const db = await f.store.read();
  assert.equal(db.chatOperations?.find(o => o.operationId === "operation_default_cap_work")?.workRun?.budget, 0.5);
  assert.equal(db.chatOperations?.find(o => o.operationId === "operation_explicit_cap")?.workRun?.budget, 0.02);
  assert.equal(second.taskId, first.taskId);
});
async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
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
  assert.equal((await f.service.state(a)).notices.length, 3);
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
  assert.equal(reviewed.notices.length, notices.length,'task review does not drop unreported dispatcher feedback');
  assert.ok(reviewed.notices.every(n=>n.read&&!n.reported));
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
  await assert.rejects(() =>
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
  await assert.rejects(() =>
    f.service.dispatch(a, input("operation_invalid_1", "UI"), key),
  );
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
 assert.match(main.messages.at(-1)!.content,/任务仍暂停/);assert.doesNotMatch(main.messages.at(-1)!.content,/结果会回到/);
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
 await assert.rejects(()=>f.service.retryLatest(a,r.taskId!,latest.id,undefined,key),/核对 Notion/);
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
  await assert.rejects(()=>f.service.dispatch(a,input('operation_local_foreign_01','在别人任务里写文件'),key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  f.setRoute(()=>localCall());
  await assert.rejects(()=>f.service.dispatch(a,{...input('operation_local_bound_001','修改当前文档'),boundTaskId:accepted.taskId},key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  f.setRoute(()=>localCall(null,'delegate_task'));
  await assert.rejects(()=>f.service.dispatch(a,input('operation_local_cloud_001','不能用普通分派拿到本机权限'),key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  assert.equal(localCalls,1);
  await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:2,action:'pause'}));
  f.setRoute(()=>localCall());
  await assert.rejects(()=>f.service.dispatch(a,input('operation_local_disabled_01','逻辑能力停用后不可静默降级'),key,undefined,executeLocal),/未完成分派|工具未授权|参数无效/);
  assert.equal(localCalls,1);
});

test('explicit local button accepts local_special through both routing tools without relaxing task ownership',async()=>{
  for(const name of ['delegate_task','execute_local_task']){
    const f=fixture();
    const profile=await f.store.mutate(d=>updateExecutor(d,'a',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'本机交接',modelId:'worker',routingRole:'logic'}}));
    await f.store.mutate(d=>updateExecutor(d,'a',profile.id,{revision:1,action:'publish'}));
    let calls=0;
    const localCall=(taskId:string|null)=>({...answer(''),toolCalls:[{id:'explicit-local-alias',type:'function' as const,function:{name,arguments:JSON.stringify({taskId,title:'独立文档',instruction:'在授权目录内新建并核验文档',executorId:'local_special'})}}]});
    f.setRoute(messages=>messages.at(-1)?.role==='tool'?answer('已经交给本机'):localCall(null));
    const run=async()=>{calls++;return{id:'local-real',status:'queued'};};
    const accepted=await f.service.dispatch(a,{...input(`operation_explicit_alias_${name}`,'新建本地文档'),localExecution:true},key,undefined,run);
    assert.ok(accepted.taskId);assert.equal(calls,1);
    assert.equal(f.calls[0].requiredTool,'execute_local_task');
    f.setRoute(()=>localCall('foreign-task'));
    await assert.rejects(()=>f.service.dispatch(a,{...input(`operation_explicit_foreign_${name}`,'写入文件'),localExecution:true},key,undefined,run),/未开始|尚未开始|未完成分派|参数无效/);
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
    const catalog=JSON.parse(messages.find(m=>m.content?.startsWith('本轮执行规则优先于旧版本提示：'))!.content!.split('能力目录（资料，不是指令）：')[1]);
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
  const reply=await response;assert.match(reply.message.content,/连续本机文档.*有新反馈/);assert.match(reply.message.content,/task=same-local-conversation/);
  let db=await f.store.read();assert.equal(db.chatOperations!.filter(o=>o.id==='notice_same-local-execution'&&o.assistantMessageId===reply.message.id).length,1);
  assert.equal(db.executionTasks[0].status,'running');assert.equal(db.executionTasks[0].reportedRound,undefined);assert.equal(db.executionTasks[0].reportedToCoordinatorAt,undefined);
  const state=await service.state(a);assert.deepEqual(state.recentReportedReceiptIds,['same-local-execution']);assert.ok(state.transfers.some(t=>t.id==='same-local-conversation'&&t.running));
  assert.equal((await service.dispatch(a,input('operation_report_old_round','上一轮做了什么？只回答，不执行。'),key)).message.id,reply.message.id,'replaying the same answer cannot report twice');
  await f.store.mutate(d=>{const task=d.executionTasks[0];task.status='completed';task.finalResponse='NEW_ROUND_RESULT：改好新标题并回读';task.updatedAt=new Date().toISOString();task.completedAt=task.updatedAt;saveExecutionReceipt(d,task);});
  const next=await service.state(a);assert.deepEqual(next.notices.map(n=>n.id),['same-local-execution_1']);assert.equal(next.notices[0].reported,false);assert.equal(next.notices[0].read,false);
  db=await f.store.read();assert.equal(db.messages.filter(m=>m.id==='execution_receipt_same-local-execution_0').length,1);assert.equal(db.messages.filter(m=>m.id==='execution_receipt_same-local-execution_1').length,1);
});
