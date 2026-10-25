import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTaskWorkflow,WorkflowPlanningError,type ResolveTaskWorkflowInput,type WorkflowPlanningReason} from './workflowPlanning.js';
import {TaskWorkflowError,type WorkflowSpec,type WorkflowStep} from './taskWorkflow.js';

const base=(values:Partial<ResolveTaskWorkflowInput>={}):ResolveTaskWorkflowInput=>({requiredKnowledge:false,readOnlyNotion:false,notion:false,features:[],requiredFeatureIds:[],instruction:'完成本次用户交代的完整目标，保留约束与自然结尾。',tools:[],executorIds:['writer'],...values});
const step=(id:string,values:Partial<WorkflowStep>={}):WorkflowStep=>({id,title:'当前步骤',kind:'model',instruction:'当前明确步骤指令。',inputs:[],...values});
const plan=(...steps:WorkflowStep[]):WorkflowSpec=>({version:1,steps});
const reason=(expected:WorkflowPlanningReason)=>(error:unknown)=>error instanceof WorkflowPlanningError&&error.reason===expected;

test('a single model or required feature retains the short path and available web is not a search requirement',()=>{
 assert.equal(resolveTaskWorkflow(base({tools:['web_search']})),undefined);
 assert.equal(resolveTaskWorkflow(base({features:[{id:'custom',name:'已选单功能'}],requiredFeatureIds:['custom'],executorIds:[]})),undefined);
});
test('required knowledge uses the complete actual topic as its query rather than a generic instruction',()=>{
 const instruction='从得到大脑查找 ONE-WORKFLOW青色42 会议材料，按原资料写完整方案，不公开，不分享。',spec=resolveTaskWorkflow(base({instruction,requiredKnowledge:true,tools:['knowledge_search','web_search']}))!;
 assert.deepEqual(spec.steps.map(s=>s.kind),['tool','model']);assert.equal(spec.steps[0].tool,'knowledge_search');assert.equal(spec.steps[0].instruction,instruction);assert.deepEqual(spec.steps.at(-1)!.inputs,[spec.steps[0].id]);assert.ok(spec.steps.every(s=>s.required===true&&s.historyCount===0));
 assert.match(spec.steps[0].instruction,/ONE-WORKFLOW青色42/);
 assert.throws(()=>resolveTaskWorkflow(base({requiredKnowledge:true})),reason('tool'));
});
test('required public search needs an explicit public query and never sends the private full goal by default',()=>{
 const instruction='结合我的私人客户方案和预算42，查询上海明日天气。';
 for(const requiredKnowledge of [false,true])assert.throws(()=>resolveTaskWorkflow(base({instruction,requiredKnowledge,tools:['knowledge_search','web_search'],requiredTools:['web_search']})),reason('public_query'));
 const explicit=plan(step('weather',{kind:'tool',tool:'web_search',instruction:'上海明天天气 天气预报'}),step('answer',{inputs:['weather']}));
 const resolved=resolveTaskWorkflow(base({instruction,explicit,tools:['web_search'],requiredTools:['web_search']}))!;
 assert.equal(resolved.steps[0].instruction,'上海明天天气 天气预报');assert.doesNotMatch(resolved.steps[0].instruction,/私人客户|预算42/);
});
test('knowledge to one feature needs no redundant model step and preserves the feature source dependency',()=>{
 const spec=resolveTaskWorkflow(base({requiredKnowledge:true,tools:['knowledge_search'],features:[{id:'image',name:'制作配图'}],requiredFeatureIds:['image'],executorIds:[]}))!;
 assert.deepEqual(spec.steps.map(s=>s.kind),['tool','feature']);assert.equal(spec.steps[1].featureId,'image');assert.deepEqual(spec.steps[1].inputs,[spec.steps[0].id]);
});
test('a Notion manuscript is model then save even without knowledge, and a reviewed HTML conversion consumes both manuscript and saved receipt',()=>{
 const noFeature=resolveTaskWorkflow(base({notion:true,tools:['save_notion_draft']}))!;
 assert.deepEqual(noFeature.steps.map(s=>s.kind),['model','notion']);assert.deepEqual(noFeature.steps[1].inputs,[noFeature.steps[0].id]);
 const html=resolveTaskWorkflow(base({requiredKnowledge:true,notion:true,tools:['knowledge_search','save_notion_draft'],features:[{id:'one-visual-html',name:'交互网页'}],requiredFeatureIds:['one-visual-html']}))!;
 assert.deepEqual(html.steps.map(s=>s.kind),['tool','model','notion','feature']);assert.deepEqual(html.steps[3].inputs,['draft','save']);assert.deepEqual(html.steps[2].inputs,['draft']);assert.deepEqual(html.steps[1].inputs,['source_1']);
 assert.throws(()=>resolveTaskWorkflow(base({notion:true})),reason('notion'));
});
test('default planning never guesses multi-feature order or trusts a webpage-looking name for a post-save conversion',()=>{
 for(const values of [
  {features:[{id:'one-visual-html',name:'网页'},{id:'image',name:'作图'}],requiredFeatureIds:['image','one-visual-html']},
  {notion:true,tools:['save_notion_draft'],features:[{id:'image',name:'作图'}],requiredFeatureIds:['image']},
  {notion:true,tools:['save_notion_draft'],features:[{id:'uploaded',name:'完整交互网页'}],requiredFeatureIds:['uploaded']},
 ])assert.throws(()=>resolveTaskWorkflow(base(values)),reason('ambiguous'));
});
test('an explicit authorized multi-feature recipe is retained rather than reordered by the default recipe',()=>{
 const explicit=plan(step('source',{kind:'tool',tool:'knowledge_search'}),step('picture',{kind:'feature',featureId:'image',inputs:['source']}),step('article',{executorId:'writer',inputs:['picture']}),step('html',{kind:'feature',featureId:'one-visual-html',inputs:['article']}),step('save',{kind:'notion',inputs:['html']}));
 const before=structuredClone(explicit),resolved=resolveTaskWorkflow(base({explicit,requiredKnowledge:true,notion:true,tools:['knowledge_search','save_notion_draft'],features:[{id:'image',name:'作图'},{id:'one-visual-html',name:'网页'}],requiredFeatureIds:['image','one-visual-html']}))!;
 assert.deepEqual(resolved.steps.map(s=>s.id),['source','picture','article','html','save']);assert.deepEqual(explicit,before);explicit.steps[0].instruction='caller later mutation';assert.notEqual(resolved.steps[0].instruction,explicit.steps[0].instruction);
});
test('explicit plans validate all fields and cannot inject bindings, forward references or raw write tools',()=>{
 for(const explicit of [
  {...plan(step('s')),workspaceId:'foreign'},
  plan(step('s',{inputs:['future']}),step('future')),
  plan(step('s',{kind:'tool',tool:'save_notion_draft' as 'knowledge_search'})),
  plan(step('s',{instruction:'x'.repeat(4001)})),
 ] as WorkflowSpec[])assert.throws(()=>resolveTaskWorkflow(base({explicit})),error=>error instanceof TaskWorkflowError&&error.code==='WORKFLOW_INVALID');
});
test('preflight rejects unselected features, unavailable tools and unavailable executor IDs',()=>{
 assert.throws(()=>resolveTaskWorkflow(base({explicit:plan(step('feature',{kind:'feature',featureId:'foreign'}))})),reason('feature'));
 assert.throws(()=>resolveTaskWorkflow(base({explicit:plan(step('read',{kind:'tool',tool:'web_search'}))})),reason('tool'));
 assert.throws(()=>resolveTaskWorkflow(base({explicit:plan(step('model',{executorId:'foreign'}))})),reason('executor'));
 assert.throws(()=>resolveTaskWorkflow(base({explicit:plan(step('model')),executorIds:[]})),reason('executor'));
 assert.throws(()=>resolveTaskWorkflow(base({features:[],requiredFeatureIds:['missing']})),reason('required_feature'));
});
test('required features and required saves cannot be omitted or made optional by a planner',()=>{
 const settings={features:[{id:'feature',name:'必需功能'}],requiredFeatureIds:['feature']};
 assert.throws(()=>resolveTaskWorkflow(base({...settings,explicit:plan(step('model'))})),reason('required_feature'));
 assert.throws(()=>resolveTaskWorkflow(base({...settings,explicit:plan(step('feature',{kind:'feature',featureId:'feature',required:false}))})),reason('required_feature'));
 for(const explicit of [plan(step('model')),plan(step('model'),step('save',{kind:'notion',inputs:['model'],required:false}))])assert.throws(()=>resolveTaskWorkflow(base({notion:true,tools:['save_notion_draft'],explicit})),reason('required_tool'));
 assert.throws(()=>resolveTaskWorkflow(base({requiredTools:['save_notion_draft']})),reason('notion'));
});
test('mandatory knowledge must be required and flow through transitive ancestry to every later producer',()=>{
 const good=plan(step('source',{kind:'tool',tool:'knowledge_search'}),step('article',{inputs:['source']}),step('save',{kind:'notion',inputs:['article']}));
 assert.deepEqual(resolveTaskWorkflow(base({requiredKnowledge:true,notion:true,tools:['knowledge_search','save_notion_draft'],explicit:good}))!.steps.at(-1)!.inputs,['article']);
 const invalid=[
  plan(step('source',{kind:'tool',tool:'knowledge_search'}),step('article')),
  plan(step('source',{kind:'tool',tool:'knowledge_search',required:false}),step('article',{inputs:['source']})),
  plan(step('article'),step('source',{kind:'tool',tool:'knowledge_search'})),
  plan(step('source',{kind:'tool',tool:'knowledge_search'}),step('article',{inputs:['source']}),step('save',{kind:'notion'})),
 ];
 for(const explicit of invalid)assert.throws(()=>resolveTaskWorkflow(base({requiredKnowledge:true,tools:['knowledge_search','save_notion_draft'],notion:explicit.steps.some(s=>s.kind==='notion'),explicit})),error=>error instanceof WorkflowPlanningError&&['source_dependency','required_tool','notion_input'].includes(error.reason));
});
test('explicit required web search and current document reads cannot be satisfied by disconnected source steps',()=>{
 for(const name of ['web_search','read_notion_document'] as const){
  assert.throws(()=>resolveTaskWorkflow(base({requiredTools:[name],tools:[name],explicit:plan(step('source',{kind:'tool',tool:name}),step('article'))})),reason('source_dependency'));
  assert.ok(resolveTaskWorkflow(base({requiredTools:[name],tools:[name],explicit:plan(step('source',{kind:'tool',tool:name}),step('article',{inputs:['source']}))})));
 }
});
test('read-only Notion uses the actual read and never admits a write or a missing read in an explicit workflow',()=>{
 const read=resolveTaskWorkflow(base({readOnlyNotion:true,notion:true,tools:['read_notion_document']}))!;
 assert.deepEqual(read.steps.map(s=>s.kind),['tool','model']);assert.equal(read.steps[0].tool,'read_notion_document');assert.equal(read.steps.some(s=>s.kind==='notion'),false);
 assert.throws(()=>resolveTaskWorkflow(base({readOnlyNotion:true,notion:true,tools:['read_notion_document','save_notion_draft'],explicit:plan(step('read',{kind:'tool',tool:'read_notion_document'}),step('save',{kind:'notion',inputs:['read']}))})),reason('readonly'));
 assert.throws(()=>resolveTaskWorkflow(base({readOnlyNotion:true,notion:true,tools:['read_notion_document'],explicit:plan(step('article'))})),reason('required_tool'));
 assert.throws(()=>resolveTaskWorkflow(base({readOnlyNotion:true,requiredTools:['save_notion_draft']})),reason('readonly'));
 assert.throws(()=>resolveTaskWorkflow(base({explicit:plan(step('save',{kind:'notion'})),tools:['save_notion_draft']})),reason('notion'));
});
test('feature-owned lower-level tools are deferred only when an authorized required feature is actually present',()=>{
 const settings={features:[{id:'html',name:'网页'}],requiredFeatureIds:['html'],requiredTools:['oneHtml']};
 assert.ok(resolveTaskWorkflow(base({...settings,requiredKnowledge:true,tools:['knowledge_search']})));
 assert.equal(resolveTaskWorkflow(base(settings)),undefined);
 assert.throws(()=>resolveTaskWorkflow(base({requiredTools:['oneHtml'],explicit:plan(step('article'))})),reason('required_tool'));
 assert.throws(()=>resolveTaskWorkflow(base({requiredTools:['oneHtml']})),reason('required_tool'));
});
test('Notion admission requires a direct model or feature manuscript, not a read or a transitive save reference',()=>{
 const settings={notion:true,tools:['read_notion_document','save_notion_draft']};
 for(const explicit of [plan(step('save',{kind:'notion'})),plan(step('read',{kind:'tool',tool:'read_notion_document'}),step('save',{kind:'notion',inputs:['read']})),plan(step('draft'),step('save1',{kind:'notion',inputs:['draft']}),step('save2',{kind:'notion',inputs:['save1']}))])assert.throws(()=>resolveTaskWorkflow(base({...settings,explicit})),reason('notion_input'));
 assert.ok(resolveTaskWorkflow(base({...settings,explicit:plan(step('draft'),step('save',{kind:'notion',inputs:['draft']}))})));
 assert.ok(resolveTaskWorkflow(base({...settings,features:[{id:'article',name:'正文功能'}],requiredFeatureIds:['article'],explicit:plan(step('article',{kind:'feature',featureId:'article'}),step('save',{kind:'notion',inputs:['article']}))})));
});
test('long owning goals stay intact while an oversized default knowledge query is rejected rather than clipped',()=>{
 const instruction='目标开头\n'+'完整用户限制与正文；不要截断。'.repeat(1500)+'\n目标唯一结尾';
 const request=base({instruction,notion:true,tools:['save_notion_draft']}),before=structuredClone(request),spec=resolveTaskWorkflow(request)!;
 assert.deepEqual(request,before);assert.equal(request.instruction,instruction);assert.ok(spec.steps.every(s=>s.instruction.length<4000));assert.doesNotMatch(JSON.stringify(spec),/目标唯一结尾|目标开头/,'the caller sends the full instruction once as context goal, not inside every stage');
 assert.throws(()=>resolveTaskWorkflow({...request,requiredKnowledge:true,tools:['knowledge_search','save_notion_draft']}),error=>error instanceof TaskWorkflowError&&error.code==='WORKFLOW_INVALID');assert.equal(request.instruction,instruction);
 const exact='检索主题：'+'青'.repeat(4000-'检索主题：'.length),accepted=resolveTaskWorkflow(base({instruction:exact,requiredKnowledge:true,tools:['knowledge_search']}))!;assert.equal(accepted.steps[0].instruction,exact);assert.equal(accepted.steps[0].instruction.length,4000);
});
