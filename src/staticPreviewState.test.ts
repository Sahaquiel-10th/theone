import test from 'node:test';
import assert from 'node:assert/strict';
import {previewReceiptMatches, previewUnavailableMessage,staticPreviewAvailability} from './staticPreviewState.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StaticPreviewPanel} from './StaticPreviewPanel';
import type {LocalDeviceReadiness} from './localDeviceReadiness';
test('only the same confirmed live preview keeps its link', () => {
  assert.equal(previewReceiptMatches('a', {status:'ready', url:'a'}), true);
  for (const reply of [{status:'stopped'}, {status:'unknown'}, {status:'ready', url:'b'}, {status:'ready'}]) assert.equal(previewReceiptMatches('a', reply), false);
  assert.match(previewUnavailableMessage({status:'stopped'}), /已停止/);
  assert.match(previewUnavailableMessage({status:'unknown'}), /更新/);
  assert.match(previewUnavailableMessage(), /尚未确认/);
});
test('current Windows does not advertise a Mac-only preview or send an unsupported request',()=>{
 const readiness:LocalDeviceReadiness={checkedAt:new Date().toISOString(),ready:true,connected:true,folder:{state:'ready',targetName:'C:\\QA'},executor:{state:'ready',installedVersion:'0.4.29'},reason:'ready',platform:'windows',capabilities:{staticPreview:false,taskDirectoryBinding:false}};
 const html=renderToStaticMarkup(createElement(StaticPreviewPanel,{taskId:'owned-task',readiness,request:async()=>{throw new Error('Unsupported preview cannot issue requests.');}}));
 assert.match(html,/Windows.*暂不支持/);assert.doesNotMatch(html,/Mac 静态|请更新|请升级|<button|<input/);
 assert.equal(staticPreviewAvailability({...readiness,platform:'macos',capabilities:{staticPreview:true,taskDirectoryBinding:true}}).canStart,true);
 assert.equal(staticPreviewAvailability({...readiness,platform:'macos',capabilities:{staticPreview:true,taskDirectoryBinding:false}}).canStart,false);
 assert.equal(staticPreviewAvailability(undefined).canStart,false);
});
