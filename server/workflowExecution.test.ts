import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowRun,type WorkflowBinding,type WorkflowSpec,type WorkflowStep} from './taskWorkflow.js';
import {executeWorkflowStages,type WorkflowExecutionInput} from './workflowExecution.js';
import type {TaskStep,TaskStepStore} from './taskSteps.js';
import type {WorkRun} from './coordinatorTypes.js';
import {legacyNotionNormalized,notionHash} from './notionCanonical.js';
import type {WorkflowContextInput,WorkflowHistoryMessage} from './workflowContext.js';

const owner:WorkflowBinding={workspaceId:'ws_a',userId:'usr_a',operationId:'op_a'};
const step=(id:string,inputs:string[]=[],extra:Partial<WorkflowStep>={}):WorkflowStep=>({id,title:`处理${id}`,kind:'model',instruction:`完成${id}`,inputs,...extra});
const plan=(...steps:WorkflowStep[]):WorkflowSpec=>({version:1,steps});
const answer=(body:string,outcome='completed')=>({content:JSON.stringify({outcome,content:body,summary:'本步骤结果。'}),toolCalls:[]});
function fixture(spec:WorkflowSpec){
 let run=createWorkflowRun(spec,owner),receipt:WorkRun['notionReceipt'];const steps:TaskStep[]=[];let modelCalls=0,saves=0;
 const checkpoints:TaskStepStore={namespace:'worker',steps,save:async cp=>{const index=steps.findIndex(saved=>saved.key===cp.key);if(index<0)steps.push(structuredClone(cp));else steps[index]=structuredClone(cp);}};
 const persist:WorkflowExecutionInput['persist']=async(next,expected)=>{if(next.id!==run.id||JSON.stringify(next.binding)!==JSON.stringify(run.binding)||run.sequence!==expected)return false;run=structuredClone(next);return true;};
 const makeProof=async(body:string,options:{verified?:boolean;key?:string;scopeId?:string;final?:boolean}={})=>{
  const key=options.key??'notion_actual_checkpoint',expectedDigest=notionHash(legacyNotionNormalized(body)),digest=notionHash(body),verified=options.verified!==false;
  receipt={state:verified?'verified':'uncertain',pageId:'1234567890abcdef1234567890abcdef',checkpointKey:key,expectedDigest,digest,final:options.final!==false,...(!verified?{verification:{state:'scheduled',version:1,attempt:1,nextCheckAt:new Date().toISOString(),deadlineAt:'2099-01-01T00:00:00.000Z'}}:{})};
  await checkpoints.save({key,namespace:'worker',scopeId:options.scopeId??owner.operationId,tool:'save_notion_draft',label:'保存原文',effect:'external_write',state:verified?'completed':'started',updatedAt:new Date().toISOString(),...(verified?{output:{state:'verified',pageId:receipt.pageId,digest,expectedDigest,final:receipt.final}}:{})});
  return {state:verified?'verified':'uncertain',pageId:receipt.pageId,digest,expectedDigest,final:receipt.final};
 };
 return {steps,checkpoints,makeProof,setReceipt:(r:WorkRun['notionReceipt'])=>{receipt=structuredClone(r);},get receipt(){return structuredClone(receipt);},get run(){return structuredClone(run);},get modelCalls(){return modelCalls;},get saves(){return saves;},execute:(overrides:Partial<WorkflowExecutionInput>={})=>executeWorkflowStages({binding:owner,run:structuredClone(run),goal:'完成完整方案，保留数字与结尾，不发布。',modelSystemPrompt:'原样保留的模型提示词',history:[],inputs:[],checkpoints,tools:[],featureTools:{},verify:async()=>{},persist,callModel:async s=>{modelCalls++;return answer(`完整正文${s.id}\n自然结尾。`);},saveNotion:async(_s,body)=>{saves++;return makeProof(body);},receipt:async()=>structuredClone(receipt),...overrides})};
}
const references=(messages:Parameters<WorkflowExecutionInput['callModel']>[1])=>{
 const text=messages.at(-1)!.content!;return JSON.parse(text.slice(text.indexOf('\n')+1)) as {inputs:WorkflowContextInput[];history:{id:string;content:string}[]};
};

test('source → one model → real Notion save is sequential and passes full checkpoints without extra model summary',async()=>{
 const longSource='会议原始材料。'.repeat(8000)+'唯一结尾';
 const f=fixture(plan(step('source',[],{kind:'tool',tool:'knowledge_search'}),step('write',['source']),step('save',['write'],{kind:'notion'})));let calls=0,queries:string[]=[];
 const result=await f.execute({tools:[{name:'knowledge_search',run:async query=>{queries.push(query);return {status:'used',chunks:[{id:'k1',content:longSource}]};}}],callModel:async(s,messages)=>{
  calls++;assert.equal(s.id,'write');assert.equal(messages.some(message=>message.tool_calls),false);assert.match(messages[0].content!,/原样保留的模型提示词/);
  const refs=references(messages),source=refs.inputs.find(ref=>ref.kind==='knowledge')!;assert.equal(refs.history.length,0);assert.equal(source.content,longSource);assert.equal(source.complete,false);return answer('一份完整的长方案\n\n自然结尾保留。');
 }});
 assert.equal(result.run.phase,'completed');assert.equal(result.outcome,'completed');assert.equal(result.waiting,false);assert.equal(calls,1);assert.equal(f.saves,1);assert.deepEqual(queries,['完成source']);
 assert.match(result.content,/一份完整的长方案/);assert.match(result.content,/已回读核对/);assert.ok(f.steps.some(cp=>cp.tool==='save_notion_draft'&&cp.state==='completed'));
 assert.equal(JSON.stringify(result.run).includes(longSource),false);
 const again=await f.execute({callModel:async()=>assert.fail('completed model repeated'),saveNotion:async()=>assert.fail('completed write repeated')});assert.equal(again.outcome,'completed');
});

test('history is absent by default and only an explicitly requested tail is selected',async()=>{
 const history:WorkflowHistoryMessage[]=Array.from({length:5},(_,i)=>({...owner,id:`h${i}`,role:'user',content:`历史${i}`}));
 const f=fixture(plan(step('zero'),step('two',[],{historyCount:2})));const included:string[][]=[];
 await f.execute({history,callModel:async(s,messages)=>{included.push(references(messages).history.map(row=>row.id));return answer(s.id);}});
 assert.deepEqual(included,[[],['h3','h4']]);
});

test('feature mapping runs once with full selected context; unrelated tool schemas are not offered to a model',async()=>{
 const input:WorkflowContextInput={...owner,id:'attachment',kind:'artifact',content:'附件中的完整资料',complete:true};
 const f=fixture(plan(step('draft'),step('page',['draft'],{kind:'feature',featureId:'html_feature'})));let featureCalls=0,queries:string[]=[];
 const result=await f.execute({inputs:[input],featureTools:{html_feature:'feature_7'},tools:[{name:'feature_7',effect:'artifact',run:async query=>{featureCalls++;queries.push(query);return {content:JSON.stringify({outcome:'completed',content:'已做好的网页说明正文',summary:'已生成网页'}),file:{id:'artifact_a'}};}},{name:'unrelated_video',run:async()=>assert.fail('unselected tool ran')} ]});
 assert.equal(featureCalls,1);assert.match(queries[0],/完整方案/);assert.match(queries[0],/完整正文draft/);assert.match(queries[0],/附件中的完整资料/);assert.doesNotMatch(queries[0],/原样保留的模型提示词|unrelated_video/);assert.equal(f.modelCalls,1);assert.equal(result.content,'已做好的网页说明正文');assert.equal(result.outcome,'completed');
});

test('read_notion_document uses its bound structured empty arguments, never a query or arbitrary page',async()=>{
 const f=fixture(plan(step('read',[],{kind:'tool',tool:'read_notion_document'})));let validated=0,reads=0;
 const result=await f.execute({tools:[{name:'read_notion_document',run:async()=>assert.fail('unbound query path used'),structured:{schema:{},validate:raw=>{validated++;assert.deepEqual(raw,{});return {};},run:async raw=>{reads++;assert.deepEqual(raw,{});return {status:'read',complete:true,content:'原文全文\n原文结尾'};}}}]});
 assert.equal(validated,1);assert.equal(reads,1);assert.equal(result.content,'原文全文\n原文结尾');assert.equal(result.outcome,'completed');
});

test('whole-task result summarizes both completed file stages instead of copying the last child scope disclaimer',async()=>{
 const f=fixture(plan(step('draft'),step('page',['draft'],{kind:'feature',featureId:'html_feature',title:'制作交互网页'}),step('chart',['draft'],{kind:'feature',featureId:'chart_feature',title:'制作完整流程图'})));
 const result=await f.execute({featureTools:{html_feature:'feature_0',chart_feature:'feature_1'},tools:[
  {name:'feature_0',run:async()=>({content:'网页已经完成。',artifacts:[{name:'网页.html',openUrl:'/api/welcome-pages/file_a/view'}]})},
  {name:'feature_1',run:async()=>({content:'本步骤只交付了流程图；交互网页不属于当前步骤的交付范围。',artifacts:[{name:'图.svg',openUrl:'/api/welcome-pages/file_b/view'}]})},
 ]});
 assert.equal(result.outcome,'completed');assert.match(result.content,/已完成：处理draft、制作交互网页、制作完整流程图/);assert.match(result.summary,/制作交互网页、制作完整流程图/);assert.match(result.content,/完整正文draft/);assert.doesNotMatch(result.content,/本步骤只交付|不属于当前步骤/);assert.equal(f.modelCalls,1,'summary needs no extra model call');
});

for(const empty of [{status:'no_match',chunks:[]},{status:'used',chunks:[]},{status:'used',chunks:[{content:'   '}]}])test(`empty search result ${JSON.stringify(empty)} never becomes a completed source`,async()=>{
 const f=fixture(plan(step('find',[],{kind:'tool',tool:'knowledge_search'}),step('write',['find']),step('independent')));const models:string[]=[];
 const result=await f.execute({tools:[{name:'knowledge_search',run:async()=>empty}],callModel:async s=>{models.push(s.id);return answer('独立部分完成。');}});
 assert.deepEqual(models,['independent']);assert.equal(result.run.steps[0].state,'needs_input');assert.equal(result.run.steps[1].waitingFor,'inputs');assert.equal(result.outcome,'needs_input');assert.match(result.content,/独立部分完成/);assert.match(result.content,/没有找到可用/);
});

test('usable partial recall retains its partial diagnostics and full content for the next selected step',async()=>{
 const f=fixture(plan(step('find',[],{kind:'tool',tool:'knowledge_search'}),step('write',['find'])));
 const result=await f.execute({tools:[{name:'knowledge_search',run:async()=>({status:'partial',chunks:[{content:'可用素材',provider:'notion',title:'昨天记录',createdAt:'2026-10-24',dateEvidence:{basis:'event',date:'2026-10-24',status:'requires_content_verification'}}],failures:[{reason:'暂未查全'}]})}],callModel:async(_s,messages)=>{const refs=references(messages),source=refs.inputs.find(ref=>ref.kind==='knowledge')!,diagnostics=JSON.parse(refs.inputs.find(ref=>ref.kind==='tool_result')!.content);assert.equal(diagnostics.status,'partial');assert.equal(source.content,'可用素材');assert.equal(source.complete,false);assert.equal(source.source,'notion');assert.equal(source.createdAt,'2026-10-24');assert.equal(source.dateEvidence?.status,'requires_content_verification');return answer('基于已找到的资料，未宣称查全。');}});
 assert.equal(result.outcome,'completed');assert.match(result.run.steps[0].summary!,/部分/);
});

test('model needs_input is retained as a real blocker and never saved as a placeholder document',async()=>{
 const f=fixture(plan(step('write'),step('save',['write'],{kind:'notion'})));
 const result=await f.execute({callModel:async()=>answer('请补充昨天会议的原始记录，我接着写。','needs_input'),saveNotion:async()=>assert.fail('placeholder write attempted')});
 assert.equal(result.outcome,'needs_input');assert.match(result.content,/昨天会议的原始记录/);assert.equal(result.run.steps[1].waitingFor,'inputs');assert.equal(f.steps.filter(cp=>cp.tool==='save_notion_draft').length,0);
});

test('a later missing-material question remains visible beside an earlier usable draft',async()=>{
 const f=fixture(plan(step('draft'),step('finish',['draft'])));
 const result=await f.execute({callModel:async s=>s.id==='draft'?answer('已经完成的方案草稿。'):answer('还缺活动日期，请告诉我是周六还是周日？','needs_input')});
 assert.equal(result.outcome,'needs_input');assert.match(result.content,/已经完成的方案草稿/);assert.match(result.content,/还缺活动日期/);assert.match(result.summary,/活动日期/);
});

test('a known Notion precondition refusal without a receipt is not described as an in-flight save',async()=>{
 for(const value of [{status:'needs_input',saved:false,message:'还缺必需的项目资料，请先补充。'},{saved:false,status:'rejected',message:'HTTP PRIVATE_SECRET'},{state:'needs_input',content:'HTTP authorization PRIVATE_SECRET'}]){
  const f=fixture(plan(step('draft'),step('save',['draft'],{kind:'notion'})));
  const result=await f.execute({saveNotion:async()=>value});
  assert.equal(result.waiting,false);assert.notEqual(result.outcome,'completed');assert.doesNotMatch(JSON.stringify(result),/已经交给|PRIVATE_SECRET|HTTP|authorization/);
  if(value.status==='needs_input'){assert.equal(result.outcome,'needs_input');assert.match(result.content,/项目资料/);}
 }
});

test('the selected stage model receives its own exact prompt instead of the base executor prompt',async()=>{
 const f=fixture(plan(step('first',[],{executorId:'writer'}),step('second',['first'],{executorId:'reviewer'})));const prompts:string[]=[];
 await f.execute({modelPromptForStep:s=>s.executorId==='reviewer'?'审稿模型原始提示词':'写作模型原始提示词',callModel:async(_s,messages)=>{prompts.push(messages[0].content!);return answer('正文');}});
 assert.match(prompts[0],/写作模型原始提示词/);assert.doesNotMatch(prompts[0],/审稿模型原始提示词|原样保留的模型提示词/);assert.match(prompts[1],/审稿模型原始提示词/);assert.doesNotMatch(prompts[1],/写作模型原始提示词|原样保留的模型提示词/);
});

test('partial or truncated model body is preserved but cannot satisfy its dependent final save',async()=>{
 const f=fixture(plan(step('write'),step('save',['write'],{kind:'notion'})));
 const result=await f.execute({callModel:async()=>({...answer('已经生成的前半部分'),finishReason:'length'}),saveNotion:async()=>assert.fail('partial manuscript saved as final')});
 assert.equal(result.outcome,'partial');assert.equal(result.content,'已经生成的前半部分');assert.equal(result.run.steps[0].state,'failed');assert.equal(result.run.steps[1].state,'waiting');
});

test('delayed verified receipt recovers the exact actual save checkpoint without any model/write retry',async()=>{
 const f=fixture(plan(step('write'),step('save',['write'],{kind:'notion'})));let models=0,writes=0,body='';
 const first=await f.execute({callModel:async()=>{models++;return answer('完整正文\n唯一自然结尾');},saveNotion:async(_s,content)=>{writes++;body=content;return f.makeProof(content,{verified:false});}});
 assert.equal(first.waiting,true);assert.equal(first.outcome,'partial');assert.equal(first.run.steps[1].waitingFor,'result');assert.equal(f.steps.find(cp=>cp.tool==='save_notion_draft')!.state,'started');
 await f.makeProof(body);
 const second=await f.execute({callModel:async()=>assert.fail('extra model call during verification'),saveNotion:async()=>assert.fail('write retried during verification')});
 assert.equal(second.outcome,'completed');assert.equal(second.waiting,false);assert.equal(models,1);assert.equal(writes,1);assert.match(second.content,/唯一自然结尾/);assert.match(second.content,/已回读核对/);
 const third=await f.execute({callModel:async()=>assert.fail('third model call'),saveNotion:async()=>assert.fail('third write')});assert.equal(third.outcome,'completed');
});

test('save throw after real write is unknown, but a subsequent exact read-only proof can finish it',async()=>{
 const f=fixture(plan(step('write'),step('save',['write'],{kind:'notion'}),step('independent')));let writes=0;
 const first=await f.execute({saveNotion:async(_s,body)=>{writes++;await f.makeProof(body,{verified:false});throw new Error('HTTP PRIVATE_SECRET');}});
 assert.equal(first.waiting,true);assert.equal(first.run.steps[2].state,'queued');assert.doesNotMatch(JSON.stringify(first),/PRIVATE_SECRET|HTTP/);
 const actual=f.steps.find(cp=>cp.tool==='save_notion_draft')!,r=f.receipt!;f.setReceipt({...r,state:'verified',verification:undefined});await f.checkpoints.save({...actual,state:'completed',output:{state:'verified',pageId:r.pageId,digest:r.digest,expectedDigest:r.expectedDigest,final:true}});
 const second=await f.execute({saveNotion:async()=>assert.fail('unknown write replayed')});assert.equal(second.outcome,'completed');assert.equal(writes,1);
});

test('verified state alone, wrong checkpoint scope, nonfinal save or mismatched body never proves the workflow write',async()=>{
 for(const scenario of ['no_checkpoint','foreign_checkpoint','not_final','wrong_body','verification_still_active'] as const){
  const f=fixture(plan(step('write'),step('save',['write'],{kind:'notion'})));
  const result=await f.execute({saveNotion:async(_s,body)=>{
   const value=await f.makeProof(scenario==='wrong_body'?'另一个正文':body,{scopeId:scenario==='foreign_checkpoint'?'other_op':owner.operationId,final:scenario!=='not_final'});
   if(scenario==='no_checkpoint')f.steps.splice(f.steps.findIndex(cp=>cp.tool==='save_notion_draft'),1);
   if(scenario==='verification_still_active')f.setReceipt({...f.receipt!,verification:{state:'exhausted',version:1,attempt:3,nextCheckAt:'2026-10-25T01:00:00Z',deadlineAt:'2026-10-25T02:00:00Z',lastReason:'mismatch'}});
   return value;
  }});
  assert.notEqual(result.outcome,'completed',scenario);assert.equal(result.waiting,true,scenario);assert.doesNotMatch(result.content,/已回读核对/,scenario);
 }
});

test('Notion body is selected from the latest declared model/feature input, never arbitrary tool or attachment text',async()=>{
 const f=fixture(plan(step('old'),step('new'),step('save',['new','old'],{kind:'notion'})));let body='';
 const result=await f.execute({inputs:[{...owner,id:'unselected_body',kind:'artifact',content:'不该保存的附件'}],callModel:async s=>answer(s.id==='new'?'最新正文':'旧正文'),saveNotion:async(_s,content)=>{body=content;return f.makeProof(content);}});
 assert.equal(body,'最新正文');assert.equal(result.outcome,'completed');
 const noBody=fixture(plan(step('find',[],{kind:'tool',tool:'knowledge_search'}),step('save',['find'],{kind:'notion'})));
 const missing=await noBody.execute({tools:[{name:'knowledge_search',run:async()=>({status:'used',chunks:[{content:'不能直接冒充成稿的原始素材'}]})}],saveNotion:async()=>assert.fail('raw source saved as manuscript')});assert.equal(missing.outcome,'needs_input');
});

test('known tool/feature failure is safe and does not abort an independent selected stage',async()=>{
 const f=fixture(plan(step('bad',[],{kind:'feature',featureId:'bad_feature'}),step('independent')));
 const result=await f.execute({featureTools:{bad_feature:'feature_0'},tools:[{name:'feature_0',run:async()=>({status:'failed',content:'HTTP 401 Bearer PRIVATE_SECRET password=bad'})}]});
 assert.equal(result.outcome,'partial');assert.equal(result.run.steps[1].state,'completed');assert.doesNotMatch(JSON.stringify(result),/HTTP|Bearer|PRIVATE_SECRET|password/);
});

test('unknown feature exception never retries the paid handler on later events',async()=>{
 const f=fixture(plan(step('image',[],{kind:'feature',featureId:'image_feature'}),step('independent')));let calls=0;
 const tools=[{name:'feature_0',run:async()=>{calls++;throw new Error('provider secret');}}];
 const first=await f.execute({tools,featureTools:{image_feature:'feature_0'}});assert.equal(first.waiting,true);assert.equal(first.run.steps[1].state,'queued');
 const second=await f.execute({tools,featureTools:{image_feature:'feature_0'}});assert.equal(calls,1);assert.equal(second.waiting,true);assert.equal(second.run.steps[1].state,'completed');
});

test('foreign workspace inputs/history and foreign run binding are rejected before any paid/external call',async()=>{
 for(const field of ['inputs','history','binding'] as const){
  const f=fixture(plan(step('write')));let calls=0;
  const overrides:Partial<WorkflowExecutionInput>={callModel:async()=>{calls++;return answer('should not run');}};
  if(field==='inputs')overrides.inputs=[{...owner,workspaceId:'ws_b',id:'foreign',kind:'knowledge',content:'private other workspace'}];
  if(field==='history')overrides.history=[{...owner,userId:'other_user',id:'foreign',role:'user',content:'private other user'}];
  if(field==='binding')overrides.binding={...owner,operationId:'other_operation'};
  await assert.rejects(()=>f.execute(overrides));assert.equal(calls,0);assert.equal(f.steps.length,0);
 }
});

test('a missing or foreign persisted workflow checkpoint cannot be silently rerun or fed to a later model',async()=>{
 const f=fixture(plan(step('write'),step('feature',['write'],{kind:'feature',featureId:'html'})));
 await f.execute({featureTools:{html:'feature_0'},tools:[{name:'feature_0',run:async()=>({content:'网页正文'})}]});
 const cp=f.steps.find(cp=>cp.tool.endsWith(':write'))!;cp.scopeId='foreign_operation';
 await assert.rejects(()=>f.execute({callModel:async()=>assert.fail('rerun to replace missing checkpoint')}));
});

test('concurrent adapter events only issue one model call through the workflow CAS',async()=>{
 const f=fixture(plan(step('write')));const old=f.run;let calls=0;
 const result=await Promise.allSettled([f.execute({run:old,callModel:async()=>{calls++;return answer('正文');}}),f.execute({run:old,callModel:async()=>{calls++;return answer('正文');}})]);
 assert.equal(calls,1);assert.equal(result.filter(value=>value.status==='fulfilled').length,1);
});
