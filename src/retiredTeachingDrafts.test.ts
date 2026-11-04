import test from 'node:test';
import assert from 'node:assert/strict';
import {clearRetiredTeachingDrafts} from './retiredTeachingDrafts';
import {teacherDraftStorageKey} from './teacherTaskState';

test('retiring test preparations removes only the exact current owner legacy key',()=>{
  const owner={userId:'teacher-a',workspaceId:'class-a'},other={userId:'teacher-b',workspaceId:'class-b'},key=teacherDraftStorageKey(owner),foreign=teacherDraftStorageKey(other);
  const data=new Map([[key,JSON.stringify({version:1,...owner,drafts:Array.from({length:6},(_,id)=>({id}))})],[foreign,JSON.stringify({version:1,...other,drafts:[{id:'foreign'}]})],['one-teaching-course-manager:current','keep course and its original save receipt']]);
  const storage={getItem:(key:string)=>data.get(key)??null,removeItem:(key:string)=>{data.delete(key);}};
  assert.equal(clearRetiredTeachingDrafts(storage,owner),6);assert.equal(data.has(key),false);assert.equal(data.has(foreign),true);assert.equal(data.get('one-teaching-course-manager:current'),'keep course and its original save receipt');assert.equal(clearRetiredTeachingDrafts(storage,owner),0);
});
test('retirement does not remove mismatched owners, unknown versions or unavailable storage',()=>{
  const owner={userId:'teacher-a',workspaceId:'class-a'};
  for(const raw of [JSON.stringify({version:2,...owner,drafts:[]}),JSON.stringify({version:1,userId:'other',workspaceId:owner.workspaceId,drafts:[]}),'{invalid']){
    let removed=false;assert.equal(clearRetiredTeachingDrafts({getItem:()=>raw,removeItem:()=>{removed=true;}},owner),0);assert.equal(removed,false);
  }
  assert.equal(clearRetiredTeachingDrafts({getItem:()=>{throw Error('storage blocked');},removeItem:()=>{}},owner),0);
});
