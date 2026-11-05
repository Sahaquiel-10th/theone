import test from 'node:test';import assert from 'node:assert/strict';
import {teachingStoryPreviewRequest} from './teachingStoryRequest';
import type {TeachingRequest} from './teachingUploads';
const base='/api/teaching/courses/course-a',payload={kind:'script',activityId:'activity-a',operationId:'original-script-request-001',attachmentIds:['original-file'],content:''};
test('submitting an uploaded script immediately preflights its source then sends the original payload once without a cost gate',async()=>{
 const calls:{path:string;init?:RequestInit}[]=[];const request=(async(path,init)=>{calls.push({path,init});return path.endsWith('/ai')?{operation:{id:'one',status:'running'}}:{valid:true};}) as TeachingRequest;
 const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request,onKnowledgeProblem:()=>assert.fail('valid knowledge')});
 await send(base+'/questions',{method:'POST',body:JSON.stringify(payload)});
 assert.equal(calls.length,2);assert.match(calls[0].path,/purpose=script$/);assert.equal(calls[1].path,base+'/ai');assert.deepEqual(JSON.parse(String(calls[1].init?.body)),{...payload,preview:true,conversationId:'workshop-activity-a'});
});
test('changed authorization still opens repair before any AI operation while retaining the original file and request',async()=>{
 let repairs=0,calls=0;const error=Object.assign(new Error('知识范围已更改'),{status:409,code:'TEACHING_KNOWLEDGE_BINDING_CHANGED'});
 const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request:(async()=>{calls++;throw error;}) as TeachingRequest,onKnowledgeProblem:()=>{repairs++;}});
 await assert.rejects(send(base+'/questions',{method:'POST',body:JSON.stringify(payload)}),(e:any)=>e===error&&e.notStarted);assert.equal(calls,1);assert.equal(repairs,1);assert.deepEqual(payload.attachmentIds,['original-file']);
});
test('existing receipt recovery and file upload use their original routes without starting an AI operation',async()=>{
 const routes:string[]=[];const send=teachingStoryPreviewRequest({base,activityId:'activity-a',request:(async path=>{routes.push(path);return {};}) as TeachingRequest,onKnowledgeProblem:()=>assert.fail('no source change')});
 await send(base+'/operations/original-script-request-001');await send(base+'/uploads',{method:'POST',body:'original file'});assert.deepEqual(routes,[base+'/operations/original-script-request-001',base+'/uploads']);
});
