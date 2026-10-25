import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowRun,runTaskWorkflow,validateWorkflowSpec,workflowProgress,workflowSpecSchema,TaskWorkflowError,type WorkflowBinding,type WorkflowRun,type WorkflowRunner,type WorkflowSpec,type WorkflowStep,type WorkflowStepResult} from './taskWorkflow.js';

const owner:WorkflowBinding={workspaceId:'ws_a',userId:'usr_a',operationId:'op_a'};
const step=(id:string,inputs:string[]=[],extra:Partial<WorkflowStep>={}):WorkflowStep=>({id,title:`处理${id}`,kind:'model',instruction:`完成${id}，私有原始要求不进入公开进度。`,inputs,...extra});
const spec=(...steps:WorkflowStep[]):WorkflowSpec=>({version:1,steps});
const completed=(id:string):WorkflowStepResult=>({state:'completed',checkpointKey:`checkpoint_${id}`,summary:`${id}已有可用成果。`});
const code=(expected:TaskWorkflowError['code'])=>(error:unknown)=>error instanceof TaskWorkflowError&&error.code===expected;
function fixture(plan:WorkflowSpec){
 let stored=createWorkflowRun(plan,owner);const writes:WorkflowRun[]=[];
 const persist:WorkflowRunner['persist']=async(next,expected)=>{
  if(stored.id!==next.id||stored.revision!==next.revision||JSON.stringify(stored.binding)!==JSON.stringify(next.binding)||stored.sequence!==expected||next.sequence!==expected+1)return false;
  stored=structuredClone(next);writes.push(structuredClone(next));return true;
 };
 return {get stored(){return structuredClone(stored);},writes,persist,replace:(run:WorkflowRun)=>{stored=structuredClone(run);},run:(execute:WorkflowRunner['execute'],recover?:WorkflowRunner['recover'],overrides:Partial<WorkflowRunner>={})=>runTaskWorkflow({binding:owner,run:structuredClone(stored),persist,verify:async()=>{},execute,recover,...overrides})};
}

test('workflow spec is bounded, strict, normalized and detached from dispatcher arguments',()=>{
 const raw=spec(step('find',[],{kind:'tool',tool:'knowledge_search'}),step('write',['find'],{executorId:'writer',historyCount:3}),step('draw',['write'],{kind:'feature',featureId:'feature_12',required:false}),step('save',['write'],{kind:'notion'}));
 const parsed=validateWorkflowSpec(raw);assert.equal(parsed.steps[0].required,true);assert.equal(parsed.steps[0].historyCount,0);
 raw.steps[1].inputs.push('draw');assert.deepEqual(parsed.steps[1].inputs,['find']);
 assert.equal(workflowSpecSchema.additionalProperties,false);assert.equal(workflowSpecSchema.properties.steps.items.additionalProperties,false);assert.equal(workflowSpecSchema.properties.steps.maxItems,12);
 assert.equal(validateWorkflowSpec(spec(...Array.from({length:12},(_,i)=>step(`s${i}`)))).steps.length,12);
});

test('unreviewed fields, bindings, cycles, forward references and kind mismatches are rejected',()=>{
 const base=spec(step('one'),step('two',['one']));
 const invalidSpecs:unknown[]=[null,[],{...base,version:2},{...base,workspaceId:'ws_foreign'},spec(),spec(...Array.from({length:13},(_,i)=>step(`s${i}`))),spec(step('same'),step('same')),spec(step('one',['one'])),spec(step('one',['two']),step('two',['one'])),spec(step('one'),step('two',['unknown'])),spec(step('one'),step('two',['one','one'])),spec({...step('one'),kind:'shell' as WorkflowStep['kind']}),spec({...step('one'),kind:{toString:()=> 'model'} as unknown as 'model'}),spec({...step('one'),credentials:'private'} as WorkflowStep),spec(step('one',[],{kind:'feature'})),spec(step('one',[],{kind:'feature',featureId:'feature_1',executorId:'writer'})),spec(step('one',[],{featureId:'feature_1'})),spec(step('one',[],{tool:'web_search'})),spec(step('one',[],{kind:'tool'})),spec(step('one',[],{kind:'tool',tool:'run_command' as 'web_search'})),spec(step('one',[],{kind:'notion',executorId:'writer'})),spec(step('one',[],{id:'one two'})),spec(step('one',[],{instruction:''})),spec(step('one',[],{title:'x'.repeat(81)}))];
 for(const value of invalidSpecs)assert.throws(()=>validateWorkflowSpec(value),code('WORKFLOW_INVALID'));
 for(const historyCount of [-1,21,1.5,'3',true])assert.throws(()=>validateWorkflowSpec(spec({...step('one'),historyCount} as WorkflowStep)),code('WORKFLOW_INVALID'));
 for(const required of [0,'true',null])assert.throws(()=>validateWorkflowSpec(spec({...step('one'),required} as unknown as WorkflowStep)),code('WORKFLOW_INVALID'));
});

test('sequential handlers receive only real input checkpoint keys; bodies are not duplicated in the run',async()=>{
 const f=fixture(spec(step('find',[],{kind:'tool',tool:'knowledge_search'}),step('write',['find']),step('image',['write'],{kind:'feature',featureId:'feature_7'}),step('save',['write','image'],{kind:'notion'})));
 const seen:{id:string;inputs:readonly string[]}[]=[];
 const run=await f.run(async(s,inputs)=>{seen.push({id:s.id,inputs});s.instruction='handler mutation';return completed(s.id);});
 assert.deepEqual(seen,[{id:'find',inputs:[]},{id:'write',inputs:['checkpoint_find']},{id:'image',inputs:['checkpoint_write']},{id:'save',inputs:['checkpoint_write','checkpoint_image']}]);
 assert.equal(run.phase,'completed');assert.equal(f.stored.phase,'completed');assert.equal(run.sequence,8);
 assert.notEqual(run.spec.steps[0].instruction,'handler mutation');assert.equal(JSON.stringify(run).includes('fullBody'),false);
 assert.ok(f.writes.every(w=>w.phase));
});

test('completed workflow and repeated completion events never execute, recover or rewrite progress again',async()=>{
 const f=fixture(spec(step('one'),step('two',['one'])));let executions=0;
 await f.run(async s=>{executions++;return completed(s.id);});const before=f.stored;
 const repeated=await f.run(async()=>assert.fail('completed step executed again'),async()=>assert.fail('completed step recovered again'));
 assert.equal(executions,2);assert.deepEqual(repeated,before);assert.equal(f.writes.length,4);
});

test('simultaneous duplicate events use owner CAS before an execution, not an in-process lock',async()=>{
 const f=fixture(spec(step('save',[],{kind:'notion'})));const snapshot=f.stored;let calls=0;
 const execute:WorkflowRunner['execute']=async()=>{calls++;return completed('save');};
 const values=await Promise.allSettled([f.run(execute,undefined,{run:snapshot}),f.run(execute,undefined,{run:snapshot})]);
 assert.equal(calls,1);assert.equal(values.filter(v=>v.status==='fulfilled').length,1);
 const rejected=values.find(v=>v.status==='rejected') as PromiseRejectedResult;assert.ok(code('WORKFLOW_CHANGED')(rejected.reason));assert.equal(f.stored.phase,'completed');
});

for(const blocking of ['failed','needs_input','waiting'] as const)test(`known required ${blocking} blocks only dependents; independent safe steps continue`,async()=>{
 const f=fixture(spec(step('source'),step('article',['source']),step('independent')));const seen:string[]=[];
 const run=await f.run(async s=>{seen.push(s.id);return s.id==='source'?{state:blocking,summary:'还缺昨天的会议记录。'}:completed(s.id);});
 assert.deepEqual(seen,['source','independent']);assert.equal(run.steps[1].state,'waiting');assert.equal(run.steps[1].waitingFor,'inputs');assert.equal(run.steps[2].state,'completed');
 assert.equal(run.phase,blocking);assert.equal(f.stored.phase,blocking);
});

test('optional failures are preserved, dependent optional work is skipped, independent mandatory delivery completes',async()=>{
 const f=fixture(spec(step('illustrate',[],{required:false}),step('caption',['illustrate'],{required:false}),step('article')));const seen:string[]=[];
 const run=await f.run(async s=>{seen.push(s.id);return s.id==='illustrate'?{state:'failed',summary:'这次配图没有成功。'}:completed(s.id);});
 assert.deepEqual(seen,['illustrate','article']);assert.equal(run.steps[1].state,'skipped');assert.equal(run.phase,'partial');
 const again=await f.run(async()=>assert.fail('terminal step replayed'));assert.deepEqual(again,run);
});

test('a mandatory dependent never consumes a failed optional output, but unrelated work still runs',async()=>{
 const f=fixture(spec(step('source',[],{required:false}),step('dependent',['source']),step('independent')));const seen:string[]=[];
 const run=await f.run(async s=>{seen.push(s.id);return s.id==='source'?{state:'failed'}:completed(s.id);});
 assert.deepEqual(seen,['source','independent']);assert.equal(run.steps[1].state,'waiting');assert.equal(run.phase,'waiting');
});

test('result waiting is recovered read-only; its dependent first executes only after real completion',async()=>{
 const f=fixture(spec(step('save',[],{kind:'notion'}),step('deliver',['save']),step('independent')));let writes=0;const seen:string[]=[];
 await f.run(async s=>{seen.push(s.id);if(s.id==='save'){writes++;return {state:'waiting'};}return completed(s.id);});
 assert.equal(f.stored.steps[0].waitingFor,'result');assert.equal(f.stored.steps[1].waitingFor,'inputs');
 const run=await f.run(async(s,inputs)=>{seen.push(s.id);assert.equal(s.id,'deliver');assert.deepEqual(inputs,['checkpoint_save']);return completed(s.id);},async(s,state)=>{assert.equal(s.id,'save');assert.equal(state.state,'waiting');return completed(s.id);});
 assert.equal(writes,1);assert.deepEqual(seen,['save','independent','deliver']);assert.equal(run.phase,'completed');
});

test('recover returning undefined retains unknown result; an event can still finish independent work',async()=>{
 const f=fixture(spec(step('save'),step('dependent',['save']),step('independent')));const seeded=f.stored;
 seeded.steps[0]={id:'save',state:'waiting',waitingFor:'result'};seeded.phase='waiting';f.replace(seeded);let recoveries=0;
 const run=await f.run(async s=>{assert.equal(s.id,'independent');return completed(s.id);},async()=>{recoveries++;return undefined;});
 assert.equal(recoveries,1);assert.equal(run.steps[0].waitingFor,'result');assert.equal(run.steps[1].waitingFor,'inputs');assert.equal(run.steps[2].state,'completed');assert.equal(run.phase,'waiting');
});

test('unknown execution error stops this turn, retains attempted result, and never automatically retries it',async()=>{
 const f=fixture(spec(step('save',[],{kind:'notion'}),step('independent')));let attempted=0;
 const first=await f.run(async()=>{attempted++;throw new Error('HTTP 401 Bearer PRIVATE api_key=SECRET');});
 assert.equal(first.phase,'waiting');assert.equal(first.steps[0].waitingFor,'result');assert.equal(first.steps[1].state,'queued');assert.doesNotMatch(JSON.stringify(first),/HTTP|Bearer|PRIVATE|SECRET/);
 const second=await f.run(async s=>{assert.equal(s.id,'independent');return completed(s.id);});assert.equal(attempted,1);assert.equal(second.phase,'waiting');
 const third=await f.run(async()=>assert.fail('unknown attempt replayed'),async()=>completed('save'));assert.equal(third.phase,'completed');
});

test('restarted running attempt can only recover; a failed read-only check does not trigger any new execution',async()=>{
 const f=fixture(spec(step('one'),step('two')));const seed=f.stored;seed.steps[0]={id:'one',state:'running'};seed.phase='running';f.replace(seed);
 const first=await f.run(async()=>assert.fail('execution after unknown recovery error'),async()=>{throw new Error('read failed');});assert.equal(first.steps[0].state,'running');assert.equal(first.steps[1].state,'queued');
 const second=await f.run(async s=>{assert.equal(s.id,'two');return completed(s.id);},async(s,state)=>{assert.equal(state.state,'running');return completed(s.id);});assert.equal(second.phase,'completed');
});

test('invalid handler output or missing checkpoint never produces a successful step or raw-output leak',async()=>{
 for(const output of [{state:'completed'},{state:'completed',checkpointKey:'https://private.invalid/?key=secret'},{state:'completed',checkpointKey:'cp_one',fullBody:'private'},{state:'skipped'},{state:'queued'},{state:'waiting',checkpointKey:'cp_one'}]){
  const f=fixture(spec(step('one')));const run=await f.run(async()=>output as WorkflowStepResult);assert.equal(run.phase,'waiting');assert.equal(run.steps[0].waitingFor,'result');assert.equal(run.steps[0].checkpointKey,undefined);assert.doesNotMatch(JSON.stringify(workflowProgress(run)),/private|secret|fullBody|https/);
 }
});

test('fresh authorization checks stop globally before work and after an effect; persisted running cannot replay',async()=>{
 const f=fixture(spec(step('one'),step('two')));let calls=0;
 await assert.rejects(()=>f.run(async s=>{calls++;return completed(s.id);},undefined,{verify:async()=>{throw new Error('foreign token');}}),code('WORKFLOW_VERIFY_FAILED'));assert.equal(calls,0);assert.equal(f.stored.sequence,0);
 let revoked=false;
 await assert.rejects(()=>f.run(async s=>{calls++;revoked=true;return completed(s.id);},undefined,{verify:async()=>{if(revoked)throw new Error('Key revoked');}}),code('WORKFLOW_VERIFY_FAILED'));
 assert.equal(calls,1);assert.equal(f.stored.steps[0].state,'running');assert.equal(f.stored.steps[1].state,'queued');
 const run=await f.run(async s=>{assert.equal(s.id,'two');return completed(s.id);},async()=>completed('one'));assert.equal(run.phase,'completed');assert.equal(calls,1);
});

test('persistence throw or cancellation CAS failure never issues the subsequent execution',async()=>{
 const f=fixture(spec(step('one')));
 await assert.rejects(()=>f.run(async()=>assert.fail('execute after failed persistence'),undefined,{persist:async()=>{throw new Error('database password');}}),code('WORKFLOW_PERSIST_FAILED'));
 await assert.rejects(()=>f.run(async()=>assert.fail('execute after cancellation'),undefined,{persist:async()=>false}),code('WORKFLOW_CHANGED'));
 assert.equal(f.stored.sequence,0);
});

test('lost completion acknowledgement leaves the original running proof for recovery, not execution replay',async()=>{
 const f=fixture(spec(step('one')));let calls=0;
 await assert.rejects(()=>f.run(async s=>{calls++;return completed(s.id);},undefined,{persist:async(next,expected)=>{if(next.steps[0].state==='completed')throw new Error('lost write acknowledgement');return f.persist(next,expected);}}),code('WORKFLOW_PERSIST_FAILED'));
 assert.equal(f.stored.steps[0].state,'running');const run=await f.run(async()=>assert.fail('paid call repeated'),async()=>completed('one'));assert.equal(run.phase,'completed');assert.equal(calls,1);
});

test('foreign scope, changed owner/revision, invalid binding and inconsistent saved state stop before callbacks',async()=>{
 const original=createWorkflowRun(spec(step('one'),step('two',['one'])),owner);let called=0;
 for(const foreign of [{...owner,workspaceId:'ws_b'},{...owner,userId:'usr_b'},{...owner,operationId:'op_b'}])await assert.rejects(()=>runTaskWorkflow({binding:foreign,run:original,persist:async()=>{called++;return true;},verify:async()=>{called++;},execute:async()=>{called++;return completed('one');}}),code('WORKFLOW_BINDING_INVALID'));
 for(const bad of [{...original,id:'arbitrary'},{...original,revision:2}])await assert.rejects(()=>runTaskWorkflow({binding:owner,run:bad,persist:async()=>true,verify:async()=>{called++;},execute:async()=>completed('one')}),code('WORKFLOW_BINDING_INVALID'));
 assert.throws(()=>createWorkflowRun(spec(step('one')),{...owner,workspaceId:''}),code('WORKFLOW_BINDING_INVALID'));
 assert.throws(()=>createWorkflowRun(spec(step('one')),{...owner,secret:'secret'} as WorkflowBinding),code('WORKFLOW_BINDING_INVALID'));
 const inconsistent=structuredClone(original);inconsistent.steps[1]={id:'two',state:'completed',checkpointKey:'cp_two'};
 await assert.rejects(()=>runTaskWorkflow({binding:owner,run:inconsistent,persist:async()=>true,verify:async()=>{called++;},execute:async()=>completed('one')}),code('WORKFLOW_INVALID'));
 assert.equal(called,0);
});

test('plan revisions bind a separate run, while sequence is only the atomic transition counter',()=>{
 const first=createWorkflowRun(spec(step('one')),owner),again=createWorkflowRun(spec(step('one')),owner),revised=createWorkflowRun(spec(step('one')),owner,2);
 assert.equal(first.id,again.id);assert.notEqual(first.id,revised.id);assert.equal(first.sequence,0);assert.equal(revised.sequence,0);
 for(const revision of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>createWorkflowRun(spec(step('one')),owner,revision));
});

test('all-optional untouched workflow remains queued; skipped optional steps finish as partial',async()=>{
 const f=fixture(spec(step('optional',[],{required:false})));assert.equal(workflowProgress(f.stored).status,'queued');
 const run=await f.run(async()=>({state:'skipped'}));assert.equal(run.phase,'partial');assert.equal(workflowProgress(run).status,'partial');
});

test('public progress is an explicit safe projection and cannot expose scope, tools, model, query or bodies',async()=>{
 const f=fixture(spec(step('private',[],{title:'Bearer PRIVATE_SECRET',kind:'tool',tool:'read_notion_document',instruction:'private raw query'}),step('model',['private'],{executorId:'secret_model'})));
 const run=await f.run(async s=>({state:'completed',checkpointKey:`checkpoint_${s.id}`,summary:s.id==='private'?'HTTP authorization api_key=PRIVATE_SECRET':'已完成整理。'}));
 const progress=workflowProgress(run),serialized=JSON.stringify(progress);
 assert.deepEqual(Object.keys(progress).sort(),['next','status','steps','summary']);assert.deepEqual(Object.keys(progress.steps[0]).sort(),['status','summary','title']);
 assert.doesNotMatch(serialized,/ws_a|usr_a|op_a|private raw query|PRIVATE_SECRET|secret_model|read_notion_document|checkpoint_|instruction|executorId|workspaceId|binding/);assert.equal(progress.steps[0].title,'处理这一步');assert.equal(progress.steps[1].summary,'已完成整理。');
});
