import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedStateValue,updateScopedState} from './coordinatorScopedState';

test('same user switching workspace hides previous render state before effects run',()=>{
 const first={userId:'same-user',workspaceId:'first'},second={userId:'same-user',workspaceId:'second'};
 const state={scope:first,value:'FIRST_WORKSPACE_PRIVATE_SENTINEL'};
 assert.equal(scopedStateValue(state,second,null),null);
 assert.equal(scopedStateValue(state,first,null),'FIRST_WORKSPACE_PRIVATE_SENTINEL');
});
test('a previously queued updater cannot mutate the replacement workspace or invoke its reducer',()=>{
 const first={},second={};let called=false;
 const state={scope:second,value:['new']};
 assert.equal(updateScopedState(state,first,second,[],()=>{called=true;return['old'];}),state);
 assert.equal(called,false);
 assert.deepEqual(updateScopedState({scope:first,value:['old']},second,second,[],old=>[...old,'new']),{scope:second,value:['new']});
});
test('same workspace API epoch changes also drop stale callbacks',()=>{
 const oldEpoch={userId:'same',workspaceId:'same'},newEpoch={userId:'same',workspaceId:'same'};
 const state={scope:oldEpoch,value:{pending:'old'}};
 assert.equal(scopedStateValue(state,newEpoch,null),null);
 assert.equal(updateScopedState(state,oldEpoch,newEpoch,{pending:''},{pending:'late'}),state);
});
