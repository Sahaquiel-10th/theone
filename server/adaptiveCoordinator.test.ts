import test from 'node:test';
import assert from 'node:assert/strict';
import {CoordinatorService} from './coordinatorService.js';
import {dispatchFixture,evalScope,evalAnswer} from '../scripts/eval/dispatchFixture.js';
import {readCoordinatorContext,recentCoordinatorMessages,validateContextRead,initialCoordinatorToolNames} from './adaptiveCoordinator.js';
import {inputProfile} from './oneContext.js';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const key=async()=>{};
const call=(name:string,args:unknown)=>({...evalAnswer(''),toolCalls:[{id:`call-${name}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]});
const knowledge={recallWithDiagnostics:async()=>{throw Error('knowledge must not be read');}};

test('paired weather fixture removes irrelevant task bodies without an extra model round or card',async()=>{
 const results=[];
 for(const contextMode of ['legacy','adaptive'] as const){
  const f=dispatchFixture();let calls=0,searches=0,bytes=0;let initialNames:string[]=[];
  const service=new CoordinatorService(f.store,knowledge,{contextMode,webSearch:async()=>{searches++;return [{title:'合成天气来源',url:'https://example.com/weather',snippet:'杭州合成天气：晴，22度。'}];},modelCall:async(_m,messages,tools)=>{
   calls++;bytes+=inputProfile({messages,tools},evalScope.workspaceId)!.totalBytes;
   assert.doesNotMatch(JSON.stringify(messages),/FOREIGN_SECRET/);
   if(calls===1){initialNames=tools.map(t=>t.function.name);if(contextMode==='adaptive')assert.doesNotMatch(JSON.stringify(messages),/UNRELATED_TASK_/);return call('web_search',{query:'杭州今天天气'});}
   return evalAnswer('杭州合成天气：晴，22度。[来源](https://example.com/weather)');
  }});
  await service.dispatch(evalScope,{operationId:`weather_${contextMode}_20261023`,text:'杭州今天天气怎么样？只回答，不要创建任务。',webSearch:true},key);
  assert.equal(searches,1);assert.equal(calls,2);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
  if(contextMode==='adaptive'){assert.ok(initialNames.includes('web_search'));assert.ok(!initialNames.includes('generate_image'));assert.ok(!initialNames.includes('delegate_task'));}
  results.push({contextMode,calls,bytes});
 }
 assert.ok(results[1].bytes<results[0].bytes*.45,JSON.stringify(results));
});
test('older exact instructions are fetched on demand and dispatched once with numbers and restrictions',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,messages)=>{
  calls++;
  if(calls===1){assert.doesNotMatch(JSON.stringify(messages),/42人/);return call('read_context',{query:'蓝桥'});}
  if(calls===2){assert.match(messages.at(-1)!.content!,/42人.*900元.*不要覆盖/);return call('delegate_task',{taskId:null,title:'蓝桥活动网页',instruction:'蓝桥活动，42人，总预算900元；不要覆盖已有文件，只生成一个新HTML。',executorId:'general',featureIds:[]});}
  return evalAnswer('蓝桥活动网页已安排。');
 }});
 const result=await service.dispatch(evalScope,{operationId:'history_adaptive_20261023',text:'按刚才说的蓝桥活动，开始制作吧。'},key);
 const db=await f.store.read(),job=db.chatOperations!.find(o=>o.workRun)!;
 assert.ok(result.taskId);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,1);assert.match(job.workRun!.instruction,/42人.*900元.*不要覆盖/);
});
test('a bound continuation must read its original task before dispatch; omitted original text is recoverable',async()=>{
 const f=dispatchFixture();await f.store.mutate(d=>{const c=d.conversations.find(c=>c.id==='old-task-0')!;c.messages[0].content='42人，总预算900元，不覆盖原文件。'+'合成正文'.repeat(1000);});let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,messages)=>{
  calls++;
  if(calls===1)return call('delegate_task',{taskId:'old-task-0',title:'继续',instruction:'继续',executorId:'general',featureIds:[]});
  if(calls===2){assert.match(messages.at(-1)!.content!,/先用 read_task/);return call('read_task',{query:'old-task-0'});}
  if(calls===3){assert.match(messages.at(-1)!.content!,/42人.*900元.*不覆盖/);return call('delegate_task',{taskId:'old-task-0',title:'继续活动',instruction:'42人，总预算900元，不覆盖原文件，补齐活动内容。',executorId:'general',featureIds:[]});}
  return evalAnswer('已继续原任务。');
 }});
 const result=await service.dispatch(evalScope,{operationId:'bound_adaptive_20261023',boundTaskId:'old-task-0',text:'继续这个任务。'},key);
 assert.equal(result.taskId,'old-task-0');assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,1);
});
test('unmatched-language intent can load an existing tool without granting a new one',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,_messages,tools)=>{
  calls++;
  if(calls===1){assert.ok(!tools.some(t=>t.function.name==='delegate_task'));return call('load_tools',{names:['delegate_task']});}
  if(calls===2){assert.ok(tools.some(t=>t.function.name==='delegate_task'));return call('delegate_task',{taskId:null,title:'Synthetic brochure',instruction:'Make a short synthetic brochure.',executorId:'general',featureIds:[]});}
  return evalAnswer('已安排。');
 }});
 const result=await service.dispatch(evalScope,{operationId:'load_adaptive_20261023',text:'Make a short synthetic brochure.'},key);assert.ok(result.taskId);
});
test('history cannot read a foreign task or future messages and loading cannot invent run_command',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,messages)=>{
  calls++;assert.doesNotMatch(JSON.stringify(messages),/FOREIGN_SECRET_BODY/);assert.ok(!messages.some(m=>m.role==='user'&&m.content==='FUTURE_PRIVATE'));
  if(calls===1){await f.store.mutate(d=>{d.conversations.find(c=>c.coordinatorMain)!.messages.push({id:'future',role:'user',content:'FUTURE_PRIVATE',createdAt:'later'});});return call('read_context',{query:'',taskId:'foreign-task'});}
  if(calls===2){assert.equal(JSON.parse(messages.at(-1)!.content!).status,'not_found');return call('load_tools',{names:['run_command']});}
  if(calls===3){assert.match(messages.at(-1)!.content!,/不能加载索引之外/);return call('read_context',{query:'FUTURE_PRIVATE'});}
  assert.equal(JSON.parse(messages.at(-1)!.content!).status,'no_match');return evalAnswer('没有读取到这些资料，也没有执行命令。');
 }});
 await service.dispatch(evalScope,{operationId:'scope_adaptive_20261023',text:'请帮我回忆之前的安排。'},key);
 assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('exact repeated context reads stop before buying another model round',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async()=>{calls++;return call('read_context',{query:'不存在的合成词'});}});
 const result=await service.dispatch(evalScope,{operationId:'repeat_adaptive_20261023',text:'查一下之前的安排。'},key);
 assert.equal(result.taskId,undefined);assert.equal(calls,2);const db=await f.store.read();assert.equal(db.chatOperations![0].status,'completed');assert.ok(db.contextTraces.length);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);
});
test('context paging is explicit and recent window never truncates the current full message',async()=>{
 const f=dispatchFixture(),db=await f.store.read(),c=db.conversations.find(c=>c.coordinatorMain)!;
 c.messages[0].content='原要求'.repeat(4000);const first=readCoordinatorContext(c,{query:'',messageId:c.messages[0].id}) as any;
 const second=readCoordinatorContext(c,{query:'',messageId:c.messages[0].id,offset:first.items[0].nextOffset}) as any;
 assert.equal(first.items[0].content+second.items[0].content,c.messages[0].content);
 c.messages.push({id:'current',role:'user',content:'完整本轮'.repeat(3000),createdAt:'now'});
 assert.equal(recentCoordinatorMessages(c.messages,'current').at(-1)!.content,c.messages.at(-1)!.content);
 for(const value of [{query:'',offset:-1},{query:'',messageId:'x',beforeMessageId:'y'},{query:'',workspaceId:'foreign-workspace'}])assert.throws(()=>validateContextRead(value));
 assert.ok(!initialCoordinatorToolNames({text:'天气',available:['web_search','generate_image']}).includes('generate_image'));
});
test('a clipped original task cannot be continued until its remaining original text is read',async()=>{
 const f=dispatchFixture();await f.store.mutate(d=>{d.conversations.find(c=>c.id==='old-task-0')!.messages[0].content='合成原要求'.repeat(1700)+'最后限制：不得覆盖已有文件，人数42，预算900。';});let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,messages)=>{
  calls++;
  if(calls===1)return call('read_task',{query:'old-task-0'});
  if(calls===2){assert.equal(JSON.parse(messages.at(-1)!.content!).originalRequest.truncated,true);return call('delegate_task',{taskId:'old-task-0',title:'继续',instruction:'继续原任务',executorId:'general',featureIds:[]});}
  if(calls===3){assert.match(messages.at(-1)!.content!,/先用 read_task/);return call('read_context',{query:'',taskId:'old-task-0',messageId:'old-input-0',offset:8000});}
  if(calls===4){assert.match(messages.at(-1)!.content!,/不得覆盖.*42.*900/);return call('delegate_task',{taskId:'old-task-0',title:'继续',instruction:'人数42，预算900，不得覆盖已有文件，继续原任务。',executorId:'general',featureIds:[]});}
  return evalAnswer('已继续。');
 }});
 const result=await service.dispatch(evalScope,{operationId:'long_bound_adaptive_20261023',boundTaskId:'old-task-0',text:'继续原任务。'},key);assert.equal(result.taskId,'old-task-0');assert.equal(calls,4);
});
test('empty history lookup starts before the initial window and revoked Key blocks the read',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,messages)=>{
  calls++;if(calls===1)return call('read_context',{query:''});
  const result=JSON.parse(messages.at(-1)!.content!);assert.equal(result.items.at(-1).id,'history-18');return evalAnswer('已读取更早的对话。');
 }});
 await service.dispatch(evalScope,{operationId:'older_window_adaptive_20261023',text:'看看更早的对话，只回答。'},key);
 const g=dispatchFixture();let revoked=false,modelCalls=0;
 const blocked=new CoordinatorService(g.store,knowledge,{contextMode:'adaptive',modelCall:async()=>{modelCalls++;revoked=true;return call('read_context',{query:'蓝桥'});}});
 await assert.rejects(()=>blocked.dispatch(evalScope,{operationId:'revoked_read_adaptive_20261023',text:'回忆蓝桥活动。'},async()=>{if(revoked)throw Error('synthetic key revoked');}));
 assert.equal(modelCalls,1);assert.equal((await g.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('funded adaptive chat can settle above the former implicit 0.5 route cap; explicit caps still stop before a paid call',async()=>{
 for(const explicit of [false,true]){
  const f=dispatchFixture();await f.store.mutate(d=>{d.models[0].inputPowerPerMillion=100;d.models[0].outputPowerPerMillion=100;});let calls=0;
  const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async()=>{calls++;return {...evalAnswer('你好。'),usage:{inputTokens:6000,outputTokens:10,totalTokens:6010,source:'provider'}};}});
  const result=await service.dispatch(evalScope,{operationId:`funded_adaptive_${explicit}_20261023`,text:'你好。',...(explicit?{routeBudget:.001}:{})},key);
  const db=await f.store.read(),charged=db.modelUsageRecords.reduce((sum,row)=>sum+(row.chargedMicros??0),0);
  if(explicit){assert.equal(calls,0);assert.equal(charged,0);assert.equal(result.taskId,undefined);assert.equal(db.powerAccounts[0].balanceMicros,100e6);}
  else{assert.equal(calls,1);assert.ok(charged>500000);assert.ok(db.powerAccounts[0].balanceMicros>90e6);}
 }
});
test('disabled executor cannot dispatch and identical invalid attempts do not buy a third adaptive model call',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async()=>{calls++;return call('delegate_task',{taskId:null,title:'合成任务',instruction:'制作合成内容',executorId:'not-published',featureIds:[]});}});
 const result=await service.dispatch(evalScope,{operationId:'disabled_adaptive_20261023',text:'帮我制作一份合成方案。'},key);
 assert.equal(calls,2);assert.equal(result.taskId,undefined);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('explicit deliverable prose without a real dispatch is corrected, while one useful clarification stays one call',async()=>{
 for(const clarify of [false,true]){
  const f=dispatchFixture();let calls=0;
  const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async(_m,messages)=>{
   calls++;if(clarify)return evalAnswer('请问网页主要介绍什么主题？');
   if(calls===1)return evalAnswer('报告内容：这是一个合成出行方案。');
   if(calls===2){assert.match(messages.at(-1)!.content!,/实际交付/);return call('delegate_task',{taskId:null,title:'合成报告',instruction:'制作一份合成报告。',executorId:'general',featureIds:[]});}
   return evalAnswer('已安排，成果会留在任务里。');
  }});
  const result=await service.dispatch(evalScope,{operationId:`delivery_gate_${clarify}_20261023`,text:'请制作一个报告。'},key);
  if(clarify){assert.equal(calls,1);assert.equal(result.taskId,undefined);}else{assert.equal(calls,2);assert.ok(result.taskId);}
 }
});
test('an explicit HTML delivery cannot silently become an untooled generic task',async()=>{
 const f=dispatchFixture();let calls=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',modelCall:async()=>{calls++;return call('delegate_task',{taskId:null,title:'合成网页',instruction:'制作HTML网页',executorId:'general',featureIds:[]});}});
 const result=await service.dispatch(evalScope,{operationId:'html_contract_adaptive_20261023',text:'请生成一个可打开的HTML网页。'},key);
 assert.equal(result.taskId,undefined);assert.equal(calls,2);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
});
test('weather explicitly naming its city cannot fabricate a fresh search when profile city is absent',async()=>{
 const f=dispatchFixture();let calls=0,searches=0;
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',webSearch:async()=>{searches++;return [{title:'合成来源',url:'https://example.com/weather',snippet:'合成天气：22度。'}];},modelCall:async(_m,messages)=>{
  calls++;if(calls===1)return evalAnswer('杭州今天晴，22度，我联网查过了。');
  if(calls===2){assert.match(messages.at(-1)!.content!,/尚未实际搜索/);return call('web_search',{query:'杭州今天天气'});}
  return evalAnswer('合成结果：22度，来源 https://example.com/weather');
 }});
 await service.dispatch(evalScope,{operationId:'named_city_adaptive_20261023',text:'请联网查杭州今天天气。',webSearch:true},key);assert.equal(searches,1);assert.equal(calls,3);
});
test('answer-only weather permits the requested read without creating a task in either context mode',async()=>{
 for(const contextMode of ['legacy','adaptive'] as const){
  const f=dispatchFixture();let calls=0,searches=0;
  await f.store.mutate(d=>{d.users[0].contextPreferences=[{...evalScope,timeZone:'Asia/Shanghai',city:'杭州'}];});
  const service=new CoordinatorService(f.store,knowledge,{contextMode,webSearch:async()=>{searches++;return [{title:'合成来源',url:'https://example.com/weather',snippet:'合成天气：22度。'}];},modelCall:async(_m,messages,tools,_request,options)=>{
   calls++;if(calls===1){const text=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.match(text,/不创建任务.*不等于禁止搜索/);assert.ok(tools.some(t=>t.function.name==='web_search'));assert.ok(!tools.some(t=>t.function.name==='delegate_task'));assert.equal(options?.requiredTool,'web_search');return call('web_search',{query:'杭州今天天气'});}
   return evalAnswer('合成结果：22度，来源 https://example.com/weather');
  }});
  const result=await service.dispatch(evalScope,{operationId:`answer_only_weather_${contextMode}_20261023`,text:'请联网查杭州今天天气，用一句话回答并附来源，不要创建任务。',webSearch:true},key);
  assert.equal(searches,1);assert.equal(calls,2);assert.equal(result.taskId,undefined);assert.equal((await f.store.read()).chatOperations!.filter(o=>o.workRun).length,0);
 }
});
test('reviewed orchestration failures leave an owned durable next step, never an empty pending reply',async()=>{
 for(const contextMode of ['legacy','adaptive'] as const)for(const reason of ['已达到调度步骤上限，未完成任务；请缩小问题范围','模型工具指令未完整返回，已停止执行；本次已产生的用量可在账单中查看']){
  const f=dispatchFixture();let calls=0;
  const service=new CoordinatorService(f.store,knowledge,{contextMode,modelCall:async()=>{calls++;throw Error(reason);}});
  const result=await service.dispatch(evalScope,{operationId:`reviewed_failure_${contextMode}_${reason.length}_20261023`,text:'做一份合成报告。'},key);
  const db=await f.store.read();assert.equal(calls,1);assert.equal(result.taskId,undefined);assert.equal(db.chatOperations![0].status,'completed');assert.match(result.message.content,/原话|原要求/);assert.match(result.message.content,/核对|继续/);assert.ok(db.contextTraces.some(t=>t.userId===evalScope.userId&&t.workspaceId===evalScope.workspaceId));assert.equal(db.chatOperations!.filter(o=>o.workRun).length,0);
 }
});
test('text-only continuation keeps the no-overwrite restriction without inventing a file prerequisite',async()=>{
 for(const contextMode of ['legacy','adaptive'] as const){
  const f=dispatchFixture();await f.store.mutate(d=>{d.conversations.find(c=>c.id==='old-task-0')!.messages[0].content='42人，总预算900元。整理活动安排文字，不覆盖已有文件；不联网、不写外部平台。';});let route=0,workers=0;
  const service=new CoordinatorService(f.store,knowledge,{contextMode,modelCall:async(_m,messages)=>{
   const text=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.match(text,/纯文字任务直接交付正文/);assert.match(text,/“不得覆盖”是限制/);
   if(text.includes('你已在独立任务内')){workers++;return evalAnswer(JSON.stringify({outcome:'completed',content:'42人，总预算900元；雨天改为室内分组活动，不追加预算。不覆盖已有文件，不联网、不写外部平台。',summary:'原要求保留，已补雨天备选。'}));}
   route++;if(route===1)return call('read_task',{query:'old-task-0'});
   if(route===2)return call('delegate_task',{taskId:'old-task-0',title:'活动安排',instruction:'整理42人、预算900元的活动安排文字，补一句雨天室内备选；不覆盖已有文件，不联网、不写外部平台。',executorId:'general',featureIds:[]});
   return evalAnswer('已继续原任务。');
  }});
  const result=await service.dispatch(evalScope,{operationId:`text_continuation_${contextMode}_20261023`,boundTaskId:'old-task-0',text:'继续这个任务：补一句雨天备选，不要改原有要求。',budget:2},key);await service.resume(evalScope,key);
  for(let i=0;i<100;i++){if((await f.store.read()).chatOperations!.find(o=>o.workRun)?.workRun?.state==='completed')break;await new Promise(r=>setTimeout(r,10));}
  const db=await f.store.read();assert.equal(result.taskId,'old-task-0');assert.equal(workers,1);assert.equal(db.chatOperations!.find(o=>o.workRun)!.workRun!.state,'completed');assert.equal(db.attachments.length,0);
 }
});
test('one mandatory self-contained feature executes its own model without a paid wrapper or acknowledgement loop',async()=>{
 const f=dispatchFixture(),directory=await mkdtemp(path.join(tmpdir(),'one-adaptive-feature-'));let routes=0,features=0;
 await f.store.mutate(d=>{const values={name:'合成网页',author:'ONE',description:'生成HTML',instructions:'调用oneHtml保存网页',limitations:'不访问外部资料',integration:'question_answer' as const,modelId:'eval-model',knowledgeMode:'none' as const,usageMultiplier:1,tools:[{id:'oneHtml',description:'保存HTML'}]};const version={version:1,values,evidence:'test',approvedBy:'a',approvedAt:'now'};d.settings.officialFeatures=[{id:'page',revision:1,draft:values,status:'approved',current:version,history:[version],release:{id:'page-release',version:1,userIds:[evalScope.userId],publishedAt:'now',publishedBy:'a'}}];});
 const scene={id:'sun',title:'晴天',situation:'合成22度',feature:'户外散步',advantage:'简单',benefit:'放松',evidence:'合成资料',steps:['带水','散步'],prompt:'安排散步',capabilityIds:[]};
 const service=new CoordinatorService(f.store,knowledge,{contextMode:'adaptive',artifactDirectory:directory,modelCall:async(_m,messages,tools)=>{
  const text=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.ok(!text.includes('你已在独立任务内'),'no generic worker model is needed for a selected fixed feature');
  if(tools.some(t=>t.function.name==='oneHtml')||messages.some(m=>m.role==='tool'&&m.tool_call_id==='call-oneHtml')){features++;return messages.at(-1)?.role==='tool'?evalAnswer('网页已保存。'):call('oneHtml',{version:1,title:'合成出行',intro:'合成22度出行说明',scenes:[scene,{...scene,id:'rain',title:'雨天',feature:'室内活动'}]});}
  routes++;assert.equal(routes,1,'a queued receipt must not buy another acknowledgement or dispatch');return call('delegate_task',{taskId:null,title:'合成网页',instruction:'生成合成22度出行网页，晴天和雨天两个场景。',executorId:'general',featureIds:['page']});
 }});
 const reply=await service.dispatch(evalScope,{operationId:'one_feature_direct_20261023',text:'生成一份合成出行网页。',budget:2},key);await service.resume(evalScope,key);
 for(let i=0;i<100;i++){if((await f.store.read()).chatOperations!.find(o=>o.workRun)?.workRun?.state==='completed')break;await new Promise(r=>setTimeout(r,10));}
 const db=await f.store.read();assert.equal(routes,1);assert.equal(features,2);assert.equal(db.chatOperations!.filter(o=>o.workRun).length,1);assert.equal(db.chatOperations!.find(o=>o.workRun)!.workRun!.state,'completed');assert.equal(db.modelUsageRecords.filter(r=>r.activity==='task_worker').length,0);assert.equal(db.modelUsageRecords.length,3);const file=db.attachments.find(a=>a.conversationId===reply.taskId)!;assert.equal(path.extname(file.originalName),'.html');assert.match(await readFile(file.storagePath,'utf8'),/合成22度/);
});
