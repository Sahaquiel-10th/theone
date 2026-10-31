import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalDeviceReadinessResource,localDeviceReadinessResource,LOCAL_READINESS_TTL_MS} from './localDeviceReadinessStore';
import type {LocalDeviceReadiness} from './localDeviceReadiness';
import type {api as Api} from './oneApi';

const ready=():LocalDeviceReadiness=>({checkedAt:new Date().toISOString(),ready:true,connected:true,folder:{state:'ready',targetName:'/fixture/owned-folder'},executor:{state:'ready',installedVersion:'0.4.29'},reason:'ready'});
test('settings, destination and sending share one scoped probe and a ten second cache',async()=>{
 let calls=0,now=Date.now();const started=now;let finish!:(value:LocalDeviceReadiness)=>void;
 const api=(async()=>{calls++;return new Promise<LocalDeviceReadiness>(resolve=>{finish=resolve;});}) as typeof Api;
 const resource=createLocalDeviceReadinessResource(api,{now:()=>now});
 const first=resource.refresh(),second=resource.refresh();assert.equal(calls,1);assert.equal(resource.getSnapshot().status,'checking');
 finish({...ready(),checkedAt:new Date(now).toISOString()});await Promise.all([first,second]);assert.equal(resource.getSnapshot().value?.ready,true);
 now=started+LOCAL_READINESS_TTL_MS-1;await resource.refresh();assert.equal(calls,1);
 now=started+LOCAL_READINESS_TTL_MS;const expired=resource.refresh();assert.equal(calls,2);assert.equal(resource.getSnapshot().value,undefined);
 finish({...ready(),checkedAt:new Date(now).toISOString()});await expired;
 assert.equal(localDeviceReadinessResource(api),localDeviceReadinessResource(api));
 const foreignApi=(async()=>ready()) as typeof Api;assert.notEqual(localDeviceReadinessResource(api),localDeviceReadinessResource(foreignApi));
});
test('a failed recheck or invalid response cannot leave the old ready visible',async()=>{
 let response:unknown=ready();const api=(async()=>{if(response instanceof Error)throw response;return response;}) as typeof Api;
 const resource=createLocalDeviceReadinessResource(api);await resource.refresh();assert.equal(resource.getSnapshot().value?.ready,true);
 response=new Error('offline');await resource.refresh(true);assert.equal(resource.getSnapshot().status,'error');assert.equal(resource.getSnapshot().value,undefined);
 response={ready:true};await resource.refresh(true);assert.equal(resource.getSnapshot().status,'error');assert.equal(resource.getSnapshot().value,undefined);
});
test('changing a setting discards a pre-change inflight result before probing again',async()=>{
 const finishes:((value:LocalDeviceReadiness)=>void)[]=[];let calls=0;
 const api=(async()=>{calls++;return new Promise<LocalDeviceReadiness>(resolve=>{finishes.push(resolve);});}) as typeof Api;
 const resource=createLocalDeviceReadinessResource(api);const old=resource.refresh();resource.invalidate();const current=resource.refresh(true);
 finishes[0](ready());await old;await Promise.resolve();assert.equal(calls,2);assert.notEqual(resource.getSnapshot().status,'confirmed');
 finishes[1]({...ready(),ready:false,connected:false,folder:{state:'unknown'},executor:{state:'unknown'},reason:'offline'});await current;
 assert.equal(resource.getSnapshot().value?.ready,false);
});

test('browser cache expires from the server probe timestamp rather than extending its own ten-second window',async()=>{
 const now=Date.now();let calls=0;
 const api=(async()=>{calls++;return{...ready(),checkedAt:new Date(now-9000).toISOString()};}) as typeof Api;
 let clock=now;const resource=createLocalDeviceReadinessResource(api,{now:()=>clock});await resource.refresh();assert.equal(resource.getSnapshot().value?.ready,true);
 clock+=1001;await resource.refresh();assert.equal(calls,2);assert.equal(resource.getSnapshot().value,undefined);assert.equal(resource.getSnapshot().status,'error');
});
