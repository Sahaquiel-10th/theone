import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRecovery} from './taskRecovery';

test('recovery offers safe actions for text, images, local execution and ongoing work',()=>{
  assert.equal(taskRecovery([{id:'text',state:'failed'}]).kind,'retry');
  assert.equal(taskRecovery([{id:'text',state:'interrupted'}]).kind,'retry');
  assert.equal(taskRecovery([{id:'img',state:'failed',kind:'image'}]).kind,'review_image');
  assert.equal(taskRecovery([{id:'img',state:'queued',kind:'image'}]).kind,'resume');
  assert.equal(taskRecovery([{id:'local',state:'prepared'}]).kind,'review_local');
  assert.equal(taskRecovery([{id:'active',state:'running'},{id:'later',state:'queued'}]).kind,'none');
  assert.equal(taskRecovery([{id:'done',state:'completed'}]).kind,'none');
});
