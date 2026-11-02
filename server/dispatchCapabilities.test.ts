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
 {id:'knowledge:source-a',sourceId:'source-a',kind:'knowledge',mode:'text',name:'得到大脑',description:'按需查资料',version:1,available:true,outputKinds:['text'],tools:['knowledge_search']},
];
const task=(ids:string[]):PlannedTask=>({taskId:null,title:'合成测试',instruction:'只处理合成材料',executorId:'general',outputKind:'text',featureIds:ids,dependsOn:[]});
test('exact discovered card IDs normalize image, feature and model routes without mutating originals',()=>{
 const queryCard={id:'builtin:public_web_search',kind:'builtin' as const,mode:'text' as const,name:'联网',description:'查公开网页',version:1,available:true,outputKinds:['text' as const],tools:['web_search'],readOnlyTool:'web_search' as const};
 assert.deepEqual(callableCapabilities([queryCard])[0].invocation,{tool:'web_search'});
 assert.deepEqual(resolveDispatchCapabilities(task([queryCard.id]),[queryCard]).requiredTools,['web_search']);
 const old=task(['builtin:image_generation']);const image=resolveDispatchCapabilities(old,cards);
 assert.equal(image.executorId,'image_generation');assert.equal(image.outputKind,'image');assert.deepEqual(image.featureIds,[]);assert.deepEqual(old.featureIds,['builtin:image_generation']);
 assert.deepEqual(resolveDispatchCapabilities(task(['feature:page']),cards).featureIds,['page']);
 assert.deepEqual(resolveDispatchCapabilities(task(['page']),cards).featureIds,['page']);
 assert.equal(resolveDispatchCapabilities({...task([]),capabilityIds:['executor:logic','feature:page']},cards).executorId,'logic');
 assert.deepEqual(resolveDispatchCapabilities({...task(['page']),capabilityIds:['feature:page']},cards).featureIds,['page']);
 assert.deepEqual(callableCapabilities(cards)[0].invocation,{capabilityIds:['builtin:image_generation'],executorId:'image_generation',featureIds:[],outputKind:'image'});
});
test('authorized knowledge and query cards bind required reads without becoming executable features',()=>{
 const query:CapabilityCard={id:'builtin:public_web_search',kind:'builtin',mode:'text',name:'联网',description:'查公开网页',version:1,available:true,outputKinds:['text'],tools:['web_search'],readOnlyTool:'web_search'};
 const original:PlannedTask={...task([]),executorId:'logic',capabilityIds:['executor:logic','knowledge:source-a',query.id]};
 const resolved=resolveDispatchCapabilities(original,[...cards,query]);
 assert.equal(resolved.executorId,'logic');assert.deepEqual(resolved.featureIds,[]);assert.deepEqual(resolved.knowledgeSourceIds,['source-a']);assert.deepEqual(resolved.requiredTools,['knowledge_search','web_search']);
 assert.equal(original.knowledgeSourceIds,undefined);assert.deepEqual(original.featureIds,[]);
 assert.equal(resolveDispatchCapabilities({...task([]),knowledgeSourceIds:['foreign']},cards).knowledgeSourceIds,undefined,'only resolved cards may produce internal source bindings');
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['knowledge:foreign']},cards),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['knowledge:source-a']},cards.map(c=>c.kind==='knowledge'?{...c,available:false}:c)),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['knowledge:source-a'],knowledge:'none'},cards),/冲突/);
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['knowledge:source-a']},cards.map(c=>c.kind==='knowledge'?{...c,sourceId:'other'}:c)),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:[query.id]},[{...query,tools:[]}]),OrchestrationInputError);
});
test('unknown, foreign, disabled and mixed-effect capabilities cannot gain permission by prefix stripping',()=>{
 for(const id of ['feature:foreign','feature:feature:page','builtin:unknown'])assert.throws(()=>resolveDispatchCapabilities(task([id]),cards),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities(task(['page']),cards.map(c=>({...c,available:false}))),OrchestrationInputError);
 assert.throws(()=>resolveDispatchCapabilities(task(['builtin:image_generation','feature:page']),cards),/dependsOn/);
 assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['executor:logic'],executorId:'writing'},cards),/冲突/);
});
test('dedicated image and local handoffs cannot silently discard referenced knowledge or public reads',()=>{
 const query:CapabilityCard={id:'builtin:public_web_search',kind:'builtin',mode:'text',name:'联网',description:'查公开网页',version:1,available:true,outputKinds:['text'],tools:['web_search'],readOnlyTool:'web_search'};
 const local:CapabilityCard={id:'builtin:codex_execution',kind:'builtin',mode:'local',name:'本机',description:'本机操作',version:1,available:true,outputKinds:['local_file'],tools:[],executorId:'local_special'};
 for(const read of ['knowledge:source-a',query.id]){
  assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:['builtin:image_generation',read]},[...cards,query,local]),/先单独读取/);
  assert.throws(()=>resolveDispatchCapabilities({...task([]),capabilityIds:[local.id,read]},[...cards,query,local]),/先单独读取/);
  assert.throws(()=>resolveDispatchCapabilities({...task([]),title:'生成海报',capabilityIds:[read]},[...cards,query,local]),/先单独读取/);
 }
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
