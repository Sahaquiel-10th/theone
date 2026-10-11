import test from 'node:test';
import assert from 'node:assert/strict';
import {OneKeyPresence} from './oneKeyPresence.js';
import {WebSocket} from 'ws';

const scope = {workspaceId: 'w', userId: 'u', deviceId: 'd', installationId: 'a'.repeat(32)};
function fixture() {
  const db = {oneKeyDevices: [{id:'d',workspaceId:'w',userId:'u',status:'active'}], executionTasks:[{id:'t', ...scope, status:'completed'}]};
  const presence = new OneKeyPresence({read:async()=>db} as any);
  const socket = {readyState:WebSocket.OPEN, send(_payload: string, callback: (error?: Error)=>void) {callback(new Error('test transport stopped'));}};
  (presence as any).sockets.set('d', socket);
  (presence as any).states.set(socket, {authenticated:true,installationId:scope.installationId,capabilities:new Set(['static_preview_v1'])});
  presence.requireProof = async supplied => { assert.equal(supplied.method,'POST'); assert.match(supplied.path,/preview$/); };
  return {presence,db,socket};
}
test('static preview rejects foreign workspace, user, device, installation and task before sending', async()=>{
  const {presence} = fixture();
  for (const changed of [{workspaceId:'other'},{userId:'other'},{deviceId:'other'},{installationId:'b'.repeat(32)}]) await assert.rejects(()=>presence.staticPreview({...scope,...changed},'t','start','index.html'));
  await assert.rejects(()=>presence.staticPreview(scope,'foreign','start','index.html'));
});
test('static preview forbids absolute, protected, traversal and non-HTML entry paths',async()=>{
  const {presence}=fixture();
  for(const path of ['/index.html','../index.html','web/../index.html','.env.html','web\\index.html','file.txt','web//index.html']) await assert.rejects(()=>presence.staticPreview(scope,'t','start',path), /HTML/);
});
test('static preview rejects old launchers, active executions, changed transport; no silent success',async()=>{
  const {presence,db,socket}=fixture();
  await assert.rejects(()=>presence.staticPreview(scope,'t','start','index.html'),/断开/);
  db.executionTasks[0].status='running'; await assert.rejects(()=>presence.staticPreview(scope,'t','start','index.html'),/结束/);
  db.executionTasks[0].status='completed'; (presence as any).states.get(socket).capabilities.clear();
  await assert.rejects(()=>presence.staticPreview(scope,'t','start','index.html'),/升级/);
});

function acknowledge(f: ReturnType<typeof fixture>, output: string, mutate?: ()=>void) {
  f.socket.send = (payload, callback) => {
    const request = JSON.parse(payload), pending = (f.presence as any).pendingLocal.get(request.requestId);
    clearTimeout(pending.timeout); (f.presence as any).pendingLocal.delete(request.requestId);
    mutate?.(); pending.resolve({output}); callback();
  };
}
test('static preview accepts only bounded loopback receipts and revalidates ownership',async()=>{
  const valid = `http://127.0.0.1:3000/${'a'.repeat(32)}/%E9%A6%96%E9%A1%B5.html`;
  const f = fixture(); acknowledge(f,valid);
  assert.deepEqual(await f.presence.staticPreview(scope,'t','start','首页.html'),{status:'ready',url:valid});
  assert.deepEqual(await f.presence.staticPreview(scope,'t','stop'),{status:'stopped'});
  for(const url of ['https://example.com/index.html',valid.replace(':3000',':99999'),valid+'/../secret',valid+'?token=other']) {
    const bad=fixture(); acknowledge(bad,url); await assert.rejects(()=>bad.presence.staticPreview(scope,'t','start','index.html'),/有效/);
  }
  const moved=fixture(); acknowledge(moved,valid,()=>{moved.db.executionTasks[0].userId='other';});
  await assert.rejects(()=>moved.presence.staticPreview(scope,'t','start','index.html'),/归属/);
});
