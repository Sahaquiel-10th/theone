import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {api as Api} from './oneApi';
import type {LocalDeviceReadiness} from './localDeviceReadiness';
import {localDeviceReadinessResource} from './localDeviceReadinessStore';
const css=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {LocalDeviceSettings}=await import('./LocalDeviceSettings');
const {DocumentDestinationPicker}=await import('./DocumentDestination');
css.deregister();
const ready:LocalDeviceReadiness={checkedAt:new Date().toISOString(),ready:true,connected:true,folder:{state:'ready',targetName:'/synthetic/owned-folder'},executor:{state:'ready',installedVersion:'0.4.29'},reason:'ready'};
const picker=(api:typeof Api)=>renderToStaticMarkup(createElement(DocumentDestinationPicker,{api,value:'local',onChange(){throw new Error('Rendering must not change destination.');},localDisabled:false,onSettings(){}}));
test('real settings and destination components read the same confirmed snapshot without a separate executor readiness guess',async()=>{
 let calls=0;const api=(async(path:string)=>{calls++;assert.match(path,/\/api\/me\/local-device\/readiness/);return ready;}) as typeof Api;
 await localDeviceReadinessResource(api).refresh();
 const settings=renderToStaticMarkup(createElement(LocalDeviceSettings,{api}));assert.match(settings,/本机执行已就绪/);assert.match(settings,/synthetic\/owned-folder/);assert.match(settings,/文件夹已检查/);
 assert.match(picker(api),/本地文件/);assert.equal(calls,1);
});
test('offline or failed rechecks remove ready labels but retain the local destination without asking to reconfigure',async()=>{
 let response:unknown=ready;const api=(async()=>{if(response instanceof Error)throw response;return response;}) as typeof Api;
 const resource=localDeviceReadinessResource(api);await resource.refresh();
 response={...ready,ready:false,connected:false,folder:{state:'unknown'},executor:{state:'unknown'},reason:'offline'};await resource.refresh(true);
 assert.doesNotMatch(renderToStaticMarkup(createElement(LocalDeviceSettings,{api})),/本机执行已就绪|文件夹已检查/);
 let html=picker(api);assert.match(html,/本地文件/);assert.doesNotMatch(html,/保存位置不可用，请重新选择/);
 response=new Error('connection unavailable');await resource.refresh(true);html=renderToStaticMarkup(createElement(LocalDeviceSettings,{api}));assert.doesNotMatch(html,/本机执行已就绪|文件夹已检查/);assert.match(html,/本机状态尚未确认/);
 assert.match(picker(api),/本地文件/);
});
