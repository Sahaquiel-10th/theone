import test from 'node:test';
import assert from 'node:assert/strict';
import {localDeviceStatus} from './localDeviceStatus';

test('a downloadable executor is not presented as a ready local device',()=>{
  assert.equal(localDeviceStatus({available:true,version:'1.0'},false,false).state,'setup');
  assert.equal(localDeviceStatus({available:true,installedVersion:'1.0'},false,false).state,'ready');
});
test('connection errors and preparation take precedence over an older ready version',()=>{
  const old={available:true,installedVersion:'1.0'};
  assert.equal(localDeviceStatus(old,false,false,'connection unavailable').state,'unconfirmed');
  assert.equal(localDeviceStatus({...old,preparing:true,phase:'verifying'},false,false).state,'preparing');
  assert.equal(localDeviceStatus({...old,error:'verification failed'},false,false).state,'unconfirmed');
});
test('technical executor messages never become the primary readiness label',()=>{
  const status=localDeviceStatus({available:false,message:'INTERNAL_ENGINE_NOT_CONNECTED'},false,false);
  assert.equal(status.state,'unconfirmed');
  assert.doesNotMatch(status.title+status.description,/INTERNAL|工程|渠道/);
});
