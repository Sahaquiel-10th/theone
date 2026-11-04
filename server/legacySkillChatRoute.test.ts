import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {once} from 'node:events';
import express,{type Request,type Response,type NextFunction} from 'express';
import ts from 'typescript';
import type {Database,ModelConfig,Message} from './types.js';
import type {Store} from './db.js';
import type {OfficialFeatureValues} from './officialFeatures.js';
import * as skills from './legacySkillSelection.js';
import * as operations from './chatOperations.js';
import {runBilledModel} from './modelBilling.js';
import {availablePowerMicros} from './powerBilling.js';
import {FeatureConfigError} from './officialFeatures.js';
import {BetaInputError} from './betaProfile.js';
import {initializeCompanion,companionPrompt} from './oneCompanion.js';
import {runTaskOrchestrator} from './taskOrchestrator.js';

// Exercise the actual production route statement over HTTP, not a copied handler.
// Only its dependencies are synthetic; importing index would start all live services.
const source=fs.readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
function statement(predicate:(call:ts.CallExpression)=>boolean){return ast.statements.find(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&predicate(node.expression))!.getText(ast);}
const route=statement(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.expression.getText(ast)==='app'&&call.expression.name.text==='post'&&ts.isStringLiteral(call.arguments[0])&&call.arguments[0].text==='/api/chat');
const errorHandler=statement(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.name.text==='use'&&!!call.arguments[0]&&ts.isArrowFunction(call.arguments[0])&&call.arguments[0].parameters[0]?.name.getText(ast)==='err');
const compiled=ts.transpileModule(route+'\n'+errorHandler,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const usage={inputTokens:10,outputTokens:20,totalTokens:30,source:'provider' as const};
async function harness(t:test.TestContext,options:{values?:Partial<OfficialFeatureValues>;orchestrator?:boolean;knowledgeMissing?:boolean;summarize?:boolean;revokeDuringModel?:boolean}={}){
  const values:OfficialFeatureValues={name:'已发布写作',author:'ONE',description:'仅使用已认定要求',instructions:'approved-skill-instruction',limitations:'keep-private-boundaries',integration:'question_answer',usageMultiplier:.6,knowledgeMode:'none',tools:[],...options.values};
  const model={id:'chat',name:'Synthetic chat',kind:'chat',enabled:true,apiKey:'synthetic',systemPrompt:'base-model',inputPowerPerMillion:2,outputPowerPerMillion:4,costInputPowerPerMillion:1,costOutputPowerPerMillion:2} as ModelConfig;
  const db={users:[{id:'a',enabled:true,role:'user',defaultWorkspaceId:'wa'},{id:'b',enabled:true,role:'admin',defaultWorkspaceId:'wb'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],models:[model],conversations:[],conversationFolders:[],messages:[],attachments:[],contextTraces:[],retrievalLogs:[],auditLogs:[],knowledgeConnections:[{id:'ka',workspaceId:'wa',provider:'notion',status:'connected',providerUserId:'account-a'},{id:'kb',workspaceId:'wb',provider:'notion',status:'connected',providerUserId:'account-b'}],chatOperations:[],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'pa',workspaceId:'wa',userId:'a',balanceMicros:1e8},{id:'pb',workspaceId:'wb',userId:'b',balanceMicros:1e8}],settings:{safetyRules:'server-safety',aiTasks:{orchestrator:{published:{enabled:!!options.orchestrator}}},officialFeatures:[{id:'writer',revision:1,status:'approved',draft:structuredClone(values),history:[{version:1,values,evidence:'synthetic',approvedBy:'b',approvedAt:'now'}],release:{id:'writer-release',version:1,audience:'all',userIds:[],publishedAt:'now',publishedBy:'b'}}]}} as unknown as Database;
  let queue=Promise.resolve<unknown>(undefined),sequence=0,proofs=0;
  const store:Store={read:async()=>db,mutate:fn=>{const promise=queue.then(()=>fn(db));queue=promise.catch(()=>undefined);return promise;}};
  const modelCalls:{messages:unknown;tools:unknown}[]=[],knowledgeCalls:{workspaceId:string;sourceIds:readonly string[]|undefined;userId:string|undefined}[]=[];
  const answer=async(_model:unknown,messages:unknown,tools:unknown[]=[])=>{modelCalls.push({messages,tools});if(options.revokeDuringModel)db.settings.officialFeatures![0].status='paused';return {content:'verified-answer',toolCalls:[],usage,finishReason:'stop' as const};};
  let toolUsed=false;
  const callWithTools=async(model:unknown,messages:unknown,tools:{function:{name:string}}[])=>{if(options.values?.tools?.length&&!toolUsed){toolUsed=true;modelCalls.push({messages,tools});return {content:'',usage,toolCalls:[{id:'tool-call',type:'function',function:{name:tools.find(tool=>tool.function.name==='legacy_skill_tool_0')!.function.name,arguments:JSON.stringify({operation:'profit',dataJson:JSON.stringify({revenue:100,variableCost:30,fixedCost:10,quantity:1})})}}]};}return answer(model,messages,tools);};
  const app=express();app.use(express.json());
  const keyAuth=[(req:Request,res:Response,next:NextFunction)=>{req.workspaceId=String(req.headers['x-test-workspace']??'wa');req.user=db.users.find(user=>user.id===(req.headers['x-test-user']??'a'));res.locals.requestId=`request-${++sequence}`;next();}];
  class NoMatchError extends Error {}
  const attachment=options.summarize?{id:'file',workspaceId:'wa',userId:'a',kind:'document',originalName:'真实输入.txt',extractedText:'text',size:4}:undefined;
  const deps={...skills,...operations,initializeCompanion,companionPrompt,app,keyAuth,asyncRoute:(handler:(req:Request,res:Response)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>{Promise.resolve(handler(req,res)).catch(next);},store,FeatureConfigError,BetaInputError,attachmentMaxFiles:5,attachmentMaxBytes:200e6,attachmentContextChars:24000,chatHistoryMessages:12,
    requiredString:(value:unknown)=>{if(typeof value!=='string'||!value.trim())throw new Error('required');return value.trim();},availablePowerMicros,selectConversationAttachments:()=>({current:attachment?[attachment]:[],context:attachment?[attachment]:[],omittedCount:0}),fullDocumentIntent:()=>false,hasImageGenerationIntent:()=>false,
    resolveAiTask:(_settings:unknown,_models:unknown,id:string)=>({model:structuredClone(model),version:1,values:{tools:id==='orchestrator'?['knowledge_search']:[],toolDescriptions:{},maxSteps:4}}),uid:(prefix:string)=>`${prefix}-${++sequence}`,now:()=>new Date().toISOString(),attachmentSummary:(item:unknown)=>item,completeOnboardingOnChat:()=>{},messageRecord:(message:Message,scope:Record<string,string>)=>({...message,...scope}),titleFrom:(text:string)=>text.slice(0,32),
    confirmKeyBeforeModel:async()=>{proofs++;},knowledgePolicy:()=>({required:false,declined:false}),publicSearchPermitted:()=>false,explicitlyNeedsPublicSearch:()=>false,
    knowledgeService:{recallWithDiagnostics:async(workspaceId:string,_query:string,_top:number,sourceIds:readonly string[]|undefined,userId:string|undefined)=>{knowledgeCalls.push({workspaceId,sourceIds,userId});return options.knowledgeMissing||sourceIds?.length===0?{status:'no_match',chunks:[],failures:[]}:{status:'used',chunks:[{title:'合成资料',content:'authorized-knowledge-result'}],failures:[]};}},knowledgeRecallOptions:()=>({}),runtimeContext:()=>({today:'2026-11-04'}),runtimeContextText:()=> 'runtime',temporalKnowledgeResult:(value:unknown)=>value,
    runTaskOrchestrator,runBilledModel,callModel:answer,callModelWithTools:callWithTools,friendlyConversationGuidance:'friendly',executionReceipts:()=>[],prepareAttachmentContext:async(_files:unknown,_scope:unknown,_content:unknown,_limit:unknown,summarize:(text:string)=>Promise<string>)=>({text:options.summarize?await summarize('generic-attachment-text'):'',truncated:false}),ownedAttachment:()=>attachment,attachmentImageDataUrls:async()=>[],buildSearchContext:()=>'',buildContextTraceSections:()=>[],appendOwnerContextTrace:()=>{},persistGeneratedImage:async()=>undefined,
    CoordinatorLocalError:NoMatchError,LocalExecutionNotStartedError:NoMatchError,GetNoteProviderError:NoMatchError,multer:{MulterError:NoMatchError},getNoteAuditDetails:()=>({}),console:{error:()=>{}},fs:{promises:{rm:async()=>{}}},
  };
  vm.compileFunction(compiled,Object.keys(deps))(...Object.values(deps));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return {db,store,modelCalls,knowledgeCalls,get proofs(){return proofs;},async post(body:Record<string,unknown>,headers:Record<string,string>={}){const response=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({content:'真实输入',modelId:'chat',operationId:'operation_http_0001',...body})});return {status:response.status,body:await response.json() as Record<string,unknown>};}};
}
const chosen={featureIds:['writer'],featureApprovals:[],confirmedExternal:true};

test('actual legacy HTTP route injects the approved prompt and one published price, then replays completed output after withdrawal',async t=>{
  const f=await harness(t),first=await f.post({...chosen,instructions:'browser-injection'});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(f.modelCalls.length,1);assert.match(JSON.stringify(f.modelCalls[0].messages),/approved-skill-instruction/);assert.doesNotMatch(JSON.stringify(f.modelCalls[0].messages),/browser-injection/);assert.equal(f.db.modelUsageRecords[0].featurePriceSnapshot?.multiplier,.6);
  f.db.settings.officialFeatures![0].status='paused';const replay=await f.post(chosen);assert.equal(replay.status,200);assert.deepEqual(replay.body,first.body);assert.equal(f.modelCalls.length,1);
});
test('required knowledge is retrieved from the exact authorized source before the first model call and blocks missing data',async t=>{
  const good=await harness(t,{values:{knowledgeMode:'required'},orchestrator:true});const result=await good.post(chosen);assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(good.knowledgeCalls[0],{workspaceId:'wa',sourceIds:['ka'],userId:'a'});assert.match(JSON.stringify(good.modelCalls[0].messages),/authorized-knowledge-result/);
  const missing=await harness(t,{values:{knowledgeMode:'required'},knowledgeMissing:true});assert.equal((await missing.post(chosen)).status,424);assert.equal(missing.modelCalls.length,0);assert.equal(missing.db.modelUsageRecords.length,0);
});
test('read-only tools require an already enabled orchestrator and really execute through the reviewed runner',async t=>{
  const values={tools:[{id:'oneFinance',description:'计算本次用户明确给出的数据'}]};const disabled=await harness(t,{values});assert.equal((await disabled.post(chosen)).status,422);assert.equal(disabled.modelCalls.length,0);assert.equal(disabled.db.chatOperations?.length,0);
  const enabled=await harness(t,{values,orchestrator:true});const response=await enabled.post(chosen);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(enabled.modelCalls.length,2);assert.match(JSON.stringify(enabled.modelCalls[0].tools),/legacy_skill_tool_0/);assert.match(JSON.stringify(enabled.modelCalls[1].messages),/operatingProfit/);assert.ok(enabled.db.modelUsageRecords.every(row=>row.featurePriceSnapshot?.id==='writer'));assert.ok(enabled.proofs>3);
});
test('actual route blocks a foreign private Skill and a revoked in-flight selection without saving a fake answer',async t=>{
  const foreign=await harness(t);foreign.db.settings.officialFeatures![0].workspaceId='wa';assert.equal((await foreign.post(chosen,{'x-test-user':'b','x-test-workspace':'wb'})).status,403);assert.equal(foreign.modelCalls.length,0);
  const revoked=await harness(t,{revokeDuringModel:true});assert.equal((await revoked.post(chosen)).status,403);assert.equal(revoked.modelCalls.length,1);assert.equal(revoked.db.messages.some(message=>message.role==='assistant'),false);assert.equal(revoked.db.modelUsageRecords.length,1);
});
test('no-Skill request replays an old operation hash and generic attachment summarization keeps its existing rate',async t=>{
  const f=await harness(t),scope={workspaceId:'wa',userId:'a',operationId:'operation_http_0001'};
  await operations.beginChatOperation(f.store,{...scope,requestId:'old-request',payload:{content:'真实输入',modelId:'chat',conversationId:'',attachmentIds:[],webSearch:false,folderId:''}});
  const conversation={id:'old-conversation',workspaceId:'wa',userId:'a',modelId:'chat',title:'旧记录',messages:[{id:'answer',role:'assistant' as const,content:'old-answer',createdAt:'now'}],archived:false,createdAt:'now',updatedAt:'now'};f.db.conversations.push(conversation);await f.store.mutate(db=>{operations.bindChatOperationConversation(db,scope,conversation.id);operations.completeChatOperation(db,scope,{conversationId:conversation.id,assistantMessageId:'answer'});});
  assert.equal((await f.post({featureIds:[],featureApprovals:[],confirmedExternal:false})).status,200);assert.equal(f.modelCalls.length,0);
  const summarized=await harness(t,{summarize:true});assert.equal((await summarized.post(chosen)).status,200);assert.equal(summarized.db.modelUsageRecords.length,2);assert.equal(summarized.db.modelUsageRecords[0].activity,'attachment_summary');assert.equal(summarized.db.modelUsageRecords[0].featurePriceSnapshot,undefined);assert.equal(summarized.db.modelUsageRecords[1].featurePriceSnapshot?.id,'writer');
});


test('actual handler marks only a proven pre-claim rejection as unaccepted; post-claim failure retains its receipt',async t=>{
  const unsupported=await harness(t,{values:{tools:[{id:'oneDocument',description:'生成真实文件'}]}});const rejected=await unsupported.post(chosen);
  assert.equal(rejected.status,422);assert.equal(rejected.body.accepted,false);assert.equal(rejected.body.retryable,true);assert.equal(unsupported.db.chatOperations?.length,0);assert.equal(unsupported.modelCalls.length,0);
  const unknown=await harness(t,{revokeDuringModel:true});const failed=await unknown.post(chosen);
  assert.notEqual(failed.status,200);assert.notEqual(failed.body.accepted,false);assert.equal(failed.body.retryable,false);assert.equal(unknown.db.chatOperations?.length,1);assert.equal(unknown.modelCalls.length,1);
  const reused=await harness(t);assert.equal((await reused.post(chosen)).status,200);const malformed=await reused.post({...chosen,featureIds:['writer','writer']});assert.equal(malformed.status,422);assert.notEqual(malformed.body.accepted,false);assert.equal(reused.modelCalls.length,1);
  const main=fs.readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');assert.match(main,/err.retryable === true\|\|err.accepted===false/);
});
