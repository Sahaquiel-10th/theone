import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database,ModelConfig} from './types.js';
import type {Store} from './db.js';
import type {OfficialFeatureValues} from './officialFeatures.js';
import {featureToolEndpoint} from './featureTools.js';
import {runBilledModel} from './modelBilling.js';
import {assertLegacySkillModel,legacySkillContext,legacySkillFeaturePrice,legacySkillKnowledgeScope,legacySkillOperationPayload,legacySkillSelectionInput,legacySkillTools,prepareLegacySkillSelection,requireLegacySkillKnowledge,verifyLegacySkillSelection,LegacySkillSelectionError} from './legacySkillSelection.js';

function fixture(overrides:Partial<OfficialFeatureValues>={}){
  const scope={workspaceId:'wa',userId:'a'};
  const values:OfficialFeatureValues={name:'写作助手',description:'整理用户给出的文字',author:'ONE',instructions:'按用户目标整理文字，保留事实和不确定性。',limitations:'不得编造来源或声称已外发。',integration:'question_answer',modelId:'chat',knowledgeMode:'none',tools:[],usageMultiplier:.6,...overrides};
  const model={id:'chat',name:'测试模型',kind:'chat',enabled:true,apiKey:'synthetic',systemPrompt:'safe',inputPowerPerMillion:2,outputPowerPerMillion:4,costInputPowerPerMillion:1,costOutputPowerPerMillion:2} as ModelConfig;
  const db={users:[{id:'a',enabled:true,role:'user'},{id:'b',enabled:true,role:'admin'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],models:[model],knowledgeConnections:[{id:'ka',workspaceId:'wa',provider:'notion',status:'connected',providerUserId:'remote-a'},{id:'kb',workspaceId:'wb',provider:'notion',status:'connected',providerUserId:'remote-b'}],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'pa',workspaceId:'wa',userId:'a',balanceMicros:1e6},{id:'pb',workspaceId:'wb',userId:'b',balanceMicros:1e6}],conversations:[],messages:[],chatOperations:[],auditLogs:[],settings:{safetyRules:'safe',officialFeatures:[{id:'writer',revision:1,status:'approved',draft:structuredClone(values),history:[{version:1,values,evidence:'synthetic evidence',approvedBy:'b',approvedAt:'now'}],release:{id:'release_writer',version:1,audience:'all',userIds:[],publishedBy:'b',publishedAt:'now'}}]}} as unknown as Database;
  const store={read:async()=>db,mutate:async<T,>(fn:(db:Database)=>T)=>fn(db)} as Store;
  return {db,store,scope,model,values,body:{featureIds:['writer'],featureApprovals:[],confirmedExternal:true}};
}
const fails=(fn:()=>unknown,status:number,code?:string)=>assert.throws(fn,error=>error instanceof LegacySkillSelectionError&&error.status===status&&(!code||error.code===code));

test('legacy selection accepts one ID and projects only approvals and consent, never a browser prompt/tool/price',()=>{
  const f=fixture(),selected=prepareLegacySkillSelection(f.db,f.scope,{...f.body,instructions:'browser-injection',systemPrompt:'browser-system',tools:[{id:'evil'}],multiplier:0});
  assert.match(legacySkillContext(selected),/按用户目标整理文字/);assert.doesNotMatch(legacySkillContext(selected),/browser-injection|browser-system|evil/);assert.deepEqual(legacySkillOperationPayload(selected),f.body);assert.equal(legacySkillFeaturePrice(selected)!.multiplier,.6);
  fails(()=>legacySkillSelectionInput({...f.body,featureIds:['writer','another']}),422);fails(()=>legacySkillSelectionInput({...f.body,featureIds:['writer','writer']}),422);fails(()=>legacySkillSelectionInput({...f.body,featureIds:['../other']}),400);fails(()=>legacySkillSelectionInput({...f.body,confirmedExternal:'yes'}),400);
  fails(()=>prepareLegacySkillSelection(f.db,f.scope,{...f.body,confirmedExternal:false}),400,'LEGACY_SKILL_CONSENT');
  const ordinary=prepareLegacySkillSelection(f.db,f.scope,{content:'普通聊天'});assert.deepEqual(legacySkillOperationPayload(ordinary),{});assert.equal(legacySkillContext(ordinary),'');assert.equal(legacySkillFeaturePrice(ordinary),undefined);
});
test('snapshot is fixed while live release/config revocation is rechecked before use',()=>{
  const f=fixture(),selected=prepareLegacySkillSelection(f.db,f.scope,f.body);verifyLegacySkillSelection(f.db,f.scope,selected);
  assert.equal(Object.isFrozen(selected.skill!.values),true);assert.throws(()=>{selected.skill!.values.instructions='overwrite';});
  f.values.instructions='new server config under old release';assert.match(legacySkillContext(selected),/按用户目标整理文字/);fails(()=>verifyLegacySkillSelection(f.db,f.scope,selected),409,'LEGACY_SKILL_CHANGED');
  const g=fixture(),previous=prepareLegacySkillSelection(g.db,g.scope,g.body);g.db.settings.officialFeatures![0].release!.id='new-release';assert.throws(()=>verifyLegacySkillSelection(g.db,g.scope,previous),/未开放|版本已变更/);
});
test('scope isolation includes platform admins and private company/global feature visibility',()=>{
  const f=fixture(),selected=prepareLegacySkillSelection(f.db,f.scope,f.body);fails(()=>verifyLegacySkillSelection(f.db,{workspaceId:'wb',userId:'b'},selected),403,'LEGACY_SKILL_SCOPE');
  f.db.settings.officialFeatures![0].workspaceId='wa';assert.throws(()=>prepareLegacySkillSelection(f.db,{workspaceId:'wb',userId:'b'},f.body),/未开放/);
  assert.throws(()=>prepareLegacySkillSelection(f.db,{workspaceId:'wb',userId:'a'},f.body),/账号或空间不可用/);
  f.db.workspaceMembers[0].status='disabled';assert.throws(()=>verifyLegacySkillSelection(f.db,f.scope,selected),/账号或空间不可用/);
});
test('published price and approval remain exact and a new threshold or price cannot reuse old consent',()=>{
  const f=fixture({usageMultiplier:3});assert.throws(()=>prepareLegacySkillSelection(f.db,f.scope,f.body),/超过/);
  const price={id:'writer',releaseId:'release_writer',version:1,multiplier:3};assert.throws(()=>prepareLegacySkillSelection(f.db,f.scope,{...f.body,featureApprovals:[{...price,releaseId:'old'}]}),/超过/);
  const selected=prepareLegacySkillSelection(f.db,f.scope,{...f.body,featureApprovals:[price]});assert.deepEqual(legacySkillFeaturePrice(selected),{...price,name:'写作助手'});
  const normal=fixture(),normalSelected=prepareLegacySkillSelection(normal.db,normal.scope,normal.body);normal.db.users[0].featureBudgetPolicies=[{...normal.scope,approvalThreshold:.5,updatedAt:'now'}];assert.throws(()=>verifyLegacySkillSelection(normal.db,normal.scope,normalSelected),/超过/);
});
test('knowledge context binds only currently readable exact-workspace sources and rejects required missing results',()=>{
  const f=fixture({knowledgeMode:'required'}),selected=prepareLegacySkillSelection(f.db,f.scope,f.body);assert.deepEqual(legacySkillKnowledgeScope(selected),{required:true,sourceIds:['ka']});
  fails(()=>requireLegacySkillKnowledge(selected,{status:'failed',chunks:[]}),424);requireLegacySkillKnowledge(selected,{status:'used',chunks:[{title:'真实资料',content:'实际检索结果'}]});
  f.db.knowledgeConnections[0].providerUserId='different-provider-account';fails(()=>verifyLegacySkillSelection(f.db,f.scope,selected),409,'LEGACY_SKILL_SOURCE_CHANGED');
  const g=fixture({knowledgeMode:'required'});g.db.knowledgeConnections=g.db.knowledgeConnections.filter(source=>source.workspaceId==='wb');fails(()=>prepareLegacySkillSelection(g.db,g.scope,g.body),422,'LEGACY_SKILL_KNOWLEDGE_REQUIRED');
  const optional=fixture({knowledgeMode:'optional'});optional.db.knowledgeConnections=[];const allowed=prepareLegacySkillSelection(optional.db,optional.scope,optional.body);requireLegacySkillKnowledge(allowed,{status:'no_match',chunks:[]});
});
test('image, Office/file tools and unselected required actions fail clearly rather than disappear',()=>{
  for(const tool of ['oneDocument','oneSlides','oneWorkbook','oneHtml','oneFlowchart','oneTable']){const f=fixture({tools:[{id:tool,description:'需要生成文件'}]});fails(()=>prepareLegacySkillSelection(f.db,f.scope,f.body,{supportsTools:true}),422);}
  const image=fixture({experience:{mode:'image',inputs:[],actions:[{id:'make',label:'画图',instruction:'生成图像'}]}});fails(()=>prepareLegacySkillSelection(image.db,image.scope,image.body),422);
  const action=fixture({experience:{inputs:[{id:'format',label:'格式',type:'text',required:true}],actions:[{id:'make',label:'整理',instruction:'按格式整理'}]}});fails(()=>prepareLegacySkillSelection(action.db,action.scope,action.body),422);
  const tool=fixture({tools:[{id:'sandboxLookup',description:'只读查询园区规则'}]});fails(()=>prepareLegacySkillSelection(tool.db,tool.scope,tool.body),422);
});
test('one approved default text action really enters context while model/tool support must be explicit',()=>{
  const f=fixture({experience:{inputs:[{id:'tone',label:'语气',type:'select',options:['自然','正式'],default:'自然'}],actions:[{id:'write',label:'整理成文',instruction:'用三段正文表达'}]}}),selected=prepareLegacySkillSelection(f.db,f.scope,f.body);
  assert.match(legacySkillContext(selected),/用三段正文表达/);assert.match(legacySkillContext(selected),/自然/);assertLegacySkillModel(selected,{kind:'chat'},false);fails(()=>assertLegacySkillModel(selected,{kind:'image'},false),422);
});
test('reviewed read-only tools execute with fresh key/owner checks and stable names, never browser definitions',async()=>{
  const f=fixture({integration:'openapi',tools:[{id:'sandboxLookup',description:'只读查询园区规则'}]}),selected=prepareLegacySkillSelection(f.db,f.scope,f.body,{supportsTools:true});let verifies=0,reads=0;
  const tools=legacySkillTools(f.store,f.scope,selected,async()=>{verifies++;},{transport:async()=>{reads++;return {synthetic:true,found:true,title:'合成规则',answer:'测试说明'};}});
  assert.equal(tools[0].name,'legacy_skill_tool_0');assert.match(legacySkillContext(selected),/sandboxLookup → legacy_skill_tool_0/);fails(()=>assertLegacySkillModel(selected,{kind:'chat'},false),422);
  const args=tools[0].structured!.validate({topic:'meeting'});const result=await tools[0].structured!.run(args);assert.equal(reads,1);assert.ok(verifies>=2);assert.equal((result as {answer?:string}).answer,'测试说明');
  f.db.workspaceMembers[0].status='disabled';await assert.rejects(tools[0].structured!.run(args),/账号或空间不可用/);assert.equal(reads,1);
});
test('credential snapshots pin only current owner endpoint/auth revisions and never include secrets',()=>{
  const f=fixture({integration:'openapi',tools:[{id:'sandboxLookup',description:'只读园区规则',auth:'bearer'}]}),endpoint=featureToolEndpoint(f.values.tools![0]);
  f.db.users[0].featureCredentials=[{...f.scope,endpoint,auth:'bearer',encryptedSecret:'synthetic-encrypted-private-secret',revision:'credential-v1',updatedAt:'now'}];
  const selected=prepareLegacySkillSelection(f.db,f.scope,f.body,{supportsTools:true});assert.doesNotMatch(JSON.stringify(selected),/synthetic-encrypted-private-secret/);assert.deepEqual(selected.credentials,[{endpoint,auth:'bearer',revision:'credential-v1'}]);
  f.db.users[0].featureCredentials![0].revision='credential-v2';assert.throws(()=>verifyLegacySkillSelection(f.db,f.scope,selected),/凭证已更换或撤销/);
});
test('normal billed model call receives the one published Skill price with no synthetic bundle or base-price mutation',async()=>{
  const f=fixture(),selected=prepareLegacySkillSelection(f.db,f.scope,f.body),price=legacySkillFeaturePrice(selected)!;
  await runBilledModel(f.store,{...f.scope,model:f.model,featurePrice:price,requestId:'legacy-test',activity:'chat',input:{messages:[{role:'system',content:legacySkillContext(selected)},{role:'user',content:'真实输入'}]},beforeReserve:db=>verifyLegacySkillSelection(db,f.scope,selected)},async()=>({content:'真实返回',usage:{inputTokens:10,outputTokens:20,totalTokens:30,source:'provider'}}));
  assert.deepEqual(f.db.modelUsageRecords[0].featurePriceSnapshot,price);assert.equal(f.db.modelUsageRecords[0].chargedMicros,60);assert.equal(f.model.inputPowerPerMillion,2);assert.equal(f.db.modelUsageRecords.filter(row=>row.workspaceId==='wb').length,0);
});
