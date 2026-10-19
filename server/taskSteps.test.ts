import test from 'node:test';
import assert from 'node:assert/strict';
import {runTaskOrchestrator} from './taskOrchestrator.js';
import {taskStepKey,completedSteps,toolSucceeded,stepProgress,type TaskStep,type TaskStepStore} from './taskSteps.js';
test('rephrased recovery supersedes only the same delivery failure, not independent reads or uncertain saves',()=>{
 const base={namespace:'worker',tool:'feature_2',label:'预算表',effect:'model' as const,updatedAt:'now'};
 const old:TaskStep={...base,key:'old',state:'failed'};
 const done:TaskStep={...base,key:'new',state:'completed',output:{content:'真实结果'}};
 assert.deepEqual(stepProgress([old,done]),{completed:['预算表'],pending:[]});assert.equal(old.state,'failed');
 assert.deepEqual(stepProgress([old,{...done,namespace:'foreign'}]).pending,['预算表']);
 assert.deepEqual(stepProgress([{...old,namespace:'source',tool:'knowledge_search',label:'另一个查询',effect:'read'}, {...done,namespace:'source',tool:'knowledge_search',effect:'read'}]).pending,['另一个查询']);
 const started={...old,tool:'oneWorkbook',effect:'artifact' as const,state:'started' as const};
 assert.deepEqual(stepProgress([started,{...done,tool:'oneWorkbook',effect:'artifact'}]).pending,['预算表']);
});
test('unavailable and unconfigured tools never satisfy required steps or become reusable completed work',async()=>{
  for(const status of ['unavailable','not_configured','needs_input']){
    assert.equal(toolSucceeded({status}),false);
    let calls=0;const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[{name:'web_search',run:async()=>({status})}],requiredTools:['web_search'],maxSteps:2,beforeStep:async()=>{},call:async()=>++calls===1?{content:'',toolCalls:[{id:'x',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'public'})}}]}:{content:'没查成',toolCalls:[]}});
    assert.deepEqual(result.requiredMissing,['web_search']);
  }
});
const reply=(content:string)=>({content,toolCalls:[]});
const call=(name:string,query='goal')=>({id:name,type:'function' as const,function:{name,arguments:JSON.stringify({query})}});
function checkpoints(namespace='worker'){
  const steps:TaskStep[]=[];const store:TaskStepStore={namespace,steps,save:async s=>{const i=steps.findIndex(p=>p.key===s.key);if(i<0)steps.push(s);else steps[i]=s;}};
  return store;
}
test('one failed feature does not abort independent work, and explicit retry reuses the completed feature even if rephrased',async()=>{
  const store=checkpoints();let first=0,second=0,round=0;
  const tools=[{name:'feature_0',label:'文案',effect:'model' as const,tolerateFailure:true,run:async()=>{first++;return {content:'真实文案'};}},{name:'feature_1',label:'网页',effect:'model' as const,tolerateFailure:true,run:async()=>{second++;if(second===1)throw Error('private provider error');return{content:'真实网页'};}}];
  const run=async(query:string)=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools,checkpoints:store,requiredTools:['feature_0','feature_1'],maxSteps:2,beforeStep:async()=>{},call:async()=>++round%2?{content:'',toolCalls:[call('feature_0',query),call('feature_1')]}:reply('实际结果')});
  const partial=await run('first');assert.deepEqual(partial.requiredMissing,['feature_1']);assert.equal(first,1);assert.equal(second,1);assert.equal(completedSteps(store.steps).length,1);
  const done=await run('changed words');assert.deepEqual(done.requiredMissing,[]);assert.equal(first,1);assert.equal(second,2);assert.equal(completedSteps(store.steps).length,2);
  assert.doesNotMatch(JSON.stringify(partial.trace),/private provider error/);
});
test('uncertain side effect blocks duplicate writes, and revocation also blocks reuse',async()=>{
  const store=checkpoints();let writes=0;
  const options={entryPoint:'workspace' as const,messages:[],tools:[{name:'oneHtml',effect:'artifact' as const,run:async()=>{writes++;throw Error('lost receipt');}}],checkpoints:store,maxSteps:2,beforeStep:async()=>{},call:async()=>({content:'',toolCalls:[call('oneHtml')]})};
  await assert.rejects(runTaskOrchestrator(options),/lost receipt/);assert.equal(writes,1);assert.equal(store.steps[0].state,'started');
  await assert.rejects(runTaskOrchestrator(options),/不会重复写入/);assert.equal(writes,1);
  await assert.rejects(runTaskOrchestrator({...options,call:async()=>({content:'',toolCalls:[call('oneHtml','rephrased goal')]})}),/不会重复写入/);assert.equal(writes,1);
  store.steps[0]={...store.steps[0],state:'completed',output:{file:{id:'private'}}};
  await assert.rejects(runTaskOrchestrator({...options,beforeStep:async()=>{throw Error('revoked');}}),/revoked/);assert.equal(writes,1);
});
test('mandatory actions require a successful tool receipt, not model claims or an old foreign namespace',async()=>{
  const store=checkpoints();store.steps.push({key:taskStepKey('other','knowledge_search','goal'),namespace:'other',tool:'knowledge_search',label:'查资料',effect:'read',state:'completed',output:{status:'used'},updatedAt:'now'});
  let rounds=0;
  const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[{name:'knowledge_search',run:async()=>({status:'failed'})}],checkpoints:store,requiredTools:['knowledge_search'],maxSteps:3,beforeStep:async()=>{},call:async()=>{rounds++;return reply('已经全部查过了');}});
  assert.deepEqual(result.requiredMissing,['knowledge_search']);assert.equal(rounds,3);
});
test('a bounded task can compose four authorized features in one round without creating extra tasks',async()=>{
  const store=checkpoints();let round=0,runs=0;const names=Array.from({length:4},(_,i)=>`feature_${i}`);
  const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:names.map(name=>({name,run:async()=>{runs++;return{content:name};}})),checkpoints:store,requiredTools:names,maxSteps:2,beforeStep:async()=>{},call:async()=>++round===1?{content:'',toolCalls:names.map(name=>call(name))}:reply('成果')});
  assert.equal(runs,4);assert.deepEqual(result.requiredMissing,[]);
});
