import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeFixedWorkflow,onboardingWorkflow,validateFixedWorkflowInvocation,sameFixedWorkflowInvocation,onboardingArtifactStages} from './fixedWorkflows.js';
test('the official onboarding recipe exposes one callable capability and immutable ordered stages',async()=>{
 let calls=0,checks=0;
 const result=await invokeFixedWorkflow({id:'onboarding_guide',trigger:'onboarding.complete',scope:{workspaceId:'wa',userId:'a'}},{authorize:async()=>{checks++;},run:async invocation=>{calls++;assert.deepEqual(invocation,{id:'onboarding_guide',version:1,trigger:'onboarding.complete'});return 'existing durable task';}});
 assert.equal(result,'existing durable task');assert.equal(calls,1);assert.equal(checks,1);
 assert.deepEqual(onboardingWorkflow.stages.map(stage=>stage.id),['oneManual','image_generation','oneFlowchart','oneHtml']);
 assert.deepEqual(onboardingArtifactStages.map(stage=>stage.tool),['oneFlowchart','oneHtml']);
 for(const input of [{id:'unknown',trigger:'onboarding.complete'},{id:'onboarding_guide',trigger:'chat'},{id:'onboarding_guide',trigger:'onboarding.complete',scope:{workspaceId:'',userId:'a'}}])await assert.rejects(()=>invokeFixedWorkflow({scope:{workspaceId:'wa',userId:'a'},...input},{authorize:async()=>{checks++;},run:async()=>{calls++;}}));
 await assert.rejects(()=>invokeFixedWorkflow({id:'onboarding_guide',trigger:'onboarding.remake',scope:{workspaceId:'wb',userId:'b'}},{authorize:async()=>{throw Error('not authorized');},run:async()=>{calls++;}}));
 assert.equal(calls,1);assert.equal(checks,1);
 assert.throws(()=>validateFixedWorkflowInvocation({id:'onboarding_guide',version:99,trigger:'onboarding.complete'} as any));
 assert.equal(sameFixedWorkflowInvocation({id:'onboarding_guide',version:1,trigger:'onboarding.complete'},JSON.parse('{"trigger":"onboarding.complete","version":1,"id":"onboarding_guide"}')),true);
 assert.equal(sameFixedWorkflowInvocation({id:'onboarding_guide',version:1,trigger:'onboarding.complete'},{id:'onboarding_guide',version:1,trigger:'onboarding.remake'}),false);
});
