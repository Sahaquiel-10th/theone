import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Database,ModelConfig} from './types.js';
import type {Store} from './db.js';
import {OnboardingPracticeService,practiceView,readPracticeMaterial,practiceWebReference,type PracticeTaskInput} from './onboardingPractice.js';
import {updateJourney} from './onboardingJourney.js';
import {accountProfile,completeOnboardingOnChat} from './betaProfile.js';
import {sourceBinding} from './publicSharing.js';
import {CoordinatorService} from './coordinatorService.js';
import {defaultTaskValues,updateTaskConfig} from './aiTaskConfig.js';
import type {ToolChatResult} from './modelGateway.js';
import {publicUser} from './serializers.js';

const a={workspaceId:'wa',userId:'a'},b={workspaceId:'wb',userId:'b'},peer={workspaceId:'wa',userId:'peer'};
const key=async()=>{};
const firstId='practice_first_00000001',webId='practice_web_000000001';
function fixture(){
 const users=[a,b,peer].map(s=>({id:s.userId,enabled:true,role:'user',defaultWorkspaceId:s.workspaceId,createdAt:'now',profile:{workspaceId:s.workspaceId,displayName:s.userId,onboarding:{nameSetAt:'now',knowledgeChoice:'connected',journey:{id:`journey-${s.userId}`,launchId:'launch_00000000001',version:2,experience:5,stage:'ready',startedAt:'now',featureIds:[],events:[],practiceGoal:'article'}},updatedAt:'now'}}));
 const model={id:'worker',name:'worker',enabled:true,kind:'chat',apiKey:'fixture-only',isDefault:true,systemPrompt:'',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig;
 const values={name:'交互网页',author:'ONE',description:'将实际正文做成网页',instructions:'按实际正文制作结构化交互网页，必须调用oneHtml。',limitations:'只用前置正文',integration:'question_answer' as const,modelId:'web-model',knowledgeMode:'none' as const,usageMultiplier:.6,tools:[{id:'oneHtml',description:'保存网页'}]};
 const version={version:1,values,evidence:'test',approvedBy:'admin',approvedAt:'now'};
 let db={users,workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[a,b,peer].map(s=>({...s,role:'owner'})),models:[model,{...model,id:'web-model',isDefault:false}],settings:{safetyRules:'安全边界',rechargeCnyPerPower:7,officialFeatures:[{id:'web',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'release-web',version:1,userIds:['a','b','peer'],publishedAt:'now',publishedBy:'admin'}}]},knowledgeConnections:[{id:'source-a',workspaceId:'wa',provider:'notion',status:'connected',clientId:'fixture',encryptedAccessToken:'encrypted-a',createdAt:'now',updatedAt:'now'},{id:'source-b',workspaceId:'wb',provider:'getnote',status:'connected',clientId:'fixture',encryptedApiKey:'encrypted-b',createdAt:'now',updatedAt:'now'}],conversations:[],messages:[],chatOperations:[],attachments:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[a,b,peer].map(s=>({...s,id:s.userId,balanceMicros:100e6,reservedMicros:0})),powerLedger:[]} as unknown as Database;
 updateTaskConfig(db.settings,db.models,'task_worker',{revision:0,action:'draft',values:{...defaultTaskValues('task_worker'),modelId:'worker'}},'admin','now');updateTaskConfig(db.settings,db.models,'task_worker',{revision:1,action:'publish'},'admin','now');
 db.settings.executorProfiles=(['writing','logic'] as const).map(role=>{const v={...defaultTaskValues('task_worker'),modelId:'worker',name:role,description:role,featureIds:[],routingRole:role};return {id:role,revision:1,enabled:true,draft:v,published:{...v,version:1,publishedAt:'now',publishedBy:'admin'},history:[]};});
 let chain=Promise.resolve();const store={read:async()=>structuredClone(db),mutate:<T>(fn:(d:Database)=>T)=>{const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.then(()=>{},()=>{});return next;}} as Store;
 let now=1_800_000_000_000,calls=0,queueCalls=0,failQueue=false;
 let chunks=[{id:'note-a',provider:'notion' as const,title:'熟悉的读书会笔记',content:'PRIVATE_SELECTED_MATERIAL_ONLY：读书会8人，周六两点到四点，预算尚未确认。',sourceUrl:'https://www.notion.so/note-a'},{id:'other-note',provider:'notion' as const,title:'另外一篇',content:'NEVER_SUBSTITUTE_THIS_OTHER_NOTE'}];
 const knowledge={recallWithDiagnostics:async(ws:string,_q:string,_k?:number,ids?:readonly string[],userId?:string)=>{calls++;assert.equal(ws,ids?.[0]==='source-b'?'wb':'wa');assert.ok(userId);return {status:'used' as const,chunks:structuredClone(chunks),failures:[],coverage:[{connectionId:ids?.[0],provider:'notion',status:'used' as const,attempts:1}]};}};
 const tasks={enqueuePractice:async(s:typeof a,input:PracticeTaskInput)=>{queueCalls++;if(failQueue)throw Error('fixture handoff failure');return store.mutate(d=>{const old=d.chatOperations!.find(o=>o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.operationId===input.operationId);if(old)return old.conversationId!;const taskId=`task-${input.operationId}`,sources=input.material?.connectionId?[{id:input.material.connectionId,binding:input.material.binding!}]:[];d.conversations.push({...s,id:taskId,title:'本轮任务',messages:[],createdAt:'now',updatedAt:'now'} as never);d.chatOperations!.push({...s,id:`record-${input.operationId}`,operationId:input.operationId,conversationId:taskId,status:'pending',workRun:{state:'queued',onboardingPractice:{id:input.practiceId,stage:input.stage,material:input.material},sources,skills:[],credentials:[],dependsOnOperationIds:input.firstOperationId?[input.firstOperationId]:[]}} as never);return taskId;});},resume:async()=>{}};
 const service=new OnboardingPracticeService(store,knowledge,tasks,()=>now);
 const search=()=>service.search(a,{journeyId:'journey-a',connectionId:'source-a',query:'读书会'},key);
 const start=async(sample=false)=>{const selection=sample?undefined:(await search()).results[0].selectionId;return service.start(a,{journeyId:'journey-a',operationId:firstId,sample:sample||undefined,selectionId:selection,goal:'article',topic:'把读书会办好'},key);};
 const done=async(opId=firstId,web=false)=>store.mutate(d=>{const op=d.chatOperations!.find(o=>o.operationId===opId)!,c=d.conversations.find(c=>c.id===op.conversationId)!,mid=`result-${opId}`;op.status='completed';op.workRun!.state='completed';op.workRun!.resultOutcome='completed';op.workRun!.resultMessageId=mid;c.messages.push({id:mid,role:'assistant',content:'本轮真实的读书会方案，预算待确认。',createdAt:'now',attachments:web?[{id:'html-current',originalName:'方案.html',kind:'document',mimeType:'text/html',size:42}]:undefined} as never);if(web)d.attachments.push({...a,id:'html-current',conversationId:c.id,messageId:mid,mimeType:'text/html',originalName:'方案.html',status:'ready',visualDocument:{version:1,title:'方案'},kind:'document',size:42} as never);});
 return {store,service,knowledge,tasks,search,start,done,get calls(){return calls;},get queueCalls(){return queueCalls;},advance:()=>now+=16*60_000,setChunks:(value:typeof chunks)=>chunks=value,failQueue:(v:boolean)=>failQueue=v};
}
const ids=(p:{id:string;journeyId:string})=>({practiceId:p.id,journeyId:p.journeyId});
test('search and selection handles are bound to workspace, user, journey and short expiry',async()=>{
 const f=fixture();assert.deepEqual((await f.service.view(a)).connections.map(c=>c.id),['source-a']);
 await assert.rejects(()=>f.service.search(a,{journeyId:'journey-a',connectionId:'source-b',query:'读书会'},key),/授权/);
 const selection=(await f.search()).results[0];
 await assert.rejects(()=>f.service.start(peer,{journeyId:'journey-peer',operationId:firstId,selectionId:selection.selectionId,goal:'article',topic:'试试'},key),/失效/);
 await assert.rejects(()=>f.service.start(b,{journeyId:'journey-b',operationId:firstId,selectionId:selection.selectionId,goal:'article',topic:'试试'},key),/失效/);
 await assert.rejects(()=>f.service.search(a,{journeyId:'old-journey',connectionId:'source-a',query:'读书会'},key),/引导已经变化/);
 f.advance();await assert.rejects(()=>f.service.start(a,{journeyId:'journey-a',operationId:firstId,selectionId:selection.selectionId,goal:'article',topic:'试试'},key),/失效/);assert.equal(f.queueCalls,0);
});
test('source revocation, rebinding and changed content stop selection without substituting another note',async()=>{
 for(const change of ['revoke','binding','content'] as const){const f=fixture(),selection=(await f.search()).results[0];
  if(change==='content')f.setChunks([{id:'note-a',provider:'notion',title:'熟悉的读书会笔记',content:'正文已修改',sourceUrl:'https://www.notion.so/note-a'},{id:'other-note',provider:'notion',title:'另外一篇',content:'NEVER_SUBSTITUTE_THIS_OTHER_NOTE'}]);
  else await f.store.mutate(d=>{if(change==='revoke')d.knowledgeConnections[0].status='revoked';else d.knowledgeConnections[0].encryptedAccessToken='new-binding';});
  await assert.rejects(()=>f.service.start(a,{journeyId:'journey-a',operationId:firstId,selectionId:selection.selectionId,goal:'article',topic:'试试'},key),/变化/);assert.equal(f.queueCalls,0);
 }
});
test('exact material tool returns only the chosen note and never persists search bodies in the profile',async()=>{
 const f=fixture();await f.start();const db=await f.store.read(),material=db.users[0].profile!.onboarding.practice!.material;
 assert.doesNotMatch(JSON.stringify(db.users[0].profile),/PRIVATE_SELECTED_MATERIAL_ONLY|NEVER_SUBSTITUTE_THIS_OTHER_NOTE/);
 const found=await readPracticeMaterial(f.store,f.knowledge,a,material);assert.equal(found.chunks.length,1);assert.equal(found.chunks[0].id,'note-a');assert.doesNotMatch(JSON.stringify(found),/NEVER_SUBSTITUTE/);
 await f.store.mutate(d=>d.knowledgeConnections[0].status='revoked');await assert.rejects(()=>readPracticeMaterial(f.store,f.knowledge,a,material),/变化/);
});
test('general profile and administrator user serialization omit all private practice metadata',async()=>{
 const f=fixture();await f.start();const db=await f.store.read(),internal=db.users[0].profile!.onboarding.practice!;
 assert.ok(internal.material.binding);const safe=publicUser(db.users[0]);assert.equal(safe.profile!.onboarding.practice,undefined);
 assert.doesNotMatch(JSON.stringify(safe),/熟悉的读书会笔记|把读书会办好|source-a|requestHash|digest|binding/);
 assert.equal(accountProfile(db,a).onboarding.practice!.source.title,'熟悉的读书会笔记');assert.ok((await f.service.view(a)).practice!.prompt);
});
test('duplicate clicks reuse one operation; failed prequeue handoff can be explicitly resumed with the original contract',async()=>{
 const f=fixture();f.failQueue(true);await assert.rejects(()=>f.start(true),/handoff/);const view=await f.service.view(a);assert.equal(view.practice?.first.taskId,'');assert.equal(view.practice?.first.state,'failed');
 f.failQueue(false);await Promise.all([f.service.start(a,{journeyId:'journey-a',operationId:firstId,retryHandoff:true},key),f.service.start(a,{journeyId:'journey-a',operationId:firstId,retryHandoff:true},key)]);
 assert.equal((await f.store.read()).chatOperations!.length,1);
 await assert.rejects(()=>f.service.start(a,{journeyId:'journey-a',operationId:'other_request_00000001',sample:true,goal:'article',topic:'不同要求'},key),/已经有任务/);
});
test('only the exact current result and real HTML artifact count; stale history, partial results and foreign IDs never complete',async()=>{
 const f=fixture();let v=await f.start(true),p=v.practice!;
 await assert.rejects(()=>f.service.complete(a,{...ids(p),skipWeb:true},key),/正文还未完成/);
 await f.done();v=await f.service.view(a);assert.equal(v.practice?.first.resultMessageId,`result-${firstId}`);
 await assert.rejects(()=>f.service.web(a,{...ids(p),practiceId:'old-practice',operationId:webId},key),/实战已经变化/);
 await f.service.web(a,{...ids(p),operationId:webId},key);
 await f.store.mutate(d=>{d.attachments.push({...a,id:'old-html',status:'ready',mimeType:'text/html',visualDocument:{title:'旧网页'},conversationId:'old-task'} as never);});
 await assert.rejects(()=>f.service.complete(a,ids(p),key),/网页还没有完成/);
 await f.done(webId,true);v=await f.service.complete(a,ids(p),key);assert.equal(v.practice?.web?.attachment?.id,'html-current');assert.ok(v.practice?.completedAt);assert.equal(v.practice?.skipWeb,false);
 await assert.rejects(()=>f.service.complete(peer,ids(p),key),/还没开始/);
 await f.store.mutate(d=>{d.chatOperations!.find(o=>o.operationId===firstId)!.workRun!.resultOutcome='partial';});assert.equal(practiceView(await f.store.read(),a).practice?.first.outcome,'partial');
 await assert.rejects(()=>f.service.complete(a,ids(p),key),/正文还未完成/);
});
test('an actual first result permits explicit web skip without claiming a web result',async()=>{
 const f=fixture(),p=(await f.start(true)).practice!;await f.done();const view=await f.service.complete(a,{...ids(p),skipWeb:true},key);assert.equal(view.practice?.skipWeb,true);assert.equal(view.practice?.web,undefined);
});
test('published web price approvals are checked before queuing, and long prerequisite text is never clipped',async()=>{
 const f=fixture(),p=(await f.start(true)).practice!;await f.done();await f.store.mutate(d=>{d.settings.officialFeatures![0].history[0].values.usageMultiplier=3;});
 await assert.rejects(()=>f.service.web(a,{...ids(p),operationId:webId},key),/门槛/);assert.equal((await f.store.read()).chatOperations!.length,1);
 await f.store.mutate(d=>{d.conversations.find(c=>c.id===p.first.taskId)!.messages.at(-1)!.content='长'.repeat(8001);});
 const db=await f.store.read();assert.throws(()=>practiceWebReference(db,a,p.id,firstId),/不会截断/);
});
test('experience 5 remains ready until actual practice or explicit skip, while old contracts stay unchanged',()=>{
 const f=fixture();return f.store.mutate(d=>{const profile=d.users[0].profile!;profile.onboarding.journey=undefined;
  let p=updateJourney(d,a,{action:'begin',launchId:'practice_launch_000001',experience:5}),j=p.onboarding.journey!;
  p=updateJourney(d,a,{action:'step',journeyId:j.id,step:'name',choice:'provided',displayName:'小林'});p=updateJourney(d,a,{action:'step',journeyId:j.id,step:'knowledge',choice:'connected'});assert.equal(p.onboarding.journey!.stage,'features');
  p=updateJourney(d,a,{action:'step',journeyId:j.id,step:'features',choice:'practice',goal:'article'});assert.equal(p.onboarding.journey!.stage,'ready');assert.equal(p.onboarding.handbook,undefined);
  completeOnboardingOnChat(d,a);assert.equal(accountProfile(d,a).onboarding.completedAt,undefined);
  assert.throws(()=>updateJourney(d,a,{action:'finish',journeyId:j.id}),/实战/);
  p=updateJourney(d,a,{action:'finish',journeyId:j.id,choice:'without_image',skipPractice:true});assert.equal(p.onboarding.journey!.stage,'complete');assert.equal(p.onboarding.practice,undefined);assert.ok(p.onboarding.journey!.events.some(e=>e.choice==='skipped_practice'));
 });
});

const answer=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:20,outputTokens:20,totalTokens:40,source:'provider'}});
const tool=(name:string,args:unknown)=>({...answer(''),toolCalls:[{id:`call-${name}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]});
async function waitFor(check:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('task did not settle');}
test('real worker reads the selected material, bills ordinary usage, and dependent oneHtml creates a downloadable current artifact',async()=>{
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-practice-'));let read=false,featureRead=false;
 const scene={id:'first',title:'读书会',situation:'筹备读书会',feature:'安排活动',advantage:'明确步骤',benefit:'容易开始',evidence:'预算未确认',steps:['确认时间','邀请参与者'],prompt:'继续完善读书会安排',capabilityIds:[]};
 const coordinator=new CoordinatorService(f.store,f.knowledge,{artifactDirectory:directory,contextMode:'adaptive',modelCall:async(model,messages)=>{
  if(model.id==='web-model'){featureRead=true;assert.match(JSON.stringify(messages),/REAL_FIRST_BODY_END/);return messages.at(-1)?.role==='tool'?answer('网页保存好了'):tool('oneHtml',{version:1,title:'读书会方案',intro:'本轮真实成果',scenes:[scene,{...scene,id:'second',title:'活动收尾'}]});}
  if(messages.at(-1)?.role==='tool'){if(messages.at(-1)?.content?.includes('PRIVATE_SELECTED_MATERIAL_ONLY'))read=true;return answer(JSON.stringify({outcome:'completed',content:'本轮真实读书会方案，预算待确认。REAL_FIRST_BODY_END',summary:'短文完成'}));}
  if(JSON.stringify(messages).includes('把刚才这个任务真实完成的正文'))return tool('feature_0',{query:'请完成本轮网页'});
  return tool('knowledge_search',{query:'故意与所选无关的检索词也不能换篇'});
 }});
 const service=new OnboardingPracticeService(f.store,f.knowledge,coordinator);
 try{const selection=(await service.search(a,{journeyId:'journey-a',connectionId:'source-a',query:'读书会'},key)).results[0];
  let view=await service.start(a,{journeyId:'journey-a',operationId:firstId,selectionId:selection.selectionId,goal:'article',topic:'读书会短文'},key),p=view.practice!;
  await waitFor(async()=>['completed','failed'].includes((await service.view(a)).practice!.first.state));view=await service.view(a);assert.equal(view.practice!.first.state,'completed');assert.equal(read,true);
  let db=await f.store.read();assert.equal(db.chatOperations!.find(o=>o.operationId===firstId)!.workRun!.executorId,'writing');assert.ok(db.modelUsageRecords.some(r=>r.activity==='task_worker'));assert.equal(db.powerAccounts[1].balanceMicros,100e6);
  assert.ok(db.conversations.find(c=>c.coordinatorMain)!.messages.some(m=>m.role==='user'&&m.content===p.prompt));assert.ok(db.conversations.find(c=>c.coordinatorMain)!.messages.some(m=>m.content.includes(p.first.taskId)));
  await service.web(a,{...ids(p),operationId:webId},key);await waitFor(async()=>['completed','failed'].includes((await service.view(a)).practice!.web!.state));view=await service.view(a);assert.equal(view.practice!.web!.state,'completed');assert.equal(featureRead,true);assert.ok(view.practice!.web!.attachment);
  db=await f.store.read();const file=db.attachments.find(file=>file.id===view.practice!.web!.attachment!.id)!;assert.match(readFileSync(file.storagePath,'utf8'),/读书会方案/);assert.ok(db.modelUsageRecords.some(r=>r.featurePriceSnapshot?.id==='web'));
  await service.complete(a,ids(p),key);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('explicit recovery retains exact material, revalidates reused reads and reports only its latest actual result',async()=>{
 const f=fixture();let modelCalls=0,success=false;
 const coordinator=new CoordinatorService(f.store,f.knowledge,{modelCall:async(_model,messages)=>{
  modelCalls++;if(messages.at(-1)?.role!=='tool'&&!messages.some(m=>m.role==='tool'))return tool('knowledge_search',{query:'本轮选中资料'});
  return answer(JSON.stringify({outcome:success?'completed':'partial',content:success?'NEW_RECOVERED_ACTUAL_RESULT':'OLD_PARTIAL_MUST_NOT_COMPLETE',summary:success?'已完成':'本轮未完成'}));
 }}),service=new OnboardingPracticeService(f.store,f.knowledge,coordinator);
 const selection=(await service.search(a,{journeyId:'journey-a',connectionId:'source-a',query:'读书会'},key)).results[0];
 const p=(await service.start(a,{journeyId:'journey-a',operationId:firstId,selectionId:selection.selectionId,goal:'plan',topic:'读书会方案'},key)).practice!;
 await waitFor(async()=>(await service.view(a)).practice!.first.state==='failed');
 let db=await f.store.read(),source=db.chatOperations!.find(o=>o.operationId===firstId)!,oldMessage=source.workRun!.resultMessageId;
 f.setChunks([{id:'note-a',provider:'notion',title:'熟悉的读书会笔记',content:'来源已经修改，不允许用旧checkpoint继续',sourceUrl:'https://www.notion.so/note-a'}]);success=true;
 await coordinator.retryLatest(a,p.first.taskId,source.id,undefined,key);const before=(await f.store.read()).modelUsageRecords.filter(r=>r.activity==='task_worker').length;await coordinator.resume(a,key);
 await waitFor(async()=>{const d=await f.store.read();return d.chatOperations!.filter(o=>o.conversationId===p.first.taskId&&o.workRun).at(-1)?.workRun?.state==='failed';});assert.equal((await f.store.read()).modelUsageRecords.filter(r=>r.activity==='task_worker').length,before,'changed source must stop before another billed worker call');
 db=await f.store.read();source=db.chatOperations!.filter(o=>o.conversationId===p.first.taskId&&o.workRun).at(-1)!;assert.equal(source.workRun!.onboardingPractice!.material!.noteId,'note-a');
 f.setChunks([{id:'note-a',provider:'notion',title:'熟悉的读书会笔记',content:'PRIVATE_SELECTED_MATERIAL_ONLY：读书会8人，周六两点到四点，预算尚未确认。',sourceUrl:'https://www.notion.so/note-a'}]);
 await coordinator.retryLatest(a,p.first.taskId,source.id,undefined,key);await coordinator.resume(a,key);await waitFor(async()=>(await service.view(a)).practice!.first.state==='completed');
 const view=await service.view(a);assert.notEqual(view.practice!.first.resultMessageId,oldMessage);assert.match(view.practice!.first.excerpt!,/NEW_RECOVERED_ACTUAL_RESULT/);assert.doesNotMatch(view.practice!.first.excerpt!,/OLD_PARTIAL/);
});
test('the inner enqueue transaction rejects a journey changed after the outer practice handoff check',async()=>{
 const f=fixture();f.failQueue(true);await assert.rejects(()=>f.start(true));const db=await f.store.read(),p=db.users[0].profile!.onboarding.practice!;let checks=0;
 const coordinator=new CoordinatorService(f.store,f.knowledge,{modelCall:async()=>{throw Error('must not call model');}});
 await assert.rejects(()=>coordinator.enqueuePractice(a,{operationId:p.first.operationId,practiceId:p.id,stage:'first',prompt:p.prompt,goal:p.goal,material:p.material},async()=>{if(++checks===2)await f.store.mutate(d=>d.users[0].profile!.onboarding.journey!.stage='complete');}),/实战已经变化/);
 assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);assert.equal((await f.store.read()).modelUsageRecords.length,0);
});
for(const failAt of ['intro','worker-claim'] as const)test(`real prequeue failure at ${failAt} resumes the same operation and main request without duplicate billing`,async()=>{
 const f=fixture();let failWorker=failAt==='worker-claim',paidCalls=0;
 if(failAt==='intro')await f.store.mutate(d=>{d.settings.executorProfiles!.find(p=>p.id==='writing')!.enabled=false;});
 const store={...f.store,mutate:<T>(fn:(d:Database)=>T)=>f.store.mutate(d=>{if(failWorker&&d.chatOperations?.some(o=>o.operationId===firstId&&o.status==='pending'&&!o.workRun)){failWorker=false;throw Error('known failed worker transaction');}return fn(d);})} as Store;
 const coordinator=new CoordinatorService(store,f.knowledge,{modelCall:async(_m,messages)=>{paidCalls++;return messages.at(-1)?.role==='tool'?answer(JSON.stringify({outcome:'completed',content:'RECOVERED_UNSTARTED_BODY',summary:'已完成'})):tool('knowledge_search',{query:'读取本轮样例'});}}),service=new OnboardingPracticeService(store,f.knowledge,coordinator);
 await assert.rejects(()=>service.start(a,{journeyId:'journey-a',operationId:firstId,sample:true,goal:'article',topic:'读书会文章'},key));
 let db=await store.read();assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);assert.equal(paidCalls,0);assert.equal(db.modelUsageRecords.length,0);const originalIntro=db.chatOperations!.find(o=>o.operationId===firstId+'_intro')!;assert.equal(originalIntro.status,'failed');
 await f.store.mutate(d=>{d.settings.executorProfiles!.find(p=>p.id==='writing')!.enabled=true;});
 await service.start(a,{journeyId:'journey-a',operationId:firstId,retryHandoff:true},key);await waitFor(async()=>(await service.view(a)).practice!.first.state==='completed');
 db=await store.read();assert.equal(db.chatOperations!.filter(o=>o.operationId===firstId+'_intro').length,1);assert.equal(db.chatOperations!.find(o=>o.operationId===firstId+'_intro')!.id,originalIntro.id);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,1);assert.equal(paidCalls,2);
 const main=db.conversations.find(c=>c.coordinatorMain)!;assert.equal(main.messages.filter(m=>m.role==='user').length,1);await service.start(a,{journeyId:'journey-a',operationId:firstId,retryHandoff:true},key);assert.equal(paidCalls,2);
});
test('a billed or ambiguous failed intro is never rearmed by retryHandoff',async()=>{
 const f=fixture();await f.store.mutate(d=>{d.settings.executorProfiles!.find(p=>p.id==='writing')!.enabled=false;});let calls=0;
 const coordinator=new CoordinatorService(f.store,f.knowledge,{modelCall:async()=>{calls++;return answer('must not run');}}),service=new OnboardingPracticeService(f.store,f.knowledge,coordinator);
 await assert.rejects(()=>service.start(a,{journeyId:'journey-a',operationId:firstId,sample:true,goal:'article',topic:'读书会文章'},key));
 await f.store.mutate(d=>{const intro=d.chatOperations!.find(o=>o.operationId===firstId+'_intro')!;d.modelUsageRecords.push({...a,id:'uncertain-usage',requestId:intro.requestId,status:'needs_review'} as never);d.settings.executorProfiles!.find(p=>p.id==='writing')!.enabled=true;});
 await assert.rejects(()=>service.start(a,{journeyId:'journey-a',operationId:firstId,retryHandoff:true},key),/未完成/);assert.equal(calls,0);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('paid long first output is preserved in full; web refuses it explicitly before creating a child or charging again',async()=>{
 const f=fixture(),body='长'.repeat(8001)+'PAID_BODY_END';let calls=0;
 const coordinator=new CoordinatorService(f.store,f.knowledge,{modelCall:async(_m,messages)=>{calls++;return messages.at(-1)?.role==='tool'?answer(JSON.stringify({outcome:'completed',content:body,summary:'正文完整返回'})):tool('knowledge_search',{query:'读取本轮样例'});}}),service=new OnboardingPracticeService(f.store,f.knowledge,coordinator);
 const p=(await service.start(a,{journeyId:'journey-a',operationId:firstId,sample:true,goal:'article',topic:'读书会文章'},key)).practice!;await waitFor(async()=>(await service.view(a)).practice!.first.state==='completed');
 const db=await f.store.read(),task=db.conversations.find(c=>c.id===p.first.taskId)!;assert.equal(task.messages.find(m=>m.role==='assistant')!.content,body);const before=calls;
 await assert.rejects(()=>service.web(a,{...ids(p),operationId:webId},key),/不会截断/);assert.equal(calls,before);assert.equal((await service.view(a)).practice!.web,undefined);
});
test('needs-input normal task supplement retains the selected material and becomes the exact source for the dependent web',async()=>{
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-practice-supplement-'));let supplied=false;
 const scene={id:'first',title:'方案',situation:'安排活动',feature:'读书会',advantage:'明确分工',benefit:'可执行',evidence:'预算待确认',steps:['确认场地','邀请参与者'],prompt:'完善活动安排',capabilityIds:[]};
 const coordinator=new CoordinatorService(f.store,f.knowledge,{artifactDirectory:directory,modelCall:async(model,messages)=>{
  if(model.id==='web-model'){assert.match(JSON.stringify(messages),/NEW_SUPPLEMENT_BODY/);return messages.at(-1)?.role==='tool'?answer('网页已保存'):tool('oneHtml',{version:1,title:'新补充的行动方案',intro:'按本轮实际方案整理',scenes:[scene,{...scene,id:'second',title:'会后反馈'}]});}
  if(JSON.stringify(messages).includes('把刚才这个任务真实完成的正文'))return messages.at(-1)?.role==='tool'?answer(JSON.stringify({outcome:'completed',content:'网页已生成',summary:'已完成'})):tool('feature_0',{query:'将本轮实际方案做成网页'});
  if(messages.at(-1)?.role==='tool')return answer(JSON.stringify({outcome:supplied?'completed':'needs_input',content:supplied?'NEW_SUPPLEMENT_BODY：8人读书会行动方案，预算待确认。':'请补充参与人数。',summary:supplied?'方案已完成':'等待人数'}));
  return tool('knowledge_search',{query:'同一个选中资料'});
 }}),service=new OnboardingPracticeService(f.store,f.knowledge,coordinator);
 try{const selection=(await service.search(a,{journeyId:'journey-a',connectionId:'source-a',query:'读书会'},key)).results[0],p=(await service.start(a,{journeyId:'journey-a',operationId:firstId,selectionId:selection.selectionId,goal:'plan',topic:'活动执行方案'},key)).practice!;
  await waitFor(async()=>(await service.view(a)).practice!.first.outcome==='needs_input');const old=(await service.view(a)).practice!.first.resultMessageId;supplied=true;
  await coordinator.direct(a,p.first.taskId,{operationId:'practice_supplement_00001',text:'补充：参与人数8人，请继续完成行动方案。'},key);await coordinator.resume(a,key);await waitFor(async()=>(await service.view(a)).practice!.first.state==='completed');
  const db=await f.store.read(),child=db.chatOperations!.find(o=>o.operationId==='practice_supplement_00001')!;assert.equal(child.workRun!.onboardingPractice!.material!.noteId,'note-a');assert.equal(child.workRun!.retryOfOperationId,firstId);const view=await service.view(a);assert.notEqual(view.practice!.first.resultMessageId,old);assert.match(view.practice!.first.excerpt!,/NEW_SUPPLEMENT_BODY/);
  await coordinator.direct(a,p.first.taskId,{operationId:'practice_supplement_00001',text:'补充：参与人数8人，请继续完成行动方案。'},key);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.operationId==='practice_supplement_00001').length,1);
  await service.web(a,{...ids(p),operationId:webId},key);await waitFor(async()=>(await service.view(a)).practice!.web!.state==='completed');assert.ok((await service.complete(a,ids(p),key)).practice!.completedAt);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('web needs-input supplement retains its exact first-task dependency and completes a scoped real HTML attachment',async()=>{
 const f=fixture(),directory=mkdtempSync(path.join(tmpdir(),'one-practice-web-supplement-'));let supplied=false,featureCalls=0;
 const scene={id:'first',title:'筹备安排',situation:'组织读书会',feature:'分步方案',advantage:'信息清楚',benefit:'容易执行',evidence:'原方案预算待确认',steps:['确认场地','邀请参与者'],prompt:'继续完善读书会',capabilityIds:[]};
 const coordinator=new CoordinatorService(f.store,f.knowledge,{artifactDirectory:directory,modelCall:async(model,messages)=>{
  const context=JSON.stringify(messages);
  if(model.id==='web-model'){featureCalls++;assert.match(context,/EXACT_FIRST_BODY_FOR_WEB_SUPPLEMENT/);assert.match(context,/分步骤布局/);return messages.at(-1)?.role==='tool'?answer('网页已保存'):tool('oneHtml',{version:1,title:'补充布局后的交互网页',intro:'只使用本轮原方案',scenes:[scene,{...scene,id:'second',title:'活动收尾'}]});}
  if(context.includes('把这次成果做成交互网页')){
   if(!supplied)return answer(JSON.stringify({outcome:'needs_input',content:'你想采用哪种网页布局？',summary:'等待布局选择'}));
   return messages.at(-1)?.role==='tool'?answer(JSON.stringify({outcome:'completed',content:'分步骤交互网页已保存。',summary:'已生成实际网页'})):tool('feature_0',{query:'按补充的布局制作网页'});
  }
  return messages.at(-1)?.role==='tool'?answer(JSON.stringify({outcome:'completed',content:'EXACT_FIRST_BODY_FOR_WEB_SUPPLEMENT：读书会8人，预算待确认。',summary:'正文已完成'})):tool('knowledge_search',{query:'只读选中资料'});
 }}),service=new OnboardingPracticeService(f.store,f.knowledge,coordinator);
 try{
  const selection=(await service.search(a,{journeyId:'journey-a',connectionId:'source-a',query:'读书会'},key)).results[0],p=(await service.start(a,{journeyId:'journey-a',operationId:firstId,selectionId:selection.selectionId,goal:'plan',topic:'读书会执行方案'},key)).practice!;
  await waitFor(async()=>(await service.view(a)).practice!.first.state==='completed');const web=(await service.web(a,{...ids(p),operationId:webId},key)).practice!.web!;
  await waitFor(async()=>(await service.view(a)).practice!.web!.outcome==='needs_input');const old=(await service.view(a)).practice!.web!.resultMessageId;assert.equal(featureCalls,0);
  const reply={operationId:'web_supplement_00000001',text:'补充：使用分步骤布局，请继续完成交互网页。'};
  await assert.rejects(()=>coordinator.direct(b,web.taskId,reply,key),/不存在|不属于/);
  await f.store.mutate(d=>{d.knowledgeConnections[0].status='revoked';});await assert.rejects(()=>coordinator.direct(a,web.taskId,reply,key),/正文还未完整|前置|授权/);assert.equal(featureCalls,0);
  await f.store.mutate(d=>{d.knowledgeConnections[0].status='connected';});supplied=true;
  await coordinator.direct(a,web.taskId,reply,key);await coordinator.resume(a,key);await waitFor(async()=>(await service.view(a)).practice!.web!.state==='completed');
  const db=await f.store.read(),child=db.chatOperations!.find(o=>o.operationId===reply.operationId)!;assert.equal(child.workRun!.onboardingPractice!.id,p.id);assert.equal(child.workRun!.onboardingPractice!.stage,'web');assert.deepEqual(child.workRun!.dependsOnOperationIds,[firstId]);assert.equal(child.workRun!.retryOfOperationId,webId);
  const view=await service.view(a);assert.notEqual(view.practice!.web!.resultMessageId,old);const attachment=view.practice!.web!.attachment!;assert.ok(attachment);const file=db.attachments.find(file=>file.id===attachment.id)!;assert.equal(file.workspaceId,a.workspaceId);assert.equal(file.userId,a.userId);assert.equal(file.conversationId,web.taskId);assert.equal(file.messageId,view.practice!.web!.resultMessageId);assert.match(readFileSync(file.storagePath,'utf8'),/补充布局后的交互网页/);
  assert.ok((await service.complete(a,ids(p),key)).practice!.completedAt);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
