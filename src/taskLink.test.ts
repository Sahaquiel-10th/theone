import test from 'node:test';
import assert from 'node:assert/strict';
import {internalTaskId} from './taskLink';
test('result links resolve both dispatcher query links and durable receipt fragments',()=>{
 const base='https://one.example/';
 assert.equal(internalTaskId('/?task=cnv_12',base),'cnv_12');
 assert.equal(internalTaskId('#task:cnv_12',base),'cnv_12');
 assert.equal(internalTaskId('https://one.example/?task=cnv_12',base),'cnv_12');
 for(const link of ['https://other.example/?task=cnv_12','javascript:alert(1)','/?task=../secret','/api/private?task=cnv_12','/?task=a#task:b','#task:%ZZ'])assert.equal(internalTaskId(link,base),undefined);
});
