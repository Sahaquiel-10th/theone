import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';

/** Executes only the local request fixture, with fake DOM/timers and no native network. */
function fixtureHarness(query='richPreview=1&workflowPreview=1&shareRefreshFailure=1'){
 const nodes=new Map<string,any>(),storage=new Map<string,string>(),timers:Array<()=>void>=[];let nativeCalls=0;
 const element=()=>({id:'',hidden:false,textContent:'',style:{},setAttribute(){},remove(){}});
 const document={documentElement:{dataset:{} as Record<string,string>},body:{append(node:any){nodes.set(node.id,node);}},createElement:element,addEventListener(){},getElementById(id:string){return nodes.get(id);}};
 const window={fetch:async()=>{nativeCalls++;throw Error('The synthetic fixture must not call native fetch');},EventSource:undefined};
 const sandbox={window,document,location:{origin:'http://127.0.0.1:5346',href:`http://127.0.0.1:5346/?${query}`,search:`?${query}`},localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},URL,URLSearchParams,Response,Request,Headers,Event,crypto:{randomUUID},setTimeout:(callback:()=>void)=>{timers.push(callback);return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){},console};
 const source=fs.readFileSync(new URL('../output/playwright/focus-preview.ts',import.meta.url),'utf8').split("await import('/src/main.tsx');")[0];
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
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
