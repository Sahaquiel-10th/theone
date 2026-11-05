import test from 'node:test';import assert from 'node:assert/strict';
import {createTeachingBudgetGate,teachingStoryPreviewRequest} from './teachingStoryRequest';
import type {TeachingRequest} from './teachingUploads';
const base='/api/teaching/courses/course-a',payload={kind:'script',activityId:'activity-a',operationId:'original-script-request-001',attachmentIds:['original-file'],content:''};
test('a script upload waits for the explicit budget dialog then continues the original payload exactly once',async()=>{
 const gate=createTeachingBudgetGate(),calls:{path:string;init?:RequestInit}[]=[];let requested=0;const request=(async(path,init)=>{calls.push({path,init});return path.endsWith('/ai')?{operation:{id:'one',status:'running'}}:{valid:true};}) as TeachingRequest;
 const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request,budgetConfirmed:()=>false,confirmBudget:()=>{requested++;return gate.wait();},onKnowledgeProblem:()=>assert.fail('valid knowledge')});
 const pending=send(base+'/questions',{method:'POST',body:JSON.stringify(payload)});await new Promise(resolve=>setImmediate(resolve));assert.equal(requested,1);assert.equal(calls.length,1);assert.equal(gate.waiting,true);gate.settle(true);await pending;
 assert.equal(calls.length,2);assert.equal(calls[1].path,base+'/ai');assert.deepEqual(JSON.parse(String(calls[1].init?.body)),{...payload,budgetConfirmed:true,preview:true,conversationId:'workshop-activity-a'});
});
test('cancel and page unmount settle the wait without sending a paid request or altering attachments',async()=>{
 const gate=createTeachingBudgetGate(),calls:string[]=[];const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request:(async path=>{calls.push(path);return {valid:true};}) as TeachingRequest,budgetConfirmed:()=>false,confirmBudget:()=>gate.wait(),onKnowledgeProblem:()=>{}});
 const pending=send(base+'/questions',{method:'POST',body:JSON.stringify(payload)});await new Promise(resolve=>setImmediate(resolve));gate.settle(false);await assert.rejects(pending,(error:any)=>error.code==='TEACHING_PREVIEW_CANCELLED'&&error.notStarted===true);assert.equal(calls.length,1);assert.deepEqual(payload.attachmentIds,['original-file']);assert.equal(gate.waiting,false);
 const a=gate.wait(),b=gate.wait();assert.equal(a,b);gate.settle(false);assert.equal(await a,false);
});
test('changed authorization opens repair before budget confirmation and before creating any operation',async()=>{
 let confirms=0,repairs=0,calls=0;const error=Object.assign(new Error('知识范围已更改'),{status:409,code:'TEACHING_KNOWLEDGE_BINDING_CHANGED'});
 const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request:(async()=>{calls++;throw error;}) as TeachingRequest,budgetConfirmed:()=>false,confirmBudget:async()=>{confirms++;return true;},onKnowledgeProblem:()=>{repairs++;}});
 await assert.rejects(send(base+'/questions',{method:'POST',body:JSON.stringify(payload)}),(e:any)=>e===error&&e.notStarted);assert.equal(calls,1);assert.equal(confirms,0);assert.equal(repairs,1);
});
test('existing operation recovery and attachment upload bypass the confirmation gate and keep their exact routes',async()=>{
 const routes:string[]=[];const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request:(async path=>{routes.push(path);return {};}) as TeachingRequest,budgetConfirmed:()=>false,confirmBudget:async()=>assert.fail('no paid action'),onKnowledgeProblem:()=>assert.fail('no source change')});
 await send(base+'/operations/original-script-request-001');await send(base+'/uploads',{method:'POST',body:'original file'});assert.deepEqual(routes,[base+'/operations/original-script-request-001',base+'/uploads']);
});
