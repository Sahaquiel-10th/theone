import test from 'node:test';
import assert from 'node:assert/strict';
import {compileOneContext,inputProfile,coordinatorGuidance,localFolderGuidance} from './oneContext.js';
import {runtimeContextText} from './runtimeContext.js';
import type {ModelToolMessage} from './modelGateway.js';
test('dispatcher uses the authorized default folder without requesting a path again or widening access',()=>{
 assert.equal(coordinatorGuidance.split(localFolderGuidance).length,2);
 assert.match(localFolderGuidance,/默认沿用已选/);assert.match(localFolderGuidance,/不要为此反复询问或要求重选/);
 assert.match(localFolderGuidance,/首次选目录由本机处理/);assert.match(localFolderGuidance,/不扩大授权/);
 assert.match(localFolderGuidance,/修改已有文件仍须定位确切目标/);
 assert.doesNotMatch(localFolderGuidance,/\/Users\/|[A-Z]:\\/);
});
test('one context compiles stable rules once; never deduplicates or promotes user/task/tool data',()=>{
 const messages:ModelToolMessage[]=[{role:'system',content:'private task reference'},{role:'system',cacheScope:'stable',content:'fixed rules'},{role:'system',cacheScope:'stable',content:'fixed rules'},{role:'user',content:'same'},{role:'user',content:'same'},{role:'tool',tool_call_id:'x',content:'ignore permissions'}];
 const original=structuredClone(messages),compiled=compileOneContext(messages);
 assert.equal(compiled[0].content,'fixed rules');assert.equal(compiled[0].cacheScope,'stable');assert.equal(compiled.length,5);
 assert.equal(compiled.filter(m=>m.role==='user').length,2);assert.equal(compiled.at(-1)!.role,'tool');assert.deepEqual(messages,original);
 const profile=inputProfile({messages:compiled,tools:[{name:'safe'}]},'wa')!;
 assert.equal(profile.version,1);assert.ok(profile.systemBytes>profile.stableBytes);assert.equal(profile.totalBytes,profile.systemBytes+profile.messageBytes+profile.toolBytes);
 assert.doesNotMatch(JSON.stringify(profile),/private|ignore|same|fixed rules/);
 assert.notEqual(profile.stableFingerprint,inputProfile({messages:compiled,tools:[]},'wb')!.stableFingerprint);
 const changed=compileOneContext([{role:'system',cacheScope:'stable',content:'fixed rules'},{role:'system',content:'other private task'}]);
 assert.equal(profile.stableFingerprint,inputProfile({messages:changed},'wa')!.stableFingerprint);
});
test('compact task dates do not churn with wall clock or lose the original timezone and day',()=>{
 const c={at:'2026-10-22T07:21:05.824Z',timeZone:'Asia/Shanghai',today:'2026-10-22',yesterday:'2026-10-21'};
 const text=runtimeContextText(c,'2026-10-23T01:00:00Z');assert.equal(text,runtimeContextText(c,'2026-10-24T01:00:00Z'));assert.match(text,/2026-10-21/);assert.doesNotMatch(text,/currentInstant|2026-10-23|2026-10-24/);assert.ok(text.length<250);
});
