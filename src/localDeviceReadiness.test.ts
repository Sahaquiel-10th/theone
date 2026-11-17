import assert from 'node:assert/strict';
import test from 'node:test';
import {localDeviceCanBridge,localDeviceCanRequestExecution,localReadinessStatus,parseLocalDeviceReadiness,type LocalDeviceReadiness} from './localDeviceReadiness';

const ready:LocalDeviceReadiness={checkedAt:'2026-10-31T00:00:00.000Z',ready:true,connected:true,folder:{state:'ready',targetName:'/QA/合成目录'},executor:{state:'ready',installedVersion:'0.116.0',installedSource:'managed'},reason:'ready'};
test('readiness parser accepts only coherent, dated, enumerated snapshots and strips unreviewed fields',()=>{
  assert.deepEqual(parseLocalDeviceReadiness({...ready,token:'never forward',executor:{...ready.executor,credential:'never forward'}}),ready);
  for(const value of [null,{}, {...ready,checkedAt:'yesterday'}, {...ready,checkedAt:'2026-02-30T00:00:00.000Z'}, {...ready,connected:false}, {...ready,reason:'unknown'}, {...ready,folder:{state:'unselected'}}, {...ready,executor:{state:'ready'}}, {...ready,executor:{state:'magically_ready'}}, {...ready,folder:{state:'ready',targetName:'bad\npath'}}])assert.equal(parseLocalDeviceReadiness(value),undefined);
});
test('unknown and failed checks never present stale readiness',()=>{
  assert.equal(localReadinessStatus(ready,false).state,'ready');
  assert.equal(localReadinessStatus(ready,true).state,'checking');
  assert.equal(localReadinessStatus(ready,false,'request failed').state,'unknown');
  const missing:LocalDeviceReadiness={...ready,ready:false,folder:{state:'unselected'},reason:'folder_unselected'};
  assert.equal(parseLocalDeviceReadiness(missing)?.ready,false);
  assert.equal(localReadinessStatus(missing,false).title,'还没选择工作文件夹');
});
test('an explicit execution may ask for the first folder but a probe never treats that as ready',()=>{
  assert.equal(localDeviceCanRequestExecution(ready),true);
  const unselected:LocalDeviceReadiness={...ready,ready:false,folder:{state:'unselected'},reason:'folder_unselected'};
  assert.equal(parseLocalDeviceReadiness(unselected)?.ready,false);assert.equal(localDeviceCanRequestExecution(unselected),true);
  assert.equal(localDeviceCanRequestExecution(undefined),false);
  for(const state of ['denied','unavailable','unknown'] as const)assert.equal(localDeviceCanRequestExecution({...ready,ready:false,folder:{state}}),false);
  for(const state of ['unprepared','busy','unavailable','unknown'] as const)assert.equal(localDeviceCanRequestExecution({...ready,ready:false,executor:{state}}),false);
  assert.equal(localDeviceCanRequestExecution({...ready,connected:false}),false);
});
test('relative freshness and reviewed platform capabilities are strictly parsed without trusting the server clock',()=>{
  const metadata={validForMs:9000,platform:'windows',capabilities:{staticPreview:false,taskDirectoryBinding:false}};
  assert.deepEqual(parseLocalDeviceReadiness({...ready,...metadata}),{...ready,...metadata});
  for(const invalid of [{validForMs:-1},{validForMs:10001},{validForMs:NaN},{platform:'guess'},{capabilities:{staticPreview:'yes',taskDirectoryBinding:false}},{capabilities:{staticPreview:true}}])assert.equal(parseLocalDeviceReadiness({...ready,...invalid}),undefined);
  assert.deepEqual(parseLocalDeviceReadiness({...ready,capabilities:{staticPreview:false,taskDirectoryBinding:false,privateToken:'never'}})?.capabilities,{staticPreview:false,taskDirectoryBinding:false});
});
test('bridge execution requires the exact verified runtime for each known platform and never treats builtin or protocol alone as Codex',()=>{
  const value:LocalDeviceReadiness={...ready,platform:'macos',capabilities:{staticPreview:true,taskDirectoryBinding:true,codexToolBridge:true},executor:{state:'ready',installedVersion:'0.160.1',installedSource:'managed'}};
  for(const platform of ['macos','windows'] as const)for(const installedSource of ['managed','existing'] as const)assert.equal(localDeviceCanBridge({...value,platform,executor:{...value.executor,installedSource}}),true);
  for(const installedVersion of ['0.116.0','0.134.0','0.160.0','0.160.1-beta','0.162.0','1.0.0'])assert.equal(localDeviceCanBridge({...value,executor:{...value.executor,installedVersion}}),false);
  for(const platform of [undefined,'unknown'] as const)assert.equal(localDeviceCanBridge({...value,platform}),false);
  assert.equal(localDeviceCanBridge({...value,executor:{...value.executor,installedSource:'builtin'}}),false);
  assert.equal(localDeviceCanBridge({...value,executor:{...value.executor,installedSource:undefined}}),false);
  assert.equal(localDeviceCanBridge({...value,capabilities:{...value.capabilities!,codexToolBridge:false}}),false);
  assert.equal(localDeviceCanBridge({...value,ready:false}),false);
  assert.equal(localDeviceCanRequestExecution({...value,executor:{...value.executor,installedVersion:'0.4.31',installedSource:'builtin'}}),true,'original explicit builtin file path remains available');
});
