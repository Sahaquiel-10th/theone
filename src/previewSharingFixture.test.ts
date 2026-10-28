import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import * as statusAuditFixture from '../output/playwright/status-audit-fixture';

/** Executes only the local request fixture, with fake DOM/timers and no native network. */
function fixtureHarness(query='richPreview=1&workflowPreview=1&shareRefreshFailure=1'){
 const nodes=new Map<string,any>(),storage=new Map<string,string>(),timers:Array<()=>void>=[];let nativeCalls=0;
 const element=()=>({id:'',hidden:false,textContent:'',style:{},setAttribute(){},remove(){}});
 const document={documentElement:{dataset:{} as Record<string,string>},body:{append(node:any){nodes.set(node.id,node);}},createElement:element,addEventListener(){},getElementById(id:string){return nodes.get(id);}};
 const window={fetch:async()=>{nativeCalls++;throw Error('The synthetic fixture must not call native fetch');},EventSource:undefined};
 // Load approved local fixture dependencies through CommonJS transpilation.
 // Unknown imports fail closed, instead of stripping source declarations.
 const require=(name:string)=>{if(name==='./status-audit-fixture')return statusAuditFixture;throw Error(`Unapproved fixture dependency: ${name}`);};
 const sandbox={window,document,exports:{},require,location:{origin:'http://127.0.0.1:5346',href:`http://127.0.0.1:5346/?${query}`,search:`?${query}`},localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},URL,URLSearchParams,Response,Request,Headers,Event,crypto:{randomUUID},setTimeout:(callback:()=>void)=>{timers.push(callback);return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){},console};
 const source=fs.readFileSync(new URL('../output/playwright/focus-preview.ts',import.meta.url),'utf8').split("await import('/src/main.tsx');")[0];
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(compiled,sandbox,{filename:'focus-preview-fixture.js'});
 const request=async(path:string,body?:unknown,method=body?'POST':'GET')=>{const response=await (window.fetch as any)(path,{method,...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.headers.get('X-ONE-Preview'),'synthetic');const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data};};
 return {request,flush(){while(timers.length)timers.shift()!();},get nativeCalls(){return nativeCalls;},get log(){return JSON.parse(nodes.get('fixture-api-log')?.textContent||'[]');},get mode(){return document.documentElement.dataset.onePreviewMode;}};
}
const privateBody={intent:'draft',name:'本地私有分身',description:'只用于合成验证',prompt:'PRIVATE_FIXTURE_INSTRUCTIONS',modelId:'preview-model',sourceIds:['fixture-notion'],attachments:true,budget:10,perRun:1,days:14,confirmed:true,visitorPercent:0,requireLogin:false,allowedUsernames:[]};
test('synthetic sharing creates/updates private rows without leaking slugs, then explicitly publishes once',async()=>{
 const f=fixtureHarness(),created=await f.request('/api/sharing/manage',privateBody);
 assert.equal(created.status,200);assert.ok(created.data.id);assert.equal(created.data.status,'draft');assert.equal(created.data.version,1);assert.equal(created.data.slug,undefined);
 assert.equal((await f.request('/api/sharing/manage')).status,503);
 const privateList=await f.request('/api/sharing/manage');assert.equal(privateList.data.items[0].status,'draft');assert.equal(privateList.data.items[0].slug,undefined);assert.equal(privateList.data.items[0].draftDays,undefined);
 const id=created.data.id,config=await f.request(`/api/sharing/manage/${id}/config`);assert.equal(config.data.status,'draft');assert.equal(config.data.days,14);assert.equal(config.data.intent,undefined);assert.equal(config.data.confirmed,undefined);
 assert.equal((await f.request('/api/sharing/fixture-one-1')).status,410);assert.equal((await f.request('/api/sharing/fixture-one-1/sessions',{})).status,410);
 assert.equal((await f.request(`/api/sharing-api/manage/${id}/keys`,{name:'不应签发',version:1,confirmed:true,budget:1,perRun:1,days:1})).status,410);
 const updated=await f.request(`/api/sharing/manage/${id}/update`,{...privateBody,version:1,name:'更新后的私有分身',days:21});assert.equal(updated.data.id,id);assert.equal(updated.data.status,'draft');assert.equal(updated.data.version,2);assert.equal(updated.data.slug,undefined);
 assert.equal((await f.request('/api/sharing/manage')).status,503);assert.equal((await f.request('/api/sharing/manage')).data.items[0].status,'draft');
 assert.equal((await f.request(`/api/sharing/manage/${id}/publish`,{version:2,confirmed:false})).status,400);assert.equal((await f.request(`/api/sharing/manage/${id}/publish`,{version:1,confirmed:true})).status,409);
 const published=await f.request(`/api/sharing/manage/${id}/publish`,{version:2,confirmed:true});assert.equal(published.status,200);assert.equal(published.data.id,id);assert.equal(published.data.status,'active');assert.equal(published.data.version,3);assert.equal(published.data.slug,'fixture-one-1');assert.ok(Date.parse(published.data.expiresAt)>Date.now()+20*86400000);
 assert.equal((await f.request('/api/sharing/manage')).status,503);assert.equal((await f.request('/api/sharing/manage')).data.items[0].slug,published.data.slug);
 const repeated=await f.request(`/api/sharing/manage/${id}/publish`,{version:2,confirmed:true});assert.deepEqual(repeated.data,published.data);assert.equal((await f.request('/api/sharing/manage')).status,200);
 const activeConfig=await f.request(`/api/sharing/manage/${id}/config`);assert.equal(activeConfig.data.status,'active');assert.equal(activeConfig.data.version,3);assert.equal(activeConfig.data.days,21);assert.equal(activeConfig.data.intent,undefined);
 const activeUpdate=await f.request(`/api/sharing/manage/${id}/update`,{...activeConfig.data,name:'保持已分享',confirmed:true});assert.equal(activeUpdate.status,200);assert.equal(activeUpdate.data.version,4);assert.equal(activeUpdate.data.slug,published.data.slug);assert.equal(activeUpdate.data.status,'active');
 assert.equal((await f.request(`/api/sharing/manage/${id}/update`,{...privateBody,version:4})).status,409);
 assert.equal((await f.request('/api/sharing/fixture-one-1')).status,200);assert.equal((await f.request(`/api/sharing/manage/${id}/close`,{})).status,200);assert.equal((await f.request(`/api/sharing/manage/${id}/publish`,{version:4,confirmed:true})).status,409);assert.equal((await f.request('/api/sharing/fixture-one-1')).status,410);
 assert.equal(f.mode,'synthetic');assert.equal(f.nativeCalls,0);assert.ok(f.log.every((row:any)=>row.scope==='synthetic'));
});
test('legacy publish and invalid-scope atomicity remain in the local mock',async()=>{
 const f=fixtureHarness();const {intent,...legacy}=privateBody;
 const rejected=await f.request('/api/sharing/manage',{...privateBody,sourceIds:['foreign-source']});assert.equal(rejected.status,403);assert.equal((await f.request('/api/sharing/manage')).data.total,0);
 const created=await f.request('/api/sharing/manage',legacy);assert.equal(created.status,200);assert.equal(created.data.id,'fixture-publication-1');assert.equal(created.data.status,'active');assert.equal(created.data.version,1);assert.equal(created.data.slug,'fixture-one-1');
 assert.equal((await f.request('/api/sharing/manage')).status,503);assert.equal((await f.request('/api/sharing/manage')).data.items[0].status,'active');
 const keys=await f.request(`/api/sharing-api/manage/${created.data.id}/keys`,{name:'合成接入',version:1,confirmed:true,budget:1,perRun:1,days:7});assert.equal(keys.status,200);assert.match(keys.data.token,/DEMO_ONLY/);
 assert.equal(f.nativeCalls,0);
});
test('unrelated fixture profile, feature, attachment and task workflows still run entirely in memory',async()=>{
 const f=fixtureHarness();
 assert.equal((await f.request('/api/me/profile',{appearance:{scene:'silver'}},'PATCH')).data.profile.appearance.scene,'silver');
 assert.equal((await f.request('/api/features')).status,200);assert.equal((await f.request('/api/features/writing')).status,200);
 const run=await f.request('/api/features/writing/runs',{confirmed:true,prompt:'只验证合成功能',operationId:'fixture-smoke-run'});assert.equal(run.data.status,'pending');f.flush();assert.equal((await f.request('/api/features/runs/fixture-smoke-run')).data.status,'completed');
 assert.equal((await f.request('/api/features/runs')).data.total,1);
 assert.equal((await f.request('/api/feature-credentials',{endpoint:'https://example.com/demo',auth:'bearer',secret:'DEMO_ONLY'})).status,200);
 assert.equal((await f.request('/api/attachments/fixture-plan/content')).status,200);
 const coordinator=await f.request('/api/coordinator');assert.equal(coordinator.data.tasks.length,3);
 const follow=await f.request('/api/coordinator/tasks/workflow-research/messages',{operationId:'fixture-smoke-followup',text:'补充只属于这件事'});assert.equal(follow.status,200);f.flush();const task=await f.request('/api/coordinator/tasks/workflow-research');assert.ok(task.data.conversation.messages.some((item:any)=>item.content==='补充只属于这件事'));
 assert.equal((await f.request('/api/unknown-fixture-route')).status,404);assert.equal(f.nativeCalls,0);assert.ok(f.log.every((row:any)=>row.scope==='synthetic'));
});
test('synthetic onboarding follows the actual begin/step/finish contract with no model or device side effects',async()=>{
 const f=fixtureHarness(),endpoint='/api/me/profile/onboarding';
 const initial=await f.request('/api/me/profile');assert.equal(initial.data.handbookOffer.available,false);assert.deepEqual(initial.data.welcomeContext.platforms,[]);
 assert.equal((await f.request(endpoint,{action:'begin',launchId:'bad'})).status,400);
 const begin=await f.request(endpoint,{action:'begin',launchId:'fixture-launch-123456789',experience:4});assert.equal(begin.status,200);
 const journey=begin.data.profile.onboarding.journey;assert.equal(journey.stage,'name');assert.equal(journey.version,2);
 assert.equal((await f.request(endpoint,{action:'begin',launchId:'fixture-launch-123456789',experience:4})).data.profile.onboarding.journey.id,journey.id);
 assert.equal((await f.request(endpoint,{action:'step',journeyId:'foreign',step:'name',choice:'skipped'})).status,409);
 assert.equal((await f.request(endpoint,{action:'step',journeyId:journey.id,step:'knowledge',choice:'skipped'})).status,409);
 const step=(step:string,choice:string,extra={})=>f.request(endpoint,{action:'step',journeyId:journey.id,step,choice,...extra});
 assert.equal((await step('name','provided',{displayName:'本地测试'})).data.profile.displayName,'本地测试');
 assert.equal((await step('knowledge','connected')).status,409);assert.equal((await step('knowledge','skipped')).data.profile.onboarding.journey.stage,'device');
 assert.equal((await step('device','checked')).data.profile.onboarding.journey.local.executorReady,false);
 assert.equal((await step('features','purposes',{purposeIds:['writing','work','files']})).status,400);
 assert.equal((await step('features','purposes',{purposeIds:['writing','files'],experience:4,createGuide:false})).data.profile.onboarding.journey.stage,'ready');
 assert.equal((await f.request(endpoint,{action:'finish',journeyId:journey.id,createGuide:true,budgetPower:.5})).status,400);
 const finish=await f.request(endpoint,{action:'finish',journeyId:journey.id,choice:'without_image',createGuide:false});assert.equal(finish.status,200);assert.equal(finish.data.profile.onboarding.journey.stage,'complete');assert.equal(finish.data.profile.onboarding.handbook.status,'skipped');assert.equal(finish.data.profile.onboarding.handbook.maxPower,0);assert.equal(finish.data.welcomeDelivery,undefined);
 assert.equal((await f.request(endpoint,{action:'finish',journeyId:journey.id,choice:'without_image',createGuide:false})).data.profile.onboarding.journey.events.length,5);
 assert.equal((await f.request('/api/features/runs')).data.total,0);assert.equal(f.nativeCalls,0);assert.ok(f.log.every((row:any)=>row.scope==='synthetic'));
});
test('a transient guide launch error can retry using the same safe local contract',async()=>{
 const f=fixtureHarness('guideFailBegin=1'),endpoint='/api/me/profile/onboarding',body={action:'begin',launchId:'fixture-retry-123456789',experience:4};
 assert.equal((await f.request(endpoint,body)).status,503);const retry=await f.request(endpoint,body);assert.equal(retry.status,200);assert.equal(retry.data.profile.onboarding.journey.stage,'name');assert.equal(f.nativeCalls,0);
});


test('UX audit settings stay synthetic with exact authorization and writing routes',async()=>{
 const f=fixtureHarness('uxAudit=1&realService=1');
 assert.equal(f.mode,'synthetic');
 assert.ok((await f.request('/api/me/executor')).data.installedVersion);
 assert.equal((await f.request('/api/me/local-device')).data.targetName,'ONE 演示工作区');
 assert.equal((await f.request('/api/knowledge/connections/notion')).data.connection.status,'connected');
 const writing=await f.request('/api/knowledge/connections/notion/writing');assert.equal(writing.data.ready,true);assert.deepEqual(writing.data.referenceIds,[]);
 const oauth=await f.request('/api/knowledge/connections/notion/oauth/start',{});assert.equal(oauth.status,409);assert.equal(oauth.data.authorizationUrl,undefined);
 assert.equal((await f.request('/api/knowledge/connections/notion/unknown')).status,404);
 await f.request('/api/me/context-preferences',{timeZone:'Asia/Shanghai',city:'合成城市'});
 assert.equal((await f.request('/api/me/context-preferences')).data.saved.city,'合成城市');
 const attention=await f.request('/api/attention');assert.equal(attention.data.sources.length,1);
 const saved=await f.request('/api/attention/settings',{enabled:true,sourceIds:['fixture-notion'],topics:['合成主题'],intervalHours:6,dailyLimit:4,quietStart:22,quietEnd:8,timeZone:'Asia/Shanghai'});assert.equal(saved.data.settings.enabled,true);
 assert.equal((await f.request('/api/me/membership')).data.active.remainingPercent,68);
 assert.equal((await f.request('/api/me/billing/history?kind=usage&page=1')).data.items.length,2);
 assert.equal((await f.request('/api/me/payments/wechat',{productId:'fixture-standard-1'})).status,409);
 const coordinator=await f.request('/api/coordinator'),report=coordinator.data.conversation.messages.find((message:any)=>message.id==='report_fixture-ux-audit');
 assert.match(report.content,/：已完成。.+\n\[查看这件事\]\(\/\?task=/);
 assert.equal(coordinator.data.links.filter((link:any)=>link.messageId===report.id).length,3);
 assert.equal(f.nativeCalls,0);
});
test('UX audit empty and offline devices, and management roles need no real service',async()=>{
 const empty=fixtureHarness('uxAudit=1&auditDevice=empty&auditKnowledge=empty');
 assert.equal((await empty.request('/api/me/executor')).data.installedVersion,undefined);
 assert.equal((await empty.request('/api/attention')).data.sources.length,0);
 assert.equal((await empty.request('/api/attention/settings',{enabled:true,sourceIds:[],topics:[]})).status,400);
 const offline=fixtureHarness('uxAudit=1&auditDevice=offline');assert.equal((await offline.request('/api/me/executor')).status,503);
 const admin=fixtureHarness('uxAudit=1&auditRole=admin');assert.equal((await admin.request('/api/me')).data.user.role,'admin');
 for(const path of ['/api/admin/users','/api/admin/models','/api/admin/one-keys','/api/admin/operations','/api/admin/context-traces','/api/admin/product-metrics'])assert.equal((await admin.request(path)).status,200);
 assert.equal((await admin.request('/api/admin/users',{username:'never-create'})).status,409);
 const company=fixtureHarness('uxAudit=1&auditRole=company');assert.equal((await company.request('/api/me')).data.user.access.role,'company_admin');assert.equal((await company.request('/api/company')).data.members.length,2);
 assert.equal(admin.nativeCalls+company.nativeCalls+empty.nativeCalls+offline.nativeCalls,0);
});

test('status audit entry imports its fixture and stays synthetic even when a real service is requested',async()=>{
 const f=fixtureHarness('statusAudit=1&realService=1&taskCount=5&taskState=needs_input');
 assert.equal(f.mode,'synthetic');
 const snapshot=(await f.request('/api/coordinator')).data;
 assert.equal(snapshot.tasks.length,5);
 assert.equal(snapshot.notices.length,5);
 assert.ok(snapshot.notices.every((notice:any)=>notice.outcome==='needs_input'));
 const receipt=(await f.request('/api/coordinator/messages/'+snapshot.pendingOperationId)).data;
 assert.equal(receipt.status,'pending');
 assert.equal(receipt.progress.phase,'正在查找已授权知识库');
 assert.ok(Date.now()-Date.parse(receipt.progress.startedAt)>=65000);
 assert.equal((await f.request('/api/coordinator/messages',{text:'Do not start'})).status,409);
 assert.equal((await f.request('/api/executions/from-input',{content:'Do not execute'})).status,409);
 const unavailable=fixtureHarness('statusAudit=1&statusCase=unavailable');
 assert.equal((await unavailable.request('/api/executions')).status,503);
 assert.equal((await unavailable.request('/api/me/local-device')).status,200);
 assert.equal(f.nativeCalls+unavailable.nativeCalls,0);
 assert.ok([...f.log,...unavailable.log].every((row:any)=>row.scope==='synthetic'));
});

test('startup audit holds its first snapshot, fails visibly, then recovers without real service calls',async()=>{
 const f=fixtureHarness('startupAudit=1&startupDelay=2500&startupFailures=1&realService=1');
 let settled=false;
 const first=f.request('/api/coordinator?page=1').then(response=>{settled=true;return response;});
 await Promise.resolve();assert.equal(settled,false,'a delayed first read must be reproducible before any snapshot exists');
 f.flush();
 const failed=await first;assert.equal(failed.status,503);assert.match(failed.data.error,/重新连接/);
 const recovered=await f.request('/api/coordinator?page=1');
 assert.equal(recovered.status,200);assert.equal(recovered.data.enabled,true);
 assert.equal(recovered.data.conversation.userId,'preview');
 assert.equal(f.mode,'synthetic');assert.equal(f.nativeCalls,0);
 assert.ok(f.log.every((row:any)=>row.scope==='synthetic'));
});

test('startup audit covers explicit disabled and actual launcher fragment redemption for admin/company roles',async()=>{
 const disabled=fixtureHarness('startupAudit=1&startupDisabled=1');
 assert.equal((await disabled.request('/api/coordinator')).data.enabled,false);
 for(const role of ['admin','company']){
  const f=fixtureHarness(`startupAudit=1&startupRole=${role}`);
  assert.equal((await f.request('/api/auth/one-key/redeem',{loginCode:'not-a-real-code'})).status,400);
  const authenticated=await f.request('/api/auth/one-key/redeem',{loginCode:'fixture-startup-code'});
  assert.equal(authenticated.status,200);
  if(role==='admin'){
   assert.equal(authenticated.data.user.role,'admin');
   assert.equal((await f.request('/api/admin/users')).status,200);
  }else{
   assert.equal(authenticated.data.access.role,'company_admin','match real auth response access instead of hiding it inside user');
   assert.equal((await f.request('/api/me')).data.access.role,'company_admin');
   assert.equal((await f.request('/api/company')).status,200);
  }
  assert.equal(f.nativeCalls,0);
 }
});

test('delayed synthetic stop keeps pending state until the actual handler settles, including rejection',async()=>{
 for(const variant of ['waiting','stop-rejected']){
  const f=fixtureHarness(`statusAudit=1&statusCase=${variant}&statusStopDelay=3000`);
  const snapshot=(await f.request('/api/coordinator')).data,operation=snapshot.pendingOperationId;
  let settled=false;
  const stop=f.request(`/api/coordinator/messages/${operation}/stop`,{}).then(response=>{settled=true;return response;});
  await Promise.resolve();assert.equal(settled,false);
  assert.equal((await f.request(`/api/coordinator/messages/${operation}`)).data.status,'pending','polling must not settle before delayed stop handler runs');
  assert.equal((await f.request('/api/coordinator')).data.pendingOperationId,operation);
  f.flush();
  const response=await stop;
  assert.equal(response.status,variant==='waiting'?200:503);
  assert.equal((await f.request(`/api/coordinator/messages/${operation}`)).data.status,variant==='waiting'?'interrupted':'pending');
  assert.equal(f.nativeCalls,0);
 }
});

test('the public UX preview uses only explicit synthetic requests and idempotent mock questions',async()=>{
 const source=fs.readFileSync(new URL('../output/playwright/public-sharing-preview.tsx',import.meta.url),'utf8').split('\n').filter(line=>!line.startsWith('import ')).join('\n');
 const window:{fetch?:any}={},document={documentElement:{dataset:{}},getElementById:()=>({})};
 const sandbox={window,document,location:{origin:'http://127.0.0.1:5346'},URL,Response,Request,Headers,Date,JSON,createElement:()=>null,createRoot:()=>({render(){}}),PublicSharingPage(){}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,sandbox);
 const request=async(path:string,body?:unknown)=>{const r=await window.fetch(path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.headers.get('X-ONE-Preview'),'synthetic');return {status:r.status,data:await r.json()};};
 const base='/api/sharing/fixture-ux-public';
 assert.equal((await request(base)).data.requireLogin,false);
 assert.equal((await request('https://example.com/anywhere')).status,403);
 assert.equal((await request('/api/visitors/login',{username:'not-a-real-account',password:'never-sent'})).status,409);
 assert.equal((await request('/api/me/payments/wechat',{})).status,409);
 const question={operationId:'fixture-question-1',content:'合成问题'};
 assert.equal((await request(base+'/questions',question)).status,200);
 assert.equal((await request(base+'/questions',question)).status,200);
 const session=await request(base+'/session');assert.equal(session.data.total,1);assert.equal(session.data.items[0].chargedMicros,0);
 assert.equal((await request(base+'/uploads',{})).status,409);
});
