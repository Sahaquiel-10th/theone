import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverCapabilities,initialCapabilityContext,validateDiscoveryQuery} from './capabilityDiscovery.js';
import {validateDiscoveryMetadata} from './discoveryMetadata.js';
import type {CapabilityCard} from './capabilityCatalog.js';
import {capabilityDiscoveryEnabled,defaultTaskValues,editableTaskValues,validateTaskValues} from './aiTaskConfig.js';
const card=(id:string,extra:Partial<CapabilityCard>={}):CapabilityCard=>({id:`feature:${id}`,featureId:id,kind:'feature',mode:'text',name:id,description:'通用说明',version:1,available:true,outputKinds:['text'],tools:[],...extra});
test('legacy dispatchers gain discovery without snapshot mutation, but a later explicit disable is respected',()=>{
 const legacy={...defaultTaskValues('coordinator'),capabilityDiscoveryVersion:undefined,tools:['delegate_task']};
 assert.equal(capabilityDiscoveryEnabled(legacy),true);
 const editable=editableTaskValues('coordinator',legacy);assert.ok(editable.tools.includes('discover_capabilities'));assert.deepEqual(legacy.tools,['delegate_task']);
 const disabled=validateTaskValues('coordinator',{...editable,tools:editable.tools.filter(name=>name!=='discover_capabilities')},[]);
 assert.equal(disabled.capabilityDiscoveryVersion,1);assert.equal(capabilityDiscoveryEnabled(disabled),false);
 assert.equal(capabilityDiscoveryEnabled({...disabled,tools:[...disabled.tools,'discover_capabilities']}),true);
});
test('large libraries yield a bounded shortlist, keep explicit selections and discover less common capabilities on demand',()=>{
 const cards=Array.from({length:400},(_,i)=>card(`feature-${i}`,{name:`测试能力${i}`,description:'普通材料整理'}));
 cards.push(card('rare',{name:'天文观测日志',description:'规划望远镜观测',discovery:{aliases:['望远镜排期']}}));
 const initial=initialCapabilityContext(cards,'你好',['feature-399']);
 assert.deepEqual(initial.map(c=>c.featureId),['feature-399']);
 assert.ok(JSON.stringify(initial).length<JSON.stringify(cards).length/50);
 assert.equal(discoverCapabilities(cards,{query:'望远镜排期'}).items[0].featureId,'rare');
 const first=discoverCapabilities(cards,{query:'材料'}),second=discoverCapabilities(cards,{query:'材料',offset:first.nextOffset});
 assert.equal(first.total,400);assert.equal(first.items.length,8);assert.equal(new Set([...first.items,...second.items].map(c=>c.id)).size,16);
 assert.equal(discoverCapabilities(cards,{query:'完全不存在的紫外线螺丝刀'}).total,0);
});
test('industry is a preference, not a wall; general marketing and specialist pet tools can work together',()=>{
 const cards=[card('pet',{name:'门店营销',category:'store',discovery:{industries:['宠物'],scenarios:['开业促销']}}),card('general',{name:'营销文案',category:'writing'}),card('unrelated-pet',{name:'体检预约',discovery:{industries:['宠物']}}),card('off',{name:'营销功能',available:false})];
 assert.deepEqual(discoverCapabilities(cards,{query:'营销',industry:'宠物'}).items.map(c=>c.featureId),['pet','general']);
 assert.deepEqual(discoverCapabilities(cards,{query:'营销',outputKind:'image'}).items,[]);
 assert.deepEqual(discoverCapabilities(cards,{query:'营销',category:'writing'}).items.map(c=>c.featureId),['general']);
});
test('required base executors and selected features stay available while unrelated functions are not stuffed into context',()=>{
 const cards=[card('worker',{kind:'executor',executorId:'logic'}),card('writer',{kind:'executor',executorId:'writing'}),card('selected'),card('other')];
 assert.deepEqual(initialCapabilityContext(cards,'你好',['selected']).map(c=>c.id).sort(),['feature:selected','feature:worker','feature:writer']);
});
test('routing metadata is bounded and cannot supply credentials, scripts or new authorization',()=>{
 assert.deepEqual(validateDiscoveryMetadata({industries:['宠物','宠物'],aliases:[' 攻略 '],avoidWhen:'不适用一句话回答'}),{industries:['宠物'],aliases:['攻略'],avoidWhen:'不适用一句话回答'});
 for(const value of [null,[],{apiKey:'secret'},{instructions:'run'},{industries:['']},{scenarios:Array(13).fill('x')},{avoidWhen:1}])assert.throws(()=>validateDiscoveryMetadata(value));
 for(const value of [{query:'x',workspaceId:'foreign'},{query:'x',offset:-1},{query:'x',offset:.5},{query:'x',category:'unknown'},{query:'x',industry:3},{query:'x'.repeat(301)}])assert.throws(()=>validateDiscoveryQuery(value));
});
