import assert from 'node:assert/strict';
import test from 'node:test';
import {WebSocket} from 'ws';
import {OneKeyPresence,executionTaskBinding} from './oneKeyPresence.js';

const installationId='a'.repeat(32);
const task={id:'task-a',workspaceId:'workspace-a',userId:'user-a',deviceId:'device-a',installationId,
  status:'queued',targetName:'/synthetic/original',providerThreadId:'thread-original',reportRound:2};
function fixture(capabilities=['task_directory_binding_v1']){
  const db={oneKeyDevices:[{id:task.deviceId,workspaceId:task.workspaceId,userId:task.userId,status:'active'}],executionTasks:[{...task}]};
  const presence=new OneKeyPresence({read:async()=>db} as any),frames:any[]=[];
  const socket={readyState:WebSocket.OPEN,send(payload:string,callback:(e?:Error)=>void){frames.push(JSON.parse(payload));callback();}};
  (presence as any).sockets.set(task.deviceId,socket);
  (presence as any).states.set(socket,{authenticated:true,installationId,capabilities:new Set(capabilities),runtime:{platform:'macos'}});
  (presence as any).gatewayConfiguration=async()=>undefined;
  return{db,presence,socket,frames};
}
test('server task binding is a whitelist of exact durable owner, original folder and original thread',()=>{
  assert.deepEqual(executionTaskBinding({...task,gatewayToken:'must-not-leak',instruction:'private-content'} as any,true),
    {workspaceId:task.workspaceId,userId:task.userId,deviceId:task.deviceId,installationId,taskId:task.id,targetName:task.targetName,providerThreadId:task.providerThreadId});
  for(const patch of [{targetName:''},{targetName:'/bad\npath'},{providerThreadId:undefined},{providerThreadId:'bad thread'},{installationId:'other'}]){
    assert.throws(()=>executionTaskBinding({...task,...patch} as any,true),/原任务.*绑定/);
  }
});
test('continuation after resident restart sends persisted root/thread, not current settings',async()=>{
  const f=fixture();await f.presence.continueExecution(task.deviceId,task.id,'only continuation',installationId);
  assert.equal(f.frames.length,1);assert.deepEqual(f.frames[0].taskBinding,executionTaskBinding(task as any,true));
  assert.equal(f.frames[0].round,2);
});
test('unbound or unsupported continuation never issues a local execution',async()=>{
  for(const patch of [{targetName:''},{providerThreadId:''}]){
    const f=fixture();Object.assign(f.db.executionTasks[0],patch);
    await assert.rejects(()=>f.presence.continueExecution(task.deviceId,task.id,'continue',installationId),/原任务.*绑定/);
    assert.equal(f.frames.length,0);
  }
  const old=fixture([]);await assert.rejects(()=>old.presence.continueExecution(task.deviceId,task.id,'continue',installationId),/升级/);assert.equal(old.frames.length,0);
  const foreign=fixture();foreign.db.executionTasks[0].workspaceId='foreign';
  await assert.rejects(()=>foreign.presence.continueExecution(task.deviceId,task.id,'continue',installationId),/不属于/);assert.equal(foreign.frames.length,0);
});
test('readiness capabilities belong to the exact currently authenticated installation only',()=>{
  const f=fixture(['task_directory_binding_v1','static_preview_v1']);
  assert.deepEqual(f.presence.readinessMetadata(task.deviceId,installationId),{platform:'macos',capabilities:{staticPreview:true,taskDirectoryBinding:true}});
  assert.deepEqual(f.presence.readinessMetadata(task.deviceId,'b'.repeat(32)),{platform:'unknown',capabilities:{staticPreview:false,taskDirectoryBinding:false}});
  (f.presence as any).states.get(f.socket).authenticated=false;
  assert.deepEqual(f.presence.readinessMetadata(task.deviceId,installationId),{platform:'unknown',capabilities:{staticPreview:false,taskDirectoryBinding:false}});
});
