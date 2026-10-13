import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { availableFeature, executeFeatureRun, featureRunResult, releaseFeature, retryFeatureRun, startFeatureRun } from "./featureRuns.js";
import { ModelRequestError } from './modelGateway.js';
import { installFeatureRunRoutes } from "./featureRunRoutes.js";
import { installOfficialFeatureRoutes } from "./officialFeatureRoutes.js";
import { requireRole } from "./middleware.js";
import { FeatureConfigError, updateOfficialFeature } from "./officialFeatures.js";
import { reconcileInterruptedChatOperations } from "./chatOperations.js";
import type { Database } from "./types.js";
import type { Store } from "./db.js";
import { featureBudgetPolicy, saveFeatureBudgetPolicy, requireFeatureApproval } from './featurePricing.js';

test('feature approval threshold is strict, workspace-bound and pins publication rate; rejection creates no usage',async()=>{
  const f=fixture();const scope=f.scope;
  assert.equal(featureBudgetPolicy(f.db(),scope),2);
  saveFeatureBudgetPolicy(f.db(),scope,1);
  assert.equal(featureBudgetPolicy(f.db(),{workspaceId:'wb',userId:'a'}),2);
  const price={id:'research',name:'研究助手',releaseId:f.body.releaseId,version:1,multiplier:1};
  requireFeatureApproval(f.db(),scope,[price],[]);
  assert.throws(()=>requireFeatureApproval(f.db(),scope,[{...price,multiplier:1.2}],[]),/尚未执行/);
  assert.throws(()=>requireFeatureApproval(f.db(),scope,[{...price,multiplier:1.2}],[{...price,multiplier:1.2,releaseId:'old'}]),/尚未执行/);
  requireFeatureApproval(f.db(),scope,[{...price,multiplier:1.2}],[{...price,multiplier:1.2}]);
  saveFeatureBudgetPolicy(f.db(),scope,.5);
  await assert.rejects(startFeatureRun(f.store,scope,'research',f.body,async()=>{}),/超过/);
  assert.equal(f.db().modelUsageRecords.length,0);assert.equal(f.db().chatOperations?.length,0);
  await startFeatureRun(f.store,scope,'research',{...f.body,featureApprovals:[{...price,multiplier:.6}]},async()=>{});
  assert.equal(f.db().chatOperations![0].featureRun!.price!.multiplier,.6);
});

test('feature default 0.6 is billed once; retry and unrelated tenant do not incur charges',async()=>{
  const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>done});
  assert.equal(f.db().modelUsageRecords[0].chargedMicros,24);
  assert.equal(f.db().modelUsageRecords[0].featurePriceSnapshot?.multiplier,.6);
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>{assert.fail('no duplicate model call');}});
  assert.equal(f.db().powerLedger.length,1);assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);
});

const usage={inputTokens:10,outputTokens:5,totalTokens:15,source:'provider' as const};
const done={content:'本人资料结果',toolCalls:[],usage,finishReason:'stop' as const};
function fixture(){
  const values={name:'研究助手',author:'ONE',description:'使用个人资料',instructions:'根据工具结果回答',limitations:'只读',integration:'question_answer' as const,modelId:'model',knowledgeMode:'optional' as const,tools:[]};
  let db={users:[{id:'a',username:'甲',role:'user',enabled:true},{id:'b',username:'乙',role:'admin',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],models:[{id:'model',name:'测试模型',kind:'chat',enabled:true,apiKey:'synthetic',systemPrompt:'safe',inputPowerPerMillion:2,outputPowerPerMillion:4,costInputPowerPerMillion:1,costOutputPowerPerMillion:2}],knowledgeConnections:[{id:'ka',workspaceId:'wa',provider:'notion',status:'connected',providerUserId:'remote-a'},{id:'kb',workspaceId:'wb',provider:'notion',status:'connected',providerUserId:'remote-b'}],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'pa',workspaceId:'wa',userId:'a',balanceMicros:1000000},{id:'pb',workspaceId:'wb',userId:'b',balanceMicros:1000000}],conversations:[],messages:[],contextTraces:[],chatOperations:[],auditLogs:[],settings:{safetyRules:'safe',officialFeatures:[{id:'research',revision:1,status:'approved',draft:values,current:{version:1,values,evidence:'test',approvedBy:'b',approvedAt:'t'},history:[{version:1,values,evidence:'test',approvedBy:'b',approvedAt:'t'}]}]}} as unknown as Database;
  let queue:Promise<unknown>=Promise.resolve();
  const store:Store={read:async()=>db,mutate:fn=>{const p=queue.then(()=>{const before=structuredClone(db);try{return fn(db);}catch(e){db=before;throw e;}});queue=p.catch(()=>undefined);return p;}};
  releaseFeature(db,'research',{action:'publish',revision:1,version:1,userIds:['a'],confirmed:true},'b');
  return {store,db:()=>db,scope:{workspaceId:'wa',userId:'a'},body:{releaseId:db.settings.officialFeatures![0].release!.id,prompt:'查我的资料',sourceIds:['ka'],budget:.1,confirmed:true,operationId:'operation_1234567890'}};
}
const noKnowledge={recallWithDiagnostics:async()=>{assert.fail('unexpected knowledge access');}};
test('direct feature failures preserve safe model cause, input and usage, but not raw errors',async()=>{
  for (const failure of [new ModelRequestError(408,'等待模型回复超时（150 秒）'),new Error('upstream leaked-secret=should-not-be-visible')]) {
    const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});
    await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>{throw failure;}});
    const receipt=featureRunResult(f.db(),f.scope,f.body.operationId);
    assert.equal(receipt.status,'failed');assert.equal(receipt.prompt,f.body.prompt);assert.equal(receipt.recovery?.allowed,true);
    if(failure instanceof ModelRequestError)assert.match(receipt.error??'',/408.*150 秒/);
    else assert.doesNotMatch(JSON.stringify(receipt),/leaked-secret|should-not-be-visible/);
    assert.equal(receipt.charges?.length,1);assert.equal(f.db().chatOperations!.length,1);
  }
});
test('explicit retry keeps saved input and attachments, uses current release and bills one child despite concurrent clicks',async()=>{
  const f=fixture();f.db().attachments=[{id:'source-file',...f.scope,originalName:'资料.txt',mimeType:'text/plain',kind:'document',storagePath:'/synthetic/source',size:3,extractedText:'只用原附件',status:'ready',createdAt:'t'}];
  await startFeatureRun(f.store,f.scope,'research',{...f.body,attachmentIds:['source-file']},async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>{throw new ModelRequestError(400,'模型参数不兼容');}});
  const original=structuredClone(f.db().conversations[0]),firstOperation=structuredClone(f.db().chatOperations![0]);
  const record=f.db().settings.officialFeatures![0],values={...record.current!.values,modelId:'new-model'};
  f.db().models.push({...f.db().models[0],id:'new-model'});
  record.history.push({...record.current!,version:2,values});record.current=record.history.at(-1)!;
  releaseFeature(f.db(),'research',{action:'publish',revision:record.revision,version:2,userIds:['a'],confirmed:true},'b');
  await assert.rejects(retryFeatureRun(f.store,f.scope,f.body.operationId,{budget:.1},async()=>{}),/确认/);
  await assert.rejects(retryFeatureRun(f.store,f.scope,f.body.operationId,{confirmed:true,budget:.1,releaseId:f.body.releaseId},async()=>{}),/配置已更新/);
  const body={confirmed:true,budget:.1,releaseId:record.release!.id,prompt:'tampered',attachmentIds:['foreign'],sourceIds:['kb'],operationId:'forged_operation_id'};
  const results=await Promise.all([retryFeatureRun(f.store,f.scope,f.body.operationId,body,async()=>{}),retryFeatureRun(f.store,f.scope,f.body.operationId,body,async()=>{})]);
  assert.equal(results.filter(r=>r.created).length,1);assert.equal(results[0].result.operationId,results[1].result.operationId);
  const retryId=results[0].result.operationId,next=f.db().chatOperations!.find(o=>o.operationId===retryId)!;
  assert.equal(next.featureRun!.retryOf,f.body.operationId);assert.equal(next.featureRun!.version,2);
  assert.equal(results[0].result.prompt,f.body.prompt);
  const nextConversation=f.db().conversations.find(c=>c.id===next.conversationId)!;
  assert.deepEqual(nextConversation.messages[0].attachments?.map(a=>a.id),['source-file']);
  assert.deepEqual(next.featureRun!.sources,firstOperation.featureRun!.sources);
  assert.deepEqual(f.db().conversations[0],original);assert.deepEqual(f.db().chatOperations![0],firstOperation);
  let calls=0;await executeFeatureRun(f.store,f.scope,retryId,async()=>{},noKnowledge,{modelCall:async model=>{calls++;assert.equal(model.id,'new-model');return done;}});
  assert.equal(calls,1);assert.equal(featureRunResult(f.db(),f.scope,retryId).status,'completed');
  assert.equal((await retryFeatureRun(f.store,f.scope,f.body.operationId,body,async()=>{})).created,false);
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).recovery?.operationId,retryId);
  assert.equal(f.db().chatOperations!.length,2);assert.equal(f.db().powerLedger.length,1);
});
test('retry rejects foreign owner, Key loss, changed knowledge binding and newly expanded tools',async()=>{
  const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});reconcileInterruptedChatOperations(f.db());
  const body={confirmed:true,budget:.1};
  await assert.rejects(retryFeatureRun(f.store,{workspaceId:'wb',userId:'b'},f.body.operationId,body,async()=>{}),/不存在/);
  await assert.rejects(retryFeatureRun(f.store,{workspaceId:'wb',userId:'a'},f.body.operationId,body,async()=>{}),/不可用/);
  await assert.rejects(retryFeatureRun(f.store,f.scope,f.body.operationId,body,async()=>{throw new Error('Key absent');}),/Key absent/);
  f.db().knowledgeConnections[0].providerUserId='another-account';
  await assert.rejects(retryFeatureRun(f.store,f.scope,f.body.operationId,body,async()=>{}),/知识授权已变化/);
  f.db().knowledgeConnections[0].providerUserId='remote-a';
  const record=f.db().settings.officialFeatures![0];record.history.push({...record.current!,version:2,values:{...record.current!.values,tools:[{id:'oneFinance',description:'计算用户给出的费用'}]}});record.current=record.history.at(-1)!;
  releaseFeature(f.db(),'research',{action:'publish',revision:record.revision,version:2,userIds:['a'],confirmed:true},'b');
  await assert.rejects(retryFeatureRun(f.store,f.scope,f.body.operationId,body,async()=>{}),/工具或数据使用范围/);
  assert.equal(f.db().chatOperations!.length,1);assert.equal(f.db().modelUsageRecords.length,0);
});
test('retry validates high multiplier approval for current publication before claiming',async()=>{
  const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});reconcileInterruptedChatOperations(f.db());
  saveFeatureBudgetPolicy(f.db(),f.scope,.5);
  await assert.rejects(retryFeatureRun(f.store,f.scope,f.body.operationId,{confirmed:true,budget:.1,releaseId:f.body.releaseId},async()=>{}),/超过/);
  assert.equal(f.db().chatOperations!.length,1);
  const record=f.db().settings.officialFeatures![0],featureApprovals=[{id:'research',releaseId:record.release!.id,version:1,multiplier:.6}];
  assert.equal((await retryFeatureRun(f.store,f.scope,f.body.operationId,{confirmed:true,budget:.1,releaseId:f.body.releaseId,featureApprovals},async()=>{})).created,true);
});
test('a retry claimed before binding fails can explicitly recover its owned original input once',async()=>{
  const f=fixture();f.db().attachments=[{id:'source-file',...f.scope,originalName:'资料.txt',mimeType:'text/plain',kind:'document',storagePath:'/synthetic/source',size:3,extractedText:'原材料',status:'ready',createdAt:'t'}];
  await startFeatureRun(f.store,f.scope,'research',{...f.body,attachmentIds:['source-file']},async()=>{});reconcileInterruptedChatOperations(f.db());
  const originalConversation=structuredClone(f.db().conversations[0]),release=f.db().settings.officialFeatures![0].release!;
  let mutations=0;
  const interruptedStore:Store={read:f.store.read,mutate:fn=>{
    mutations++;
    if(mutations===2){delete f.db().settings.officialFeatures![0].release;return Promise.reject(new FeatureConfigError('功能授权在创建对话前发生变化',403));}
    return f.store.mutate(fn);
  }};
  const body={confirmed:true,budget:.1,releaseId:release.id};
  await assert.rejects(retryFeatureRun(interruptedStore,f.scope,f.body.operationId,body,async()=>{}),/创建对话前/);
  assert.equal(f.db().chatOperations!.length,2);
  const child=f.db().chatOperations![1];assert.equal(child.status,'failed');assert.equal(child.conversationId,undefined);
  assert.equal(child.featureRun!.retryOf,f.body.operationId);assert.equal(f.db().modelUsageRecords.length,0);
  f.db().settings.officialFeatures![0].release=release;
  f.db().contextTraces.push({id:'unrelated-unbound-trace',...f.scope,responsePreview:'别的请求错误'} as any);
  assert.equal(featureRunResult(f.db(),f.scope,child.operationId).recovery?.allowed,true);
  assert.equal(featureRunResult(f.db(),f.scope,child.operationId).prompt,f.body.prompt);
  assert.doesNotMatch(featureRunResult(f.db(),f.scope,child.operationId).error??'',/别的请求/);
  const retried=await retryFeatureRun(f.store,f.scope,child.operationId,body,async()=>{});
  const grandchild=f.db().chatOperations!.find(o=>o.operationId===retried.result.operationId)!;
  const conversation=f.db().conversations.find(c=>c.id===grandchild.conversationId)!;
  assert.equal(retried.result.prompt,f.body.prompt);assert.deepEqual(conversation.messages[0].attachments?.map(a=>a.id),['source-file']);
  assert.deepEqual(f.db().conversations[0],originalConversation);assert.equal(child.status,'failed');
  assert.equal((await retryFeatureRun(f.store,f.scope,child.operationId,body,async()=>{})).created,false);
  let calls=0;await executeFeatureRun(f.store,f.scope,retried.result.operationId,async()=>{},noKnowledge,{modelCall:async()=>{calls++;return done;}});
  assert.equal(calls,1);assert.equal(f.db().chatOperations!.length,3);assert.equal(f.db().modelUsageRecords.length,1);
});
test('retry input fallback rejects foreign ancestry, cycles and a deleted bound conversation',async()=>{
  for(const reason of ['foreign','cycle','deleted']){
    const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});reconcileInterruptedChatOperations(f.db());
    const root=f.db().chatOperations![0];
    if(reason==='deleted')f.db().conversations=[];
    else{
      const child={...structuredClone(root),id:'child_record',operationId:'child_operation_12345',conversationId:undefined,featureRun:{...root.featureRun!,retryOf:reason==='cycle'?'child_operation_12345':root.operationId}};
      if(reason==='foreign')root.workspaceId='wb';
      f.db().chatOperations!.push(child);
    }
    const source=f.db().chatOperations!.at(-1)!;
    assert.equal(featureRunResult(f.db(),f.scope,source.operationId).recovery?.allowed,false);
    await assert.rejects(retryFeatureRun(f.store,f.scope,source.operationId,{confirmed:true,budget:.1,releaseId:f.body.releaseId},async()=>{}),/材料已移除/);
    assert.equal(f.db().modelUsageRecords.length,0);
  }
});
test('legacy option-bearing input is recovered exactly; image and produced artifacts require review rather than retry',async()=>{
  const f=fixture(),record=f.db().settings.officialFeatures![0];record.history[0].values.experience={inputs:[],actions:[{id:'make',label:'生成',instruction:'仅输出文字'}]};
  const prompt='用户原话\n\n本次选择：这也是用户自己的内容';
  await startFeatureRun(f.store,f.scope,'research',{...f.body,prompt},async()=>{});reconcileInterruptedChatOperations(f.db());
  delete f.db().chatOperations![0].featureRun!.inputPrompt;
  const r=await retryFeatureRun(f.store,f.scope,f.body.operationId,{confirmed:true,budget:.1,releaseId:f.body.releaseId},async()=>{});
  assert.equal(f.db().chatOperations!.find(o=>o.operationId===r.result.operationId)!.featureRun!.inputPrompt,prompt);
  assert.equal(r.result.prompt,f.db().conversations[0].messages[0].content);
  for(const reason of ['image','artifact']){
    const g=fixture();await startFeatureRun(g.store,g.scope,'research',g.body,async()=>{});reconcileInterruptedChatOperations(g.db());
    if(reason==='image')g.db().settings.officialFeatures![0].history[0].values.experience={mode:'image',inputs:[],actions:[{id:'draw',label:'画图',instruction:'画图'}]};
    else g.db().attachments=[{id:'output',...g.scope,conversationId:g.db().chatOperations![0].conversationId} as any];
    const receipt=featureRunResult(g.db(),g.scope,g.body.operationId);
    assert.equal(receipt.recovery?.allowed,false);assert.match(receipt.recovery?.reason??'',reason==='image'?/图片.*检查/:/成果文件.*核对/);
    await assert.rejects(retryFeatureRun(g.store,g.scope,g.body.operationId,{confirmed:true,budget:.1},async()=>{}));assert.equal(g.db().chatOperations!.length,1);
  }
});
test('late runner failure cannot overwrite an interrupted terminal receipt',async()=>{
  const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>{
    reconcileInterruptedChatOperations(f.db());throw new ModelRequestError(503,'late failure');
  }});
  const receipt=featureRunResult(f.db(),f.scope,f.body.operationId);
  assert.equal(receipt.status,'interrupted');assert.doesNotMatch(receipt.error??'',/late failure/);assert.equal(f.db().contextTraces.length,0);
});
test('HTTP retry needs Key and owner, ignores client input substitution and returns the same receipt after a lost response',async t=>{
  const f=fixture();await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});reconcileInterruptedChatOperations(f.db());
  const app=express();app.use(express.json());let calls=0;
  installFeatureRunRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}const b=req.headers['x-account']==='b';req.user={id:b?'b':'a'} as any;req.workspaceId=b?'wb':'wa';next();}],f.store,async()=>{},noKnowledge,{modelCall:async()=>{calls++;return done;}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}/api/features/runs`,url=`${base}/${f.body.operationId}/retry`,headers={'x-key':'present','content-type':'application/json'},body=JSON.stringify({confirmed:true,budget:.1,releaseId:f.body.releaseId,prompt:'forged unrelated input',workspaceId:'wb',userId:'b'});
  assert.equal((await fetch(url,{method:'POST',body,headers:{'content-type':'application/json'}})).status,428);
  assert.equal((await fetch(url,{method:'POST',body,headers:{...headers,'x-account':'b'}})).status,404);
  const created=await fetch(url,{method:'POST',body,headers});assert.equal(created.status,202);const first=await created.json();
  const repeated=await fetch(url,{method:'POST',body,headers});assert.equal(repeated.status,200);assert.equal((await repeated.json()).operationId,first.operationId);
  let receipt;
  for(let i=0;i<30;i++){receipt=await(await fetch(`${base}/${first.operationId}`,{headers})).json();if(receipt.status!=='pending')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(receipt.status,'completed');assert.equal(receipt.prompt,f.body.prompt);assert.equal(calls,1);
  assert.equal(f.db().chatOperations!.length,2);assert.equal(f.db().modelUsageRecords.length,1);assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);
});
test('publication requires approval/admin; immutable released version survives drafts; pause does not auto-resume',()=>{
  const f=fixture(),record=f.db().settings.officialFeatures![0];
  assert.throws(()=>availableFeature(f.db(),{workspaceId:'wb',userId:'b'},'research'));
  assert.throws(()=>releaseFeature(f.db(),'research',{action:'publish',revision:record.revision,version:1,userIds:['a'],confirmed:true},'a'));
  updateOfficialFeature(f.db().settings,'research',{action:'save',revision:record.revision,values:{...record.draft,instructions:'changed',category:'research'}},'b','t');
  assert.equal(availableFeature(f.db(),f.scope,'research').version.values.instructions,'根据工具结果回答');
  assert.equal(availableFeature(f.db(),f.scope,'research').version.values.category,undefined);
  updateOfficialFeature(f.db().settings,'research',{action:'pause',revision:f.db().settings.officialFeatures![0].revision},'b','t');
  assert.throws(()=>availableFeature(f.db(),f.scope,'research'));
  assert.equal(f.db().settings.officialFeatures![0].release,undefined);
});
test('own selected knowledge, trace, payer and result; stable receipt does not execute twice',async()=>{
  const f=fixture();let calls=0,reads=0;
  const start=await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});assert.equal(start.created,true);
  assert.equal((await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{})).created,false);
  await assert.rejects(startFeatureRun(f.store,f.scope,'research',{...f.body,prompt:'different'},async()=>{}),/同一提交标识/);
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{}, {recallWithDiagnostics:async(w,q,k,ids)=>{reads++;assert.equal(w,'wa');assert.deepEqual(ids,['ka']);return {chunks:[{title:'我的资料',content:'仅甲可见'}],failures:[],status:'used'};}}, {modelCall:async(_m,messages,tools)=>{
    calls++;assert.equal(tools[0].function.name,'knowledge_search');
    if(calls===1)return {...done,content:'',toolCalls:[{id:'k',type:'function',function:{name:'knowledge_search',arguments:'{"query":"相关资料"}'}}]};
    assert.match(JSON.stringify(messages),/仅甲可见/);return done;
  }});
  const result=featureRunResult(f.db(),f.scope,f.body.operationId);assert.equal(result.status,'completed');assert.equal(result.trace?.length,1);assert.equal(result.charges?.length,2);assert.equal(reads,1);
  assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);assert.equal(f.db().modelUsageRecords.every(u=>u.userId==='a'&&u.workspaceId==='wa'),true);
  assert.throws(()=>featureRunResult(f.db(),{workspaceId:'wb',userId:'b'},f.body.operationId));
  assert.throws(()=>featureRunResult(f.db(),{workspaceId:'wb',userId:'a'},f.body.operationId));
  assert.equal((await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{})).created,false);assert.equal(calls,2);
  assert.doesNotMatch(JSON.stringify(f.db().settings),/仅甲可见|remote-a|查我的资料/);
  assert.doesNotMatch(JSON.stringify(f.db().auditLogs),/仅甲可见|查我的资料/);
});
test('no implicit knowledge, foreign source rejection, budget and Key denial before calls',async()=>{
  let f=fixture();await assert.rejects(startFeatureRun(f.store,f.scope,'research',{...f.body,sourceIds:['kb']},async()=>{}),/不属于你/);
  await assert.rejects(startFeatureRun(f.store,f.scope,'research',f.body,async()=>{throw new Error('Key absent');}));assert.equal(f.db().chatOperations!.length,0);
  await startFeatureRun(f.store,f.scope,'research',{...f.body,sourceIds:[],budget:.001},async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async()=>{assert.fail('budget bypass');}});
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'failed');assert.equal(f.db().modelUsageRecords.length,0);
  f=fixture();await startFeatureRun(f.store,f.scope,'research',{...f.body,sourceIds:[]},async()=>{});
  await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{},noKnowledge,{modelCall:async(_m,_messages,tools)=>{assert.equal(tools.length,0);return done;}});
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'completed');
});
test('revocation, republish, unpublish, account switch and Key removal stop subsequent calls',async()=>{
  for(const change of ['revoked','switch','unpublish','republish','key']){
    const f=fixture();let calls=0,key=true;
    await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{});
    await executeFeatureRun(f.store,f.scope,f.body.operationId,async()=>{if(!key)throw new Error('Key absent');},noKnowledge,{modelCall:async()=>{
      calls++;await f.store.mutate(db=>{
        if(change==='revoked')db.knowledgeConnections[0].status='revoked';
        if(change==='switch')db.knowledgeConnections[0].providerUserId='other';
        const r=db.settings.officialFeatures![0];
        if(change==='unpublish')releaseFeature(db,'research',{action:'unpublish',revision:r.revision},'b');
        if(change==='republish')releaseFeature(db,'research',{action:'publish',revision:r.revision,version:1,userIds:['a'],confirmed:true},'b');
        if(change==='key')key=false;
      });return {...done,content:'',toolCalls:[{id:'k',type:'function',function:{name:'knowledge_search',arguments:'{"query":"相关资料"}'}}]};
    }});
    assert.equal(calls,1);assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'failed');assert.equal(f.db().modelUsageRecords.length,1);
  }
});
test('concurrent distinct requests have one claimant; restart interrupts without auto replay',async()=>{
  const f=fixture();const attempts=await Promise.allSettled([startFeatureRun(f.store,f.scope,'research',f.body,async()=>{}),startFeatureRun(f.store,f.scope,'research',{...f.body,operationId:'operation_9876543210'},async()=>{})]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  reconcileInterruptedChatOperations(f.db());
  assert.equal(featureRunResult(f.db(),f.scope,f.body.operationId).status,'interrupted');
  assert.equal((await startFeatureRun(f.store,f.scope,'research',f.body,async()=>{})).created,false);
});
test('HTTP consumer routes require Key, separate recipients and hide definitions; async receipt survives refresh',async t=>{
  const f=fixture();const app=express();app.use(express.json());
  installFeatureRunRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}const b=req.headers['x-account']==='b';req.user={id:b?'b':'a'} as any;req.workspaceId=b?'wb':'wa';next();}],f.store,async()=>{},noKnowledge,{modelCall:async()=>done});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/features`,headers={'x-key':'present','content-type':'application/json'};
  for(const path of ['', '/runs','/research','/runs/'+f.body.operationId])assert.equal((await fetch(url+path)).status,428);
  const list=await(await fetch(url,{headers})).json();assert.equal(list.items.length,1);assert.equal(list.items[0].instructions,undefined);assert.equal(list.items[0].userIds,undefined);
  assert.equal(list.items[0].usageMultiplier,.6);
  assert.equal((await fetch(url+'/budget-policy')).status,428);
  assert.equal((await fetch(url+'/budget-policy',{method:'POST',headers,body:JSON.stringify({approvalThreshold:.5,workspaceId:'wb',userId:'b'})})).status,200);
  assert.equal((await(await fetch(url+'/budget-policy',{headers})).json()).approvalThreshold,.5);
  assert.equal((await(await fetch(url+'/budget-policy',{headers:{...headers,'x-account':'b'}})).json()).approvalThreshold,2);
  assert.equal((await fetch(url+'/budget-policy',{method:'POST',headers,body:JSON.stringify({approvalThreshold:-1})})).status,400);
  const quote=await(await fetch(url+'/quote',{method:'POST',headers,body:JSON.stringify({featureIds:['research']})})).json();assert.equal(quote.features[0].multiplier,.6);
  assert.equal((await fetch(url+'/quote',{method:'POST',headers:{...headers,'x-account':'b'},body:JSON.stringify({featureIds:['research']})})).status,403);
  assert.equal((await fetch(url+'/quote',{method:'POST',headers,body:JSON.stringify({featureIds:[],taskId:'foreign'})})).status,403);
  await fetch(url+'/budget-policy',{method:'POST',headers,body:JSON.stringify({approvalThreshold:2})});
  assert.equal((await(await fetch(url+'?category=general',{headers})).json()).items.length,1);
  assert.equal((await(await fetch(url+'?category=research',{headers})).json()).items.length,0);
  assert.equal((await fetch(url+'?category=unreviewed',{headers})).status,400);
  assert.equal((await(await fetch(url+'?category=general',{headers:{...headers,'x-account':'b'}})).json()).items.length,0);
  assert.equal((await(await fetch(url,{headers:{...headers,'x-account':'b'}})).json()).items.length,0);
  assert.equal((await fetch(url+'/research',{headers:{...headers,'x-account':'b'}})).status,403);
  const body=JSON.stringify({...f.body,sourceIds:[],workspaceId:'wb',userId:'b'});
  assert.equal((await fetch(url+'/research/runs',{method:'POST',body,headers})).status,202);
  for(let i=0;i<30;i++){const r=await(await fetch(url+'/runs/'+f.body.operationId,{headers})).json();if(r.status!=='pending')break;await new Promise(resolve=>setTimeout(resolve,5));}
  const own=await fetch(url+'/runs/'+f.body.operationId,{headers});assert.equal(own.headers.get('cache-control'),'no-store');assert.equal((await own.json()).status,'completed');
  assert.equal((await fetch(url+'/runs/'+f.body.operationId,{headers:{...headers,'x-account':'b'}})).status,404);
  assert.equal((await(await fetch(url+'/runs?page=2',{headers})).json()).items.length,0);
  assert.equal((await fetch(url+'/research/runs',{method:'POST',body,headers})).status,200);
  assert.equal(f.db().modelUsageRecords.length,1);
});

test('HTTP publishing requires admin and fresh revision; recipients paginate without exposing credentials',async t=>{
  const f=fixture();const app=express();app.use(express.json());
  await f.store.mutate(db=>{for(let i=0;i<12;i++)db.users.push({id:`extra-${i}`,username:`内测${i}`,role:'user',enabled:true,passwordHash:'not-for-browser'} as any);});
  installOfficialFeatureRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}const admin=req.headers['x-account']==='b';req.user={id:admin?'b':'a',role:admin?'admin':'user'} as any;req.workspaceId=admin?'wb':'wa';next();},requireRole('admin')],f.store);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/admin/official-features`,headers={'x-key':'present','x-account':'b','content-type':'application/json'};
  assert.equal((await fetch(url+'/research/release',{method:'POST'})).status,428);
  assert.equal((await fetch(url+'/research/release',{method:'POST',headers:{...headers,'x-account':'a'},body:'{}'})).status,403);
  const recipients=await(await fetch(url+'/recipients?q='+encodeURIComponent('内测')+'&page=2',{headers})).json();assert.equal(recipients.total,12);assert.equal(recipients.items.length,2);assert.doesNotMatch(JSON.stringify(recipients),/password|not-for-browser/);
  const body=JSON.stringify({action:'unpublish',revision:f.db().settings.officialFeatures![0].revision});
  assert.equal((await fetch(url+'/research/release',{method:'POST',headers,body})).status,200);
  assert.equal((await fetch(url+'/research/release',{method:'POST',headers,body})).status,409);
  assert.equal(f.db().settings.officialFeatures![0].release,undefined);
});
