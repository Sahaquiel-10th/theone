import test from 'node:test';
import assert from 'node:assert/strict';
import {runTaskOrchestrator} from './taskOrchestrator.js';
import {localSkillTool} from './skillLocalTools.js';
import type {TaskStep,TaskStepStore} from './taskSteps.js';

const toolCall=(id:string,operation:string,data:unknown)=>({id,type:'function' as const,function:{name:'oneFinance',arguments:JSON.stringify({operation,dataJson:JSON.stringify(data)})}});
function checkpoints():TaskStepStore {
  const steps:TaskStep[]=[];
  return {namespace:'feature:finance:1',steps,save:async step=>{const index=steps.findIndex(s=>s.key===step.key);if(index<0)steps.push(step);else steps[index]=step;}};
}
test('a feature can calculate three cases with distinct real results and reuse only exact read inputs',async()=>{
  const saved=checkpoints();let checks=0,calls=0;
  const tool=localSkillTool('oneFinance','测算',async()=>{checks++;},{saveTable:async()=>{assert.fail('pure calculation must not export');}});
  const batch=[4,6,10].map(n=>toolCall(`profit-${n}`,'profit',{revenue:n*50,variableCost:n*15,fixedCost:120,quantity:n}));
  const run=()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:2,maxToolCallsPerTurn:4,checkpoints:saved,beforeStep:async()=>{},call:async()=>++calls%2?{content:'',toolCalls:batch}:{content:'三组结果已返回',toolCalls:[]}});
  const first=await run();
  assert.deepEqual(first.trace.map(t=>JSON.parse(t.resultPreview!).operatingProfit),[20,90,230]);
  assert.deepEqual(saved.steps.map(s=>s.effect),['read','read','read']);assert.equal(checks,6);
  const reused=await run();assert.equal(checks,6);assert.deepEqual(reused.trace.map(t=>t.status),['reused','reused','reused']);
  assert.deepEqual(reused.trace.map(t=>JSON.parse(t.resultPreview!).operatingProfit),[20,90,230]);
});
test('three promotion cases are not replaced by the first case',async()=>{
  const saved=checkpoints();let calls=0;
  const tool=localSkillTool('oneFinance','优惠',async()=>{},{saveTable:async()=>{assert.fail('must not export');}});
  const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:2,maxToolCallsPerTurn:4,checkpoints:saved,beforeStep:async()=>{},call:async()=>++calls===1?{content:'',toolCalls:[0,2.5,10].map(discount=>toolCall(`promo-${discount}`,'promotion',{price:50,discount,variableCost:15,giftCost:0,channelRate:0,fixedCampaignCost:120,participants:6}))}:{content:'好了',toolCalls:[]}});
  assert.deepEqual(result.trace.map(t=>JSON.parse(t.resultPreview!).campaignProfit),[90,75,30]);
});
test('completed quote cannot replace a calculation and an uncertain export still blocks duplicate writes',async()=>{
  for(const failExport of [false,true]){
    const saved=checkpoints();let calls=0,exports=0;
    const tool=localSkillTool('oneFinance','金额',async()=>{},{saveTable:async()=>{exports++;if(failExport)throw Error('lost export receipt');return{id:'private-file',name:'报价单.xlsx'};}});
    const quote=toolCall('quote','quote',{items:[{name:'测试',unit:'份',quantity:1,unitPrice:50}],shipping:0,taxRate:0,pricesIncludeTax:true});
    const run=(batch:typeof quote[])=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:2,maxToolCallsPerTurn:4,checkpoints:saved,beforeStep:async()=>{},call:async()=>++calls%2?{content:'',toolCalls:batch}:{content:'返回',toolCalls:[]}});
    if(failExport){await assert.rejects(run([quote]),/lost export receipt/);assert.equal(saved.steps[0].state,'started');calls=0;await assert.rejects(run([quote]),/不会重复写入/);}
    else {await run([quote]);const result=await run([toolCall('profit','profit',{revenue:300,variableCost:90,fixedCost:120,quantity:6})]);assert.equal(JSON.parse(result.trace[0].resultPreview!).operatingProfit,90);assert.equal(saved.steps[1].effect,'read');}
    assert.equal(exports,1);
  }
});
test('batch bounds, public ceiling, duplicates and cancellation remain enforced before handlers',async()=>{
  const makeCall=(id:string)=>({id,type:'function' as const,function:{name:'knowledge_search',arguments:JSON.stringify({query:id})}});
  const batch=Array.from({length:3},(_,i)=>makeCall(String(i)));let runs=0;
  const options={entryPoint:'workspace' as const,messages:[],tools:[{name:'knowledge_search',run:async()=>{runs++;return{};}}],maxSteps:2,maxToolCallsPerTurn:4,beforeStep:async()=>{},call:async()=>({content:'',toolCalls:batch})};
  for(const max of [0,5,NaN,Infinity,2.5])await assert.rejects(runTaskOrchestrator({...options,maxToolCallsPerTurn:max,call:async()=>assert.fail('invalid config must fail before model charge')}),/配置无效/);
  await assert.rejects(runTaskOrchestrator({...options,entryPoint:'published_web'}),/过多或重复/);
  await assert.rejects(runTaskOrchestrator({...options,call:async()=>({content:'',toolCalls:[...batch,makeCall('3'),makeCall('4')]})}),/过多或重复/);
  await assert.rejects(runTaskOrchestrator({...options,call:async()=>({content:'',toolCalls:[batch[0],batch[0]]})}),/过多或重复/);assert.equal(runs,0);
  let checks=0;
  await assert.rejects(runTaskOrchestrator({...options,beforeStep:async()=>{if(++checks===4)throw Error('revoked or cancelled');}}),/revoked or cancelled/);assert.equal(runs,2);
});
