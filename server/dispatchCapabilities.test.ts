import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDispatchCapabilities,callableCapabilities} from './dispatchCapabilities.js';
import {OrchestrationInputError,runTaskOrchestrator} from './taskOrchestrator.js';
import type {CapabilityCard} from './capabilityCatalog.js';
import type {PlannedTask} from './dispatchPlan.js';
const cards:CapabilityCard[]=[
 {id:'builtin:image_generation',kind:'builtin',mode:'image',name:'图片',description:'画图',version:1,available:true,outputKinds:['image'],tools:[],executorId:'image_generation'},
 {id:'feature:page',featureId:'page',kind:'feature',mode:'text',name:'网页',description:'做网页',version:2,available:true,outputKinds:['text'],tools:['oneHtml']},
 {id:'executor:logic',executorId:'logic',kind:'executor',mode:'text',name:'逻辑',description:'分析',version:1,available:true,outputKinds:['text'],tools:[]},
];
const task=(ids:string[]):PlannedTask=>({taskId:null,title:'合成测试',instruction:'只处理合成材料',executorId:'general',outputKind:'text',featureIds:ids,dependsOn:[]});
test('exact discovered card IDs normalize image, feature and model routes without mutating originals',()=>{
 const old=task(['builtin:image_generation']);const image=resolveDispatchCapabilities(old,cards);
 assert.equal(image.executorId,'image_generation');assert.equal(image.outputKind,'image');assert.deepEqual(image.featureIds,[]);assert.deepEqual(old.featureIds,['builtin:image_generation']);
 assert.deepEqual(resolveDispatchCapabilities(task(['feature:page']),cards).featureIds,['page']);
 assert.deepEqual(resolveDispatchCapabilities(task(['page']),cards).featureIds,['page']);
 assert.equal(resolveDispatchCapabilities({...task([]),capabilityIds:['executor:logic','feature:page']},cards).executorId,'logic');
 assert.deepEqual(resolveDispatchCapabilities({...task(['page']),capabilityIds:['feature:page']},cards).featureIds,['page']);
 assert.deepEqual(callableCapabilities(cards)[0].invocation,{capabilityIds:['builtin:image_generation'],executorId:'image_generation',featureIds:[],outputKind:'image'});
});
test('unknown, foreign, disabled and mixed-effect capabilities cannot gain permission by prefix stripping',()=>{
 for(const id of ['feature:foreign','feature:feature:page','builtin:unknown'])assert.throws(()=>resolveDispatchCapabilities(task([id]),cards),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities(task(['page']),cards.map(c=>({...c,available:false}))),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities(task(['builtin:image_generation','feature:page']),cards),/dependsOn/);
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['executor:logic'],executorId:'writing'},cards),/冲突/);
});
test('reviewed input repair returns controlled feedback and is bounded; provider failures are not replayed',async()=>{
 let calls=0,runs=0;
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:2,maxCorrections:2,beforeStep:async()=>{},tools:[{name:'delegate_task',run:async()=>{runs++;throw new OrchestrationInputError('请从目录选择真实能力');}}],call:async messages=>{
  calls++;if(calls===2){assert.match(messages.at(-1)!.content!,/TOOL_INPUT_REPAIR/);return{content:'工具还没就位，可以稍后继续。',toolCalls:[]};}
  return{content:'',toolCalls:[{id:'first',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({query:'测试'})}}]};
 }});
 assert.equal(calls,2);assert.equal(runs,1);assert.match(result.content,/工具还没就位/);assert.equal(result.trace[0].status,'rejected');
 calls=0;
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],maxSteps:4,maxCorrections:2,beforeStep:async()=>{},tools:[{name:'delegate_task',run:async()=>{throw Error('secret provider error');}}],call:async()=>{calls++;return{content:'',toolCalls:[{id:'first',type:'function',function:{name:'delegate_task',arguments:'{"query":"test"}'}}]};}}),/secret provider/);
 assert.equal(calls,1);
});
