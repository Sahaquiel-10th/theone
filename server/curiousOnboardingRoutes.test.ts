import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express, { type RequestHandler } from 'express';
import type { Store } from './db.js';
import type { Database, ModelConfig } from './types.js';
import { defaultTaskValues } from './aiTaskConfig.js';
import { handbookGuide } from './onboardingHandbook.js';
import { installOnboardingProfileRoutes, type OnboardingProfileDependencies } from './onboardingRoutes.js';
import type { CuriousOnboardingInput, CuriousOnboardingView } from './curiousOnboarding.js';

const scope={workspaceId:'wa',userId:'a'};
async function fixture(t:TestContext){
  const model={id:'model',name:'Model',enabled:true,isDefault:true,kind:'chat',protocol:'openai',apiKey:'PRIVATE_KEY',baseUrl:'https://private.example',model:'test',systemPrompt:'PRIVATE_PROMPT',inputPowerPerMillion:.01,outputPowerPerMillion:.01,costInputPowerPerMillion:.01,costOutputPowerPerMillion:.01} as ModelConfig;
  const db={users:[{id:'a',username:'a',enabled:true,defaultWorkspaceId:'wa',createdAt:'now'},{id:'b',username:'b',enabled:true,defaultWorkspaceId:'wb',createdAt:'now'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a',role:'owner'},{workspaceId:'wb',userId:'b',role:'owner'}],knowledgeConnections:[],models:[model],settings:{aiTasks:{image_generation:{published:{...defaultTaskValues('image_generation'),modelId:'model',imagePowerPerCall:.01,costImagePowerPerCall:.005,version:1}}}},conversations:[],messages:[],chatOperations:[],modelUsageRecords:[],powerAccounts:[{id:'p',...scope,balanceMicros:1000000,reservedMicros:0}],powerLedger:[],publications:[]} as unknown as Database;
  const store:Store={read:async()=>db,mutate:async fn=>fn(db)};let generated=0,queued=0,resumed=0,keyLost=false,serial=0;
  const auth:RequestHandler=(req,res,next)=>{if(req.headers['x-deny']==='yes'){res.status(428).json({error:'Key required'});return;}const index=req.headers['x-owner']==='b'?1:0;req.user=db.users[index];req.workspaceId=db.users[index].defaultWorkspaceId;next();};
  const deps:OnboardingProfileDependencies={storageAvailable:true,verifyKey:async()=>{if(keyLost)throw Object.assign(new Error('Key required'),{status:428});},resume:async()=>{resumed++;},curiousGenerate:async()=>{
    generated++;return {content:'',finishReason:'tool_calls',usage:{inputTokens:10,outputTokens:20,totalTokens:30,source:'provider'},toolCalls:[{id:'q',type:'function',function:{name:'oneCuriousQuestion',arguments:JSON.stringify({understanding:'你提到要讲清楚事情。先区分对象和目的，后面会更顺。',question:'平时更接近哪种情况？',options:[{label:'整理已有材料',reply:'会整理已有材料'},{label:'需要几种方向',reply:'希望先看几种方向'},{label:'边聊边调整',reply:'习惯边聊边调整'}]})}}]};
  },enqueueImage:async(s,input,verify)=>{
    await verify();queued++;assert.deepEqual(s,scope);assert.ok(input.guide?.curiosity);assert.deepEqual(input.guide,handbookGuide(db,s));assert.equal(input.sponsored,true);assert.doesNotMatch(JSON.stringify(input.guide),/PRIVATE_KEY|PRIVATE_PROMPT|receipts|oneCuriousQuestion/);
    db.conversations.push({...scope,id:'guide_task'} as never);db.chatOperations!.push({...scope,id:'accepted',operationId:`${input.operationId}_image`,requestId:'image_req',conversationId:'guide_task',status:'pending',workRun:{kind:'image',state:'queued'}} as never);return 'guide_task';
  }};
  const app=express();app.use(express.json());installOnboardingProfileRoutes(app,[auth],store,deps);
  app.use((error:Error&{status?:number},_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??400).json({error:error.message}));
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');t.after(()=>{listener.closeAllConnections();listener.close();});const address=listener.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/me/profile`,url=base+'/curious-onboarding';
  const post=(body:object,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const act=async(v:CuriousOnboardingView|undefined,action:CuriousOnboardingInput['action'],extra:Partial<CuriousOnboardingInput>={})=>{const response=await post({action,requestId:`http_req_${++serial}`,...(v?.session?{sessionId:v.session.id,revision:v.session.revision}:{}),...extra});assert.equal(response.status,200);return response.json() as Promise<CuriousOnboardingView>;};
  const toKnowledge=async()=>{let v=await act(undefined,'begin');for(const optionId of ['friend','keep_style','teaching','reply_0','reply_1'])v=await act(v,'answer',{optionId});return v;};
  return {db,store,deps,url,base,post,act,toKnowledge,loseKey:()=>{keyLost=true;},stats:()=>({generated,queued,resumed})};
}

test('HTTP completion queues the existing sponsored snapshot pipeline once; refresh is read-only and receipt is not delivery',async t=>{
  const f=await fixture(t);let v=await f.toKnowledge();const final={action:'answer',requestId:'http_finish_once',sessionId:v.session!.id,revision:v.session!.revision,optionId:'later'};
  const responses=await Promise.all([f.post(final),f.post(final)]);for(const r of responses)assert.equal(r.status,200);v=await responses[0].json();
  assert.equal(v.session!.status,'completed');assert.equal(v.welcomeDelivery?.state,'queued');assert.equal(v.welcomeDelivery?.taskId,'guide_task');assert.equal(f.stats().queued,1);assert.equal(f.stats().generated,2);
  assert.equal(f.db.users[0].profile!.onboarding.handbook!.guideSnapshot!.curiosity!.activity.id,'teaching');
  assert.equal(v.profile.onboarding.curious,undefined);assert.equal(v.profile.onboarding.handbook?.guideSnapshot,undefined);
  const next=await fetch(f.url);assert.equal(next.headers.get('cache-control'),'no-store');const get=await next.json();assert.equal(get.welcomeDelivery.state,'queued');assert.equal(f.stats().queued,1);
  await f.post(final);await fetch(f.url);assert.equal(f.stats().queued,1);assert.equal(f.stats().generated,2);
  const normal=await(await fetch(f.base)).json();assert.equal(normal.profile.onboarding.curious,undefined);assert.equal(normal.profile.onboarding.handbook.guideSnapshot,undefined);
});

test('curious routes authorize the live Key and scope and reject forged workspace/operation fields',async t=>{
  const f=await fixture(t),v=await f.act(undefined,'begin');
  assert.equal((await fetch(f.url,{headers:{'x-deny':'yes'}})).status,428);
  const other=await(await fetch(f.url,{headers:{'x-owner':'b'}})).json();assert.equal(other.session,undefined);assert.doesNotMatch(JSON.stringify(other),new RegExp(v.session!.id));
  const foreign=await f.post({action:'answer',requestId:'foreign_click_123',sessionId:v.session!.id,revision:v.session!.revision,optionId:'friend'},{'x-owner':'b'});assert.equal(foreign.status,409);
  assert.equal((await f.post({action:'begin',requestId:'forged_scope_123',workspaceId:'wb'})).status,400);
  f.loseKey();assert.equal((await fetch(f.url)).status,428);assert.equal((await f.post({action:'answer',requestId:'revoked_key_123',sessionId:v.session!.id,revision:v.session!.revision,optionId:'friend'})).status,428);assert.equal(f.stats().generated,0);
});

test('unavailable guide configuration preserves collection completion and never claims successful output',async t=>{
  const f=await fixture(t);f.deps.storageAvailable=false;let v=await f.toKnowledge();v=await f.act(v,'answer',{optionId:'later'});
  assert.equal(v.session!.status,'completed');assert.equal(v.welcomeDelivery?.state,'failed');assert.equal(f.stats().queued,0);assert.equal(v.profile.onboarding.handbook?.reason,'not_configured');assert.ok(v.notice);
  await fetch(f.url);assert.equal(f.stats().queued,0);
});
