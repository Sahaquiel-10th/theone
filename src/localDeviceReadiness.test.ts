import assert from 'node:assert/strict';
import test from 'node:test';
import {localDeviceCanRequestExecution,localReadinessStatus,parseLocalDeviceReadiness,type LocalDeviceReadiness} from './localDeviceReadiness';

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
