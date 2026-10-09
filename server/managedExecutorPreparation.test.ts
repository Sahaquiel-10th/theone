import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { OneKeyPresence } from './oneKeyPresence.js';
import { ManagedExecutorDistribution } from './managedExecutorDistribution.js';

test('managed preparation binds owner, computer, live Key and task/update exclusion', async () => {
  const pair = crypto.generateKeyPairSync('ed25519'), installationId = 'a'.repeat(32);
  const db: any = { oneKeyDevices: [{ id:'key', workspaceId:'wa', userId:'a', status:'active', publicKey: pair.publicKey.export({type:'spki',format:'pem'}).toString() }], executionTasks:[], auditLogs:[] };
  const store: any = { read:async()=>structuredClone(db), mutate:async(fn:any)=>fn(db) };
  const presence = new OneKeyPresence(store), server = createServer(); presence.attach(server); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/one-key/launcher?deviceId=key&installationId=${installationId}`);
  const auth = JSON.parse((await once(socket,'message'))[0].toString());
  const sign = (nonce:string)=>crypto.sign(null,Buffer.from(nonce,'base64url'),pair.privateKey).toString('base64url');
  socket.send(JSON.stringify({type:'auth_response', challengeId:auth.challengeId, signature:sign(auth.nonce), capabilities:['managed_codex_v1','runtime_update_v1','local_configuration_v1'],platform:'macos',architecture:'arm64',launcherVersion:'0.4.10',updateProtocol:1})); await once(socket,'message');
  let held:any, count=0;
  socket.on('message', raw => {
    const message=JSON.parse(raw.toString());
    if(message.type==='request_challenge')socket.send(JSON.stringify({type:'proof_response',challengeId:message.challengeId,signature:sign(message.nonce)}));
    if(message.type==='executor_status')socket.send(JSON.stringify({type:'local_ready',taskId:'device_settings',requestId:message.requestId,output:'0.160.1'}));
    if(message.type==='executor_prepare'){held=message;count++;}
  });
  const scope = { deviceId:'key',installationId,workspaceId:'wa',userId:'a' }, envelope={payload:'signed',signature:'signed'};
  const catalog=()=>({envelope,version:'0.160.1',size:100});
  try {
    assert.equal((await presence.managedExecutor(scope,catalog)).installedVersion,'0.160.1');
    for(const change of [{workspaceId:'wb'},{userId:'b'},{installationId:'b'.repeat(32)}])
      await assert.rejects(presence.managedExecutor({...scope,...change},catalog,true),/不属于|当前这台电脑/);
    db.executionTasks.push({deviceId:'key',installationId,status:'running'});
    await assert.rejects(presence.managedExecutor(scope,catalog,true),/正在执行/);assert.equal(count,0);
    db.executionTasks=[];
    const preparation=await presence.managedExecutor(scope,catalog,true);
    for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,5));assert.ok(held);
    assert.equal((await presence.managedExecutor(scope,catalog)).preparing,true);
    await assert.rejects(presence.managedExecutor(scope,catalog,true),/正在准备/);assert.equal(count,1);
    await assert.rejects(presence.localConfiguration(scope,true),/正在设置/);
    await assert.rejects(presence.requestRuntimeUpdate({...scope,version:'0.4.11',envelope}),/准备工具/);
    socket.send(JSON.stringify({type:'local_ready',taskId:'device_settings',requestId:held.requestId,output:'0.160.1'}));
    assert.equal(preparation.preparing,true);
    await new Promise(r=>setTimeout(r,10));
    assert.equal((await presence.managedExecutor(scope,catalog)).installedVersion,'0.160.1');
    held=undefined;
    const nextCatalog=()=>({envelope,version:'0.160.2',size:100});
    await presence.managedExecutor(scope,nextCatalog,true);
    for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,5));
    socket.send(JSON.stringify({type:'local_error',taskId:'device_settings',requestId:held.requestId,error:'用户拒绝，原工具保留'}));
    await new Promise(r=>setTimeout(r,10));
    const refused=await presence.managedExecutor(scope,nextCatalog);
    assert.equal(refused.installedVersion,'0.160.1');assert.match(refused.error!,/用户拒绝/);
    const afterRefusal=count;await presence.managedExecutor(scope,nextCatalog);assert.equal(count,afterRefusal);
    held=undefined;
    const interrupted=await presence.managedExecutor(scope,catalog,true);
    for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(interrupted.preparing,true);
    socket.close();await once(socket,'close');
    await assert.rejects(presence.managedExecutor(scope,catalog),/插入|断开/);
  } finally {socket.terminate();await presence.close();await new Promise<void>(r=>server.close(()=>r()));}
});

test('executor distribution serves only signed public artifacts and exact platform', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'one-distribution-test-')), pair=crypto.generateKeyPairSync('ed25519');
  const publicKey=(pair.publicKey.export({type:'spki',format:'der'}) as Buffer).subarray(-32).toString('base64url');
  const bytes=Buffer.from('archive');
  const value={kind:'one-managed-executors',schemaVersion:1,releasedAt:new Date().toISOString(),releases:[{executor:'codex',version:'0.160.1',platform:'macos',architecture:'arm64',url:'https://one.example/executor-downloads/codex.tar',sourceUrl:'https://github.com/openai/codex/releases/download/rust-v0.160.1/codex.tar.gz',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,entrypoint:'bin/codex',license:'Apache-2.0',licenseFiles:['LICENSE','NOTICE']}]};
  const payload=Buffer.from(JSON.stringify(value));
  const envelope={payload:payload.toString('base64url'),signature:crypto.sign(null,payload,pair.privateKey).toString('base64url')};
  const manifest=path.join(dir,'catalog.json');fs.writeFileSync(manifest,JSON.stringify(envelope));fs.writeFileSync(path.join(dir,'codex.tar'),bytes);
  try {
    const distribution=new ManagedExecutorDistribution({manifest,publicKey,origins:['https://one.example']});
    assert.equal(distribution.release({platform:'macos',architecture:'arm64'})?.version,'0.160.1');
    assert.equal(distribution.release({platform:'macos',architecture:'x86_64'}),undefined);
    assert.equal(distribution.artifact('codex.tar'),path.join(dir,'codex.tar'));
    const dotted={...value,releases:[{...value.releases[0],url:'https://one.example/executor-downloads/codex-macos-arm64-0.160.1.tar.gz'}]};
    const dottedPayload=Buffer.from(JSON.stringify(dotted));
    fs.writeFileSync(manifest,JSON.stringify({payload:dottedPayload.toString('base64url'),signature:crypto.sign(null,dottedPayload,pair.privateKey).toString('base64url')}));
    fs.writeFileSync(path.join(dir,'codex-macos-arm64-0.160.1.tar.gz'),bytes);
    assert.equal(distribution.artifact('codex-macos-arm64-0.160.1.tar.gz'),path.join(dir,'codex-macos-arm64-0.160.1.tar.gz'));
    fs.writeFileSync(manifest,JSON.stringify(envelope));
    for(const name of ['../secret','catalog.json','codex.exe','foreign.tar'])assert.equal(distribution.artifact(name),undefined);
    fs.unlinkSync(path.join(dir,'codex.tar'));fs.symlinkSync(manifest,path.join(dir,'codex.tar'));
    assert.equal(distribution.artifact('codex.tar'),undefined);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
