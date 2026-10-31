import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import express from 'express';
import {WebSocket} from 'ws';
import {OneKeyPresence} from './oneKeyPresence.js';
import {auth,requireOneKeySession} from './middleware.js';
import {signToken} from './security.js';
import {createLocalDeviceReadiness,assertLocalDeviceReadinessScope,installLocalDeviceReadinessRoute,type LocalDeviceReadinessScope} from './localDeviceReadiness.js';

const scope:LocalDeviceReadinessScope={workspaceId:'qa-space',userId:'qa-user',deviceId:'qa-key',installationId:'a'.repeat(32)};
const folder={targetName:'/QA/synthetic'}, executor={available:true,installedVersion:'0.116.0',installedSource:'managed' as const};
function fixture(options:{timeoutMs?:number;ttlMs?:number}={}){
  let token:object|undefined={},now=1_800_000_000_000,authorized=true,busy=false,folderCalls=0,executorCalls=0;
  let probeFolder=async(_s:LocalDeviceReadinessScope,_signal:AbortSignal)=>folder;
  let probeExecutor=async(_s:LocalDeviceReadinessScope,_signal:AbortSignal)=>executor;
  const checker=createLocalDeviceReadiness({authorize:async()=>{if(!authorized)throw Error('forbidden');return{busy};},connectionToken:()=>token,
    probeFolder:(s,signal)=>{folderCalls++;return probeFolder(s,signal);},probeExecutor:(s,signal)=>{executorCalls++;return probeExecutor(s,signal);},now:()=>now,...options});
  return{checker,get calls(){return[folderCalls,executorCalls];},disconnect(){token=undefined;},reconnect(){token={};},advance(ms:number){now+=ms;},deny(){authorized=false;},busy(){busy=true;},setFolder(fn:typeof probeFolder){probeFolder=fn;},setExecutor(fn:typeof probeExecutor){probeExecutor=fn;}};
}
test('same fully bound scope deduplicates inflight and caches for at most ten seconds',async()=>{
  const f=fixture({ttlMs:50_000});
  const results=await Promise.all([f.checker.inspect(scope),f.checker.inspect({...scope})]);
  assert.equal(results[0].ready,true);assert.deepEqual(f.calls,[1,1]);
  results[0].folder.targetName='/mutated';assert.equal((await f.checker.inspect(scope)).folder.targetName,folder.targetName);
  f.advance(10_001);await f.checker.inspect(scope);assert.deepEqual(f.calls,[2,2]);
  await f.checker.inspect(scope,{fresh:true});assert.deepEqual(f.calls,[3,3]);
});
test('cache and inflight never cross workspace, user, device or installation boundaries',async()=>{
  const f=fixture();
  await Promise.all([scope,{...scope,workspaceId:'other'},{...scope,userId:'other'},{...scope,deviceId:'other'},{...scope,installationId:'b'.repeat(32)}].map(s=>f.checker.inspect(s)));
  assert.deepEqual(f.calls,[5,5]);
});
test('disconnect, replacement socket, revocation and active work invalidate previous ready',async()=>{
  const f=fixture();assert.equal((await f.checker.inspect(scope)).ready,true);
  f.disconnect();const offline=await f.checker.inspect(scope);assert.equal(offline.reason,'offline');assert.equal(offline.folder.targetName,undefined);assert.equal(offline.ready,false);
  f.reconnect();await f.checker.inspect(scope);assert.deepEqual(f.calls,[2,2]);
  f.busy();assert.equal((await f.checker.inspect(scope)).reason,'busy');
  f.deny();await assert.rejects(f.checker.inspect(scope),/forbidden/);
});
test('bounded timeout aborts only read-only probes and cannot be revived by a late result',async()=>{
  const f=fixture({timeoutMs:20});let aborted=0;let complete!:(value:typeof folder)=>void;
  f.setFolder(async(_s,signal)=>new Promise(resolve=>{complete=resolve;signal.addEventListener('abort',()=>aborted++);}));
  const result=await f.checker.inspect(scope);assert.equal(result.ready,false);assert.equal(result.reason,'unknown');assert.equal(aborted,1);
  complete(folder);await new Promise(resolve=>setTimeout(resolve,1));assert.equal((await f.checker.inspect(scope)).ready,false);assert.deepEqual(f.calls,[1,1]);
});
test('missing folder, denied folder, unavailable folder and missing executor are distinct without raw errors',async()=>{
  const cases=[{folder:async()=>({targetName:undefined}),executor:async()=>executor,reason:'folder_unselected'},
    {folder:async()=>{throw Error('permission denied secret=do-not-leak');},executor:async()=>executor,reason:'folder_denied'},
    {folder:async()=>{throw Error('已选的 ONE 工作文件夹暂时不可用 secret=do-not-leak');},executor:async()=>executor,reason:'folder_unavailable'},
    {folder:async()=>folder,executor:async()=>({available:true}),reason:'executor_unprepared'},
    {folder:async()=>folder,executor:async()=>{throw Error('unexpected token secret=do-not-leak');},reason:'unknown'}];
  for(const c of cases){const f=fixture();f.setFolder(c.folder as any);f.setExecutor(c.executor as any);const result=await f.checker.inspect(scope);assert.equal(result.reason,c.reason);assert.equal(result.ready,false);assert.doesNotMatch(JSON.stringify(result),/secret|do-not-leak/);}
});
test('scope authorization checks exact owner, membership, active Key and valid computer before cache',()=>{
  const db:any={users:[{id:scope.userId,enabled:true}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[{userId:scope.userId,workspaceId:scope.workspaceId,status:'active'}],oneKeyDevices:[{id:scope.deviceId,userId:scope.userId,workspaceId:scope.workspaceId,status:'active'}],executionTasks:[]};
  assert.deepEqual(assertLocalDeviceReadinessScope(db,scope),{busy:false});
  for(const changed of [{workspaceId:'other'},{userId:'other'},{deviceId:'other'},{installationId:'bad'}])assert.throws(()=>assertLocalDeviceReadinessScope(db,{...scope,...changed}),/无权检查/);
  db.workspaceMembers[0].status='disabled';assert.throws(()=>assertLocalDeviceReadinessScope(db,scope),/无权检查/);
  db.workspaceMembers[0].status='active';db.executionTasks.push({...scope,status:'failed',executionSafetyHold:{reason:'synthetic'}});
  assert.equal(assertLocalDeviceReadinessScope(db,scope).busy,true,'an unresolved process/receipt safety hold is not ready even if its public task status is failed');
  db.executionTasks[0].workspaceId='foreign';assert.equal(assertLocalDeviceReadinessScope(db,scope).busy,false);
});
test('invalidating changed settings prevents an old inflight probe from restoring ready',async()=>{
  const f=fixture();let complete!:(value:typeof folder)=>void;
  f.setFolder(async()=>new Promise(resolve=>{complete=resolve;}));
  const work=f.checker.inspect(scope);for(let i=0;i<10&&!complete;i++)await new Promise(resolve=>setTimeout(resolve,1));
  f.checker.invalidate(scope);complete(folder);assert.equal((await work).reason,'unknown');
});

async function realReadOnlyDevice(t:test.TestContext){
  const pair=crypto.generateKeyPairSync('ed25519'),db:any={users:[{id:scope.userId,enabled:true,defaultWorkspaceId:scope.workspaceId}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[{userId:scope.userId,workspaceId:scope.workspaceId,status:'active'}],oneKeyDevices:[{id:scope.deviceId,userId:scope.userId,workspaceId:scope.workspaceId,status:'active',publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString()}],executionTasks:[],auditLogs:[]};
  const store:any={read:async()=>structuredClone(db),mutate:async(fn:any)=>fn(db)},presence=new OneKeyPresence(store),app=express(),server=createServer(app);
  presence.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const socket=new WebSocket(`${origin.replace('http','ws')}/api/one-key/launcher?deviceId=${scope.deviceId}&installationId=${scope.installationId}`),challenge=JSON.parse((await once(socket,'message'))[0].toString());
  const sign=(nonce:string)=>crypto.sign(null,Buffer.from(nonce,'base64url'),pair.privateKey).toString('base64url');
  const authenticated=once(socket,'message');socket.send(JSON.stringify({type:'auth_response',challengeId:challenge.challengeId,signature:sign(challenge.nonce),capabilities:['local_configuration_v1','managed_codex_v1'],platform:'macos',architecture:'arm64',launcherVersion:'0.4.27',updateProtocol:1}));await authenticated;
  const messages:any[]=[];let reply=true,proof=true;
  socket.on('message',raw=>{const m=JSON.parse(raw.toString());messages.push(m);if(m.type==='request_challenge'&&proof)socket.send(JSON.stringify({type:'proof_response',challengeId:m.challengeId,signature:sign(m.nonce)}));
    if(reply&&m.type==='local_configuration')socket.send(JSON.stringify({type:'local_ready',taskId:'device_settings',requestId:m.requestId,...folder}));
    if(reply&&m.type==='executor_status')socket.send(JSON.stringify({type:'local_ready',taskId:'device_settings',requestId:m.requestId,output:executor.installedVersion,targetName:'managed'}));});
  const catalog=()=>({version:executor.installedVersion,size:100,envelope:{payload:'synthetic',signature:'synthetic'}});
  const checker=createLocalDeviceReadiness({authorize:async s=>assertLocalDeviceReadinessScope(await store.read(),s),connectionToken:s=>presence.readinessConnectionToken(s.deviceId,s.installationId),probeFolder:(s,signal)=>presence.localConfiguration(s,false,{signal,timeoutMs:100}),probeExecutor:(s,signal)=>presence.managedExecutor(s,catalog,false,true,{signal,timeoutMs:100}),timeoutMs:50});
  installLocalDeviceReadinessRoute(app,[auth('qa-secret',{store,oneKeyPresence:presence}),requireOneKeySession],checker);
  t.after(async()=>{socket.terminate();await presence.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const request=(changes:object={})=>fetch(`${origin}/api/me/local-device/readiness`,{headers:{Authorization:`Bearer ${signToken({sub:scope.userId,...scope,...changes},'qa-secret')}`}});
  return{checker,presence,messages,request,setReply(value:boolean){reply=value;},setProof(value:boolean){proof=value;},
    answerProof(m:any){socket.send(JSON.stringify({type:'proof_response',challengeId:m.challengeId,signature:sign(m.nonce)}));},
    async disconnect(){const closed=once(socket,'close');socket.close();await closed;for(let i=0;i<100&&presence.isConnected(scope.deviceId,scope.installationId);i++)await new Promise(resolve=>setTimeout(resolve,1));}};
}
test('owner readiness API uses real signed read-only folder and executor probes without choosing or executing',async t=>{
  const f=await realReadOnlyDevice(t),response=await f.request();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json() as any).ready,true);
  assert.equal(f.messages.filter(m=>m.type==='local_configuration').length,1);assert.equal(f.messages.find(m=>m.type==='local_configuration').change,false);
  assert.equal(f.messages.filter(m=>m.type==='executor_status').length,1);assert.equal(f.messages.filter(m=>['executor_prepare','execution_start','tool_request','local_prepare'].includes(m.type)).length,0);
  const before=f.messages.length;
  for(const changed of [{workspaceId:'foreign-space'},{userId:'foreign-user',sub:'foreign-user'},{deviceId:'foreign-key'},{installationId:'b'.repeat(32)}]){const denied=await f.request(changed);assert.ok([401,403,428].includes(denied.status));assert.equal(denied.headers.get('cache-control'),'no-store');assert.doesNotMatch(await denied.text(),/QA\/synthetic|installedVersion/);}
  assert.equal(f.messages.slice(before).filter(m=>m.type==='local_configuration'||m.type==='executor_status').length,0);
});
test('readiness deadline removes its proof and local pending RPCs while leaving the launcher connection alive',async t=>{
  const f=await realReadOnlyDevice(t);f.setReply(false);
  const first=await f.checker.inspect(scope,{fresh:true});assert.equal(first.reason,'unknown');
  assert.equal((f.presence as any).pendingLocal.size,0);assert.equal((f.presence as any).pending.size,0);assert.equal(f.presence.isConnected(scope.deviceId,scope.installationId),true);
  f.setProof(false);await f.checker.inspect(scope,{fresh:true});assert.equal((f.presence as any).pending.size,0);assert.equal((f.presence as any).pendingLocal.size,0);
  f.setProof(true);f.setReply(true);assert.equal((await f.checker.inspect(scope,{fresh:true})).ready,true);
});
test('readiness cancellation does not cancel an unrelated protected request on the same socket',async t=>{
  const f=await realReadOnlyDevice(t);f.setProof(false);
  const original=f.presence.requireProof({...scope,method:'GET',path:'/qa/independent-read'});void original.catch(()=>{});
  for(let i=0;i<100&&!f.messages.some(m=>m.path==='/qa/independent-read');i++)await new Promise(resolve=>setTimeout(resolve,1));
  const challenge=f.messages.find(m=>m.path==='/qa/independent-read');assert.ok(challenge);
  assert.equal((await f.checker.inspect(scope,{fresh:true})).ready,false);assert.equal((f.presence as any).pending.size,1);
  f.answerProof(challenge);await original;assert.equal((f.presence as any).pending.size,0);
});
test('disconnect after a successful owner HTTP check cannot return cached ready or its previous path',async t=>{
  const f=await realReadOnlyDevice(t);assert.equal((await (await f.request()).json() as any).ready,true);await f.disconnect();
  assert.equal((await f.checker.inspect(scope)).reason,'offline');
  const response=await f.request();assert.equal(response.status,428);assert.equal(response.headers.get('cache-control'),'no-store');assert.doesNotMatch(await response.text(),/QA\/synthetic|"ready":true/);
});
