import test from 'node:test';import assert from 'node:assert/strict';
import {waitingForCurrentReply,canPeekAtFeatures} from './oneFocusState';
test('current reply waiting stops at first content and never belongs to old answers',()=>{
 const old=[{role:'user',content:'old'},{role:'assistant',content:'done'}];
 assert.equal(waitingForCurrentReply(true,old),false);
 assert.equal(waitingForCurrentReply(false,[...old,{role:'user',content:'new'}]),false);
 assert.equal(waitingForCurrentReply(true,[...old,{role:'user',content:'new'},{role:'assistant',content:''}]),true);
 assert.equal(waitingForCurrentReply(true,[...old,{role:'user',content:'new'},{role:'assistant',content:'first fragment'}]),false);
 assert.equal(waitingForCurrentReply(true,[]),false);
});
test('feature invitation stays quiet while typing, working, reading or configuring',()=>{
 assert.equal(canPeekAtFeatures(true,false,''),true);
 for(const args of [[false,false,''],[true,true,''],[true,false,'writing']] as const)assert.equal(canPeekAtFeatures(args[0],args[1],args[2]),false);
});
