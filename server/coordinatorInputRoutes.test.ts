import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {installCoordinatorRoutes} from './coordinatorRoutes.js';
import type {Database} from './types.js';
import type {ChatOperation} from './chatOperations.js';

const owner={workspaceId:'wa',userId:'ua'};
async function fixture(t:TestContext){
 const stamp=new Date().toISOString();
 const db={users:[{id:'ua',enabled:true},{id:'ub',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'ua'},{workspaceId:'wb',userId:'ub'}],models:[],settings:{},conversations:[{...owner,id:'owned-task',archived:false,messages:[],createdAt:stamp,updatedAt:stamp},{workspaceId:'wb',userId:'ub',id:'foreign-task',archived:false,messages:[],createdAt:stamp,updatedAt:stamp}],messages:[],attachments:[],chatOperations:[],auditLogs:[],modelUsageRecords:[],powerLedger:[]} as unknown as Database;
 let calls=0,beforeMutate:(()=>void)|undefined;
 const store={read:async()=>db,mutate:async<T>(fn:(state:Database)=>T)=>{beforeMutate?.();beforeMutate=undefined;return fn(db);}};
 const app=express();app.use(express.json({limit:'2mb'}));
 const auth:express.RequestHandler=(req,res,next)=>{req.user={id:'ua',role:'user'} as any;req.workspaceId='wa';res.locals.requestId='req_input_test';next();};
 installCoordinatorRoutes(app,[auth],[auth],store,async()=>{}, {recallWithDiagnostics:async()=>({chunks:[],failures:[],status:'no_match'})},{modelCall:async()=>{calls++;throw Error('no provider call is permitted');}});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/coordinator`;
 return {db,post:(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),set race(fn:()=>void){beforeMutate=fn;},get calls(){return calls;}};
}
const payload=(operationId:string)=>({operationId,text:'PRIVATE_HEAD_'+'中'.repeat(32000)+'PRIVATE_TAIL',attachmentIds:['private-file-id']});
test('main and task HTTP refusals expose a precise 413 and safe length event with no task, model or bill',async t=>{
 const f=await fixture(t);
 for(const [index,path] of ['/messages','/tasks/owned-task/messages'].entries()){
  const input=payload(`oversized_http_operation_${index}`),response=await f.post(path,input),body=await response.json();
  assert.equal(response.status,413);assert.equal(body.accepted,false);assert.deepEqual(body.failure,{code:'input_too_long',stage:'accepting',outcome:'not_started'});
  assert.equal(body.code,'COORDINATOR_INPUT_TOO_LONG');assert.equal(body.inputChars,input.text.length);assert.equal(body.maxInputChars,32000);assert.match(body.error,/32,000.*附件/);
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE_HEAD|PRIVATE_TAIL|private-file-id/);
 }
 assert.equal(f.db.auditLogs.length,2);assert.equal(f.calls,0);assert.equal(f.db.messages.length,0);assert.equal(f.db.chatOperations!.length,0);assert.equal(f.db.modelUsageRecords.length,0);assert.equal(f.db.powerLedger.length,0);
 assert.doesNotMatch(JSON.stringify(f.db.auditLogs),/PRIVATE_HEAD|PRIVATE_TAIL|private-file-id/);
});
test('late owner acceptance wins during refusal persistence, and a foreign task cannot create an owner refusal event',async t=>{
 const f=await fixture(t),input=payload('late_accepted_http_operation_01');
 f.race=()=>{f.db.chatOperations!.push({...owner,id:'accepted',operationId:input.operationId,requestId:'coord_accepted',status:'pending',createdAt:'now',updatedAt:'now'} as ChatOperation);};
 const response=await f.post('/messages',input),body=await response.json();
 assert.equal(response.status,413);assert.notEqual(body.accepted,false);assert.equal(body.failure.outcome,'unknown');assert.equal(f.db.auditLogs.length,0);assert.equal(f.db.messages.length,0);
 const foreign=await f.post('/tasks/foreign-task/messages',payload('foreign_bound_http_operation_01'));
 assert.equal(foreign.status,413);assert.equal(f.db.auditLogs.length,0,'a path targeting another owner never produces an owner-scoped refusal record');assert.equal(f.calls,0);
});
test('a different owner using the same operation ID does not hide this owner length refusal',async t=>{
 const f=await fixture(t),input=payload('shared_http_operation_01');
 f.db.chatOperations!.push({workspaceId:'wb',userId:'ub',id:'foreign',operationId:input.operationId,status:'pending'} as ChatOperation);
 const response=await f.post('/messages',input),body=await response.json();
 assert.equal(body.accepted,false);assert.equal(body.failure.outcome,'not_started');assert.equal(f.db.auditLogs.length,1);assert.equal(f.db.auditLogs[0].workspaceId,'wa');assert.equal(f.db.auditLogs[0].actorUserId,'ua');
 assert.equal(f.db.chatOperations!.length,1);assert.equal(f.calls,0);
});
