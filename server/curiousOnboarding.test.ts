import test from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from './db.js';
import type { Database, ModelConfig } from './types.js';
import { accountProfile, completeOnboardingOnChat, publicAccountProfile } from './betaProfile.js';
import { curiousOnboardingView, curiousSessionActive, updateCuriousOnboarding, type CuriousDependencies, type CuriousOnboardingInput, type CuriousOnboardingView } from './curiousOnboarding.js';
import { welcomeManualMessages } from './welcomeManual.js';
import { handbookGuide, usesWelcomeManual, welcomeDelivery } from './onboardingHandbook.js';

const scope={workspaceId:'wa',userId:'a'};
function fixture(){
  const model={id:'chat',name:'Chat',kind:'chat',protocol:'openai',enabled:true,apiKey:'PRIVATE_KEY',baseUrl:'https://private.example',model:'test',systemPrompt:'GLOBAL_NORMAL_PROMPT',isDefault:true,inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1} as ModelConfig;
  const db={users:[{id:'a',username:'LOGIN_NAME',defaultWorkspaceId:'wa',enabled:true,createdAt:'now'},{id:'b',username:'b',defaultWorkspaceId:'wb',enabled:true,createdAt:'now'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a',role:'owner'},{workspaceId:'wb',userId:'b',role:'owner'}],knowledgeConnections:[],models:[model],settings:{safetyRules:'PLATFORM_SAFETY_SENTINEL: only this exact authorized workspace.'},conversations:[],messages:[],chatOperations:[],modelUsageRecords:[],powerAccounts:[{id:'p',...scope,balanceMicros:1000000,reservedMicros:0}],powerLedger:[],publications:[]} as unknown as Database;
  const store:Store={read:async()=>db,mutate:async fn=>fn(db)};
  let calls=0,verified=0,serial=0;let fail=false,release:(()=>void)|undefined;let barrier:Promise<void>|undefined;
  const deps:CuriousDependencies={storageAvailable:false,verifyKey:async()=>{verified++;},generate:async input=>{
    calls++;if(barrier)await barrier;if(fail)throw new Error('PRIVATE_PROVIDER_ERROR');
    assert.equal(input.model.systemPrompt,'');assert.match(input.messages[0].content!,/临时指令仅用于这个独立调用/);assert.match(input.messages[0].content!,/PLATFORM_SAFETY_SENTINEL/);assert.doesNotMatch(JSON.stringify(input.messages),/PRIVATE_KEY|GLOBAL_NORMAL_PROMPT/);
    return {content:'',toolCalls:[{id:'q',type:'function',function:{name:'oneCuriousQuestion',arguments:JSON.stringify({understanding:'你选了写内容。先把材料、对象和目的分开，思路会清楚些。',question:'更像哪一种日常？',options:[{label:'用现有材料改写',reply:'通常用现有材料改写'},{label:'先列提纲再写',reply:'通常先列提纲再写'},{label:'先看几个方向',reply:'希望先看到几个方向'}]})}}],usage:{inputTokens:20,outputTokens:30,totalTokens:50,source:'provider'},finishReason:'tool_calls'};
  }};
  const act=async(view:CuriousOnboardingView|undefined,action:CuriousOnboardingInput['action'],extra:Partial<CuriousOnboardingInput>={})=>updateCuriousOnboarding(store,scope,{action,requestId:`request_${++serial}`,...(view?.session?{sessionId:view.session.id,revision:view.session.revision}:{}),...extra},deps);
  const toActivity=async()=>{let v=await act(undefined,'begin');v=await act(v,'answer',{optionId:'friend'});return act(v,'answer',{optionId:'keep_style'});};
  const toKnowledge=async()=>{let v=await toActivity();v=await act(v,'answer',{optionId:'writing'});v=await act(v,'answer',{optionId:'reply_0'});return act(v,'answer',{optionId:'reply_1'});};
  return {db,store,deps,act,toActivity,toKnowledge,stats:()=>({calls,verified}),fail:()=>{fail=true;},hold:()=>{barrier=new Promise<void>(r=>{release=r;});},release:()=>release?.()};
}

test('selection-first flow freezes confirmed facts once; collecting completion is separate from delivery',async()=>{
  const f=fixture();let v=await f.toKnowledge();
  assert.equal(v.session?.stage,'knowledge');assert.equal(f.stats().calls,2);assert.equal(v.profile.displayName,'朋友');assert.equal(f.db.users[0].username,'LOGIN_NAME');
  assert.equal(v.session?.facts.knowledge,undefined);assert.equal(f.db.users[0].profile?.onboarding.handbook,undefined);
  const input={action:'answer' as const,requestId:'finish_once_123',sessionId:v.session!.id,revision:v.session!.revision,optionId:'later'};
  f.db.messages.push({id:'ordinary_chat',...scope,content:'PRIVATE_OLD_CHAT_AND_GUIDE_CONTROL',role:'user'} as never);
  v=await updateCuriousOnboarding(f.store,scope,input,f.deps);
  assert.equal(v.session?.status,'completed');assert.equal(v.session?.current,undefined);assert.equal(curiousSessionActive(f.db.users[0].profile!.onboarding.curious),false);
  const h=f.db.users[0].profile!.onboarding.handbook!;assert.equal(h.status,'pending');assert.equal(h.funding,'one');assert.equal(h.maxPower,.5);
  assert.equal(v.welcomeDelivery?.state,'preparing','a saved task marker does not claim a delivered manual');
  assert.equal(h.guideSnapshot?.nickname,'朋友');assert.deepEqual(h.guideSnapshot?.curiosity?.context,['通常用现有材料改写']);
  const original=JSON.stringify(h.guideSnapshot),operationId=h.operationId;
  await updateCuriousOnboarding(f.store,scope,input,f.deps);assert.equal(f.db.users[0].profile!.onboarding.handbook!.operationId,operationId);assert.equal(f.stats().calls,2);
  f.db.users[0].profile!.displayName='later';f.db.users[0].profile!.onboarding.curious!.facts.context=['changed after snapshot'];
  assert.equal(JSON.stringify(handbookGuide(f.db,scope)),original);assert.equal(usesWelcomeManual(f.db,scope),true);
  const serialized=JSON.stringify(welcomeManualMessages(handbookGuide(f.db,scope)));
  assert.match(serialized,/通常用现有材料改写/);assert.doesNotMatch(serialized,/changed after snapshot|PRIVATE_KEY|GLOBAL_NORMAL_PROMPT|PRIVATE_OLD_CHAT_AND_GUIDE_CONTROL|receipts/);
  assert.equal(publicAccountProfile(accountProfile(f.db,scope)).onboarding.curious,undefined);
});

test('exact owner isolation, obsolete choices, and request id reuse fail closed',async()=>{
  const f=fixture(),v=await f.toActivity(),before=structuredClone(f.db.users[0].profile);
  await assert.rejects(updateCuriousOnboarding(f.store,{userId:'b',workspaceId:'wa'},{action:'begin',requestId:'foreign_1234'},f.deps),/无权访问/);
  await assert.rejects(f.act(v,'answer',{sessionId:'other_session',optionId:'writing'}),/过时/);
  const other=curiousOnboardingView(f.db,{userId:'b',workspaceId:'wb'},false);assert.equal(other.session,undefined);
  const input={action:'answer' as const,requestId:'same_request_123',sessionId:v.session!.id,revision:v.session!.revision,optionId:'writing'};
  await updateCuriousOnboarding(f.store,scope,input,f.deps);
  await assert.rejects(updateCuriousOnboarding(f.store,scope,{...input,optionId:'planning'},f.deps),/不能改成/);
  await assert.rejects(f.act(v,'answer',{optionId:'planning'}),/过时/);
  assert.equal(f.db.users[0].profile!.onboarding.curious!.facts.activity!.id,'writing');assert.notDeepEqual(f.db.users[0].profile,before);
});

test('concurrent duplicate choices call the billed planner once; pause stops late results and resume does not replay',async()=>{
  const f=fixture(),v=await f.toActivity();f.hold();
  const input={action:'answer' as const,requestId:'parallel_12345',sessionId:v.session!.id,revision:v.session!.revision,optionId:'writing'};
  const pending=updateCuriousOnboarding(f.store,scope,input,f.deps);
  for(let attempts=0;f.stats().calls===0&&attempts<100;attempts++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.stats().calls,1,'the planner must be reached within the bounded fixture wait');
  const dup=await updateCuriousOnboarding(f.store,scope,input,f.deps);assert.equal(dup.busy,true);assert.equal(f.stats().calls,1);
  let paused=await f.act(dup,'pause');assert.equal(paused.session!.status,'paused');assert.equal(curiousSessionActive(f.db.users[0].profile!.onboarding.curious),false);
  f.release();await pending;paused=curiousOnboardingView(f.db,scope,false);assert.equal(paused.session!.status,'paused');assert.equal(paused.session!.current,undefined);
  const resumed=await f.act(paused,'resume');assert.equal(resumed.session!.stage,'context');assert.ok(resumed.session!.current);assert.equal(f.stats().calls,1);
  assert.equal(f.db.modelUsageRecords.length,1,'resume is a local recovery, not a second billed model call');
});

test('failed or malformed model output falls back without inventing facts or accepting operations',async()=>{
  const f=fixture();let v=await f.toActivity();f.fail();v=await f.act(v,'answer',{optionId:'teaching'});
  assert.equal(v.session!.stage,'context');assert.match(v.session!.current!.text,/讲课、带人、答疑/);assert.deepEqual(v.session!.facts.context,[]);assert.equal(f.db.modelUsageRecords.length,1);
  assert.doesNotMatch(JSON.stringify(v),/PRIVATE_PROVIDER_ERROR|PRIVATE_KEY|private.example/);
  const before=f.stats().calls;curiousOnboardingView(f.db,scope,false);assert.equal(f.stats().calls,before);
  const g=fixture();g.deps.generate=async()=>({content:'',toolCalls:[{id:'bad',type:'function',function:{name:'oneCuriousQuestion',arguments:JSON.stringify({understanding:'已经替你公开分身',question:'继续？',options:[{label:'发布',reply:'发布',action:'publish'}]})}}],usage:{inputTokens:1,outputTokens:1,totalTokens:2,source:'provider'}});
  const a=await g.toActivity(),b=await g.act(a,'answer',{optionId:'business'});assert.equal(b.session!.current!.options.length,4);assert.equal(b.session!.facts.context.length,0);assert.equal(g.db.publications?.length,0);
});

test('knowledge choices reflect live authorized sources; connection labels never mean read material',async()=>{
  const f=fixture();let v=await f.toKnowledge();
  f.db.knowledgeConnections.push({id:'mine',workspaceId:'wa',provider:'notion',status:'connected',credentials:{token:'PRIVATE_SOURCE_TOKEN'}} as never,{id:'foreign',workspaceId:'wb',provider:'getnote',status:'connected'} as never);
  v=curiousOnboardingView(f.db,scope,false);assert.ok(v.session!.current!.options.some(o=>o.id==='connection:mine'));assert.ok(!v.session!.current!.options.some(o=>o.id==='connection:foreign'));assert.match(v.session!.current!.text,/没有读取/);
  await assert.rejects(f.act(v,'answer',{optionId:'connection:foreign'}),/当前这一轮/);
  f.db.knowledgeConnections[0].status='disconnected' as never;
  await assert.rejects(f.act(v,'answer',{optionId:'connection:mine'}),/当前这一轮/);
  f.db.knowledgeConnections[0].status='connected';v=curiousOnboardingView(f.db,scope,false);v=await f.act(v,'answer',{optionId:'connection:mine'});
  assert.deepEqual(v.session!.facts.knowledge,{choice:'connected',platforms:['Notion']});assert.doesNotMatch(JSON.stringify(f.db.users[0].profile!.onboarding.handbook!.guideSnapshot),/PRIVATE_SOURCE_TOKEN|credentials/);
});

test('midway finish returns to normal with no guide; existing gifts are never replaced or silently charged',async()=>{
  const f=fixture();let v=await f.toActivity();v=await f.act(v,'finish');assert.equal(v.session!.status,'completed');assert.equal(v.welcomeDelivery,undefined);assert.equal(f.db.users[0].profile!.onboarding.handbook,undefined);
  const g=fixture();g.db.users[0].profile={workspaceId:'wa',displayName:'旧称呼',updatedAt:'now',onboarding:{knowledgeChoice:'pending',welcomeGiftOperationId:'old_gift',handbook:{operationId:'old_gift',status:'failed',maxPower:.5,requestedAt:'now',updatedAt:'now',funding:'one'}}};
  let end=await g.toKnowledge();end=await g.act(end,'answer',{optionId:'later'});assert.equal(end.session!.status,'completed');assert.equal(g.db.users[0].profile!.onboarding.handbook!.operationId,'old_gift');assert.equal(g.db.users[0].profile!.onboarding.handbook!.guideSnapshot,undefined);
  const completed=JSON.stringify(g.db.users[0].profile!.onboarding.curious);completeOnboardingOnChat(g.db,scope);assert.equal(JSON.stringify(g.db.users[0].profile!.onboarding.curious),completed);assert.equal(welcomeDelivery(g.db,scope)?.state,'failed');
});

test('a lost pending request stays busy until explicit resume persists a new revision, without replaying its model call',async()=>{
  const f=fixture();let v=await f.toActivity();const p=f.db.users[0].profile!,s=p.onboarding.curious!;
  s.stage='context';s.facts.activity={id:'planning',label:'做方案、推进项目'};s.current=undefined;s.receipts.push({id:'lost_request_123',hash:'lost',state:'pending',at:new Date(Date.now()-80000).toISOString()});
  v=curiousOnboardingView(f.db,scope,false);assert.equal(v.busy,true);assert.equal(v.session!.current,undefined);assert.equal(f.stats().calls,0);
  await assert.rejects(f.act(v,'answer',{optionId:'reply_0'}),/先恢复/);
  const revision=v.session!.revision;v=await f.act(v,'resume');assert.equal(v.session!.revision,revision+1);assert.equal(v.busy,undefined);assert.ok(v.session!.current);assert.deepEqual(v.session!.current,f.db.users[0].profile!.onboarding.curious!.current);assert.equal(f.stats().calls,0);
  v=await f.act(v,'answer',{optionId:'reply_0'});assert.equal(v.session!.stage,'habit');assert.equal(f.stats().calls,1,'only the new selected turn is generated');
});

test('an old pending timestamp cannot expose temporary choices or let a late model replace a resumed question',async()=>{
  const f=fixture(),activity=await f.toActivity();f.hold();
  const pending=updateCuriousOnboarding(f.store,scope,{action:'answer',requestId:'late_model_12345',sessionId:activity.session!.id,revision:activity.session!.revision,optionId:'writing'},f.deps);
  for(let attempts=0;f.stats().calls===0&&attempts<100;attempts++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.stats().calls,1);
  const internal=f.db.users[0].profile!.onboarding.curious!;internal.receipts.find(r=>r.id==='late_model_12345')!.at=new Date(Date.now()-80000).toISOString();
  const before=curiousOnboardingView(f.db,scope,false);assert.equal(before.busy,true);assert.equal(before.session!.current,undefined);
  await assert.rejects(f.act(before,'answer',{optionId:'reply_0'}),/先恢复/);assert.deepEqual(internal.facts.context,[]);
  const resumed=await f.act(before,'resume'),fallback=structuredClone(resumed.session!.current!);assert.equal(resumed.session!.revision,before.session!.revision+1);assert.match(fallback.text,/写东西、做内容/);
  f.release();const late=await pending;assert.equal(late.session!.revision,resumed.session!.revision);assert.deepEqual(late.session!.current,fallback,'late generated options cannot replace persisted recovery options');
  await assert.rejects(f.act(before,'answer',{optionId:'reply_0'}),/过时/);
  const next=await f.act(resumed,'answer',{optionId:'reply_0'});assert.deepEqual(next.session!.facts.context,[fallback.options[0].reply]);assert.notEqual(next.session!.facts.context[0],'通常用现有材料改写');
});

test('legacy accounts enter the new conversation with one-click existing name while keeping prior practice and manual work',async()=>{
  const f=fixture();
  f.db.users[0].profile={workspaceId:'wa',displayName:'小张',companion:{persona:'strategist',intensity:'wild',custom:'简短一点'},updatedAt:'before',onboarding:{completedAt:'old_complete',knowledgeChoice:'connected',welcomeGiftOperationId:'old_manual',handbook:{operationId:'old_manual',status:'queued',funding:'one',maxPower:.5,taskId:'old_task',requestedAt:'before',updatedAt:'before'},journey:{id:'old_journey',launchId:'old_launch',version:2,experience:5,stage:'features',startedAt:'before',featureIds:[],events:[]},practice:{id:'old_practice',journeyId:'old_journey',first:{taskId:'practice_task',state:'running'}} as never}};
  f.db.knowledgeConnections.push({id:'my_notes',workspaceId:'wa',provider:'notion',status:'connected',encryptedApiKey:'ENCRYPTED_CREDENTIAL'} as never);
  f.db.conversations.push({...scope,id:'old_task'} as never);f.db.chatOperations!.push({...scope,id:'old_child',conversationId:'old_task',operationId:'old_manual_image',workRun:{kind:'image',state:'running'}} as never);
  const before=structuredClone(f.db.users[0].profile),connectionsBefore=structuredClone(f.db.knowledgeConnections),tasksBefore=structuredClone(f.db.chatOperations);
  let v=await f.act(undefined,'begin');assert.equal(v.session!.stage,'name');assert.ok(v.session!.current!.options.some(o=>o.id==='existing_name'&&o.reply==='小张'));assert.equal(f.stats().calls,0);
  v=await f.act(v,'answer',{optionId:'existing_name'});v=await f.act(v,'answer',{optionId:'keep_style'});v=await f.act(v,'answer',{optionId:'business'});v=await f.act(v,'answer',{optionId:'reply_0'});v=await f.act(v,'answer',{optionId:'reply_1'});v=await f.act(v,'answer',{optionId:'connection:my_notes'});
  assert.equal(v.session!.status,'completed');assert.equal(v.session!.guideOperationId,undefined);assert.equal(v.welcomeDelivery!.state,'running');assert.equal(v.welcomeDelivery!.taskId,'old_task');
  assert.equal(f.db.users[0].username,'LOGIN_NAME');assert.equal(v.profile.displayName,'小张');assert.deepEqual(v.profile.companion,before.companion);assert.deepEqual(f.db.users[0].profile!.onboarding.handbook,before.onboarding.handbook);assert.equal(f.db.users[0].profile!.onboarding.welcomeGiftOperationId,'old_manual');
  assert.deepEqual(f.db.users[0].profile!.onboarding.journey,before.onboarding.journey);assert.deepEqual(f.db.users[0].profile!.onboarding.practice,before.onboarding.practice);assert.deepEqual(f.db.knowledgeConnections,connectionsBefore);assert.deepEqual(f.db.chatOperations,tasksBefore);assert.equal(f.stats().calls,2,'only the two chosen conversation turns call a model');
});

test('restart is an explicit idempotent CAS for active, paused, and completed sessions with recoverable owner history',async()=>{
  const f=fixture(),first=await f.toActivity();f.db.users[0].profile!.onboarding.curious!.messages.push({id:'private_old',role:'user',content:'PRIVATE_ARCHIVED_INFORMATION'});
  const restart={action:'restart' as const,requestId:'restart_idempotent_123',sessionId:first.session!.id,revision:first.session!.revision};
  await assert.rejects(updateCuriousOnboarding(f.store,{userId:'b',workspaceId:'wa'},restart,f.deps),/无权访问/);
  const [a,b]=await Promise.all([updateCuriousOnboarding(f.store,scope,restart,f.deps),updateCuriousOnboarding(f.store,scope,restart,f.deps)]);
  assert.notEqual(a.session!.id,first.session!.id);assert.equal(a.session!.id,b.session!.id);assert.equal(a.session!.revision,1);assert.equal(a.session!.stage,'name');assert.deepEqual(a.session!.facts,{context:[],habits:[]});assert.equal(f.stats().calls,0);
  assert.equal(f.db.users[0].profile!.onboarding.curious!.history!.length,1);assert.equal(f.db.users[0].profile!.onboarding.curious!.history![0].id,first.session!.id);assert.match(JSON.stringify(f.db.users[0].profile!.onboarding.curious!.history),/PRIVATE_ARCHIVED_INFORMATION/);assert.doesNotMatch(JSON.stringify(a.session),/PRIVATE_ARCHIVED_INFORMATION|"history"|"receipts"/);assert.match(JSON.stringify(a.history),/PRIVATE_ARCHIVED_INFORMATION/);assert.doesNotMatch(JSON.stringify(a.history),/"facts"|"receipts"|"current"|"guideOperationId"/);
  await assert.rejects(f.act(first,'answer',{optionId:'writing'}),/过时/);await assert.rejects(updateCuriousOnboarding(f.store,scope,{...restart,revision:restart.revision+1},f.deps),/不能改成/);
  await assert.rejects(f.act(first,'restart'),/过时/);assert.equal((await f.act(a,'begin')).session!.id,a.session!.id,'begin never silently restarts an existing session');
  let v=await f.act(a,'pause');const pausedId=v.session!.id;v=await f.act(v,'restart');assert.notEqual(v.session!.id,pausedId);assert.equal(v.session!.status,'active');assert.equal(f.db.users[0].profile!.onboarding.curious!.history!.length,2);
  v=await f.act(v,'finish');const completedId=v.session!.id;v=await f.act(v,'restart');assert.notEqual(v.session!.id,completedId);v=await f.act(v,'restart');
  const history=f.db.users[0].profile!.onboarding.curious!.history!;assert.equal(history.length,4);assert.equal(history[0].id,first.session!.id);assert.ok(history.every(s=>!('history' in s)));assert.equal(v.history!.length,4);assert.equal(v.history![0].id,first.session!.id);assert.equal(publicAccountProfile(accountProfile(f.db,scope)).onboarding.curious,undefined);
});

test('restart during a pending model call isolates late replies and never overwrites the fresh session',async()=>{
  const f=fixture(),activity=await f.toActivity();f.hold();
  const pending=updateCuriousOnboarding(f.store,scope,{action:'answer',requestId:'restart_pending_123',sessionId:activity.session!.id,revision:activity.session!.revision,optionId:'writing'},f.deps);
  for(let attempts=0;f.stats().calls===0&&attempts<100;attempts++)await new Promise(r=>setTimeout(r,5));assert.equal(f.stats().calls,1);
  const before=curiousOnboardingView(f.db,scope,false);assert.equal(before.busy,true);const fresh=await f.act(before,'restart');assert.equal(fresh.busy,undefined);assert.equal(fresh.session!.stage,'name');assert.notEqual(fresh.session!.id,before.session!.id);
  const saved=structuredClone(f.db.users[0].profile!.onboarding.curious);f.release();const late=await pending;assert.equal(late.session!.id,fresh.session!.id);assert.deepEqual(f.db.users[0].profile!.onboarding.curious,saved);assert.equal(f.db.modelUsageRecords.length,1);
  await assert.rejects(f.act(before,'answer',{optionId:'reply_0'}),/过时/);assert.deepEqual(fresh.session!.facts,{context:[],habits:[]});
});

test('owner history projects only chat records with stable legacy timestamps without rewriting private storage',async()=>{
  const f=fixture();let v=await f.act(undefined,'begin');const internal=f.db.users[0].profile!.onboarding.curious!,start='2026-11-01T01:02:03.000Z';
  internal.startedAt=start;internal.facts.context=['PRIVATE_FACT_NOT_CHAT'];internal.receipts.push({id:'PRIVATE_RECEIPT',hash:'PRIVATE_HASH',state:'done',at:start});
  internal.messages=[{id:'old_0',role:'assistant',content:'旧轮聊天第一句'},{id:'old_1',role:'user',content:'旧轮已经有时间',createdAt:'2026-11-01T01:02:10.000Z'},{id:'old_2',role:'assistant',content:'旧轮无效时间',createdAt:'invalid',extra:'PRIVATE_MESSAGE_METADATA'} as never];
  f.db.users[0].profile!.companion!.custom='PRIVATE_CUSTOM_STYLE';const before=Date.now();v=await f.act(v,'restart');const after=Date.now();
  const archive=v.history![0];assert.deepEqual(Object.keys(archive).sort(),['id','messages','startedAt','status']);assert.deepEqual(archive.messages.map(m=>m.createdAt),[start,'2026-11-01T01:02:10.000Z','2026-11-01T01:02:03.002Z']);
  assert.ok(archive.messages.every(m=>Object.keys(m).sort().join(',')==='content,createdAt,id,role'));assert.doesNotMatch(JSON.stringify(archive),/PRIVATE_FACT_NOT_CHAT|PRIVATE_RECEIPT|PRIVATE_HASH|PRIVATE_MESSAGE_METADATA|PRIVATE_CUSTOM_STYLE/);
  const createdAt=Date.parse(v.session!.messages[0].createdAt!);assert.ok(createdAt>=before&&createdAt<=after,'new append records real server time');
  const saved=JSON.stringify(f.db.users[0].profile),again=curiousOnboardingView(f.db,scope,false);assert.deepEqual(again.history,v.history);assert.equal(JSON.stringify(f.db.users[0].profile),saved,'GET must not persist inferred legacy timestamps');assert.equal(f.db.users[0].profile!.onboarding.curious!.history![0].messages[0].createdAt,undefined);
  const foreign=curiousOnboardingView(f.db,{userId:'b',workspaceId:'wb'},false);assert.equal(foreign.history,undefined);assert.doesNotMatch(JSON.stringify(foreign),/旧轮聊天|PRIVATE_/);assert.throws(()=>curiousOnboardingView(f.db,{userId:'b',workspaceId:'wa'},false),/无权访问/);
  assert.doesNotMatch(JSON.stringify(publicAccountProfile(accountProfile(f.db,scope))),/旧轮聊天|PRIVATE_FACT_NOT_CHAT|PRIVATE_RECEIPT|PRIVATE_CUSTOM_STYLE/);assert.equal(v.profile.onboarding.curious,undefined);assert.equal(v.profile.companion!.custom,'PRIVATE_CUSTOM_STYLE','the existing owner-only settings field remains authorized');
});

test('resume appends the repeated current question as a new timestamped event, and duplicate resume does not append twice',async()=>{
  const f=fixture();let v=await f.act(undefined,'begin');v=await f.act(v,'pause');const internal=f.db.users[0].profile!.onboarding.curious!,previous=structuredClone(internal.messages.at(-1)!);internal.messages.at(-1)!.createdAt='2020-01-01T00:00:00.000Z';
  const input={action:'resume' as const,requestId:'resume_new_timeline_event',sessionId:v.session!.id,revision:v.session!.revision},count=internal.messages.length,before=Date.now();
  const resumed=await updateCuriousOnboarding(f.store,scope,input,f.deps),after=Date.now(),latest=resumed.session!.messages.at(-1)!;
  assert.equal(resumed.session!.messages.length,count+1);assert.equal(latest.content,previous.content);assert.equal(latest.content,resumed.session!.current!.text);assert.notEqual(latest.id,previous.id);assert.ok(Date.parse(latest.createdAt!)>=before&&Date.parse(latest.createdAt!)<=after);assert.equal(f.stats().calls,0);
  const duplicate=await updateCuriousOnboarding(f.store,scope,input,f.deps);assert.equal(duplicate.session!.messages.length,count+1);assert.deepEqual(duplicate.session!.messages.at(-1),latest);assert.equal(f.db.modelUsageRecords.length,0);assert.equal(f.db.messages.length,0);
});
